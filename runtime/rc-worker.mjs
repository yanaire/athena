import { maxRcSamples, rcBinding } from './mcp-contract.mjs';
import { McpDataError, serve } from './mcp-worker.mjs';

function calculate(text) {
  let input;
  try { input = JSON.parse(text); } catch { throw new McpDataError('Invalid RC input JSON.'); }
  const fields = ['schemaVersion', 'resistanceOhm', 'capacitanceFarad', 'inputVolt', 'sampleTimesSeconds'];
  if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !fields.includes(key))) {
    throw new McpDataError('Expected a version 1 RC input object.');
  }
  const {resistanceOhm: r, capacitanceFarad: c, inputVolt, sampleTimesSeconds: times} = input;
  if (![r, c].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(inputVolt)
    || !Array.isArray(times) || !times.length || times.length > maxRcSamples ||
    !times.every(value => Number.isFinite(value) && value >= 0)) {
    throw new McpDataError('Invalid RC components, step voltage or sample times.');
  }
  const timeConstantSeconds = r * c;
  const cutoffHz = (0.5 / Math.PI) / timeConstantSeconds;
  if (![timeConstantSeconds, cutoffHz].every(value => Number.isFinite(value) && value > 0)) {
    throw new McpDataError('RC time constant or cutoff is outside the numeric range.');
  }
  const samples = times.map(timeSeconds => {
    const ratio = timeSeconds / timeConstantSeconds;
    const outputVolt = inputVolt * -Math.expm1(-ratio);
    if (!Number.isFinite(ratio) || !Number.isFinite(outputVolt) || (timeSeconds > 0 && (ratio === 0 || (inputVolt !== 0 && outputVolt === 0)))) {
      throw new McpDataError('RC sample is outside the numeric range.');
    }
    return {timeSeconds, outputVolt};
  });
  return {schemaVersion: 1, timeConstantSeconds, cutoffHz, samples};
}
await serve(rcBinding, 'Compute the step response of a first-order RC low-pass from the granted JSON.',
  calculate);
