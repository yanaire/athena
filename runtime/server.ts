import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Connections, object } from './connections.ts';
import { TaskManager } from './manager.ts';
import { WorkspaceFeed } from './feed.ts';

const directory = resolve(process.env.ATHENA_DATA_DIR || join(homedir(), '.athena', 'workspace'));
const port = Number(process.env.ATHENA_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid ATHENA_PORT.');
const modelId = process.env.ATHENA_MODEL?.trim();
if (!modelId || !process.env.ATHENA_ENDPOINT) throw new Error('Set ATHENA_ENDPOINT and ATHENA_MODEL to your model server (see README).');
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
// OS-owned lock, also released on process death. Two hosts must not recover/dispatch in the same workspace.
const lock = new DatabaseSync(join(directory, 'host.lock.sqlite'));
try { lock.exec('BEGIN EXCLUSIVE'); } catch { throw new Error('This Athena data directory is in use by another host.'); }
const connections = new Connections(directory, process.env.ATHENA_ENDPOINT, { provider: 'athena', modelId }, process.env.ATHENA_API_KEY);
const manager = new TaskManager({ dataDir: directory });
await manager.initialize();
const web = new URL('../athena-backend-handoff/athena-codex-ui/', import.meta.url);
const html = (await readFile(new URL('athena-preview.html', web), 'utf8')).replace('</body>', '<script src="/athena-host.js"></script></body>');
const bridge = await readFile(new URL('integrations/athena-host.js', web));
const streams = new Set<ServerResponse>();
const feed = new WorkspaceFeed();
function publish(event: object) {
  const frame = feed.append(event);
  for (const client of streams) {
    if (client.writableLength > 4 * 1024 * 1024) client.destroy(); // reconnect and hydrate from disk
    else client.write(frame);
  }
}
manager.subscribe(snapshot => publish({ type: 'snapshot', snapshot }));
manager.subscribeAllPi((sessionId, event) => publish({ type: 'pi', sessionId, event }));

function string(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected a nonempty string.');
  return value;
}
function model(value: unknown) {
  if (value == null) return null;
  if (!object(value) || value.provider !== connections.model.provider || value.modelId !== modelId || (value.thinkingLevel && value.thinkingLevel !== 'off')) throw new TypeError('This host does not support the requested model or reasoning level.');
  return connections.model;
}
async function rpc(method: string, args: unknown[]) {
  const [input, second] = args;
  switch (method) {
    case 'createProject':
      if (!object(input)) throw new TypeError('Expected project.');
      return manager.createProject({ name: string(input.name), defaultModel: model(input.defaultModel) });
    case 'createSession': {
      if (!object(input)) throw new TypeError('Expected conversation.');
      if (input.configurationId != null && input.configurationId !== connections.getState().configurationId) throw new TypeError('The model settings have changed.');
      return manager.createSession({ projectId: string(input.projectId), title: string(input.title ?? 'New research'), model: model(input.model) });
    }
    case 'openSession': return manager.openSession(string(input));
    case 'getAgentHistory': return manager.getAgentHistory(string(input), string(second));
    case 'cancelTask': return manager.cancelTask(string(input));
    case 'cancelRun': return manager.cancelRun(string(input));
    case 'setProjectDefaultModel': return manager.setProjectDefaultModel(string(input), model(second));
    case 'pi': {
      if (!object(second) || typeof second.type !== 'string') throw new TypeError('Expected a Pi command.');
      return manager.pi(string(input), { ...second, type: second.type, ...(typeof second.id === 'string' ? { id: second.id } : {}) });
    }
    case 'stageFiles': {
      if (!Array.isArray(second)) throw new TypeError('Expected files.');
      return manager.stageFiles(string(input), second.map(item => {
        if (!object(item) || typeof item.data !== 'string' || typeof item.mimeType !== 'string') throw new TypeError('Malformed file.');
        return { name: string(item.name), mimeType: item.mimeType, data: item.data };
      }));
    }
    case 'verifyConnection': case 'saveConfig': {
      const result = method === 'verifyConnection' ? await connections.verifyConnection(input) : connections.saveConfig(input);
      publish({ type: 'connection', connection: connections.getState() });
      return result;
    }
    default: throw new TypeError('Unsupported host operation.');
  }
}

async function jsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new RangeError('Request exceeds 16 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const json = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const host = `127.0.0.1:${req.socket.localPort}`;
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: 'Local same-origin requests only.' }); return; }
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const artifact = /^\/api\/artifacts\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
      if (artifact?.[1] && artifact[2]) {
        const { bytes, name } = await manager.artifactDownload(artifact[1], artifact[2]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }).end(bytes);
        return;
      }
      switch (url.pathname) {
        case '/': res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return;
        case '/athena-host.js': res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(bridge); return;
        case '/favicon.ico': res.writeHead(204).end(); return;
        case '/api/bootstrap': json(200, { snapshot: manager.getSnapshot(), cursor: feed.cursor, connection: connections.getState(), capabilities: manager.capabilities, piCapabilities: manager.piCapabilities, inputContract: manager.inputContract }); return;
        case '/api/events': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          const last = req.headers['last-event-id'];
          const parts = typeof last === 'string' ? last.split(':') : null;
          if (parts || url.searchParams.has('epoch') || url.searchParams.has('after')) {
            const frames = feed.replay(parts ? parts[0] ?? null : url.searchParams.get('epoch'), parts ? parts[1] ?? null : url.searchParams.get('after'));
            if (!frames) { res.end(`data: ${JSON.stringify({ type: 'reset', ...feed.cursor })}\n\n`); return; }
            for (const frame of frames) res.write(frame);
          }
          streams.add(res); res.write(': subscribed\n\n');
          const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
          res.on('close', () => { clearInterval(timer); streams.delete(res); });
          return;
        }
      }
    }
    if (req.method === 'POST' && req.url === '/api/rpc') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(415, { error: 'Expected application/json.' }); return; }
      const body = await jsonBody(req);
      if (!object(body) || typeof body.method !== 'string' || !Array.isArray(body.args)) throw new TypeError('Expected {method,args}.');
      json(200, { result: await rpc(body.method, body.args) }); return;
    }
    json(404, { error: 'Not found.' });
  } catch (error) {
    json(error instanceof RangeError ? 413 : 400, { error: error instanceof Error ? error.message : 'Request failed.' });
  }
});
server.requestTimeout = 30000;
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Athena listening at http://127.0.0.1:${address.port}`);
});
async function stop() {
  for (const stream of streams) stream.end();
  server.close();
  await manager.close(); connections.close(); lock.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
