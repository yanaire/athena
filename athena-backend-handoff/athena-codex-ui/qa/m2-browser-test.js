/* Run with Bun from the UI directory after python3 build.py. */
import assert from 'node:assert/strict';

const projectId = 'project-rc', sessionId = 'conversation', runId = 'run';
const scope = { projectId, sessionId, runId };
const child = { ...scope, taskId: 'child', parentTaskId: 'parent', agentSessionId: 'child-pi', attemptId: 'child-attempt' };
const parent = { ...scope, taskId: 'parent', parentTaskId: null, agentSessionId: 'main-pi', attemptId: 'main-attempt' };
const context = (ctx, title) => ({ ...ctx, id: ctx.taskId, title, status: 'running', dependencies: [], toolIds: [], artifactIds: [] });
const file = { ...scope, id: 'result', name: 'statistics.json', mimeType: 'application/json', bytes: 11, sha256: 'b'.repeat(64) };
const primaryTasks = [context(parent, 'Root research'), context(child, 'Analyze measurements')];
const artifactPath = '/api/artifacts/conversation/result';
let revision = 1, epoch = 'initial', sequence = 0, runStatus = 'running', tasks = primaryTasks;
const clients = new Set(), frames = [];
const connection = { status: 'not_configured' };
const snapshot = () => ({
  revision, projectId, sessionId, projects: [{ id: projectId, name: 'Measurements' }],
  sessions: [{ id: sessionId, projectId, title: 'Saved research' }], run: { id: runId, status: runStatus }, tasks,
  agents: [parent, child].map((ctx, i) => ({ ...ctx, id: ctx.agentSessionId, name: i ? 'Statistics worker' : 'Coordinator', role: i ? 'analyst' : 'main', status: 'running' })),
  attempts: [{ ...child, id: 'earlier-attempt', status: 'failed' }, { ...child, id: child.attemptId, status: 'running' }],
  processes: [{ ...child, id: 'process-record', processId: 'process-id', toolId: 'tool', status: 'succeeded', program: 'csv-worker', args: [], stdout: 'Rows counted: 17', stderr: '', exitCode: 0, artifact: file }],
  artifacts: [{ ...child, ...file, artifactId: file.id, version: file.sha256, kind: 'json', title: file.name, processId: 'process-id', toolId: 'tool' }],
  tools: [], approvals: [], events: []
});
const encoder = new TextEncoder();
const json = value => Response.json(value);
function publish() {
  const data = { type: 'snapshot', snapshot: snapshot(), epoch, sequence: ++sequence };
  const frame = encoder.encode('id: ' + epoch + ':' + sequence + '\ndata: ' + JSON.stringify(data) + '\n\n');
  frames.push(frame);
  for (const client of clients) client.enqueue(frame);
}
const html = (await Bun.file('athena-preview.html').text()).replace('</body>', '<script src="/athena-host.js"></script></body>');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/athena-host.js') return new Response(Bun.file('integrations/athena-host.js'), { headers: { 'Content-Type': 'text/javascript' } });
  if (url.pathname === artifactPath) return json({ rows: 17 });
  if (url.pathname === '/api/bootstrap') return json({ snapshot: snapshot(), connection, capabilities: ['cancel_run', 'cancel_task', 'get_agent_history'], piCapabilities: ['get_state', 'get_messages'], cursor: { epoch, sequence } });
  if (url.pathname === '/api/events') {
    const headers = { 'Content-Type': 'text/event-stream' };
    const requested = url.searchParams.get('epoch');
    if (requested && requested !== epoch) return new Response('data: ' + JSON.stringify({ type: 'reset', epoch, sequence }) + '\n\n', { headers });
    const last = request.headers.get('last-event-id')?.split(':');
    const after = Number(last?.[1] ?? url.searchParams.get('after'));
    let controller;
    return new Response(new ReadableStream({ start(c) {
      controller = c; clients.add(c); c.enqueue(encoder.encode(': connected\n\n'));
      if (requested) for (const frame of frames.slice(after)) c.enqueue(frame);
    }, cancel() { clients.delete(controller); } }), { headers });
  }
  if (url.pathname !== '/api/rpc') return new Response(null, { status: 404 });
  const { method, args } = await request.json();
  if (method === 'pi') {
    const [boundSession, command] = args;
    if (boundSession !== sessionId) return json({ error: 'Wrong conversation' });
    const data = command.type === 'get_messages' ? { messages: [{ role: 'assistant', content: 'Main conversation ' + epoch }] } : { sessionId };
    return json({ result: { type: 'response', command: command.type, id: command.id, success: true, data } });
  }
  if (method === 'getAgentHistory' && args[0] === sessionId && [parent.agentSessionId, child.agentSessionId].includes(args[1])) {
    const content = (args[1] === child.agentSessionId ? 'Worker-only history ' : 'Coordinator-only history ') + epoch;
    return json({ result: { conversationId: sessionId, agentSessionId: args[1], messages: [{ role: 'assistant', content }] } });
  }
  if (method === 'cancelTask' && args[0] === 'child') tasks = tasks.map(task => task.id === 'child' ? { ...task, status: 'cancelled' } : task);
  else if (method === 'cancelRun' && args[0] === runId) runStatus = 'cancelled';
  else return json({ error: 'Wrong scope or unsupported method' });
  revision++; publish(); return json({ result: { cancellationRequested: true } });
} });

