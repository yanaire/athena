import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createPiSession } from "../runtime/pi.ts";
import type { PiOrchestration } from "../runtime/pi.ts";

type Call = { readonly id: string; readonly name: string; readonly args: object };

interface ModelRequest {
  readonly tools: readonly { readonly function: { readonly name: string } }[];
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

async function scenario(t: TestContext, calls: readonly Call[], orchestration: PiOrchestration) {
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const call = calls[requests.length - 1];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
      id: "orchestration-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (call) {
      emit({ role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null);
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "Done." }, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const keys = { ATHENA_ENDPOINT: `http://127.0.0.1:${address.port}/v1`, ATHENA_MODEL: "fixture-model", ATHENA_API_KEY: "" };
  for (const [key, value] of Object.entries(keys)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const directory = await mkdtemp(join(tmpdir(), "athena-pi-orchestration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectDir = join(directory, "project");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "ungranted.txt"), "Ungranted evidence 49205");
  return { session: await createPiSession({ projectDir, sessionDir: join(directory, "sessions"), orchestration }), requests };
}

test("parent SDK tools preserve explicit request IDs and support joining all children", { timeout: 15000 }, async t => {
  const calls: Call[] = [
    { name: "spawn_agent", id: "call_spawn_92", args: { title: "Analysis", prompt: "Calculate the mean." } },
    { name: "send_to_agent", id: "call_send_93", args: { taskId: "task-401", message: "Use the voltage column.", requestId: "request-7" } },
    { name: "wait_for_agents", id: "call_wait_94", args: {} },
    { name: "calculate_csv", id: "call_parent_csv", args: {} },
    { name: "request_review", id: "call_review_disabled", args: { missionId:"mission",evidenceIds:["evidence"],question:"Review it." } },
  ];
  const received: Call[] = [];
  const { session, requests } = await scenario(t, calls, { role: "parent", async execute(name, id, args) {
    received.push({ name, id, args });
    if (name === "spawn_agent") return { taskId: "task-401" };
    if (name === "wait_for_agents") return { tasks: [{ taskId: "task-401", status: "failed" }] };
    return { ok: true };
  } });
  try {
    await session.prompt("Delegate the analysis.");
    assert.deepEqual(requests[0]?.tools.map(tool => tool.function.name).sort(),
      ["cancel_task", "get_task", "list_tasks", "read", "send_to_agent", "spawn_agent", "wait_for_agents",
        "list_skills", "load_skill", "get_research_board", "add_research_evidence", "remember_research",
        "plan_research", "propose_knowledge", "run_bibliography_search"].sort());
    assert.match(JSON.stringify(requests[0]?.messages), /Independent evidence review is unavailable/);
    assert.deepEqual(received, calls.slice(0, 3), "Only parent tools reach the manager, with raw IDs and validated arguments");
    const results = requests.at(-1)?.messages.filter(message => message.role === "tool").map(message => message.content);
    assert.ok(results?.includes('{"tasks":[{"taskId":"task-401","status":"failed"}]}'));
  } finally {
    session.close();
  }
});

test("child SDK tools delegate grants and reject path arguments and parent tools", { timeout: 15000 }, async t => {
  const calls: Call[] = [
    { name: "read", id: "call_read_denied", args: { path: "ungranted.txt" } },
    { name: "spawn_agent", id: "call_spawn_denied", args: { title: "Another child", prompt: "Read the file." } },
    { name: "calculate_csv", id: "call_csv_granted", args: { column: "voltage" } },
    { name: "read", id: "call_read_granted", args: { fileId: "grant-72" } },
    { name: "read", id: "call_read_other", args: { fileId: "grant-73" } },
  ];
  const received: Call[] = [];
  const { session, requests } = await scenario(t, calls, { role: "child", async execute(name, id, args) {
    received.push({ name, id, args });
    if (name === "calculate_csv") return { count: 3, mean: 7.5 };
    if (args.fileId !== "grant-72") throw new Error("File is outside this child's grants.");
    return "Granted evidence 85139";
  } });
  try {
    await session.prompt("Read and calculate using the assigned file.");
    assert.deepEqual(requests[0]?.tools.map(tool => tool.function.name).sort(), ["calculate_csv", "calculate_rc_response", "read",
      "list_skills", "load_skill", "get_research_board", "add_research_evidence", "remember_research", "submit_review"].sort());
    assert.deepEqual(received, calls.slice(2));
    const results = requests.at(-1)?.messages.filter(message => message.role === "tool").map(message => message.content);
    assert.ok(results?.includes('{"count":3,"mean":7.5}'));
    assert.ok(results?.includes("Granted evidence 85139"));
    assert.ok(results?.includes("File is outside this child's grants."));
    assert.doesNotMatch(JSON.stringify(results), /Ungranted evidence 49205/);
  } finally {
    session.close();
  }
});

test("aborting a Pi prompt aborts the manager's pending wait", { timeout: 15000 }, async t => {
  const running = Promise.withResolvers<AbortSignal>();
  const cancelled = Promise.withResolvers<void>();
  const { session } = await scenario(t, [{ name: "wait_for_agents", id: "call_pending", args: {} }], {
    role: "parent", async execute(_name, _id, _args, signal) {
      assert.ok(signal, "A running Pi tool must have the session's abort signal");
      signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      running.resolve(signal);
      await cancelled.promise;
      signal.throwIfAborted();
    },
  });
  const prompting = session.prompt("Wait for the assigned research.");
  try {
    const signal = await Promise.race([running.promise, prompting.then(() => assert.fail("Prompt settled before the tool started"))]);
    assert.equal(signal.aborted, false);
    await session.command({ type: "abort" });
    await cancelled.promise;
    assert.equal(signal.aborted, true);
  } finally {
    await Promise.allSettled([prompting]);
    session.close();
  }
});
