import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDesktopInput, DesktopControl, type DesktopDriver } from '../runtime/desktop-control.ts';
import { applicationEnvironment } from '../runtime/desktop-process.ts';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJxsAAAAASUVORK5CYII=', 'base64');
const window = { appId: 'cad', pid: 12, windowId: '7', document: 'doc', viewport: [0, 0, 100, 100, 1, 96, 96] };

test('desktop observations authorize a single displayed action', async () => {
  const actions: string[] = [];
  const control = new DesktopControl({
    observe: async () => ({ window, targets: ['next'], png: pixel }),
    activate: async (_, target) => { actions.push(target); },
    revoke: () => {},
  }, () => {});
  const first = await control.observe();
  const second = await control.observe();
  await assert.rejects(control.activate(first.id, 'next'), { code: 'stale_observation' });
  await assert.rejects(control.activate(second.id, 'next'), { code: 'stale_observation' });
  const latest = await control.observe();
  await control.activate(latest.id, 'next');
  await assert.rejects(control.activate(latest.id, 'next'), { code: 'stale_observation' });
  assert.deepEqual(actions, ['next']);
  await control.stop();
});

test('takeover revokes pending input before releasing the desktop lease', async () => {
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const driver: DesktopDriver = {
    observe: async () => ({ window, targets: ['next'], png: pixel }),
    activate: async (_, __, signal) => {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      events.push('settled');
    },
    revoke: () => { events.push('revoked'); },
  };
  const control = new DesktopControl(driver, () => { events.push('released'); });
  const frame = await control.observe();
  const input = control.activate(frame.id, 'next');
  await entered.promise;
  assert.throws(() => control.activate(frame.id, 'next'), { code: 'busy' });
  const stop = control.stop();
  assert.throws(() => control.observe(), { code: 'stopped' });
  await assert.rejects(input, { code: 'stopped' });
  await stop;
  assert.deepEqual(events, ['revoked', 'settled', 'released']);
});

test('the OS-owned desktop input lease contends across controllers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'athena-desktop-test-'));
  try {
    const release = acquireDesktopInput(directory);
    try { assert.throws(() => acquireDesktopInput(directory), { code: 'busy' }); }
    finally { release(); }
    acquireDesktopInput(directory)();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the app process environment excludes provider and executable preload settings', () => {
  assert.deepEqual(applicationEnvironment({
    DISPLAY: ':91', ATHENA_API_KEY: 'secret', PYTHONPATH: 'unexpected', NODE_OPTIONS: 'unexpected',
  }), { DISPLAY: ':91' });
});
