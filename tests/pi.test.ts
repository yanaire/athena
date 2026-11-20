import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createPiSession, endpointConfig, modelReference, PiRuntimeError } from "../runtime/pi.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function environment(t: TestContext, key: string, value: string) {
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  process.env[key] = value;
}

test("disk session identity and history remain available without configured credentials", { timeout: 15000 }, async t => {
  for (const key of ["ATHENA_MODEL", "ATHENA_ENDPOINT", "ATHENA_PROVIDER", "ATHENA_API_KEY"]) environment(t, key, "");
  const directory = await mkdtemp(join(tmpdir(), "athena-pi-offline-"));
  environment(t, "ATHENA_AUTH_PATH", join(directory, "auth.json"));
  try {
    const projectDir = join(directory, "project");
    await mkdir(projectDir);
    const options = { projectDir, sessionDir: join(directory, "sessions") };
    const session = await createPiSession(options);
    const sessionId = session.sessionId;
    const sessionFile = session.sessionFile;
    assert.equal(JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0] ?? "").id, sessionId);
    assert.deepEqual(session.getMessages(), []);
    await assert.rejects(session.prompt("Hello"), PiRuntimeError);
    await assert.rejects(session.command({ type: "bash", command: "pwd" }), PiRuntimeError);
    session.close();

    const reopened = await createPiSession({ ...options, sessionFile });
    assert.equal(reopened.sessionId, sessionId);
    assert.equal(reopened.getState().messageCount, 0);
    assert.deepEqual(reopened.getMessages(), []);
    reopened.close();
    await assert.rejects(createPiSession({ ...options, sessionFile: join(directory, "absent.jsonl") }), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public SDK events, history and RPC responses redact host credentials", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "athena-pi-secrets-"));
  const secret = "fixture-secret-581092";
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the SDK request before replying. */ }
    authorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      id: "fixture-secret", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: `Provider echoed ${secret}` }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  environment(t, "ATHENA_ENDPOINT", `http://127.0.0.1:${address.port}/v1`);
  environment(t, "ATHENA_MODEL", "fixture-model");
  environment(t, "ATHENA_API_KEY", secret);
  try {
    const session = await createPiSession({ projectDir: directory, sessionDir: join(directory, "sessions") });
    const events: unknown[] = [];
    session.subscribe(event => events.push(event));
    await session.prompt("Hello.");
    const output = JSON.stringify({ events, history: session.getMessages(),
      rpc: await session.command({ type: "get_messages" }), state: session.getState() });
    assert.equal(authorization, `Bearer ${secret}`);
    assert.ok(output.includes("[redacted]"));
    assert.ok(!output.includes(secret));
    session.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("official SDK streams a model-requested confined read and restores its transcript", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "athena-pi-stream-"));
  const projectDir = join(directory, "project");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "paper.txt"), "Measured evidence: 92713.");
  // A wire fixture tests the actual SDK's tool dispatch and persistence, not model quality.
  const requests: unknown[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const hasResult = record(body) && Array.isArray(body.messages)
      && body.messages.some((message: unknown) => record(message) && message.role === "tool");
    if (!hasResult) {
      emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function",
        function: { name: "read", arguments: '{"path":"paper.txt"}' } }] });
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "The measured evidence is 92713." });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  environment(t, "ATHENA_ENDPOINT", `http://127.0.0.1:${address.port}/v1`);
  environment(t, "ATHENA_MODEL", "fixture-model");
  environment(t, "ATHENA_API_KEY", "");
  try {
    assert.equal(modelReference(), "athena/fixture-model");
    assert.equal(endpointConfig()?.loopback, true);
    const options = { projectDir, sessionDir: join(directory, "sessions") };
    const session = await createPiSession(options);
    const catalog = await session.command({ type: "get_available_models" });
    assert.ok(record(catalog) && record(catalog.data) && Array.isArray(catalog.data.models));
    assert.deepEqual(catalog.data.models.map((model: unknown) => record(model) ? `${model.provider}/${model.id}` : null),
      ["athena/fixture-model"]);
    const events: string[] = [];
    const detach = session.subscribe(event => events.push(event.type));
    await session.prompt("Read paper.txt and give the measurement.");
    assert.ok(events.includes("tool_execution_start"));
    assert.ok(events.includes("tool_execution_end"));
    assert.ok(events.includes("message_update"));
    assert.ok(events.includes("agent_settled"));
    const messages = session.getMessages();
    assert.ok(messages.some(message => record(message) && message.role === "toolResult"
      && JSON.stringify(message).includes("92713")));
    assert.ok(messages.some(message => record(message) && message.role === "assistant"
      && JSON.stringify(message).includes("The measured evidence is 92713.")));
    assert.deepEqual(authorizations, [undefined, undefined]);
    assert.equal(requests.length, 2);
    const first = requests[0];
    assert.ok(record(first) && Array.isArray(first.tools));
    assert.deepEqual(first.tools.map((tool: unknown) => record(tool) && record(tool.function) ? tool.function.name : null), ["read"]);
    const sessionId = session.sessionId;
    const sessionFile = session.sessionFile;
    detach();
    session.close();
    // History is read from Pi JSONL even after host configuration/credentials disappear.
    environment(t, "ATHENA_ENDPOINT", "");
    environment(t, "ATHENA_MODEL", "");
    environment(t, "ATHENA_PROVIDER", "");
    environment(t, "ATHENA_AUTH_PATH", join(directory, "auth.json"));
    const reopened = await createPiSession({ ...options, sessionFile });
    assert.equal(reopened.sessionId, sessionId);
    assert.deepEqual(reopened.getMessages(), messages);
    reopened.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
