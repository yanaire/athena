/* Local wire fixture for browser QA. This is not the Athena host server. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
let failing = false;
let snapshot = { revision: 1, projectId: 'qa-project', sessionId: 'qa-session',
  projects: [{ id: 'qa-project', name: 'Hosted research' }],
  sessions: [{ id: 'qa-session', projectId: 'qa-project', title: 'Saved conversation' }],
  run: { id: null, status: 'ready', startedAt: null, elapsedMs: 0, model: null },
  tasks: [], agents: [], tools: [], artifacts: [], events: [], approvals: [] };
const configuration = { version: 1, provider: 'custom', endpoint: 'https://models.example/v1', defaultModel: 'pinned-model', roleModels: {}, parallelLimit: 1, contextBudget: 32768, outputBudget: 4096 };
const streams = new Set();
const history = new Map([['qa-session', [
  { id: 'saved-user', role: 'user', content: 'What did we establish in the previous session?' },
  { id: 'saved-assistant', role: 'assistant', content: [{ type: 'text', text: 'The saved conversation is restored from the host. New messages and attachments stay with this project.' }] }
]]]);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (url.pathname === '/__qa/failure') {
    failing = url.searchParams.get('enabled') === 'true';
    for (const stream of streams) stream.end();
    json({ failing }); return;
  }
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(': connected\n\n'); streams.add(response);
    request.on('close', () => streams.delete(response)); return;
  }
  if (url.pathname === '/api/bootstrap') {
    json(failing ? { error: 'QA injected bootstrap failure' } : { snapshot, connection: { status: 'configured', configuration }, capabilities: ['create_project', 'create_session', 'open_session'], piCapabilities: ['get_state', 'get_messages', 'prompt', 'abort', 'stage_files'] }, failing ? 503 : 200); return;
  }
  if (url.pathname === '/api/rpc') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { method, args } = JSON.parse(body);
    if (method === 'pi') {
      const [sessionId, command] = args;
      let data = {};
      if (command.type === 'get_state') data = { sessionId, sessionName: 'Saved conversation', isStreaming: false };
      if (command.type === 'get_messages') data = { messages: history.get(sessionId) || [] };
      if (command.type === 'prompt') { json({ error: 'QA injected send failure; draft was not accepted' }); return; }
      json({ result: { type: 'response', id: command.id, command: command.type, success: true, data } }); return;
    }
    if (method === 'createProject') {
      const project = { id: 'qa-created', name: args[0].name };
      snapshot = { ...snapshot, revision: snapshot.revision + 1, projectId: project.id, sessionId: null, projects: [...snapshot.projects, project] };
      json({ result: { project, snapshot } }); return;
    }
    json({ error: 'Unavailable in this browser QA fixture' }); return;
  }
  if (url.pathname === '/athena-host.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(fs.readFileSync(path.join(base, 'integrations/athena-host.js'))); return;
  }
  if (url.pathname === '/') {
    let html = fs.readFileSync(path.join(base, 'athena-preview.html'), 'utf8');
    if (url.searchParams.has('preinit')) html = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    html = html.replace('<head>', '<head><script>window.AthenaHosted=true;document.documentElement.dataset.athenaHosted="true";</script>');
    if (!url.searchParams.has('preinit')) html = html.replace('</body>', '<script src="/athena-host.js"></script></body>');
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return;
  }
  if (url.pathname === '/athena-preview.html') {
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(fs.readFileSync(path.join(base, 'athena-preview.html'))); return;
  }
  response.writeHead(404); response.end();
});
server.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + server.address().port));
