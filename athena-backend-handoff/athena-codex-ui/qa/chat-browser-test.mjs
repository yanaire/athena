// Run: node qa/chat-browser-test.mjs (from the UI folder, after python3 build.py).
// Requires pinned Playwright + Chromium. ATHENA_BROWSER_EVIDENCE selects artifacts.
// --fixture-smoke checks the real host/provider fixture without claiming browser QA.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixture, inputs, prompts } from './chat-browser-fixture.mjs';

const require = createRequire(import.meta.url);
const smoke = process.argv.includes('--fixture-smoke');
const evidence = resolve(process.env.ATHENA_BROWSER_EVIDENCE || join(tmpdir(), 'athena-browser-evidence-' + randomUUID()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = await createFixture();
const checks = [], pageErrors = [], downloads = [];
let browser, page;
const report = { browser: !smoke, model: 'controlled compatible SSE provider', realChatGPTAccount: false,
  host: 'runtime/server.ts', workers: ['athena-measurements', 'athena-circuits'], checks, downloads, evidenceDirectory: evidence, screenshots: [], limitations: [
    'The model response is controlled. This does not verify real model reasoning, ChatGPT accounts, native macOS rendering, or two-account switching.',
    'Cancellation covers a streaming model response. The short MCP calculations are not cancelled in flight.',
  ] };

async function shot(name) {
  const file = name + '.png'; await page.screenshot({ path: join(evidence, file), fullPage: true }); report.screenshots.push(file);
}
async function connected() {
  await page.waitForFunction(() => {
    const state = window.AthenaApp?.getState();
    return state?.piConnected && state.workspace?.mode === 'runtime' && state.workspace.taskManagerConnected && state.workspace.sessionBound !== false;
  });
}
async function idle() { await page.waitForFunction(() => window.AthenaApp?.getState().busy === false); }
async function send(prompt, attachments = []) {
  if (attachments.length) await page.locator('.acm-file-input').setInputFiles(attachments);
  await page.locator('#ac-prompt-input').fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
function successful(snapshot) {
  assert.equal(snapshot.run.status, 'succeeded');
  assert.equal(snapshot.tasks.length, 3);
  assert.ok(snapshot.tasks.every(task => task.status === 'succeeded'));
  assert.equal(snapshot.processes.length, 2);
  assert.ok(snapshot.processes.every(process => process.status === 'succeeded'));
  assert.deepEqual(snapshot.artifacts.map(artifact => artifact.file.name).sort(), ['rc-response.json', 'statistics.json']);
}
async function verifyDownloads(snapshot, useBrowser) {
  for (const artifact of snapshot.artifacts) {
    let bytes;
    if (useBrowser) {
      await page.evaluate(id => window.AthenaApp.openWorkspace('artifacts', { artifactId: id }), artifact.id);
      await page.locator('[data-awv-artifact-view] a[download]').first().waitFor({ state: 'visible' });
      const transfer = page.waitForEvent('download');
      await page.locator('[data-awv-artifact-view] a[download]').first().click();
      const download = await transfer;
      const target = join(evidence, artifact.file.name); await download.saveAs(target); bytes = await readFile(target);
      await page.waitForFunction(name => {
        const body = document.querySelector('[data-awv-artifact-view]')?.innerText || '';
        return name === 'statistics.json' ? body.includes('19') : body.includes('0.001');
      }, artifact.file.name);
      await shot(artifact.file.name === 'statistics.json' ? '03-csv-artifact' : '04-rc-artifact');
    } else {
      const response = await fetch(fixture.origin + artifact.location.uri); assert.equal(response.ok, true); bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal(sha(bytes), artifact.file.sha256);
    assert.equal(bytes.length, artifact.file.bytes);
    const result = JSON.parse(bytes.toString('utf8'));
    if (artifact.file.name === 'statistics.json') {
      assert.equal(result.statistics[0].mean, 19); assert.equal(result.statistics[0].min, 7); assert.equal(result.statistics[0].max, 35);
    } else {
      assert.equal(result.timeConstantSeconds, 0.001); assert.ok(Math.abs(result.cutoffHz - 159.154943091895) < 1e-9);
      assert.equal(result.samples.length, 3);
    }
    downloads.push({ name: artifact.file.name, id: artifact.id, sha256: sha(bytes), bytes: bytes.length, via: useBrowser ? 'browser download' : 'host HTTP' });
  }
}
try {
  await mkdir(evidence, { recursive: true });
  const conversation = await fixture.createConversation();
  if (smoke) {
    const staged = await fixture.rpc('stageFiles', [conversation.sessionId, inputs.map(input => ({ name: input.name, mimeType: input.mimeType, data: input.buffer.toString('base64') }))]);
    await fixture.rpc('pi', [conversation.sessionId, { type: 'prompt', id: randomUUID(), message: prompts.compare, fileReferences: staged.fileReferences }]);
  } else {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true, reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(fixture.origin); await connected();
    await send(prompts.compare, inputs);
    await page.waitForFunction(() => window.AthenaApp.getState().busy && document.querySelector('#ac-pi-transcript')?.innerText.includes('I am delegating the two attached inputs.'));
    checks.push('User send and incremental assistant streaming are visible before the response finishes.');
    await shot('01-streaming-chat');
  }
  const result = await fixture.waitSnapshot(snapshot => ['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status));
  successful(result);
  checks.push('Two uploaded files retain their grants through parent delegation and real CSV/RC MCP execution.');
  if (!smoke) {
    await idle();
    const transcript = await page.locator('#ac-pi-transcript').innerText();
    assert.match(transcript, /Summarize voltage measurements/); assert.match(transcript, /Calculate the RC response/);
    assert.match(transcript, /Both calculations completed/);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"]').first().locator('.ac-message-attachment').allTextContents(), inputs.map(input => input.name));
    assert.equal(transcript.includes('Input attachment (never a result)'), false);
    for (const record of [...result.tasks, ...result.attempts, ...result.processes]) assert.equal(transcript.includes(record.id), false, 'Internal IDs must stay out of ordinary activity text.');
    const sequence = await page.locator('#ac-pi-transcript').evaluate(element => [...element.children].map(node => ({ role: node.dataset.role, attempt: node.dataset.awAttempt, text: node.innerText })));
    assert.ok(sequence.findIndex(row => row.attempt) > sequence.findIndex(row => row.role === 'user'));
    assert.ok(sequence.findIndex(row => row.attempt) < sequence.findIndex(row => row.text.includes('Both calculations completed.')));
    checks.push('Child activities stay with their originating turn, show real actions and do not expose internal IDs or attachment instructions.');
    await shot('02-completed-chat');
    await page.evaluate(() => window.AthenaApp.openWorkspace('workflow'));
    await page.locator('[data-awv-action="workflow-mode"][data-awv-value="graph"]').click();
    await page.locator('[data-awv-workflow-map]').waitFor({ state: 'visible' });
    assert.match(await page.locator('[data-awv-workflow-map]').innerText(), /Summarize voltage measurements/);
    assert.equal(await page.locator('[data-awg-node]').count(), result.tasks.length);
    const taskIds = new Set(result.tasks.map(task => task.id));
    const dependencyCount = result.tasks.reduce((count, task) => count + new Set((task.dependencies || []).filter(id => taskIds.has(id))).size, 0);
    assert.equal(await page.locator('[data-awg-edge="dependency"]').count(), dependencyCount);
    const worker = result.tasks.find(task => task.title === 'Summarize voltage measurements');
    assert.ok(worker);
    const node = page.locator('[data-awg-node] [data-awv-task="' + worker.id + '"]');
    await node.focus(); await node.press('Enter');
    await page.waitForFunction(title => document.querySelector('[data-awv-detail-heading]')?.innerText.includes(title), worker.title);
    await page.locator('[data-awv-action="graph-fit"]').click();
    const fitted = Number((await page.locator('[data-awg-zoom]').innerText()).replace('%', ''));
    await page.locator('[data-awv-action="graph-zoom-in"]').click();
    assert.ok(Number((await page.locator('[data-awg-zoom]').innerText()).replace('%', '')) > fitted);
    await page.locator('[data-awv-action="graph-fit"]').click();
    checks.push('The real workflow graph contains the recorded tasks and dependency edges; keyboard node selection and fit/zoom controls work.');
    await shot('05-workflow-graph');
    await page.setViewportSize({ width: 760, height: 900 });
    await shot('06-workflow-narrow');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await verifyDownloads(result, !smoke);
  checks.push(smoke ? 'Direct host HTTP downloads match both real MCP receipts and numerical expectations.'
    : 'The artifact table and browser download read the same saved JSON; downloaded SHA-256 matches both real MCP receipts.');
  if (!smoke) {
    await page.evaluate(() => window.AthenaApp.closePanel());
    const userText = 'Please preserve this identifier exactly: ' + result.tasks[0].id;
    await send(userText);
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('The requested identifier was preserved.'));
    await idle();
    assert.ok((await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents()).includes(userText));
    checks.push('An actual internal-looking identifier explicitly typed by the user is preserved verbatim.');

    // A rejected transport is explicitly injected; it is not counted as a host execution.
    const beforeReject = await fixture.rpc('getSnapshot');
    const rejectOnce = async route => {
      const body = route.request().postDataJSON();
      if (body.method === 'pi' && body.args[1]?.type === 'prompt') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected browser transport rejection.' }) });
      } else await route.continue();
    };
    await page.route('**/api/rpc', rejectOnce);
    await send(prompts.rejected);
    await page.waitForFunction(value => document.querySelector('#ac-prompt-input')?.value === value && !window.AthenaApp.getState().busy, prompts.rejected);
    assert.equal((await fixture.rpc('getSnapshot')).attempts.length, beforeReject.attempts.length);
    await page.unroute('**/api/rpc', rejectOnce);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('The preserved draft was accepted.'));
    await idle();
    await page.waitForFunction(value => [...document.querySelectorAll('#ac-pi-transcript [data-role="user"] .ac-stream-text')].filter(node => node.textContent === value).length === 1, prompts.rejected);
    checks.push('A deliberately rejected send restores the draft and creates no host attempt; resending reaches the real host.');

    await send(prompts.cancel);
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('Waiting for cancellation.'));
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await fixture.waitSnapshot(snapshot => snapshot.run.status === 'cancelled'); await idle();
    const stopped = await fixture.rpc('getSnapshot');
    assert.equal(stopped.artifacts.length, result.artifacts.length);
    assert.ok(result.artifacts.every(artifact => stopped.artifacts.some(saved => saved.id === artifact.id && saved.file.sha256 === artifact.file.sha256)));
    checks.push('Stop response cancels the live model stream while preserving earlier successful outputs.');
    await shot('07-cancelled-chat');

    const reconnectBootstrap = page.waitForResponse(response => response.url() === fixture.origin + '/api/bootstrap' && response.ok(), { timeout: 30000 });
    await fixture.stopHost(); await fixture.startHost();
    await reconnectBootstrap;
    await connected();
    await page.waitForFunction(() => window.AthenaApp.getState().workspace.run.status === 'cancelled');
    await page.reload(); await connected();
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('Both calculations completed.'));
    const restored = await fixture.rpc('getSnapshot');
    assert.deepEqual(restored.tasks.map(task => task.id), stopped.tasks.map(task => task.id));
    assert.deepEqual(restored.processes.map(process => process.id), stopped.processes.map(process => process.id));
    assert.deepEqual(restored.artifacts.map(artifact => [artifact.id, artifact.file.sha256]), stopped.artifacts.map(artifact => [artifact.id, artifact.file.sha256]));
    assert.ok((await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents()).includes(userText));
    assert.equal((await page.locator('#ac-pi-transcript').innerText()).includes('Input attachment (never a result)'), false);
    assert.equal((await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents()).filter(text => text === prompts.compare).length, 1);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"]').first().locator('.ac-message-attachment').allTextContents(), inputs.map(input => input.name));
    for (const artifact of restored.artifacts) {
      const response = await fetch(fixture.origin + artifact.location.uri);
      assert.equal(sha(Buffer.from(await response.arrayBuffer())), artifact.file.sha256);
    }
    await shot('08-restored-chat');
    checks.push('A real host restart reconnects and page reload restores the same tasks, processes, outputs, attachment badges and user messages without automatic re-execution.');

    await page.evaluate(() => window.AthenaApp.createResearch('Attachment-only message'));
    await connected();
    await send('', [inputs[0]]);
    await page.waitForFunction(() => document.querySelector('#ac-pi-transcript')?.innerText.includes('The preserved draft was accepted.'));
    await idle();
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents(), ['']);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-message-attachment').allTextContents(), ['measurements.csv']);
    await page.reload(); await connected();
    await page.locator('#ac-pi-transcript [data-role="user"] .ac-message-attachment').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-stream-text').allTextContents(), ['']);
    assert.deepEqual(await page.locator('#ac-pi-transcript [data-role="user"] .ac-message-attachment').allTextContents(), ['measurements.csv']);
    checks.push('An attachment-only send is accepted without inventing user text, and its file badge survives reload.');
    await shot('09-attachment-only-restored');
  }
  assert.deepEqual(fixture.failures, []); assert.deepEqual(pageErrors, []);
  report.status = 'passed'; report.providerRequests = fixture.calls.length;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); report.pageErrors = pageErrors; report.providerFailures = fixture.failures;
  if (page) await shot('failure').catch(() => {});
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
} finally {
  await browser?.close(); await fixture.close();
}
