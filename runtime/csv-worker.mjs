import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { constants, closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';

// This worker accepts data only. It never imports from a request, opens a
// socket, starts another process, or interprets any CSV cell as code.
const MAX_INPUT = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 128;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

class CsvDataError extends Error {}

function input() {
  const fd = openSync('input.csv', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < 1 || st.size > MAX_INPUT) throw new CsvDataError('CSV input size is invalid.');
    const data = Buffer.allocUnsafe(MAX_INPUT + 1);
    let size = 0;
    while (size < data.length) {
      const n = readSync(fd, data, size, data.length - size, size);
      if (!n) break;
      size += n;
    }
    if (size !== st.size) throw new CsvDataError('CSV input changed during reading.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new CsvDataError('CSV must be valid UTF-8.');
    }
  } finally {
    closeSync(fd);
  }
}

/** Yield one record at a time; retain no previously parsed rows. */
function* records(csv) {
  let row = [];
  let field = '';
  let state = 'field_start';
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '\0') throw new CsvDataError('CSV cannot contain a NUL character.');
    if (state === 'quoted') {
      if (char === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        state = 'after_quote';
      } else {
        field += char;
      }
      continue;
    }
    if (char === ',' || char === '\r' || char === '\n') {
      row.push(field);
      if (row.length > MAX_COLUMNS) throw new CsvDataError('CSV has too many columns.');
      field = '';
      state = 'field_start';
      if (char !== ',') {
        if (char === '\r' && csv[i + 1] === '\n') i++;
        yield row;
        row = [];
      }
    } else if (state === 'after_quote') {
      throw new CsvDataError('Unexpected character after a quoted CSV field.');
    } else if (char === '"') {
      if (state !== 'field_start') throw new CsvDataError('Unexpected quote in an unquoted CSV field.');
      state = 'quoted';
    } else {
      field += char;
      state = 'unquoted';
    }
  }
  if (state === 'quoted') throw new CsvDataError('Unclosed quoted CSV field.');
  if (row.length || state !== 'field_start') {
    row.push(field);
    if (row.length > MAX_COLUMNS) throw new CsvDataError('CSV has too many columns.');
    yield row;
  }
}

function summary(csv, column) {
  const rows = records(csv);
  const { value: columns } = rows.next();
  if (!columns || columns.some(name => !name.trim() || Buffer.byteLength(name) > 256) || new Set(columns).size !== columns.length) {
    throw new CsvDataError('CSV requires nonblank, unique header names of at most 256 bytes.');
  }
  if (column !== undefined && !columns.includes(column)) throw new CsvDataError('Requested CSV column does not exist.');
  let rowCount = 0;
  const statistics = columns.flatMap((name, index) => column === undefined || column === name ? [{
    column: name, index, count: 0, missing: 0, nonNumeric: 0, min: null, max: null, mean: null,
  }] : []);
  for (const row of rows) {
    if (++rowCount > MAX_ROWS) throw new CsvDataError('CSV has too many rows.');
    if (row.length !== columns.length) throw new CsvDataError('CSV row width does not match its header.');
    for (const stat of statistics) {
      const field = row[stat.index].trim();
      if (!field) { stat.missing++; continue; }
      const value = DECIMAL.test(field) ? Number(field) : NaN;
      if (!Number.isFinite(value)) { stat.nonNumeric++; continue; }
      stat.count++;
      if (stat.mean === null) {
        stat.min = value;
        stat.max = value;
        stat.mean = value;
        continue;
      }
      stat.min = Math.min(stat.min, value);
      stat.max = Math.max(stat.max, value);
      // For opposite signs, avoid an overflowing difference. Each term
      // remains finite and has opposite sign, so their sum cannot overflow.
      stat.mean = Math.sign(stat.mean) === Math.sign(value)
        ? stat.mean + (value - stat.mean) / stat.count
        : stat.mean * ((stat.count - 1) / stat.count) + value / stat.count;
    }
  }
  return { schemaVersion: 1, rowCount, columns, statistics: statistics.map(({ index: _, ...stat }) => stat) };
}

// Athena measurement MCP server 1.0.0, stdio transport (2025-06-18).
// Each server has one host-granted input and one write-once output.
const version = '2025-06-18';
const tool = { name: 'calculate_csv', description: 'Summarize numeric measurements in the granted CSV.',
  inputSchema: { type: 'object', properties: { column: { type: 'string', minLength: 1, maxLength: 256 } }, additionalProperties: false } };
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let phase = 'new';
function dispatch(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    send({ id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const { method, params = {}, id } = msg;
  if (id === undefined) {
    if (method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
    return;
  }
  const fail = (code, message) => send({ id, error: { code, message } });
  const reply = result => send({ id, result });
  if (method === 'ping') return reply({});
  if (method === 'initialize' && phase === 'new') {
    phase = 'initializing';
    return reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'athena-measurements', version: '1.0.0' } });
  }
  if (phase !== 'ready') return fail(-32600, 'Measurement server is not initialized.');
  if (method === 'tools/list') return reply({ tools: [tool] });
  if (method !== 'tools/call') return fail(-32601, 'Method not found');
  const args = params?.arguments ?? {};
  if (params?.name !== tool.name || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'column')
    || (args.column !== undefined && (typeof args.column !== 'string' || !args.column.length || Buffer.byteLength(args.column) > 256))) {
    return fail(-32602, 'Invalid measurement tool or arguments.');
  }
  try {
    const result = summary(input(), args.column);
    const json = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(json) > MAX_OUTPUT) throw new CsvDataError('CSV statistics exceed the artifact size limit.');
    writeFileSync('statistics.json', json, { flag: 'wx', mode: 0o400 });
    const receipt = { filename: 'statistics.json', rowCount: result.rowCount, sha256: createHash('sha256').update(json).digest('hex') };
    return reply({ content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt });
  } catch (error) {
    const message = error instanceof CsvDataError ? error.message : 'Could not read the granted input or write the result.';
    return reply({ isError: true, content: [{ type: 'text', text: message }] });
  }
}
process.umask(0o077);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let msg;
  try { msg = JSON.parse(line); }
  catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  dispatch(msg);
}
