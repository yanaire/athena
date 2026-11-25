import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { openProviderCredentials } from '../runtime/provider-credentials.ts';
import { ProviderError, ProviderManager } from '../runtime/provider-manager.ts';

test('the Athena catalog exposes each Pi factory, without claiming unverified access or exposing Claude subscription login', async t => {
  t.mock.method(process, 'loadEnvFile', () => undefined);
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; });
  const manager = await ProviderManager.create(new InMemoryCredentialStore());
  const expected = builtinProviders().map(provider => provider.id).sort();
  assert.equal(new Set(expected).size, 43);
  assert.deepEqual(manager.providers().map(provider => provider.id).sort(), expected);
  const openai = await manager.catalog('openai', { query: 'gpt' });
  assert.equal(openai.provider.auth, 'unconfigured');
  assert.deepEqual(openai.availableModelIds, []);
  assert.ok(openai.models.some(model => model.id === 'gpt-4o' && model.input.includes('image')));
  assert.ok(openai.models.every(model => model.tools === 'unverified' && model.id.includes('gpt')));
  assert.deepEqual(manager.providers('anthropic').map(provider => [provider.id, provider.methods.map(method => [method.kind, method.enabled])]), [
    ['anthropic', [['api_key', true], ['oauth', false]]],
  ]);
  await assert.rejects(manager.saveApiKey('amazon-bedrock', 'fixture-must-not-be-saved'), { code: 'UNSUPPORTED_AUTH' });
});

test('Pi stores a key for the selected provider without configuring a sibling provider', async () => {
  const credentials = new InMemoryCredentialStore();
  const manager = await ProviderManager.create(credentials);
  for (const provider of ['google', 'opencode', 'opencode-go', 'deepseek', 'groq', 'xai', 'mistral', 'nvidia']) {
    await manager.saveApiKey(provider, `fixture-key-${provider}`);
    const row = (await manager.listProviders(provider)).find(value => value.id === provider);
    assert.deepEqual([row?.credentialType, row?.credentialSource, row?.auth], ['api_key', 'stored', 'configured']);
  }
  assert.equal(await credentials.read('google-vertex'), undefined);
  assert.equal(await credentials.read('openrouter'), undefined);
  assert.equal(JSON.stringify(await manager.listProviders()).includes('fixture-key-'), false);
});

test('SDK key setup and logout survive reopening the encrypted vault without disclosing credential values', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'athena-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vaultKey = randomBytes(32).toString('hex');
  const previous = process.env.ATHENA_CREDENTIAL_KEY;
  t.after(() => { if (previous === undefined) delete process.env.ATHENA_CREDENTIAL_KEY; else process.env.ATHENA_CREDENTIAL_KEY = previous; });
  process.env.ATHENA_CREDENTIAL_KEY = vaultKey;
  const first = await openProviderCredentials(directory);
  assert.equal(first.mode, 'operator_key');
  const manager = await ProviderManager.create(first.store);
  const openaiKey = `openai-fixture-${randomBytes(18).toString('hex')}`;
  const anthropicKey = `anthropic-fixture-${randomBytes(18).toString('hex')}`;
  await manager.saveApiKey('openai', openaiKey);
  await manager.saveApiKey('anthropic', anthropicKey);
  await assert.rejects(manager.saveApiKey('anthropic', ''), (error: unknown) => error instanceof ProviderError && error.code === 'INVALID_KEY');
  const path = join(directory, 'provider-secrets.v1');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const bytes = await readFile(path);
  process.env.ATHENA_CREDENTIAL_KEY = randomBytes(32).toString('hex');
  await assert.rejects(openProviderCredentials(directory), /could not be decrypted/);
  assert.deepEqual(await readFile(path), bytes);
  for (const secret of [openaiKey, anthropicKey, vaultKey]) assert.equal(bytes.includes(secret), false);
  process.env.ATHENA_CREDENTIAL_KEY = vaultKey;
  const reopened = await openProviderCredentials(directory);
  const reopenedManager = await ProviderManager.create(reopened.store);
  assert.deepEqual(await reopened.store.read('openai'), { type: 'api_key', key: openaiKey });
  assert.deepEqual(await reopened.store.read('anthropic'), { type: 'api_key', key: anthropicKey });
  const result = await reopenedManager.catalog('anthropic');
  assert.equal(result.provider.auth, 'configured');
  assert.equal(JSON.stringify(result).includes(anthropicKey), false);
  await reopenedManager.logout('openai');
  const final = await openProviderCredentials(directory);
  assert.equal(await final.store.read('openai'), undefined);
  assert.deepEqual(await final.store.read('anthropic'), { type: 'api_key', key: anthropicKey });
});

