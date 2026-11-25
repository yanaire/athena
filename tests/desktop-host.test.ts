import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AnalysisFiles } from '../runtime/analysis-files.ts';
import { chatGPTAccountRef } from '../runtime/chatgpt-catalog.ts';
import { artifactRef, type ArtifactRow } from '../runtime/orchestration.ts';
import { openProviderCredentials } from '../runtime/provider-credentials.ts';
import { Storage } from '../runtime/storage.ts';
import { assertKilled, assertPrivatePermissions, restorePrivatePermissions, systemEnvironment, windows } from './platform-test-helpers.ts';

const marker = 'ATHENA_DESKTOP_BOOTSTRAP';
const authPath = (directory: string) => join(directory, 'auth/credentials.v2.json');
const prohibitKeychain = `import cp from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  const original = cp.execFile;
  cp.execFile = function(file, ...args) {
    if (file === '/usr/bin/security') process.exit(84);
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();`;
const script = fileURLToPath(new URL('../runtime/server.ts', import.meta.url));
const hex = () => randomBytes(32).toString('hex');
const ownedChildren = new WeakMap<TestContext, Set<() => Promise<void>>>();

async function workspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'athena-desktop-test-'));
  t.after(async () => {
    // Windows cannot remove a workspace while its host still owns SQLite files.
    const closed = await Promise.allSettled([...(ownedChildren.get(t) ?? [])].map(close => close()));
    await rm(directory, { recursive: true, force: true });
    const failure = closed.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });
  // Match the private/current-user precondition for a freshly created test root.
  await restorePrivatePermissions(directory, 0o700);
  return directory;
}

function ownChild(t: TestContext, start: () => ChildProcessWithoutNullStreams) {
  t.signal.throwIfAborted();
  let owned: ChildProcessWithoutNullStreams | undefined;
  let completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const stop = () => {
    if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
  };
  const close = async () => {
    t.signal.removeEventListener('abort', stop);
    stop();
    await completion;
  };
  const children = ownedChildren.get(t) ?? new Set<() => Promise<void>>();
  children.add(close);
  ownedChildren.set(t, children);
  t.after(close); // Register ownership before a timed-out callback can create a child.
  t.signal.addEventListener('abort', stop, { once: true });
  t.signal.throwIfAborted();
  const child = start();
  owned = child;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  completion = exited;
  void exited.catch(() => undefined); // Awaiters below still observe spawn errors.
  return { child, exited };
}

function launch(t: TestContext, directory: string, env: NodeJS.ProcessEnv = {}, throughParent = false) {
  const relay = `const { spawn } = require('node:child_process');
    const host = spawn(process.execPath, [process.argv[1], '--desktop'], { stdio: ['pipe', 'inherit', 'inherit'] });
    process.stdin.pipe(host.stdin);
    host.once('exit', code => process.exit(code ?? 1));`;
  const { child, exited } = ownChild(t, () => spawn(process.execPath, throughParent ? ['--input-type=commonjs', '-e', relay, script] : [script, '--desktop'], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...systemEnvironment(), HOME: directory, USERPROFILE: directory, ATHENA_DATA_DIR: directory, ATHENA_PORT: 'not-a-port', NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(prohibitKeychain)}`, ...env },
  }));
  const output: string[] = [];
  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', line => output.push(line));
  const lines = stdout[Symbol.asyncIterator]();
  const stderr = child.stderr.setEncoding('utf8');
  let diagnostics = '';
  stderr.on('data', chunk => { diagnostics += chunk; });
  return { child, output, lines, exited, testSignal: t.signal, diagnostics: () => diagnostics };
}

async function ready(host: ReturnType<typeof launch>) {
  host.testSignal.throwIfAborted();
  const { value } = await host.lines.next();
  assert.ok(typeof value === 'string', host.diagnostics());
  const port = /^ATHENA_DESKTOP_READY ([1-9][0-9]{0,4})$/.exec(value)?.[1];
  assert.ok(port && Number(port) <= 65535, `Expected readiness, got ${value}`);
  return `http://127.0.0.1:${port}`;
}

async function start(t: TestContext, directory: string, startup: { readonly token: string } = { token: hex() }) {
  const host = launch(t, directory);
  t.signal.throwIfAborted();
  assert.equal((await host.lines.next()).value, marker);
  host.child.stdin.write(JSON.stringify(startup) + '\n');
  return { ...host, base: await ready(host), cookie: `athena_desktop=${startup.token}` };
}

const rpc = (method: string, args: unknown[] = []): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }),
});

