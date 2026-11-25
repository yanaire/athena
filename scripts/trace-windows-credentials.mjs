// Diagnostic branch only. Run from the repository root with Node --import.
// Never print arguments, provider/account identifiers, credential values or errors.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { LocalCredentialStore } = await import(pathToFileURL(resolve('runtime/local-credentials.ts')).href);
const names = new Set(['AbortError', 'TimeoutError', 'CredentialVaultError', 'Error', 'TypeError']);
const codes = new Set(['VAULT_INVALID', 'VAULT_WRITE_FAILED', 'ABORT_ERR', 'ERR_ABORTED', 'ERR_INVALID_STATE']);
let sequence = 0;

for (const operation of ['read', 'list']) {
  const original = LocalCredentialStore.prototype[operation];
  Object.defineProperty(LocalCredentialStore.prototype, operation, {
    configurable: true, writable: true,
    value: async function (...args) {
      const request = ++sequence;
      const started = performance.now();
      const options = operation === 'read' ? args[1] : args[0];
      const signal = options?.signal;
      const abortedAtStart = signal?.aborted ?? false;
      let failure;
      try { return await Reflect.apply(original, this, args); }
      catch (error) { failure = error; throw error; }
      finally {
        process.stdout.write('ATHENA_CREDENTIAL_TIMING ' + JSON.stringify({
          pid: process.pid, sequence: request, operation,
          startedMs: Math.round(started),
          elapsedMs: Math.round(performance.now() - started),
          status: failure === undefined ? 'fulfilled' : 'rejected',
          ...(failure === undefined ? {} : {
            errorName: names.has(failure?.name) ? failure.name : 'other',
            errorCode: codes.has(failure?.code) ? failure.code : 'other',
          }),
          abortedAtStart, aborted: signal?.aborted ?? false,
          ...(signal?.aborted ? { reasonName: names.has(signal.reason?.name) ? signal.reason.name : 'other' } : {}),
        }) + '\n');
      }
    },
  });
}
