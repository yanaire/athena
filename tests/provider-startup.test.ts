import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { InMemoryCredentialStore, type CredentialStore } from '@earendil-works/pi-ai';
import { ProviderManager } from '../runtime/provider-manager.ts';

test('preparing dedicated ChatGPT flows does not scan every stored provider before a request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-provider-startup-'));
  const backing = new InMemoryCredentialStore();
  const reads: string[] = [];
  let lists = 0;
  const credentials: CredentialStore = {
    read: (provider, options) => { reads.push(provider); return backing.read(provider, options); },
    list: options => { lists++; return backing.list(options); },
    modify: (provider, update, options) => backing.modify(provider, update, options),
    delete: (provider, options) => backing.delete(provider, options),
  };
  const providers = await ProviderManager.create(credentials, directory, { chatGPTEnabled: true });
  t.after(async () => { await providers.close(); await rm(directory, { recursive: true, force: true }); });
  // Flush Pi's queued asynchronous registration work. A provider-wide scan used
  // to read the vault more than a hundred times here despite no requested auth.
  await setImmediate();
  assert.deepEqual(reads, []);
  assert.equal(lists, 0);
  const openai = providers.providers('OpenAI').find(provider => provider.id === 'openai');
  assert.ok(openai?.methods.some(method => method.kind === 'oauth' && method.enabled));
  await providers.listProviders('OpenAI');
  assert.equal(lists, 1);
  assert.deepEqual(reads, []);
});