test('private migration pipe accepts explicit key replies and rejects malformed or concurrent requests', { timeout: 15_000 }, async t => {
  const account = hex();
  const key = hex();
  const module = new URL('../runtime/desktop-host.ts', import.meta.url).href;
  for (const [reply, expected] of [
    [JSON.stringify({ migration: key }), key],
    [JSON.stringify({ migration: key.toUpperCase() }), key],
    ['{"migration":"unavailable"}', 'unavailable'],
    ['{"migration":"invalid"}', 'STARTUP_FAILED'],
    [`{"migration":"${key}","migration":"${key}"}`, 'STARTUP_FAILED'],
    [JSON.stringify({ migration: key, token: hex() }), 'STARTUP_FAILED'],
    [undefined, 'STARTUP_FAILED'],
  ] as const) {
    await t.test(expected, async t => {
      const source = `
        import { readDesktopStartup } from ${JSON.stringify(module)};
        const desktop = await readDesktopStartup();
        try {
          await desktop.requestMigrationKey('invalid-account');
          process.exit(85);
        } catch (error) { if (error.code !== 'STARTUP_FAILED') throw error; }
        const pending = desktop.requestMigrationKey(${JSON.stringify(account)});
        try {
          await desktop.requestMigrationKey(${JSON.stringify(account)});
          process.exit(86);
        } catch (error) { if (error.code !== 'STARTUP_FAILED') throw error; }
        try {
          const key = await pending;
          console.log('RESULT ' + (key?.toString('hex') ?? 'unavailable'));
        } catch (error) { console.log('RESULT ' + error.code); }
        process.stdin.destroy();
      `;
      const fixtureHome = await workspace(t);
      const { child, exited } = ownChild(t, () => spawn(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...systemEnvironment(), HOME: fixtureHome }, stdio: ['pipe', 'pipe', 'pipe'],
      }));
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      child.stdin.write(JSON.stringify({ token: hex() }) + '\n');
      assert.equal((await lines.next()).value, `ATHENA_DESKTOP_IMPORT ${account}`);
      if (reply === undefined) child.stdin.end();
      else {
        child.stdin.write(reply.slice(0, 12));
        child.stdin.write(reply.slice(12) + '\n');
      }
      assert.equal((await lines.next()).value, `RESULT ${expected}`);
      assert.deepEqual(await exited, { code: 0, signal: null });
    });
  }
});

async function seedArtifact(directory: string) {
  const scope = { projectId: 'project', sessionId: 'conversation', taskId: 'task', attemptId: 'attempt' };
  const bytes = 'score\n43\n';
  const [file] = await new AnalysisFiles(directory).publish(scope, ['score.csv'], [{ name: 'score.csv', bytes: Buffer.from(bytes) }]);
  assert.ok(file);
  const reference = artifactRef(file);
  const other = 'different-conversation';
  const storage = new Storage(directory);
  try {
    storage.putProject({ id: scope.projectId, name: 'Local fixture' });
    for (const id of [scope.sessionId, other]) {
      storage.putSession({ id, projectId: scope.projectId, title: id, sessionDir: directory, sessionFile: join(directory, `${id}.jsonl`) });
    }
    storage.putRecord('artifact', {
      ...scope, id: file.id, runId: 'run', parentTaskId: null, agentSessionId: scope.sessionId,
      version: reference.version, title: reference.name, status: 'ready', kind: 'analysis',
      file, toolId: 'publish', processId: file.attemptId, review: { status: 'unreviewed', version: reference.version }, evidence: [],
    } satisfies ArtifactRow);
  } finally { storage.close(); }
  return { uri: reference.uri, foreignUri: `/api/artifacts/${other}/${file.id}`, bytes };
}

