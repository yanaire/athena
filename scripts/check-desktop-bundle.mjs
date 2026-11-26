import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { lockedSandboxIdentity } from './analysis-provenance.mjs';
import { isolatedRuntimeEnvironment, resolveDesktopPlatform } from './desktop-platform.mjs';

const platform = resolveDesktopPlatform();
const macOS = platform.platform === 'darwin';
const root = fileURLToPath(new URL('..', import.meta.url));
const releaseDirectory = join(root, 'src-tauri', 'target', platform.target, 'release');

const [mode, appPath, ...extra] = process.argv.slice(2);
assert.ok(mode === undefined || (['--verify-only', '--verify-local-chatgpt', '--pre-notarization', '--release'].includes(mode) && appPath && extra.length === 0),
  'Usage: node scripts/check-desktop-bundle.mjs [--verify-only|--verify-local-chatgpt|--pre-notarization|--release <Athena.app or installed Windows directory>]');
const expectChatGPT = mode === '--verify-local-chatgpt' || (!mode && process.env.ATHENA_BUILD_CHATGPT_LOCAL === '1');
const bundle = appPath ? resolve(appPath)
  : macOS ? join(releaseDirectory, 'bundle/macos/Athena.app') : releaseDirectory;
const executables = macOS ? join(bundle, 'Contents/MacOS') : bundle;
const binary = join(executables, `athena-node${platform.exe}`);
const sandbox = join(executables, `athena-sandbox${platform.exe}`);
const application = join(executables, `athena-desktop${platform.exe}`);
const host = join(bundle, macOS ? 'Contents/Resources/host' : 'host');
const windowsStorage = join(host, 'runtime', 'windows-private-storage.exe');
const environment = isolatedRuntimeEnvironment(tmpdir());
const bundleIdentifier = expectChatGPT ? 'com.athena.desktop.local-chatgpt' : 'com.athena.desktop';
assert.ok(macOS || !['--pre-notarization', '--release'].includes(mode), 'Apple notarization/release verification is only valid on macOS; Windows installer signing requires its own release review.');
if (macOS) {
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents/Info.plist')],
    { encoding: 'utf8' }).trim(), bundleIdentifier, 'Unexpected desktop bundle identifier.');
}

// On local builds Tauri leaves the main arm64 executable linker-signed. Seal
// the actual .app resources without changing a Developer ID signature.
if (macOS && !mode && (expectChatGPT || !process.env.APPLE_SIGNING_IDENTITY)) {
  // Exercise the shipped helper with Hardened Runtime and no JIT entitlements.
  // Sign the inner executable before sealing the containing app.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', sandbox], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleIdentifier, bundle], { stdio: 'inherit' });
}
if (macOS) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });

if (mode === '--pre-notarization' || mode === '--release') {
  const jit = 'com.apple.security.cs.allow-jit';
  const native = join(host, 'node_modules', '@earendil-works', 'pi-tui', 'native', 'darwin', 'prebuilds', `darwin-${platform.arch}`, 'darwin-platform.node');
  const requirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  let expectedTeam;
  for (const [path, label, runtime, entitlements] of [
    [bundle, 'Athena.app', true, {}],
    [binary, 'athena-node', true, { [jit]: true }],
    [sandbox, 'athena-sandbox', true, {}],
    [native, `Pi ${platform.arch} module`, false, {}],
  ]) {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, path], { stdio: 'inherit' });
    const { stderr, status, error } = spawnSync('/usr/bin/codesign', ['-dvvv', path], { encoding: 'utf8' });
    if (error) throw error;
    assert.equal(status, 0, `${label}: could not read the signature`);
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1];
    assert.ok(team, `${label}: missing Developer ID Team ID`);
    expectedTeam ??= team;
    assert.equal(team, expectedTeam, `${label}: unexpected signing team`);
    const flags = /^CodeDirectory .* flags=0x[0-9a-f]+\(([^)]+)\)/m.exec(stderr)?.[1].split(',');
    if (runtime) assert.ok(flags?.includes('runtime'), `${label}: Hardened Runtime is required`);
    const xml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', path],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const actual = xml.length === 0 ? {} : JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }));
    assert.deepEqual(actual, entitlements, `${label}: unexpected entitlements`);
  }
  if (mode === '--release') {
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', bundle], { stdio: 'inherit' });
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle], { stdio: 'inherit' });
    console.log('Verified stapled notarization ticket and Gatekeeper assessment.');
  }
  execFileSync(binary, ['-e', `const helper = require(process.argv[1]);
    if (typeof helper.getText !== 'function' || typeof helper.getImage !== 'function') process.exit(1);`, native],
  { env: environment, timeout: 10_000, stdio: 'inherit' });
  console.log(`Verified Developer ID, signing team, entitlements, and ${platform.arch} Pi native module.`);
}

