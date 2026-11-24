import { csvBinding } from './mcp-contract.mjs';
import { McpDataError as CsvDataError, serve } from './mcp-worker.mjs';

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 128;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

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

await serve(csvBinding, 'Summarize numeric measurements in the granted CSV.',
  (csv, args) => summary(csv, args.column),
  result => ({rowCount: result.rowCount}));