test('desktop guards all routes and keeps authenticated same-origin RPC, SSE and scoped downloads working', { timeout: 15_000 }, async t => {
  const directory = await workspace(t);
  const artifact = await seedArtifact(directory);
  const host = await start(t, directory);
  const { base, cookie } = host;
  const signal = AbortSignal.timeout(5_000);
  const local = { cookie, origin: base, 'Sec-Fetch-Site': 'same-origin' };
  const read = (path: string, headers = local) => fetch(base + path, { headers, signal });
  const call = (method: string, args: unknown[] = []) => fetch(base + '/api/rpc', {
    ...rpc(method, args), signal, headers: { ...local, 'Content-Type': 'application/json' },
  });
  for (const [path, init] of [
    ['/', {}], ['/athena-host.js', {}], ['/favicon.ico', {}], ['/api/bootstrap', {}], ['/api/events', {}],
    ['/api/rpc', rpc('createProject', [{ name: 'Unauthorized' }])], [artifact.uri, {}], ['/no-such-route', {}],
  ] satisfies [string, RequestInit][]) {
    const unauthorized = await fetch(base + path, { ...init, signal });
    assert.equal(unauthorized.status, 401, path);
    assert.equal(unauthorized.headers.get('set-cookie'), null, path);
    await unauthorized.text();
    const crossed = await fetch(base + path, { ...init, signal, headers: {
      ...init.headers, cookie, origin: 'http://127.0.0.1:1',
    } });
    assert.equal(crossed.status, 403, path);
    assert.equal(crossed.headers.get('access-control-allow-origin'), null, path);
    await crossed.text();
  }
  const page = await read('/');
  assert.equal(page.status, 200);
  const csp = new Map(page.headers.get('content-security-policy')?.split('; ').map(entry => {
    const [name, ...sources] = entry.split(' ');
    return [name, sources];
  }));
  for (const [directive, sources] of Object.entries({
    'default-src': ["'none'"], 'script-src': [base, "'unsafe-inline'"], 'style-src': [base, "'unsafe-inline'"],
    'connect-src': [base], 'img-src': [base, 'data:', 'blob:'], 'frame-src': ["'none'"], 'frame-ancestors': ["'none'"],
    'object-src': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"],
  })) assert.deepEqual(csp.get(directive), sources, directive);
  assert.match(await page.text(), /<script src="\/athena-host\.js">/);
  const bridge = await read('/athena-host.js');
  assert.equal(bridge.status, 200);
  await bridge.text();
  const bootstrap = await read('/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  await bootstrap.text();
  const created = await call('createProject', [{ name: 'Authenticated project' }]);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).result.project.name, 'Authenticated project');

  const download = await read(artifact.uri);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), "attachment; filename*=UTF-8''score.csv");
  assert.equal(await download.text(), artifact.bytes);
  const wrongScope = await read(artifact.foreignUri);
  assert.equal(wrongScope.status, 400);
  assert.equal((await wrongScope.json()).code, 'ARTIFACT_DENIED');

  const stream = await read('/api/events');
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const completion = stream.text();
  host.child.stdin.end();
  assert.equal(await completion, ': subscribed\n\n');
  assert.deepEqual(await host.exited, { code: 0, signal: null });
  assert.deepEqual(host.output, [marker, `ATHENA_DESKTOP_READY ${new URL(base).port}`]);
  await assert.rejects(read('/api/bootstrap'), TypeError);
});

test('desktop rejects cookie ambiguity, other secret transports and invalid host or fetch site', { timeout: 15_000 }, async t => {
  const token = hex();
  const { base, cookie } = await start(t, await workspace(t), { token });
  for (const [headers, expected] of [
    [{ Cookie: `athena_desktop=${hex()}` }, 401], [{ Cookie: `${cookie}; ${cookie}` }, 401],
    [{ Cookie: `${cookie}; athena_desktop=${hex()}` }, 401], [{ Cookie: `${cookie}, other=valid` }, 401],
    [{ Cookie: [cookie, 'other=valid'] }, 401], [{ Cookie: `other=valid; ${cookie}` }, 200],
    [{ Authorization: `Bearer ${token}`, 'X-Athena-Desktop': token }, 401],
    [{ Cookie: cookie, Host: 'localhost:1' }, 403], [{ Cookie: cookie, Origin: 'null' }, 403],
    [{ Cookie: cookie, 'Sec-Fetch-Site': 'same-site' }, 403], [{ Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }, 403],
  ] satisfies [NodeJS.Dict<string | string[]>, number][]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      // Raw header pairs let us send distinct Cookie fields without Node's client merging them.
      const raw = Object.entries({ Host: new URL(base).host, ...headers }).flatMap(([name, value]) =>
        value === undefined ? [] : [value].flat().flatMap(item => [name, item]));
      request(`${base}/api/bootstrap?token=${token}`, { headers: raw, signal: AbortSignal.timeout(3_000) }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject).end();
    });
    assert.equal(status, expected, Object.keys(headers).join(', '));
  }
});

