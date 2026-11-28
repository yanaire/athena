import test from 'node:test';
import assert from 'node:assert/strict';
import { manuscriptTex, readTemplate, typeset } from '../runtime/typesetting.ts';

test('attached journal templates retain supported class options and packages', () => {
  const preamble = ['\\documentclass[final,3p,times]{elsarticle}', '\\usepackage{booktabs}'];
  const parsed = readTemplate([...preamble, '\\begin{document}', 'Placeholder text', '\\end{document}'].join('\n'));
  assert.equal(parsed.style, 'elsarticle-3p');
  const tex = manuscriptTex('Current revision', 'Estimate: 95% & rising.', parsed.style, [], parsed.preamble);
  assert.ok(tex.startsWith(preamble.join('\n')));
  assert.ok(tex.includes('95\\% \\&'));
  assert.doesNotMatch(tex, /Placeholder text/);
  assert.throws(() => readTemplate('\\documentclass{article}\n\\newcommand{\\heading}{Study}\n\\begin{document}\n'), /Unsupported template directive/);
});

test('plots and tables use the selected numeric columns of the supplied version', () => {
  const sourceId = 'a'.repeat(64);
  const data = [{sourceId, rows:[{time:0, volts:-1}, {time:1, volts:0.6321}]}];
  const link = '![Charging](athena-plot:'+sourceId+'/time/volts)';
  const tex = manuscriptTex('Test', link+'\n'+link.replace('athena-plot', 'athena-table'), 'article', [], [], data);
  assert.match(tex, /\\begin\{picture\}/);
  assert.match(tex, /\\put\(169,75\)\{\\circle/);
  assert.ok(tex.includes('1 & 0.6321'));
  assert.throws(() => manuscriptTex('Test', link, 'article'), /reviewed experiment source/);
  assert.throws(() => manuscriptTex('Test', link.replace('/volts','/missing'), 'article', [], [], data), /missing or nonnumeric/);
  assert.throws(() => manuscriptTex('Test', '![Plot](missing.png)', 'article'), /unstaged figure/);
});

test('a missing TeX engine reports its actual subprocess failure', {skip:process.platform!=='linux'}, async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent-athena-test-directory';
    await assert.rejects(typeset('Study', 'Methods', 'article', new AbortController().signal), {code:'TYPESET_FAILED',message:/pdflatex.*ENOENT/});
  } finally {
    if(previous===undefined)delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
