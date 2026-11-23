import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { accountModel } from '../runtime/chatgpt-catalog.ts';
import { chatGPTResponsesApi } from '../runtime/chatgpt-responses.ts';

const token = 'fixture-access-private';
const model = accountModel({ slug: 'fixture-model', label: 'Fixture' });
const context = normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] });

test('plan Responses strips service tiers even when a caller injects an override', async () => {
  let sent: unknown;
  const stream = chatGPTResponsesApi().streamSimple(model, context, {
    apiKey: token,
    onPayload: body => {
      assert.ok(body && typeof body === 'object');
      return { ...body, service_tier: 'priority' };
    },
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.completed","response":{"model":"fixture-model","status":"completed"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.ok(sent && typeof sent === 'object');
  assert.equal(Object.hasOwn(sent, 'service_tier'), false);
});

test('plan admission failures retain only validated diagnostics and never provider text', async t => {
  for (const shape of ['structured', 'detail', 'malformed'] as const) await t.test(shape, async () => {
    const stream = chatGPTResponsesApi().streamSimple(model, context, {
      apiKey: token,
      fetch: async () => {
        const headers = { 'x-request-id': 'req_fixture_123' };
        if (shape === 'malformed') return new Response(token, { status: 503, headers });
        return Response.json(shape === 'detail' ? { detail: `Bearer ${token}` }
          : { error: { code: 'subscription_sharing_unsupported_capability', param: 'service_tier', message: token } },
        { status: shape === 'structured' ? 400 : 403, headers });
      },
    });
    const result = await stream.result();
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage ?? '', /req_fixture_123/);
    assert.match(result.errorMessage ?? '', new RegExp(`shape=${shape}`));
    if (shape === 'structured') {
      assert.match(result.errorMessage ?? '', /subscription_sharing_unsupported_capability/);
      assert.match(result.errorMessage ?? '', /param=service_tier/);
    }
    assert.equal(result.errorMessage?.includes(token), false);
  });
});

test('plan admission identifies a rejected nested request field without echoing provider text', async () => {
  const result = await chatGPTResponsesApi().streamSimple(model, context, {
    apiKey: token,
    fetch: async () => Response.json({ error: { type: 'invalid_request_error', code: 'invalid_value',
      param: 'input[0].tools[2].parameters', message: `Invalid schema for function 'read': ${token}` } }, { status: 400 }),
  }).result();
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage ?? '', /code=invalid_value; type=invalid_request_error; param=input\[0\]\.tools\[2\]\.parameters; cause=tool_schema/);
  assert.equal(result.errorMessage?.includes(token), false);

  const unsafe = await chatGPTResponsesApi().streamSimple(model, context, {
    apiKey: token,
    fetch: async () => Response.json({ error: { type: token, code: token, param: `input[0].${token}`, message: token } }, { status: 400 }),
  }).result();
  assert.equal(unsafe.errorMessage?.includes(token), false);
  assert.doesNotMatch(unsafe.errorMessage ?? '', /; (?:param|type|cause)=/);
});
