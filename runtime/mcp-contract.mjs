// Wire identities and public receipt fields shared by the host and bundled servers.
const common = { registryVersion: 1, protocol: '2025-06-18', version: '1.0.0' };
export const measurements = Object.freeze({ ...common, server: 'athena-measurements', displayName: 'Measurement statistics',
  tool: 'calculate_csv', alias: 'calculate_csv', resultKind: 'csv-statistics' });
export const circuits = Object.freeze({ ...common, server: 'athena-circuits', displayName: 'RC step response',
  tool: 'calculate_rc_response', alias: 'calculate_rc_response', resultKind: 'rc-step-response' });

export const csvBinding = Object.freeze({
  validArgs(args) {
    return Object.keys(args).every(key => key === 'column') && (args.column === undefined ||
      (typeof args.column === 'string' && args.column.trim().length > 0 && !args.column.includes('\0') && Buffer.byteLength(args.column) <= 256));
  },
  identity: measurements, worker: 'csv-worker.mjs', inputName: 'input.csv', inputBytes: 1024 * 1024,
  outputName: 'statistics.json', outputBytes: 64 * 1024, mimeType: 'application/json',
  inputSchema: { type: 'object', properties: { column: { type: 'string', minLength: 1, maxLength: 256 } }, additionalProperties: false },
});
export const rcBinding = Object.freeze({
  validArgs: args => Object.keys(args).length === 0,
  identity: circuits, worker: 'rc-worker.mjs', inputName: 'input.json', inputBytes: 64 * 1024,
  outputName: 'rc-response.json', outputBytes: 64 * 1024, mimeType: 'application/json',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});
export const maxRcSamples = 512;
