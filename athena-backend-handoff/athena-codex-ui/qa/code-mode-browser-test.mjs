import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createCodeModeFixture, request, subjects } from '../../../tests/support/code-mode-fixture.mjs';

const evidence = process.env.ATHENA_BROWSER_EVIDENCE || join(tmpdir(), 'athena-code-mode-browser');
const fixture = await createCodeModeFixture({allowGateFixture:true,responseDelayMs:100});
const checks = [], errors = [], streamFailures = [];
let browser, page;
await mkdir(evidence,{recursive:true});
try {
  browser = await chromium.launch({headless:true, ...(process.env.ATHENA_CHROMIUM ? {executablePath:process.env.ATHENA_CHROMIUM} : {})});
  page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname === '/api/events') streamFailures.push(request.failure()?.errorText);
  });
  if (process.env.ATHENA_CODE_MODE_BROWSER_DEBUG === '1') await page.addInitScript(() => {
    const native = window.EventSource;
    const records = window.__codeModeFeed = [];
    window.EventSource = class extends native {
      constructor(...args) {
        super(...args);
        records.push(['connect', args[0]]);
        this.addEventListener('open', () => records.push(['open']));
        this.addEventListener('error', () => records.push(['error', this.readyState]));
        this.addEventListener('message', event => {
          const value = JSON.parse(event.data);
          records.push([value.type,value.sequence,value.snapshot?.revision,value.snapshot?.run?.status]);
        });
      }
      close() { records.push(['close']); super.close(); }
    };
  });
  const screenshot = name => page.screenshot({path:join(evidence, name + '.png'),fullPage:true});
  const connected = () => page.waitForFunction(() => {
    const state = window.AthenaApp?.getState();
    return state?.workspace?.taskManagerConnected && state.piConnected && state.workspace.sessionBound !== false;
  });
  const send = async (message, attachments = []) => {
    if (attachments.length) await page.locator('.acm-file-input').setInputFiles(attachments);
    await page.locator('#ac-prompt-input').fill(message);
    await page.getByRole('button',{name:'Send message',exact:true}).click();
  };
  const attachments = subjects.map(subject => ({name:subject.name,mimeType:'text/csv',buffer:Buffer.from(subject.rows)}));
  const summaryRow = status => page.locator('details[data-aw-code-status="' + status + '"]').first();
  const showDetails = async row => {
    await row.waitFor({state:'visible'});
    const summary = row.locator(':scope > summary');
    if (!(await row.evaluate(node => node.open))) await summary.click();
  };
  const idle = () => page.waitForFunction(() => window.AthenaApp?.getState()?.busy === false);

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
  assert.equal(await success.locator('[data-aw-code-call]').count(),5);
  assert.equal(await success.locator('[data-aw-artifact]').count(),4);
  const result = await success.locator('[data-aw-code-result]').textContent();
  assert.match(result, /"meanMv": 10/);
  assert.match(result, /"deltaMv": 2/);
  assert.match(result, /voltage_mV.mean/);
  assert.ok(!(await success.innerText()).includes(comparison.id));
  await screenshot('code-mode-01-complete');
  checks.push('The composer ran the actual comparison and chat shows its summary and five separately recorded reads.');

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

  await send('Code-mode test: cancel',attachments);
  const running = summaryRow('running');
  await running.waitFor({state:'visible'});
  await page.waitForFunction(() => {
    const current = document.querySelector('[data-aw-code-status="running"] [data-aw-code-progress]');
    return current?.textContent.includes('reading') && current.textContent.includes('waiting');
  });
  await screenshot('code-mode-04-running');
  await page.getByRole('button',{name:'Stop response',exact:true}).click();
  const stopped = summaryRow('cancelled');
  await showDetails(stopped);
  assert.match(await stopped.locator('[data-aw-code-progress]').innerText(),/1 completed.*unfinished/);
  assert.ok(await stopped.locator('[data-status="not_dispatched"]').count());
  await screenshot('code-mode-05-stopped');
  const before = await fixture.waitSnapshot(snapshot => snapshot.run.status === 'cancelled');
  await idle();
  checks.push('Chat shows a running read and a queue. The Stop response button cancels active reads, discards pending reads and retains the completed board read.');

  await fixture.stopHost();
  await fixture.startHost();
  // Use the production reconnect handshake in the live tab, then reload from disk.
  await page.evaluate(() => window.AthenaHost.reconnect());
  await connected();
  await page.reload();
  await connected();
  await showDetails(stopped);
  assert.match(await stopped.locator('[data-aw-code-progress]').innerText(),/1 completed.*unfinished/);
  const restored = await fixture.rpc('getSnapshot');
  assert.deepEqual(restored.processes.filter(row => row.job.codeMode),before.processes.filter(row => row.job.codeMode));
  await screenshot('code-mode-06-reconnected');
  assert.deepEqual(errors,[]);
  checks.push('Browser reconnection and reload after host restart restore byte-for-byte comparison receipts.');
} catch (error) {
  if (page) {
    const state = await page.evaluate(() => {
      const app = window.AthenaApp?.getState();
      return {busy:app?.busy,run:app?.workspace?.run?.status, connected:app?.piConnected,
        connection:app?.workspace?.taskManagerConnected, status:document.querySelector('#ac-pi-session-status')?.textContent,
        codeRows:document.querySelectorAll('[data-aw-code-status]').length, feed:window.__codeModeFeed?.slice(-12), feedEvents:window.__codeModeFeed?.length};
    });
    console.error(JSON.stringify({state,errors,streamFailures}));
    await page.screenshot({path:join(evidence,'code-mode-failure.png'),fullPage:true});
  }
  throw error;
} finally {
  await writeFile(join(evidence,'code-mode-browser.json'), JSON.stringify({
    browser:browser?.version(), platform:process.platform, arch:process.arch,
    controlledProvider:true, realQuickJsAndArtifactReads:true, fixtureAnalysisGate:fixture.fixtureGate, checks, errors,
  },null,2) + '\n');
  await browser?.close();
  await fixture.close();
}
console.log(JSON.stringify({checks,evidence},null,2));