assert.equal(existsSync(join(host, 'node_modules', '@earendil-works', 'pi-coding-agent',
  'examples', 'extensions', 'doom-overlay')), false, 'The non-runtime Pi DOOM example must not ship.');
assert.equal(execFileSync(binary, ['-p', '[process.version,process.platform,process.arch].join(" ")'], { encoding: 'utf8', env: environment }).trim(),
  `v${platform.version} ${platform.platform} ${platform.arch}`);
for (const path of [application, binary, sandbox, ...(!macOS ? [windowsStorage] : [])]) {
  if (macOS) {
    assert.equal(execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim(),
      platform.arch === 'arm64' ? 'arm64' : 'x86_64', 'Each executable must match the selected native architecture.');
  } else {
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 2).toString(), 'MZ', 'Expected a Windows executable.');
    const offset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(offset), 0x00004550, 'Expected a PE executable header.');
    assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, 'Each executable must be Windows x64.');
  }
}
const analysis = join(host, 'analysis-runtime');
for (const directory of [executables, analysis]) {
  for (const name of ['athena-prepare-python', 'athena-prepare-python.exe']) {
    assert.equal(existsSync(join(directory, name)), false, 'The build-only Python preparer must not ship.');
  }
}
const { files: digests, helper } = JSON.parse(await readFile(join(analysis, 'provenance.json'), 'utf8'));
const expectedSandbox = await lockedSandboxIdentity();
assert.equal(helper.target, platform.target, 'Sandbox provenance must match the selected target.');
assert.equal(helper.lockSha256, expectedSandbox.lockSha256, 'Sandbox provenance must match sandbox/Cargo.lock.');
assert.equal(helper.identity, expectedSandbox.identity, 'Sandbox provenance must identify the locked Wasmtime and helper ABI.');
assert.equal(execFileSync(sandbox, ['--version'], { encoding: 'utf8', env: environment, timeout: 5_000, windowsHide: true }).trim(),
  expectedSandbox.identity, 'The bundled sandbox must match the locked Wasmtime and helper ABI.');