// Fifteen independent host starts exceeded the old 25s budget on native Intel CI.
test('desktop fails closed with a structured frame for invalid startup input', { timeout: 60_000 }, async t => {
  const directory = await workspace(t);
  const token = 'a'.repeat(64), key = hex();
  const valid = JSON.stringify({ token });
  for (const input of [undefined, valid, '{invalid}\n', ' '.repeat(1025), `${valid}\n${valid}\n`,
    `{"token":"${token}","token":"${token}"}\n`,
    JSON.stringify({ token, key }) + '\n', JSON.stringify({ token: token.toUpperCase() }) + '\n',
    '{"token":""}\n', '{}\n',
    JSON.stringify({ token: token.toUpperCase(), key }) + '\n', JSON.stringify({ token, key: null }) + '\n',
    JSON.stringify({ token, key, keySource: 'keychain' }) + '\n',
    JSON.stringify({ token, key, keySource: 'memory' }) + '\n', JSON.stringify({ token, keySource: 'memory' }) + '\n']) {
    const host = launch(t, directory, { ATHENA_CREDENTIAL_KEY: key });
    assert.equal((await host.lines.next()).value, marker);
    if (input === undefined || input === valid) host.child.stdin.end(input);
    else host.child.stdin.write(input);
    assert.deepEqual(await host.exited, { code: 1, signal: null });
    assert.deepEqual(host.output, [marker, 'ATHENA_DESKTOP_ERROR STARTUP_FAILED']);
    assert.equal(host.diagnostics().includes(key), false);
  }
});

test('desktop owns the workspace before requesting a private session token and shuts down through its parent pipe', { timeout: 15_000 }, async t => {
  const directory = await workspace(t);
  const first = launch(t, directory);
  assert.equal((await first.lines.next()).value, marker);
  await assert.rejects(stat(authPath(directory)), { code: 'ENOENT' });
  const contender = launch(t, directory);
  assert.deepEqual(await contender.exited, { code: 1, signal: null });
  assert.deepEqual(contender.output, ['ATHENA_DESKTOP_ERROR WORKSPACE_BUSY']);
  const startup = { token: hex() };
  const line = JSON.stringify(startup);
  first.child.stdin.write(line.slice(0, 45));
  first.child.stdin.write(line.slice(45));
  first.child.stdin.write('\n');
  await ready(first);
  first.child.stdin.end();
  assert.deepEqual(await first.exited, { code: 0, signal: null });

  const restarted = await start(t, directory, startup);
  restarted.child.stdin.end();
  assert.deepEqual(await restarted.exited, { code: 0, signal: null });
});

test('desktop also handles POSIX SIGTERM and SIGINT with a graceful exit', {
  timeout: 15_000, skip: windows ? 'Windows process.kill is forced termination; graceful desktop shutdown is verified through its parent pipe.' : false,
}, async t => {
  const directory = await workspace(t);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const host = await start(t, directory);
    assert.equal(host.child.kill(signal), true);
    assert.deepEqual(await host.exited, { code: 0, signal: null });
  }
});

