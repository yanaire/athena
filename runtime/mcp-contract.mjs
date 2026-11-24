// Wire identities and public receipt fields shared by the host and bundled servers.
const common = { registryVersion: 1, protocol: '2025-06-18', version: '1.0.0' };
export const measurements = Object.freeze({ ...common, server: 'athena-measurements', displayName: 'Measurement statistics',
  tool: 'calculate_csv', alias: 'calculate_csv', resultKind: 'csv-statistics' });
export const circuits = Object.freeze({ ...common, server: 'athena-circuits', displayName: 'RC step response',
  tool: 'calculate_rc_response', alias: 'calculate_rc_response', resultKind: 'rc-step-response' });
