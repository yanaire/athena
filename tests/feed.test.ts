import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { WorkspaceFeed } from '../runtime/feed.ts';

test('a client can resume exactly after bootstrap or the last delivered event, including while disconnected', () => {
  const feed = new WorkspaceFeed();
  const before = feed.cursor;
  const first = feed.append({ type: 'snapshot', revision: 1 });
  const after = feed.cursor;
  const second = feed.append({ type: 'pi', sessionId: 'a', event: { type: 'agent_end' } });
  assert.deepEqual(feed.replay(before.epoch, String(before.sequence)), [first, second]);
  assert.deepEqual(feed.replay(after.epoch, String(after.sequence)), [second]);
  assert.match(second, new RegExp(`^id: ${before.epoch}:2\\n`));
  assert.equal(new WorkspaceFeed().replay(after.epoch, '2'), null);
  for (let i = 0; i < 513; i++) feed.append({ type: 'connection' });
  assert.equal(feed.replay(before.epoch, '2'), null);
  assert.deepEqual(feed.replay(before.epoch, '515'), []);
  assert.equal(feed.replay(before.epoch, '516'), null);
});