test('Pi uses the selected official API key and reports stream, tool and access results independently', async t => {
  const manager = await ProviderManager.create(new InMemoryCredentialStore());
  const anthropic = (await manager.catalog('anthropic')).models.find(model => model.id.includes('sonnet') && model.api === 'anthropic-messages');
  assert.ok(anthropic);
  const nativeApis = [
    { provider: 'openai', modelId: 'gpt-4o', origin: 'https://api.openai.com', path: '/v1/responses', header: 'authorization' },
    { provider: 'anthropic', modelId: anthropic.id, origin: 'https://api.anthropic.com', path: '/v1/messages?beta=true', header: 'x-api-key' },
  ] as const;
  for (const api of nativeApis) await manager.saveApiKey(api.provider, `fixture-key-${api.provider}`);
  for (const api of nativeApis) await t.test(api.provider, async sub => {
    let status = 200;
    let suppressTool = false;
    const requests: Array<{ url: string; key: string | null; crossKey: string | null; model: string; tool: boolean }> = [];
    sub.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json();
      const tool = Array.isArray(body.tools) && body.tools.length > 0;
      requests.push({ url: request.url, key: request.headers.get(api.header), model: body.model, tool,
        crossKey: request.headers.get(api.header === 'x-api-key' ? 'authorization' : 'x-api-key') });
      if (status !== 200) return Response.json({ error: { message: 'wire fixture denied access' } }, { status });
      const call = tool && !suppressTool;
      const text = 'Athena';
      const name = 'athena_connection_check';
      const item = call ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name, arguments: '{}' }
        : { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text }] };
      const events = api.provider === 'openai' ? [
        { type: 'response.output_item.added', output_index: 0, item: call ? { ...item, arguments: '' } : { ...item, content: [] } },
        call ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' }
          : { type: 'response.output_text.delta', output_index: 0, delta: text },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { status: 'completed', model: body.model, output: [item] } },
      ] : [
        { type: 'message_start', message: { id: 'msg_fixture', model: body.model, content: [], usage: { input_tokens: 13, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'tool_fixture', name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    });

    // Saved editable API profiles carry the provider ID, not a previous run binding.
    const result = await manager.verify({ ...api, authRef: api.provider });
    assert.deepEqual([result.streaming, result.tools, result.error], ['passed', 'passed', undefined]);
    assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
    const key = `fixture-key-${api.provider}`;
    assert.deepEqual(requests.splice(0), [false, true].map(tool => ({ url: api.origin + api.path,
      key: api.header === 'authorization' ? `Bearer ${key}` : key, crossKey: null, model: api.modelId, tool })));

    suppressTool = true;
    const noTools = await manager.verify(api);
    assert.deepEqual([noTools.streaming, noTools.tools, noTools.error], ['passed', 'failed', 'unsupported']);
    for (const [http, error] of [[401, 'authentication'], [403, 'permission'], [404, 'model_unavailable'], [429, 'rate_limited']] as const) {
      status = http;
      requests.length = 0;
      const failure = await manager.verify(api);
      assert.deepEqual([failure.streaming, failure.tools, failure.error], ['failed', 'not_checked', error]);
      assert.ok(requests.length && requests.every(request => request.url === api.origin + api.path && request.model === api.modelId && !request.tool));
      assert.equal(JSON.stringify(failure).includes(key), false);
    }
  });
});

test('API credential bindings include provider-scoped account env and reject unverifiable legacy references', async t => {
  const credentials = new InMemoryCredentialStore();
  const provider = 'cloudflare-workers-ai';
  const key = 'binding-env-fixture-secret';
  await credentials.modify(provider, async () => ({ type: 'api_key', key,
    env: { CLOUDFLARE_ACCOUNT_ID: 'fixture-account-a', EXTRA: 'fixed' } }));
  const manager = await ProviderManager.create(credentials); t.after(() => manager.close());
  const model = (await manager.catalog(provider)).models[0]; assert.ok(model);
  const reference = { provider, modelId: model.id };
  const original = await manager.pin(reference);
  assert.match(original.authRef!, /^credential:v1:[a-f0-9]{64}$/u);
  assert.equal(original.authRef!.includes(key), false);
  await credentials.modify(provider, async () => ({ type: 'api_key', key,
    env: { EXTRA: 'fixed', CLOUDFLARE_ACCOUNT_ID: 'fixture-account-a' } }));
  assert.equal((await manager.pin({ ...reference, authRef: original.authRef })).authRef, original.authRef);
  await credentials.modify(provider, async () => ({ type: 'api_key', key,
    env: { CLOUDFLARE_ACCOUNT_ID: 'fixture-account-b', EXTRA: 'fixed' } }));
  await assert.rejects(manager.pin({ ...reference, authRef: original.authRef }), { code: 'MODEL_UNAVAILABLE' });
  const replacement = await manager.pin(reference); assert.notEqual(replacement.authRef, original.authRef);
  await assert.rejects(manager.pin({ ...reference, authRef: provider + ':api_key' }), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(manager.pin({ ...reference, authRef: provider }), { code: 'MODEL_UNAVAILABLE' });
});