const provenance = JSON.parse(await readFile(join(host, 'provenance.json'), 'utf8'));
assert.equal(provenance.node.target, platform.target);
assert.equal(provenance.node.archiveSha256, platform.archiveSha256);
if (macOS) {
  assert.equal(existsSync(windowsStorage), false, 'The Windows storage helper must not enter the Mac signing scope.');
  assert.equal(existsSync(windowsStorage + '.config'), false, 'The Windows CLR config must not enter the Mac bundle.');
} else {
  assert.equal(provenance.windowsStorage.target, platform.target);
  assert.equal(provenance.windowsStorage.framework, '4.8');
  assert.match(provenance.windowsStorage.sourceSha256, /^[a-f0-9]{64}$/);
  for (const [path, digest] of [[windowsStorage, provenance.windowsStorage.executableSha256],
    [windowsStorage + '.config', provenance.windowsStorage.configurationSha256]]) {
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), digest, 'Windows storage helper provenance mismatch.');
  }
  assert.equal(execFileSync(windowsStorage, ['--version'], { encoding: 'utf8', env: environment, timeout: 15_000, windowsHide: true }).trim(),
    'athena-windows-private-storage/1 .NETFramework/4.8');
}
for (const name of ['python.wasm', 'qjs.wasm']) {
  assert.equal(createHash('sha256').update(await readFile(join(analysis, name))).digest('hex'), digests[name]);
}
if (!mode) {
  // The provenance hash is for the build input, before bundle signing.
  const stagedHelper = join(root, 'src-tauri/desktop-generated/bin', `athena-sandbox-${platform.target}${platform.exe}`);
  assert.equal(createHash('sha256').update(await readFile(stagedHelper)).digest('hex'), digests['athena-sandbox']);
  if (!macOS) {
    const installers = (await readdir(join(releaseDirectory, 'bundle/nsis'))).filter(name => name.endsWith('-setup.exe'));
    assert.equal(installers.length, 1, 'Expected exactly one Windows NSIS installer for this build.');
    console.log(`Built Windows installer: ${join(releaseDirectory, 'bundle/nsis', installers[0])}`);
  }
}

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'athena-bundle-check-'));
const workspace = join(fixtureDirectory, 'workspace');
const fixtureKey = randomBytes(32).toString('hex');
const mcpFixtureKey = randomBytes(32).toString('hex');
let successfulRequests = 0;
const fixture = createServer((request, response) => {
  if (request.url === '/mcp') {
    if (request.headers.authorization !== `Bearer ${mcpFixtureKey}`) { response.writeHead(401).end(); return; }
    if (request.method === 'DELETE') { response.writeHead(202).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks));
      if (message.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
      let result;
      if (message.method === 'initialize') {
        response.setHeader('Mcp-Session-Id', 'bundle-external');
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bundle-external', version: '1.0.0' } };
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'double', inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false } }] };
      } else if (message.method === 'tools/call' && message.params.name === 'double') {
        result = { content: [{ type: 'text', text: String(message.params.arguments.value * 2) }], structuredContent: { doubled: message.params.arguments.value * 2 } };
      } else { response.writeHead(400).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    return;
  }
  if (request.headers.authorization !== `Bearer ${fixtureKey}`) { response.writeHead(401).end(); return; }
  successfulRequests++;
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'bundle-fixture' }] }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks));
    const tool = body.tools?.[0]?.function?.name;
    const delta = tool ? { tool_calls: [{ index: 0, id: 'bundle-call', type: 'function', function: { name: tool, arguments: '{}' } }] } : { content: 'Athena' };
    const event = (change, finish_reason) => `data: ${JSON.stringify({ id: 'bundle-answer', object: 'chat.completion.chunk', model: 'bundle-fixture', choices: [{ index: 0, delta: change, finish_reason }] })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(event({ role: 'assistant', ...delta }, null) + event({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');

async function withHost(step) {
  const token = randomBytes(32).toString('hex');
  const child = spawn(binary, ['runtime/server.ts', '--desktop'], {
    cwd: host, env: { ...isolatedRuntimeEnvironment(workspace), ATHENA_DATA_DIR: workspace }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = once(child, 'close');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), macOS ? 20_000 : 60_000);
  try {
    let output = '';
    let workspaceRequested = false;
    let port;
    for await (const chunk of child.stdout) {
      output += chunk.toString();
      assert.ok(output.length <= 8192, 'Unexpected bundle startup output.');
      if (!workspaceRequested && output.includes('ATHENA_DESKTOP_BOOTSTRAP\n')) {
        workspaceRequested = true;
        if (step === 'abort-bootstrap') child.stdin.end();
        else child.stdin.write(JSON.stringify({ token }) + '\n');
      }
      const ready = output.match(/^ATHENA_DESKTOP_READY ([0-9]{1,5})\n/m);
      if (ready) {
        assert.notEqual(step, 'abort-bootstrap', 'Bundled sidecar became ready without a bootstrap token.');
        port = Number(ready[1]);
        break;
      }
    }
    if (step === 'abort-bootstrap') {
      assert.deepEqual(await exited, [1, null], 'Bundled sidecar must exit when bootstrap closes before token delivery.');
      assert.ok(output === 'ATHENA_DESKTOP_BOOTSTRAP\nATHENA_DESKTOP_ERROR STARTUP_FAILED\n',
        'Bundled sidecar must report failure without publishing readiness.');
      return;
    }
    assert.ok(port, 'Bundled sidecar did not become ready.');
    const origin = `http://127.0.0.1:${port}`;
    const cookie = `athena_desktop=${token}`;
    const signal = AbortSignal.timeout(macOS ? 10_000 : 30_000);
    assert.equal((await fetch(origin + '/api/bootstrap', { signal })).status, 401);
    const response = await fetch(origin + '/api/bootstrap', { headers: { Cookie: cookie }, signal });
    assert.equal(response.status, 200);
    const { capabilities } = await response.json();
    assert.ok(capabilities.includes('model_profiles'));
    assert.ok(capabilities.includes('extensions'));
    assert.ok(capabilities.includes('research_workflow'));
    assert.ok(capabilities.includes('system_web_links'));
    assert.equal(capabilities.includes('native_oauth_browser'), expectChatGPT, 'Unexpected ChatGPT capability for this bundle.');
    const rpc = async (method, args = [], status = 200) => {
      const reply = await fetch(origin + '/api/rpc', {
        method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args }), signal,
      });
      const wire = await reply.text();
      assert.equal(wire.includes(fixtureKey), false, 'A credential reached the response.');
      assert.equal(wire.includes(mcpFixtureKey), false, 'An external MCP credential reached the response.');
      assert.equal(reply.status, status, `${method} failed.`);
      const body = JSON.parse(wire);
      return status === 200 ? body.result : body;
    };
    await rpc('openWebAddress', ['file:///sample.txt'], 400);
    await step(rpc);
    child.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    clearTimeout(watchdog);
  }
}

