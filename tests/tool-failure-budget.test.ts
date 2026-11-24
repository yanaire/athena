import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolFailureBudget } from '../runtime/tool-failure-budget.ts';

function end(id: string, args: unknown = {}, isError = true, toolName = 'calculate_csv') {
  return { type: 'tool_execution_end', toolCallId: id, toolName, args, isError };
}

test('equivalent arguments reach the repeated-failure limit without exposing their data', () => {
  const budget = new ToolFailureBudget();
  assert.equal(budget.observe(end('a', { column: 'private-field', options: { b: 2, a: 1 } })), undefined);
  assert.equal(budget.observe(end('b', { options: { a: 1, b: 2 }, column: 'private-field' })), undefined);
  const limit = budget.observe(end('c', { column: 'private-field', options: { b: 2, a: 1 } }));
  assert.equal(limit?.code, 'TOOL_FAILURE_LIMIT');
  assert.equal(limit?.reason, 'repeated');
  assert.equal(limit?.failures, 3);
  assert.equal(limit?.limit, 3);
  assert.ok(!JSON.stringify(limit).includes('private-field'));
  assert.equal(budget.observe(end('d', {})), undefined, 'only one terminal decision');
});

test('interleaved tool completions use their own start arguments and ignore duplicate end events', () => {
  const budget = new ToolFailureBudget({ maxRepeatedFailures: 2 });
  budget.observe({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { fileId: 'first' } });
  budget.observe({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: { fileId: 'second' } });
  const first = { type: 'tool_execution_end', toolCallId: 'a', isError: true };
  assert.equal(budget.observe({ type: 'tool_execution_end', toolCallId: 'b', isError: true }), undefined);
  assert.equal(budget.observe(first), undefined);
  assert.equal(budget.observe(first), undefined);
  assert.equal(budget.observe(end('c', { fileId: 'first' }, true, 'read'))?.reason, 'repeated');
});

test('success resets only the matching signature and a new attempt has a fresh budget', () => {
  const budget = new ToolFailureBudget({ maxRepeatedFailures: 2 });
  budget.observe(end('a'));
  assert.equal(budget.observe(end('b', {}, false)), undefined);
  assert.equal(budget.observe(end('c')), undefined, 'matching success clears the prior repeated failure');
  budget.observe(end('d', {}, false, 'read'));
  assert.equal(budget.observe(end('e'))?.reason, 'repeated', 'unrelated success cannot hide the loop');
  assert.equal(new ToolFailureBudget({ maxRepeatedFailures: 2 }).observe(end('fresh')), undefined);
});

test('changing arguments or alternating tools still consumes the attempt-wide failure budget', () => {
  const budget = new ToolFailureBudget();
  for (let i = 0; i < 7; i++) {
    assert.equal(budget.observe(end('error-' + i, { variant: i }, true, i % 2 ? 'read' : 'calculate_csv')), undefined);
    assert.equal(budget.observe(end('success-' + i, {}, false)), undefined);
  }
  const limit = budget.observe(end('last', { variant: 8 }));
  assert.equal(limit?.reason, 'total');
  assert.equal(limit?.failures, 8);
  assert.equal(limit?.limit, 8);
});

test('nested SDK errors count while updates, missing IDs and successful calls do not', () => {
  const budget = new ToolFailureBudget({ maxTotalFailures: 1 });
  assert.equal(budget.observe({ type: 'tool_execution_update', toolCallId: 'a', isError: true }), undefined);
  assert.equal(budget.observe({ type: 'tool_execution_end', toolName: 'read', isError: true }), undefined);
  assert.equal(budget.observe(end('successful', {}, false)), undefined);
  const limit = budget.observe({ type: 'tool_execution_end', toolCallId: 'nested', toolName: 'read', result: { isError: true } });
  assert.equal(limit?.reason, 'total');
});

test('tool identity and array argument order remain distinct', () => {
  const budget = new ToolFailureBudget({ maxRepeatedFailures: 2 });
  assert.equal(budget.observe(end('a', { values: [1, 2] }, true, 'read')), undefined);
  assert.equal(budget.observe(end('b', { values: [2, 1] }, true, 'read')), undefined);
  assert.equal(budget.observe(end('c', { values: [1, 2] }, true, 'write_file')), undefined);
  assert.equal(budget.observe(end('d', { values: [1, 2] }, true, 'read'))?.reason, 'repeated');
});

test('malformed arguments cannot throw out of the event subscriber', () => {
  const budget = new ToolFailureBudget({ maxTotalFailures: 1 });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(budget.observe(end('circular', circular))?.code, 'TOOL_FAILURE_LIMIT');
  assert.throws(() => new ToolFailureBudget({ maxRepeatedFailures: 0 }), RangeError);
  assert.throws(() => new ToolFailureBudget({ maxTotalFailures: NaN }), RangeError);
});
