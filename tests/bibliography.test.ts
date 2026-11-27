import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Storage } from '../runtime/storage.ts';
import { Papers } from '../runtime/papers.ts';
import { Bibliography } from '../runtime/bibliography.ts';
import { CrossrefProvider } from '../runtime/crossref.ts';
import { privateTestDirectory } from './platform-test-helpers.ts';
import type { TestContext } from 'node:test';
function setup(t:TestContext,transport:typeof fetch){
  const directory=privateTestDirectory(join(tmpdir(),'bibliography-'));
  const db=new Storage(directory);db.putProject({id:'p',name:'Test'});
  const papers=new Papers(db),provider=new CrossrefProvider(transport),lib=new Bibliography(db,papers,provider);
  t.after(async()=>{await lib.close();db.close();rmSync(directory,{recursive:true,force:true});});
  return {lib,papers,db,provider,prepare:(term='optical metrology',pages=1)=>lib.prepare('p','s',{mode:'query',term,pages,requestId:randomUUID()})};
}
const item=(i:number)=>({DOI:'10.1234/mock'+i,title:['Synthetic item '+i],link:[{URL:'https://example.org/paper'}],author:[{family:'Fixture'}]});
const result=(items:unknown[])=>Response.json({status:'ok',message:{items}});

test('search pages keep original provenance through partial failure and source deduplication',async t=>{
  const urls:URL[]=[];
  const {lib,prepare}=setup(t,async url=>{urls.push(new URL(String(url)));return urls.length===1?result([1,2,3,4,1].map(item)):new Response(null,{status:429});});
  const {id}=prepare('explicit words',2);
  const row=await lib.execute('p','s',id);assert.equal(row.status,'partial');assert.equal(row.error,'rate_limited');
  assert.equal(row.records.length,4);assert.equal(urls[0]?.searchParams.get('query.bibliographic'),'explicit words');assert.equal(urls[1]?.searchParams.get('offset'),'5');
  const src=lib.add('p','s',id,item(1).DOI);
  assert.equal(src.level,'metadata');assert.equal(src.sourceId,lib.add('p','s',id,item(1).DOI.toUpperCase()).sourceId);
  assert.ok(src.origin&&'provider' in src.origin);assert.deepEqual(src.origin.raw,item(1));assert.deepEqual(src.origin.fullTextLinks,['https://example.org/paper']);
  assert.equal(src.origin.fullTextAcquired,false);assert.equal(src.origin.hasAbstract,false);
  assert.throws(()=>lib.add('p','other',id,item(1).DOI));await assert.rejects(lib.execute('other','s',id));
});
test('successful empty result and persisted cache retain original retrieval time', async t=>{
  let calls=0;const {lib,db,provider,papers,prepare}=setup(t,async()=>{calls++;return result([]);});
  const first=await lib.execute('p','s',prepare().id);
  assert.equal(first.status,'succeeded');assert.deepEqual(first.records,[]);assert.ok(first.retrievedAt);
  const restored=new Bibliography(db,papers,provider),row=await restored.execute('p','s',prepare().id);
  assert.equal(row.status,'cached');assert.equal(row.retrievedAt,first.retrievedAt);assert.equal(row.cacheOrigin,first.id);assert.equal(calls,1);
});
for(const [status,reply] of Object.entries({
  forbidden:()=>new Response(null,{status:403}), rate_limited:()=>new Response(null,{status:429}),
  malformed:()=>new Response('{'),network_error:()=>{throw Error('disconnected');}, response_too_large:()=>new Response('x'.repeat(512001)),
})){
  test('Crossref records '+status+' separately from zero results',async t=>{
    const {lib,prepare}=setup(t,async()=>reply());const row=await lib.execute('p','s',prepare().id);
    assert.equal(row.status,'failed');assert.equal(row.error,status);assert.equal(row.retrievedAt,undefined);
  });
}
test('concurrent searches, cancellation, timeout and duplicate dispatch have distinct outcomes',async t=>{
  let requests=0;
  const {lib,prepare}=setup(t,async(_url,options)=>{
    requests++;const sig=options?.signal;return new Promise<Response>((_,reject)=>sig?.addEventListener('abort',()=>reject(sig.reason),{once:true}));
  });
  const first=prepare(),waiting=lib.execute('p','s',first.id);
  assert.equal((await lib.execute('p','s',first.id)).status,'running');
  assert.equal((await lib.execute('p','s',prepare('other').id)).error,'busy');
  lib.cancel('p','s',first.id);assert.equal((await waiting).status,'cancelled');assert.equal(requests,1);
  const deadline=new AbortController();t.mock.method(AbortSignal,'timeout',()=>deadline.signal);
  const expiring=lib.execute('p','s',prepare().id);deadline.abort();assert.equal((await expiring).error,'timeout');
});