try {
  // A PowerShell runner may give mkdtemp's directory an Administrators owner.
  // Create a fresh child through the shipped private-storage helper; an existing
  // user store must still be rejected rather than having its permissions repaired.
  execFileSync(binary, ['--input-type=module', '--eval', `
    import { createPrivateDirectory } from './runtime/private-storage.ts';
    createPrivateDirectory(process.argv[1]);
  `, workspace], { cwd: host, env: environment, timeout: 20_000, stdio: 'inherit' });
  if (!macOS) {
    assert.equal(execFileSync(windowsStorage, ['check'], { input: workspace, encoding: 'utf8', env: environment,
      timeout: 15_000, windowsHide: true }), 'ATHENA_PRIVATE_STORAGE_OK', 'The shipped ACL helper must work in the isolated OS environment.');
  }
  await promisify(execFile)(binary, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { JobRunner } from './runtime/jobs.ts';
    import { AnalysisFiles } from './runtime/analysis-files.ts';
    import { ExtensionStore } from './runtime/extensions.ts';
    import { discoverExternalMcp } from './runtime/external-mcp-client.ts';
    import { Storage } from './runtime/storage.ts';
    import { join } from 'node:path';
    const dataDir = process.argv[1];
    const runner = new JobRunner({ dataDir });
    const files = new AnalysisFiles(dataDir);
    for (const [language, name, source] of [
      ['python', 'job.py', "with open('/outputs/proof.txt','w') as f: f.write(open('input.txt').read().upper())"],
      ['node', 'job.mjs', "import * as std from 'qjs:std'; const f=std.open('/outputs/proof.txt','w'); f.puts(std.loadFile('input.txt').toUpperCase()); f.close();"],
    ]) {
      const result = await runner.startAnalysis({ projectId:'bundle', sessionId:'bundle', taskId:language, attemptId:language,
        requestId:language, toolId:language, language, script:{name,bytes:Buffer.from(source)}, outputs:['proof.txt'],
        inputs:[{name:'input.txt',bytes:Buffer.from('bundle input'),fileId:'bundle',versionId:'one'}] }).result;
      assert.equal(result.status,'succeeded',JSON.stringify(result));
      assert.equal(result.analysis.backend,'wasi');
      assert.equal((await files.download(result.artifacts[1])).toString(),'BUNDLE INPUT');
    }
    const scope = {projectId:'bundle', sessionId:'bundle'};
    const grant = await runner.grant({...scope, fileId:'voltage', versionId:'one', name:'measurements.csv',
      bytes:Buffer.from('measurement_mV\\n7\\n13\\n\\n21\\n35\\n')});
    const study = await runner.start({...scope, taskId:'measurement', attemptId:'measurement',
      requestId:'measurement', toolId:'measurement-tool', grantId:grant.id, column:'measurement_mV'}).result;
    assert.equal(study.status, 'succeeded', study.error);
    assert.equal(study.mcp.phase, 'tools/call');
    assert.deepEqual(JSON.parse((await runner.download(study.artifact)).toString()).statistics, [
      {column:'measurement_mV',count:4,missing:1,nonNumeric:0,min:7,max:35,mean:19}
    ]);
    const input = {schemaVersion:1,resistanceOhm:10000,capacitanceFarad:1e-7,inputVolt:1,sampleTimesSeconds:[0,0.001,0.005]};
    const circuit = await runner.grant({...scope, fileId:'circuit',versionId:'one',name:'circuit.json',
      bytes:Buffer.from(JSON.stringify(input))}, 'calculate_rc_response');
    const rc = await runner.startMcp('calculate_rc_response',{...scope,taskId:'circuit',attemptId:'circuit',
      requestId:'circuit',toolId:'circuit-tool',grantId:circuit.id}).result;
    assert.equal(rc.status,'succeeded',rc.error);
    assert.equal(rc.mcp.server,'athena-circuits');
    const response = JSON.parse((await runner.download(rc.artifact)).toString());
    assert.ok(Math.abs(response.samples[1].outputVolt - 0.632120558829) < 1e-12);
    const storage = new Storage(join(dataDir, 'extension-proof'));
    const extensions = new ExtensionStore(storage);
    const catalog = extensions.snapshot('bundle');
    assert.equal(catalog.skills.length, 12);
    assert.equal(catalog.skills.filter(skill => skill.automaticEligible).length, 3);
    const pin = extensions.pin('bundle');
    const context = {...scope, runId:'bundle', taskId:'bundle', attemptId:'bundle', parentTaskId:null, agentSessionId:'bundle'};
    const loaded = extensions.loadSkill(pin, context, 'athena-research-intake', 'Bundled skill integrity check.', [], 'automatic');
    assert.equal(loaded.use.sha256, pin.skills.find(skill => skill.id === 'athena-research-intake').sha256);
    assert.ok(loaded.instructions.length > 100);
    const definition = {id:'fixture', name:'Bundled external MCP', transport:'streamable-http', url:process.argv[2], auth:'bearer', allowedTools:['double']};
    const verification = await discoverExternalMcp(definition, {token:process.argv[3]});
    const external = await runner.startExternal({...scope, taskId:'external',attemptId:'external',requestId:'external',toolId:'external',
      server:{id:'bundle-tools/fixture',serverId:'fixture',pluginId:'bundle-tools',pluginRevision:'a'.repeat(64),definition,verification},
      tool:'double',arguments:{value:7},token:process.argv[3]}).result;
    assert.equal(external.status,'succeeded',external.error);
    assert.equal(JSON.parse((await runner.download(external.artifact)).toString()).result.structuredContent.doubled,14);
    storage.close();
    await runner.close();
  `, workspace, `http://127.0.0.1:${fixture.address().port}/mcp`, mcpFixtureKey, '--desktop'], {
    cwd: host, env: { ...environment, DOCKER_HOST: 'unix:///nonexistent-athena-bundle-check.sock' },
    // The combined verifier launches two independent WASI interpreters and MCP workers.
    timeout: 120_000,
  });
  let profileId;
  let projectId;
  await withHost(async rpc => {
    assert.equal((await rpc('listModelProfiles')).credentialMode, 'local_file');
    assert.equal((await rpc('startProviderOAuth', ['openai-codex'], 400)).code, 'UNSUPPORTED_AUTH');
    assert.deepEqual(await rpc('listChatGPTAccounts'), []);
    if (expectChatGPT) {
      const { id } = await rpc('startProviderOAuth', ['openai']);
      const waitForFlow = async predicate => {
        const deadline = Date.now() + 3000;
        let state;
        do {
          state = await rpc('getProviderOAuth', [id]);
          if (predicate(state) || state?.status !== 'pending') return state;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return state;
      };
      assert.deepEqual(await waitForFlow(state => state?.browserReady === true), { id, status: 'pending', browserReady: true });
      await rpc('cancelProviderOAuth', [id]);
      assert.deepEqual(await waitForFlow(state => state?.status === 'cancelled'), { id, status: 'cancelled' });
    } else {
      assert.equal((await rpc('startProviderOAuth', ['openai'], 400)).code, 'UNSUPPORTED_AUTH');
    }
    const endpoint = `http://127.0.0.1:${fixture.address().port}/v1`;
    const provider = await rpc('registerCompatibleEndpoint', [{ name: 'Bundle QA', endpoint, apiKey: fixtureKey }]);
    const profile = await rpc('saveModelProfile', [{ name: 'Bundle QA', provider: provider.id, modelId: 'bundle-fixture' }]);
    profileId = profile.id;
    await rpc('setAppModelProfile', [profileId]);
    projectId = (await rpc('createProject', [{name:'Bundle extension proof'}])).project.id;
    const extensions = await rpc('getExtensions', [projectId]);
    assert.equal(extensions.skills.length, 12);
    const invalid = await rpc('installPlugin', [projectId, {schemaVersion:1,id:'unsafe',command:'sh'},extensions.revision],400);
    assert.equal(invalid.code,'INVALID_EXTENSION');
    await rpc('setSkillEnabled', [projectId,'athena-scientific-figure',false,extensions.revision]);
    assert.equal((await rpc('getResearch',[projectId])).books.length,0);
  });
  const vaultPath = join(workspace, 'auth/credentials.v2.json');
  const vault = await readFile(vaultPath);
  const verifyPrivateVault = () => execFileSync(binary, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readPrivateCredentialFile } from './runtime/local-credential-files.ts';
    assert.equal(await readPrivateCredentialFile(process.argv[1], 'probe'), '');
  `, vaultPath], { cwd: host, env: environment, timeout: 20_000, stdio: 'inherit' });
  verifyPrivateVault();
  await withHost('abort-bootstrap');
  assert.ok(vault.equals(await readFile(vaultPath)), 'Interrupted bootstrap changed the existing vault.');
  verifyPrivateVault();
  await withHost(async rpc => {
    const profiles = await rpc('listModelProfiles');
    assert.equal(profiles.appDefaultProfileId, profileId);
    assert.equal(profiles.credentialMode, 'local_file');
    const restored = await rpc('verifyModelProfile', [profileId]);
    assert.deepEqual([restored.lastCheck.streaming, restored.lastCheck.tools], ['passed', 'passed']);
    const extensions = await rpc('getExtensions',[projectId]);
    assert.equal(extensions.skills.length,12);
    assert.equal(extensions.skills.find(skill=>skill.id==='athena-scientific-figure').enabled,false);
  });
  assert.equal(successfulRequests, 3);
  assert.ok(vault.equals(await readFile(vaultPath)), 'Authenticated restart changed the existing vault.');
  console.log(`Verified ${platform.target} ${macOS ? 'signed app bundle' : 'desktop payload'}, ChatGPT ${expectChatGPT ? 'local PKCE readiness' : 'disabled'}, measurement, RC and external HTTP MCP artifacts, 12 bundled skill hashes and selected-body loading, extension RPC and settings restore, Python and JavaScript artifact bytes, interrupted token-only bootstrap, preserved private local credentials and profile, and successful Pi streaming and tools after restart (isolated home).${!macOS && !mode ? ' The NSIS installer was built; installation must be checked separately on a clean Windows account.' : ''}`);
} finally {
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await rm(fixtureDirectory, { recursive: true, force: true });
}