test('desktop releases an active SSE connection and workspace when its parent is killed', { timeout: 15_000 }, async t => {
  const directory = await workspace(t);
  const host = launch(t, directory, {}, true);
  assert.equal((await host.lines.next()).value, marker);
  const startup = { token: hex() };
  host.child.stdin.write(JSON.stringify(startup) + '\n');
  const base = await ready(host);
  const stream = await fetch(`${base}/api/events`, { headers: { Cookie: `athena_desktop=${startup.token}` }, signal: AbortSignal.timeout(7_000) });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  const subscription = ': subscribed\n\n';
  let received = Buffer.alloc(0);
  while (received.length < subscription.length) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received = Buffer.concat([received, chunk.value!]);
  }
  assert.equal(received.toString('utf8'), subscription);
  const disconnected = reader.read().then(result => {
    assert.deepEqual(result, { done: true, value: undefined });
  }, (error: unknown) => {
    // libuv's Windows job kills non-detached children with their parent. The
    // already-subscribed socket may close without an HTTP response terminator.
    if (!windows) throw error;
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'terminated');
    assert.match((error.cause as NodeJS.ErrnoException | undefined)?.code ?? '', /^(UND_ERR_SOCKET|ECONNRESET)$/);
  });
  assert.equal(host.child.kill('SIGKILL'), true);
  await disconnected;
  reader.releaseLock();
  // close waits for the relay and its inherited stdout/stderr handles to close.
  const killed = await host.exited;
  assertKilled(killed.code, killed.signal);
  const restarted = await start(t, directory, startup);
  restarted.child.stdin.end();
  assert.deepEqual(await restarted.exited, { code: 0, signal: null });
});

