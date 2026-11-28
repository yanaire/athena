// Imported explicitly by isolated acceptance hosts. These are fault controls for
// a real artifact read, and an availability substitute for Linux browser CI.
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { JobRunner } from '../../runtime/jobs.ts';

if (process.env.ATHENA_TEST_ANALYSIS_GATE === '1') {
  const available = JobRunner.prototype.analysisAccess;
  JobRunner.prototype.analysisAccess = async function () {
    const original = await available.call(this);
    return original.available ? original : {
      available: true, engine: 'Wasmtime 51.0.0',
      node: { path: 'fixture-unused.wasm', version: 'QuickJS-ng 0.18.0' },
      python: { path: 'fixture-unused.wasm', version: 'CPython 3.15.2' },
    };
  };
}

const marker = process.env.ATHENA_TEST_READ_DELAY_FILE;
if (marker) {
  const download = JobRunner.prototype.download;
  JobRunner.prototype.download = async function (artifact) {
    const bytes = await download.call(this, artifact);
    if (existsSync(marker)) await delay(1800);
    return bytes;
  };
}
