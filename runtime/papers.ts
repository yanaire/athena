import { randomUUID } from 'node:crypto';
import { Storage } from './storage.ts';
import { hash, ManagerError, object } from './orchestration.ts';
import type { Context } from './orchestration.ts';
import type { ResearchReview, ResearchTarget } from './research.ts';

type Ref = {sourceId:string;version:string};
export interface PaperSource extends Ref {
  projectId:string; title:string; content:string; level:'metadata'|'abstract'|'full_text'; sha256:string;
  origin?: ResearchTarget | {provider:string;providerId:string;query:string;retrievedAt:string;raw:unknown;rawSha256:string;hasAbstract:boolean;fullTextLinks:string[];fullTextAcquired:false};
}
export type PaperLink = {kind:'claim'|'citation'|'figure'; quote:string; sourceId:string; excerpt:string;
  locator:string; manuscriptOffset?:number;sourceOffset?:number; variable?:string;unit?:string;transformation?:string;caption?:string};
type PaperVersion = {projectId:string;documentId:string;version:string;baseVersion:string|null;title:string;text:string;sha256:string;
  evidence:Ref[];links:PaperLink[];issues:string[];createdAt:string;artifact?:ResearchTarget};
export type PaperRun = {id:string;requestId:string;mode:'outline'|'write';context:Context;baseVersion:string|null;stage:string;
  outline:string[];sections:{heading:string;text:string}[];attempts:{role:string;taskId:string;attemptId:string}[];
  versions:string[];reviews:ResearchReview[];uploads:{fileId:string;sourceId:string}[];error?:string};
export type Paper = {id:string;projectId:string;title:string;goal:string;evidence:Ref[];outline:string[];versions:string[];runs:PaperRun[]};
function fail(code:string,message:string):never { throw new ManagerError(code,message); }
export function bounded(value:unknown,name:string,limit=4096):string {
  if(typeof value!=='string'||!value.trim()||value.length>limit||value.includes('\0')) fail('INVALID_INPUT','Invalid '+name+'.');
  return value;
}
export function headings(v:unknown):string[] {
  if(!Array.isArray(v)||!v.length||v.length>8) fail('INVALID_OUTLINE','Choose one to eight sections.');
  const items=v.map(s=>bounded(s,'section heading',140));
  if(new Set(items).size!==items.length) fail('INVALID_OUTLINE','Section headings must be unique.');
  return items;
}
export function sectionDrafts(v:unknown,outline:string[]) {
  if(!Array.isArray(v)||v.length!==outline.length) fail('INVALID_SECTIONS','Missing section drafts.');
  return v.map((s,i)=>{if(!object(s)||s.heading!==outline[i]) fail('INVALID_SECTIONS','Section headings differ from the outline.');
    return {heading:String(s.heading),text:bounded(s.text,'section text',Math.floor(20000/outline.length))};});
}
export function inspectLinks(v:unknown,body:string,sources:PaperSource[]) {
  if(!Array.isArray(v)||v.length>80) fail('INVALID_LINKS','Expected bounded manuscript links.');
  const issues:string[]=[];
  const links=v.map((x):PaperLink=>{
    if(!object(x)||!['claim','citation','figure'].includes(String(x.kind))) fail('INVALID_LINKS','Unknown manuscript link.');
    const link:PaperLink={kind:x.kind as PaperLink['kind'],quote:bounded(x.quote,'manuscript quote',1500),sourceId:bounded(x.sourceId,'source ID',200),
      excerpt:bounded(x.excerpt,'evidence excerpt',1500),locator:bounded(x.locator,'source location',256)};
    const source=sources.find(s=>s.sourceId===link.sourceId);
    link.manuscriptOffset=body.indexOf(link.quote);link.sourceOffset=source?.content.indexOf(link.excerpt)??-1;
    if(!body.includes(link.quote)||!source?.content.includes(link.excerpt)) issues.push('Unresolved passage or evidence: '+link.quote);
    if(link.kind!=='citation'&&source?.level==='metadata') issues.push('Bibliographic metadata alone cannot support: '+link.quote);
    if(link.kind==='figure') {
      link.variable=bounded(x.variable,'data variable',128);link.unit=bounded(x.unit,'data unit',64);
      link.transformation=bounded(x.transformation,'transformation',256);link.caption=bounded(x.caption,'caption',1024);
      if(!source?.origin||!('kind' in source.origin)||source.origin.kind!=='artifact'||!source.content.includes(link.variable)
        ||!source.content.split(/[^\p{L}\p{N}µΩ°/%^-]+/u).includes(link.unit)||!body.includes(link.caption)) issues.push('Verify the figure data, unit and caption: '+link.quote);
    }
    return link;
  });
  for(const match of body.matchAll(/\b10\.\d{4,9}\/[^\s<>\])]+/gi)){
    const doi=match[0].replace(/[.,;]+$/,'').toLowerCase();
    if(!links.some(l=>l.kind==='citation'&&sources.some(s=>s.sourceId===l.sourceId&&s.content.toLowerCase().includes(doi))))
      issues.push('Unresolved citation: '+doi);
  }
  if(!links.some(l=>l.kind==='claim')) issues.push('No major claim has linked evidence.');
  return {links,issues};
}