test('desktop persists local credentials across token-only restarts without reading the legacy vault', { timeout: 15_000 }, async t => {
  const directory = await workspace(t);
  const key = hex();
  const vault = join(directory, 'provider-secrets.v1');
  const { store } = await openProviderCredentials(directory, { source: 'operator_key', key });
  await store.modify('openai', async () => ({ type: 'api_key', key: 'legacy-test-fixture' }));
  const original = await readFile(vault);
  const first = await start(t, directory);
  const response = await fetch(first.base + '/api/rpc', { ...rpc('saveProviderApiKey', ['openai', 'local-test-fixture']),
    headers: { 'Content-Type': 'application/json', Cookie: first.cookie }, signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 200);
  await assertPrivatePermissions(authPath(directory), 0o600);
  first.child.stdin.end();
  assert.deepEqual(await first.exited, { code: 0, signal: null });
  const local = await readFile(authPath(directory));
  const restarted = await start(t, directory);
  const profiles = await fetch(restarted.base + '/api/rpc', { ...rpc('listModelProfiles'),
    headers: { 'Content-Type': 'application/json', Cookie: restarted.cookie }, signal: AbortSignal.timeout(3_000) });
  assert.equal(profiles.status, 200);
  assert.equal((await profiles.json()).result.credentialMode, 'local_file');
  const providers = await fetch(restarted.base + '/api/rpc', { ...rpc('listProviders'),
    headers: { 'Content-Type': 'application/json', Cookie: restarted.cookie }, signal: AbortSignal.timeout(3_000) });
  assert.equal(providers.status, 200);
  const providerList = (await providers.json()).result;
  assert.ok(providerList.some((provider: { id: string; auth: string; credentialSource?: string }) =>
    provider.id === 'openai' && provider.auth === 'configured' && provider.credentialSource === 'stored'));
  restarted.child.stdin.end();
  assert.deepEqual(await restarted.exited, { code: 0, signal: null });
  assert.deepEqual(await readFile(authPath(directory)), local);
  assert.deepEqual(await readFile(vault), original);
});

test('desktop reports damaged local credentials separately and does not rewrite them', { timeout: 10_000 }, async t => {
  const directory = await workspace(t);
  const first = await start(t, directory);
  first.child.stdin.end();
  assert.deepEqual(await first.exited, { code: 0, signal: null });
  const path = authPath(directory);
  const damaged = Buffer.alloc(14, 43);
  await writeFile(path, damaged, { mode: 0o600 });
  const host = launch(t, directory);
  assert.equal((await host.lines.next()).value, marker);
  host.child.stdin.write(JSON.stringify({ token: hex() }) + '\n');
  assert.deepEqual(await host.exited, { code: 1, signal: null });
  assert.deepEqual(host.output, [marker, 'ATHENA_DESKTOP_ERROR VAULT_INVALID']);
  assert.deepEqual(await readFile(path), damaged);
});

test('desktop cannot serve until it can write new local credentials', {
  timeout: 10_000,
  skip: process.platform === 'win32' || process.geteuid?.() === 0 ? 'Requires a non-root POSIX user' : false,
}, async t => {
  const directory = await workspace(t);
  const host = launch(t, directory);
  assert.equal((await host.lines.next()).value, marker);
  await chmod(directory, 0o500);
  try {
    host.child.stdin.write(JSON.stringify({ token: hex() }) + '\n');
    assert.deepEqual(await host.exited, { code: 1, signal: null });
    assert.deepEqual(host.output, [marker, 'ATHENA_DESKTOP_ERROR VAULT_WRITE_FAILED']);
    assert.equal((await readdir(directory)).includes('auth'), false);
  } finally {
    await chmod(directory, 0o700);
  }
});

test('the released desktop host preserves a legacy OAuth vault without importing or exposing its credentials', { timeout: 15_000 }, async t => {
  const directory = await workspace(t);
  const key = hex();
  const path = join(directory, 'provider-secrets.v1');
  const fixture = { type: 'oauth', issuer: 'https://auth.openai.com', clientId: 'oaiapp_desktop_fixture',
    subject: 'desktop-fixture-subject', access: hex(), refresh: hex(), idToken: hex(), expires: 0,
    scopes: ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] } as const;
  const account = chatGPTAccountRef(fixture);
  assert.ok(account);
  const { store } = await openProviderCredentials(directory, { source: 'keychain', key });
  await store.modify('openai', async () => fixture);
  const original = await readFile(path);
  const token = hex();
  // An attempted provider request makes the test process fail locally before any network call.
  const prohibitNetwork = 'globalThis.fetch=()=>{process.exit(83)};';
  const host = launch(t, directory, { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(prohibitKeychain)} --import=data:text/javascript,${encodeURIComponent(prohibitNetwork)}` });
  assert.equal((await host.lines.next()).value, marker);
  host.child.stdin.write(JSON.stringify({ token }) + '\n');
  const base = await ready(host);
  const headers = { Cookie: `athena_desktop=${token}`, Origin: base, 'Content-Type': 'application/json' };
  const signal = AbortSignal.timeout(5000);
  const secrets = [fixture.access, fixture.refresh, fixture.idToken, fixture.subject, fixture.clientId, key];
  async function desktopRpc(method: string, args: unknown[], status = 200) {
    const response = await fetch(base + '/api/rpc', { ...rpc(method, args), headers, signal });
    const wire = await response.text();
    assert.equal(response.status, status, method);
    assert.ok(secrets.every(secret => !wire.includes(secret)), `Private values appeared in ${method}.`);
    return JSON.parse(wire);
  }

  assert.deepEqual(await desktopRpc('listChatGPTAccounts', []), { result: [] });
  const { result } = await desktopRpc('getProviderCatalog', ['openai', { accountRef: account, refresh: true }]);
  assert.equal(result.source, 'chatgpt_account');
  assert.deepEqual(result.models, []);
  assert.equal(result.provider.auth, 'unconfigured');
  for (const [method, args] of [
    ['startProviderOAuth', ['openai', account]], ['startProviderOAuth', ['openai-codex']],
    ['signOutChatGPTAccount', [account]], ['openProviderOAuthBrowser', ['inactive-flow']],
  ] as const) {
    assert.equal((await desktopRpc(method, [...args], 400)).code, 'UNSUPPORTED_AUTH');
  }

  host.child.stdin.end();
  assert.deepEqual(await host.exited, { code: 0, signal: null });
  assert.deepEqual(await readFile(path), original);
  assert.ok(secrets.every(secret => !host.diagnostics().includes(secret) && !host.output.join('\n').includes(secret)));
  const reopened = await openProviderCredentials(directory, { source: 'keychain', key });
  const restored = await reopened.store.read('openai');
  assert.ok(restored?.type === 'oauth' && secrets.slice(0, 3).every((secret, i) =>
    secret === [restored.access, restored.refresh, restored.idToken][i]), 'The fixture token set did not survive reopening the vault.');
});
