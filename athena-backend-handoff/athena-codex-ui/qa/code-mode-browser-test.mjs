import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createCodeModeFixture, request, subjects } from '../../../tests/support/code-mode-fixture.mjs';

const evidence = process.env.ATHENA_BROWSER_EVIDENCE || join(tmpdir(), 'athena-code-mode-browser');
const fixture = await createCodeModeFixture({allowGateFixture:true,browser:true});
const checks = [], errors = [], streamFailures = [];
let liveProgress;
let browser, page;
await mkdir(evidence,{recursive:true});
try {
  browser = await chromium.launch({headless:true, ...(process.env.ATHENA_CHROMIUM ? {executablePath:process.env.ATHENA_CHROMIUM} : {})});
  page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.setDefaultTimeout(50_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname === '/api/events') streamFailures.push(request.failure()?.errorText);
  });
  const screenshot = name => page.screenshot({path:join(evidence, name + '.png'),fullPage:true});
  const connected = () => page.waitForFunction(() => {
    const state = window.AthenaApp?.getState();
    return state?.workspace?.taskManagerConnected && state.piConnected && state.workspace.sessionBound !== false;
  }, null, {polling:200});
  const send = async (message, attachments = []) => {
    if (attachments.length) await page.locator('.acm-file-input').setInputFiles(attachments);
    await page.locator('#ac-prompt-input').fill(message);
    await page.getByRole('button',{name:'Send message',exact:true}).click();
  };
  const attachments = [subjects[0], subjects[2], subjects[3]]
    .map(subject => ({name:subject.name,mimeType:'text/csv',buffer:Buffer.from(subject.rows)}));
  const summaryRow = status => page.locator('details[data-aw-code-status="' + status + '"]').first();
  const showDetails = async row => {
    await row.waitFor({state:'visible'});
    const summary = row.locator(':scope > summary');
    if (!(await row.evaluate(node => node.open))) await summary.click();
  };
  const idle = () => page.getByRole('button',{name:'Stop response',exact:true}).waitFor({state:'hidden'});

  await fixture.conversation();
  await page.goto(fixture.origin);
  await connected();
  await send(request, attachments);
  const saved = await fixture.waitSnapshot(snapshot => snapshot.run.status === 'succeeded');
  const comparison = saved.processes.find(row => row.job.codeMode);
  assert.ok(comparison);
  await idle();
  const success = summaryRow('succeeded');
  await showDetails(success);
  assert.equal(await success.locator('[data-aw-code-call]').count(),4);
  assert.equal(await success.locator('[data-aw-artifact]').count(),3);
  const result = await success.locator('[data-aw-code-result]').textContent();
  assert.match(result, /"meanMv": 10/);
  assert.match(result, /"deltaMv": 2/);
  assert.match(result, /voltage_mV.mean/);
  assert.ok(!(await success.innerText()).includes(comparison.id));
  await screenshot('code-mode-01-complete');
  checks.push('The composer ran the actual comparison and chat shows its summary and four separately recorded reads.');

  await success.locator('[data-aw-artifact]').first().click();
  await page.locator('[data-awv-artifact-view] a[download]').first().waitFor({state:'visible'});
  await page.evaluate(() => window.AthenaApp.openWorkspace('workflow'));
  await page.locator('[data-awv-action="workflow-mode"][data-awv-value="graph"]').click();
  const graphProcess = page.locator('[data-awv-workflow-map] [data-awv-open-process="' + comparison.id + '"]');
  await graphProcess.waitFor({state:'visible'});
  assert.match(await graphProcess.innerText(),/Research comparison\s+Complete/);
  await screenshot('code-mode-02-workflow');
  await graphProcess.click();
  await showDetails(success);
  checks.push('Verified source buttons open Artifacts and the Workflow graph opens the same comparison receipt.');

  await fixture.conversation();
  await page.reload();
  await connected();
  await send('Code-mode test: syntax');
  const failure = summaryRow('failed');
  await showDetails(failure);
  assert.match(await failure.locator('[data-aw-code-error]').innerText(),/could not be parsed/);
  assert.equal(await failure.locator('[data-aw-code-call]').count(),0);
  await screenshot('code-mode-03-syntax-error');
  await idle();
  checks.push('A real parser error displays without any fabricated read calls.');

  await fixture.conversation();
  await page.reload();
  await connected();
  // Observe the live DOM before sending. Transient progress can appear between
  // Playwright's locator polls while the host still has an active read.
  await page.evaluate(() => {
    window.codeModeTestProgress = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        const progress = document.querySelector('[data-aw-code-status="running"] [data-aw-code-progress]');
        const value = progress?.textContent || '';
        if (!progress?.getClientRects().length || !value.includes('reading') || !value.includes('waiting')) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      });
      const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, 30_000);
      observer.observe(document.body, {childList:true,subtree:true,attributes:true,characterData:true});
    });
  });
  await send('Code-mode test: cancel',attachments.slice(0,1));
  await page.waitForFunction(() => [...document.querySelectorAll('.aw-agent-name')]
    .filter(node => node.textContent.startsWith('Read tools found')).length >= 2, null, {polling:200});
  fixture.releaseCode();
  await fixture.waitSnapshot(snapshot => snapshot.processes.some(row => row.job.codeMode?.calls.some(call => call.status === 'running')
    && row.job.codeMode.calls.some(call => call.status === 'queued')));
  // Let the running snapshot enter the event feed before clicking Stop.
  await delay(175);
  await page.getByRole('button',{name:'Stop response',exact:true}).click({force:true,timeout:4_000});
  liveProgress = await page.evaluate(() => window.codeModeTestProgress);
  assert.match(liveProgress || '',/reading.*waiting/);
  const stopped = summaryRow('cancelled');
  await showDetails(stopped);
  assert.match(await stopped.locator('[data-aw-code-progress]').innerText(),/[1-4] completed.*unfinished/);
  assert.ok(await stopped.locator('[data-status="not_dispatched"]').count());
  await screenshot('code-mode-05-stopped');
  const before = await fixture.waitSnapshot(snapshot => snapshot.run.status === 'cancelled');
  await idle();
  checks.push('Chat shows a running read and a queue. The Stop response button stops active reads, discards pending reads and retains the completed board read.');

  const rehydration = await page.evaluate(() => window.AthenaApp.getState().workspace.hydration);
  const bootstrap = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap' && response.ok());
  await fixture.stopHost();
  await fixture.startHost();
  // Use the production reconnect handshake in the live tab, then reload from disk.
  await page.evaluate(() => window.AthenaHost.reconnect());
  await bootstrap;
  await connected();
  await page.waitForFunction(prior => window.AthenaApp.getState().workspace.hydration > prior, rehydration, {polling:200});
  await page.reload();
  await connected();
  await showDetails(stopped);
  assert.match(await stopped.locator('[data-aw-code-progress]').innerText(),/[1-4] completed.*unfinished/);
  const restored = await fixture.rpc('getSnapshot');
  assert.equal(JSON.stringify(restored.processes.filter(row => row.job.codeMode)),JSON.stringify(before.processes.filter(row => row.job.codeMode)));
  await screenshot('code-mode-06-reconnected');
  assert.deepEqual(errors,[]);
  checks.push('Browser reconnection and reload after host restart restore byte-for-byte comparison receipts.');
} catch (error) {
  if (page) {
    const state = await page.evaluate(() => {
      const app = window.AthenaApp?.getState();
      return {busy:app?.busy,run:app?.workspace?.run?.status, connected:app?.piConnected,
        connection:app?.workspace?.taskManagerConnected, status:document.querySelector('#ac-pi-session-status')?.textContent,
        codeRows:document.querySelectorAll('[data-aw-code-status]').length};
    });
    const saved = await fixture.rpc('getSnapshot').catch(() => null);
    const processes = saved?.processes.filter(row => row.job.codeMode).map(row => ({status:row.status, startedAt:row.job.startedAt, endedAt:row.job.endedAt,
      calls:row.job.codeMode.calls.map(call => call.status)}));
    console.error(JSON.stringify({state,processes,errors,streamFailures}));
    await page.screenshot({path:join(evidence,'code-mode-failure.png'),fullPage:true});
  }
  throw error;
} finally {
  await writeFile(join(evidence,'code-mode-browser.json'), JSON.stringify({
    browser:browser?.version(), platform:process.platform, arch:process.arch,
    controlledProvider:true, realQuickJsAndArtifactReads:true, fixtureAnalysisGate:fixture.fixtureGate, liveProgress, checks, errors,
  },null,2) + '\n');
  await browser?.close();
  await fixture.close();
}
console.log(JSON.stringify({checks,evidence},null,2));