export class Papers {
  readonly db:Storage;
  constructor(db:Storage){this.db=db;}
  private key(project:string,kind:string,id='') {
    if(!this.db.project(project)) fail('PROJECT_NOT_FOUND','Project unavailable.');
    return 'papers.v1:'+JSON.stringify([project,kind,id]);
  }
  private ids(project:string,kind:string){return this.db.get<string[]>(this.key(project,kind))??[];}
  private index(project:string,kind:string,id:string,limit:number){
    const ids=this.ids(project,kind);
    if(ids.includes(id)) return;
    if(ids.length>=limit) fail('PAPER_LIMIT','Project record limit reached.');
    this.db.set(this.key(project,kind),[...ids,id]);
  }
  source(project:string,id:string) {
    const s=this.db.get<PaperSource>(this.key(project,'source',id));
    if(!s||s.projectId!==project||s.sha256!==hash(s.content)) fail('SOURCE_DENIED','Verified project source unavailable.');
    return s;
  }
  saveSource(project:string,title:string,content:string,level:PaperSource['level']='full_text',origin?:PaperSource['origin']) {
    bounded(content,'source text',240000);if(Buffer.byteLength(content)>240000)fail('PAPER_LIMIT','Source exceeds 240 KB.');bounded(title,'source title',512);
    const sha256=hash(content);
    const sourceId=hash(JSON.stringify([project,title,sha256,origin&&('provider' in origin?[origin.provider,origin.providerId,origin.rawSha256]:origin.id)]));
    return this.db.transaction(()=>{
      if(this.db.get(this.key(project,'source',sourceId))) return this.source(project,sourceId);
      const source:PaperSource={projectId:project,sourceId,title,content,level,origin,version:sha256,sha256};
      this.index(project,'sources',sourceId,256);this.db.set(this.key(project,'source',sourceId),source);return source;
    });
  }
  list(project:string) {
    return {documents:this.ids(project,'documents').map(id=>{const d=this.paper(project,id);return {id,title:d.title,currentVersion:d.versions.at(-1)??null};}),
      sources:this.ids(project,'sources').map(id=>{const s=this.source(project,id);return {sourceId:id,version:s.version,title:s.title,level:s.level};})};
  }
  refs(project:string,value:unknown):Ref[] {
    if(!Array.isArray(value)||value.length>8) fail('INVALID_EVIDENCE','Select at most eight sources.');
    const refs=value.map(v=>{if(!object(v)||typeof v.sourceId!=='string') fail('INVALID_EVIDENCE','Invalid source.');
      const s=this.source(project,v.sourceId);if(s.version!==v.version) fail('SOURCE_DENIED','Source version changed.');
      return {sourceId:s.sourceId,version:s.version};});
    if(new Set(refs.map(r=>r.sourceId)).size!==refs.length)fail('INVALID_EVIDENCE','Duplicate source.');
    return refs;
  }
  create(project:string,args:Record<string,unknown>) {
    const title=bounded(args.title,'title',256),goal=bounded(args.goal,'objective'),evidence=this.refs(project,args.evidence);
    if(!evidence.length) fail('INVALID_EVIDENCE','Select source material.');
    const d:Paper={id:randomUUID(),projectId:project,title,goal,evidence,outline:[],versions:[],runs:[]};
    this.db.transaction(()=>{this.index(project,'documents',d.id,128);this.put(d);});return d;
  }
  paper(project:string,id:string):Paper {
    return this.db.get<Paper>(this.key(project,'paper',id))??fail('DOCUMENT_DENIED','Manuscript unavailable in this project.');
  }
  put(d:Paper){this.db.set(this.key(d.projectId,'paper',d.id),d);}
  update(project:string,id:string,fn:(paper:Paper)=>void) {
    return this.db.transaction(()=>{const d=this.paper(project,id);fn(d);this.put(d);return d;});
  }
  version(project:string,id:string,version?:string) {
    const d=this.paper(project,id), key=version??d.versions.at(-1);
    const v=key&&this.db.get<PaperVersion>(this.key(project,'version',key));
    if(!v||v.documentId!==id||v.sha256!==hash(v.text)) fail('VERSION_DENIED','Stored manuscript version unavailable.');
    const review=d.runs.flatMap(r=>r.reviews).find(r=>r.state==='completed'&&r.targets.some(t=>t.kind==='artifact'&&t.id===v.artifact?.id&&t.sha256===v.sha256));
    const status=review?.verdict==='supported'?'approved':review?.verdict?'changes_requested':'unreviewed';
    return {...v,currentVersion:d.versions.at(-1)!,persistence:'host' as const,review:{version:key,status,reviewerId:review?.reviewer?.agentSessionId,notes:review?.verdict},assessment:review};
  }
  save(project:string,id:string,args:Record<string,unknown>,generated?:{artifact:ResearchTarget;links:unknown;runId:string}) {
    const body=bounded(args.text,'manuscript text',120000),title=bounded(args.title,'title',256);
    let version='';
    this.update(project,id,d=>{
      const base=d.versions.at(-1)??null;
      if(base!==args.expectedCurrentVersion)fail('VERSION_CONFLICT','The current revision changed. Your draft is preserved.');
      const evidence=this.refs(project,args.evidence),sources=evidence.map(r=>this.source(project,r.sourceId));
      const {links,issues}=inspectLinks(generated?.links??[],body,sources);
      if(d.versions.length>=128)fail('PAPER_LIMIT','Version limit reached.');
      version=randomUUID();const sha256=hash(body);
      if(generated&&generated.artifact.sha256!==sha256)fail('ARTIFACT_DENIED','Published manuscript bytes differ.');
      const v:PaperVersion={projectId:project,documentId:id,title,text:body,evidence,baseVersion:base,version,sha256,
        links,issues,createdAt:new Date().toISOString(),artifact:generated?.artifact};
      this.db.set(this.key(project,'version',version),v);d.versions.push(version);d.title=title;d.evidence=evidence;
      if(generated) d.runs.find(r=>r.id===generated.runId)!.versions.push(version);
    });
    return this.version(project,id,version);
  }
  export(project:string,sessionId:string,id:string,version:string,format:unknown) {
    if(this.db.session(sessionId)?.projectId!==project||!['md','json'].includes(String(format))) fail('EXPORT_DENIED','Invalid export scope or format.');
    const v=this.version(project,id,version);
    const content=format==='md'?v.text:JSON.stringify({schemaVersion:1,documentId:id,version,title:v.title,markdownSha256:v.sha256,
      evidence:v.evidence.map(r=>this.source(project,r.sourceId)),links:v.links,issues:v.issues,artifact:v.artifact,review:v.review,assessment:v.assessment},null,2)+'\n';
    const bytes=Buffer.byteLength(content);if(bytes>1024*1024)fail('PAPER_LIMIT','Export exceeds 1 MiB.');
    const sha256=hash(content),exportId=hash(JSON.stringify([sessionId,id,version,format,sha256]));
    const receipt={id:exportId,sessionId,projectId:project,documentId:id,version,sha256,bytes,name:format==='md'?'manuscript.md':'manifest.json',
      mimeType:format==='md'?'text/markdown':'application/json',uri:'/api/artifacts/'+sessionId+'/'+exportId};
    this.db.set(this.key(project,'export',exportId),{...receipt,content});return receipt;
  }
  download(session:string,id:string) {
    const project=this.db.session(session)?.projectId;
    const row=project&&this.db.get<{sessionId:string;name:string;mimeType:string;content:string;sha256:string}>(this.key(project,'export',id));
    if(!row||row.sessionId!==session||hash(row.content)!==row.sha256)fail('ARTIFACT_DENIED','Export unavailable in this conversation.');
    return {name:row.name,mimeType:row.mimeType,bytes:Buffer.from(row.content)};
  }
}
