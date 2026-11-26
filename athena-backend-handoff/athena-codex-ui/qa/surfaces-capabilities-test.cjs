'use strict';
// Source + DOM contracts only. No native browser, device bridge, or real page
// navigation is exercised; the actual desktop navigation policy is audited separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dependencyPaths = [__dirname, ...(process.env.ATHENA_QA_DEPENDENCIES ? [process.env.ATHENA_QA_DEPENDENCIES] : [])];
const { parseHTML } = require(require.resolve('linkedom', { paths: dependencyPaths }));

function environment() {
  const { window, document } = parseHTML('<html><body><main id="root"></main></body></html>');
  const copied = [], opened = [], notices = [], workspaces = [];
  window.open = (...args) => { opened.push(args); return null; };
  const context = vm.createContext({ window, document, AbortController, URL, Blob, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async value => copied.push(value) } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../ui/surfaces.js'), 'utf8'), context);
  const root = document.getElementById('root');
  const api = window.AthenaSurfaces.mount(root, { files: { 'sample.csv': 'voltage\n7\n35' },
    toast: text => notices.push(text), onWorkspace: view => workspaces.push(view) });
  const q = selector => root.querySelector(selector);
  function click(selector) { const el = q(selector); assert.ok(el); el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); }
  function type(value) { q('[data-acs-address]').value = value; q('[data-acs-address]').dispatchEvent(new window.Event('input', { bubbles: true })); }
  function submit() { q('[data-acs-address-form]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  return { api, root, q, click, type, submit, copied, opened, notices, workspaces };
}

test('runtime surface choices disclose unavailable capabilities before opening them', t => {
  const e = environment(); t.after(() => e.api.destroy()); e.api.setRuntimeMode(true);
  assert.match(e.q('[data-acs-capability="browser"]').textContent, /Web links only/);
  for (const id of ['device', 'files', 'diff']) assert.match(e.q('[data-acs-capability="' + id + '"]').textContent, /unavailable/);
  assert.equal(e.root.querySelectorAll('[data-acs-surface][disabled]').length, 2);
  assert.equal(e.q('.acs-recent'), null);
});

test('runtime browser separates URL launching from agent browsing and never substitutes a sample result', t => {
  const e = environment(); t.after(() => e.api.destroy()); e.api.open('browser', false);
  assert.ok(e.q('.acs-document-preview'));
  e.api.setRuntimeMode(true);
  assert.equal(e.q('.acs-document-preview'), null);
  assert.equal(e.root.textContent.includes('RC low-pass filter'), false);
  assert.match(e.root.textContent, /Browser automation is not connected/);
  assert.match(e.q('.acs-browser-note').textContent, /new tab when available/);
  assert.equal(e.q('[data-acs-address]').getAttribute('aria-describedby'), e.q('.acs-browser-note').id);
  e.api.setRuntimeMode(false);
  assert.ok(e.q('.acs-document-preview'), 'Authored preview examples remain available outside runtime mode.');
});

test('unavailable File, Diff, and Device views route only to existing workspace views', t => {
  const e = environment(); t.after(() => e.api.destroy()); e.api.setRuntimeMode(true);
  e.api.open('files', false);
  assert.equal(e.q('.acs-code'), null);
  e.click('[data-acs-workspace="knowledge"]');
  e.click('[data-acs-workspace="artifacts"]');
  e.api.open('diff', false);
  assert.equal(e.q('.acs-diff-code'), null);
  e.click('[data-acs-workspace="artifacts"]');
  e.api.open('device', false);
  assert.match(e.root.textContent, /Device connection is not implemented/);
  assert.equal(e.root.textContent.includes('Once connected'), false);
  e.click('[data-acs-workspace="workflow"]');
  assert.deepEqual(e.workspaces, ['knowledge', 'artifacts', 'artifacts', 'workflow']);
  assert.deepEqual(e.opened, []);
});

test('copy-address remains usable when the host refuses new windows and does not claim a navigation succeeded', async t => {
  const e = environment(); t.after(() => e.api.destroy()); e.api.setRuntimeMode(true); e.api.open('browser', false);
  assert.equal(e.q('[data-acs-action="copy-address"]').disabled, true);
  e.type('example.com/research?q=measurements');
  assert.equal(e.q('[data-acs-action="copy-address"]').disabled, false);
  e.submit();
  assert.deepEqual(e.opened, [['https://example.com/research?q=measurements', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(e.notices, [], 'Opening a window is not reported as observed navigation.');
  e.click('[data-acs-action="copy-address"]'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(e.copied, ['https://example.com/research?q=measurements']);
  assert.match(e.notices.at(-1), /Web address copied/);
  assert.equal(e.q('[data-acs-address]').value, e.copied[0]);
});

test('URL launch and copy share the http/https restriction without executing unsafe schemes', async t => {
  const e = environment(); t.after(() => e.api.destroy()); e.api.open('browser', false);
  for (const address of ['javascript:alert(1)', 'file:///private/source.csv', 'data:text/html,test']) {
    e.type(address); e.submit(); e.click('[data-acs-action="copy-address"]'); await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(e.opened, []);
  assert.deepEqual(e.copied, []);
  assert.equal(e.notices.length, 6);
  e.type('localhost:4317/results'); e.click('[data-acs-action="copy-address"]'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.copied[0], 'https://localhost:4317/results');
});

test('desktop submission uses its advertised host opener and keeps copy available on failure', async t => {
  const e = environment(); t.after(() => e.api.destroy());
  const sent = [];
  e.api.setRuntimeMode(true); e.api.open('browser', false);
  e.api.setWebAddressOpener(async address => { sent.push(address); throw new Error('Launch failed'); });
  assert.match(e.q('.acs-browser-note').textContent, /your system browser/);
  e.type('example.org/circuit'); e.submit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['https://example.org/circuit']);
  assert.deepEqual(e.opened, []);
  assert.match(e.notices.at(-1), /Copy the address/);
  e.type('https://user@example.org'); e.submit();
  assert.equal(sent.length, 1);
  e.api.setWebAddressOpener(null);
  e.type('example.org'); e.submit();
  assert.equal(e.opened.length, 1);
});