const width = Number(process.env.ATHENA_BROWSER_WIDTH || 1440);
const page = new Bun.WebView({ width, height: 900 });
const query = (selector, expression) => page.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); return ' + expression + '; })()');
const click = async (selector, evidenceName) => {
  await query(selector, "el.scrollIntoView({ block: 'center', behavior: 'instant' })");
  const target = await query(selector, `(() => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit?.closest('button') === el;
  })()`);
  if (evidenceName) await screenshot(evidenceName);
  assert.equal(target, true, selector + ' reaches the viewport and is not covered');
  await query(selector, 'el.click()');
};
const visibleText = (selector, text) => page.evaluate(`new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Never displayed ' + ${JSON.stringify(text)})); }, 5000);
  const found = () => { if (document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(text)})) { clearTimeout(timeout); observer.disconnect(); resolve(true); } };
  const observer = new MutationObserver(found); observer.observe(document.body, { childList: true, attributes: true, subtree: true, characterData: true }); found();
})`);
async function screenshot(name) {
  if (process.env.ATHENA_BROWSER_EVIDENCE) await Bun.write(process.env.ATHENA_BROWSER_EVIDENCE + '/' + name + '-' + width + '-after.png', await page.screenshot());
}
try {
  await page.navigate(server.url.href);
  await visibleText('#ac-pi-transcript', 'Main conversation initial');
  if (width <= 760) await click('#ac-sidebar-collapse');
  await page.evaluate("AthenaApp.openWorkspace('knowledge')");
  assert.equal(await query('#ac-knowledge-slot', "el.innerText.includes('RC low-pass')"), false);

  await page.evaluate("AthenaApp.openWorkspace('workflow', {taskId:'child'})");
  await visibleText('[data-awv-task-detail]', 'earlier-attempt');
  assert.match(await query('[data-awv-task-detail]', 'el.innerText'), /Root research[\s\S]*child-attempt[\s\S]*csv-worker/);
  await screenshot('workflow');
  await click('[data-awv-open-process]');
  await visibleText('[data-aw-process][open]', 'Rows counted: 17');
  assert.equal(await query('[data-aw-process] a[download]', 'el.getAttribute("href")'), artifactPath);
  await screenshot('execution');
  await page.evaluate("AthenaApp.openWorkspace('artifacts', {artifactId:'result'})");
  const href = await query('[data-awv-artifact-view] a[download]', 'el?.href');
  assert.deepEqual(await (await fetch(href)).json(), { rows: 17 });
  await screenshot('artifacts');

  await page.evaluate("AthenaApp.openWorkspace('workflow', {taskId:'child'})");
  await click('[data-awv-cancel-task]');
  await visibleText('[data-awv-task-detail]', 'Cancelled');
  assert.match(await query('[data-awv-task="parent"]', 'el.innerText'), /Running/);
  // A reconnect notice can overlap this control in the narrow viewport.
  await page.evaluate("AthenaApp.reportHostError('The event stream was interrupted. Reconnecting…')");
  await visibleText('#ac-toast:not([hidden])', 'Reconnecting…');
  await click('[data-awv-action="cancel-run"]', 'cancel-run');
  await visibleText('[data-awv-run-status]', 'Cancelled');

  await page.evaluate("AthenaApp.openAgents('child-pi')");
  await visibleText('[data-awv-agent-messages]', 'Worker-only history initial');
  assert.equal(await query('#ac-pi-transcript', "el.innerText.includes('Worker-only')"), false);
  await screenshot('timeline');
  await page.evaluate(`(() => { const select = document.querySelector('[data-awv-agent-select]'); select.value = 'main-pi'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await visibleText('[data-awv-agent-messages]', 'Coordinator-only history initial');
  assert.equal(await query('[data-awv-agent-messages]', "el.innerText.includes('Worker-only')"), false);

  // Reconnect to the same epoch and receive a missed event from the cursor.
  for (const client of clients) client.close(); clients.clear();
  tasks = tasks.map(task => task.id === 'parent' ? { ...task, title: 'Replayed task title' } : task);
  revision++; publish();
  await page.evaluate("(() => { AthenaHost.reconnect(); AthenaApp.openWorkspace('workflow', {taskId:'parent'}); })()");
  await visibleText('[data-awv-task-detail]', 'Replayed task title');

  // A restarted host can reset revisions and the event cursor; both histories rehydrate.
  await page.evaluate("AthenaApp.openAgents('child-pi')");
  epoch = 'restarted'; revision = 1; sequence = 0; frames.length = 0;
  for (const client of clients) client.close(); clients.clear();
  await page.evaluate('AthenaHost.reconnect()');
  await visibleText('#ac-pi-transcript', 'Main conversation restarted');
  await visibleText('[data-awv-agent-messages]', 'Worker-only history restarted');
  assert.equal(await query('[data-awv-agent-messages]', "el.innerText.includes('initial')"), false);
  console.log('PASS: hosted navigation, cancellation, downloads, cursor replay and reset');
} finally {
  page.close(); server.stop(true);
}
