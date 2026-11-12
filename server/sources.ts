import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Evidence} from '../shared/types';
import type {Store} from './store';
import {fetchFullTextEvidence} from './retrieval';
import {resolveDoi} from './doi';
import {atomicJson} from './upstream/atomic-json';

const CACHE_VERSION=1;
const MAX_METADATA_BYTES=2*1024*1024;
const MAX_CACHE_BYTES=2*1024*1024;
interface SourceCache {version:number;key:string;characters:number;textSha256:string;savedAt:string;evidence:Evidence;}
interface PendingSource {controller:AbortController;promise:Promise<Evidence>;subscribers:number;settled:boolean;}
const pendingSources=new Map<string,PendingSource>();
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function normalizedDoi(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 const doi=value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
 return /^10\.\d{4,9}\/[^\s\u0000-\u001f]+$/i.test(doi)?doi:undefined;
}
function sourceKey(source:Evidence):string{
 return sha256(JSON.stringify([CACHE_VERSION,source.id,normalizedDoi(source.doi),source.url,source.title,source.authors,source.year,source.journal,source.publicationType]));
}
function originalText(source:Evidence,notes?:string):boolean{
 return source.readScope==='full_text'&&typeof source.text==='string'&&Boolean(source.text.trim())&&source.text!==notes
  &&!/^\s*全文文字研读笔记[:：]/.test(source.text)&&!source.location?.includes('全文文字已分块研读');
}
function documentValid(store:Store,source:Evidence):boolean{
 const document=source.sourceDocument;if(!document)return true;
 if(document.mimeType!=='application/pdf'||!/^[a-f0-9]{64}$/.test(document.sha256)||document.fileName!==document.sha256+'.pdf')return false;
 try{const file=path.join(store.root,'source-documents',document.fileName);const stat=fs.statSync(file);return stat.isFile()&&stat.size>0&&stat.size<=8*1024*1024&&sha256(fs.readFileSync(file))===document.sha256;}catch{return false;}
}
function cachedSource(store:Store,source:Evidence,key:string,verifyDocument=(value:Evidence)=>documentValid(store,value)):Evidence|undefined{
 try{
  const file=path.join(store.root,'sources',key+'.json');if(fs.statSync(file).size>MAX_CACHE_BYTES)return;
  const cache=JSON.parse(fs.readFileSync(file,'utf8')) as SourceCache;
  if(cache.version!==CACHE_VERSION||cache.key!==key||!cache.evidence||sourceKey(cache.evidence)!==key||!originalText(cache.evidence)
   ||cache.characters!==cache.evidence.text.length||cache.textSha256!==sha256(cache.evidence.text)||!verifyDocument(cache.evidence))return;
  return structuredClone(cache.evidence);
 }catch{return;}
}

type AvailableSource = {pdfFile?:string;textHash?:string};
type MemoEntry = {stamp:string;resource:AvailableSource;pdfStamp?:string};
const verifiedLibraries = new WeakMap<Store, Map<string,MemoEntry>>();
function stamp(file:string):string|undefined {
 try {
  const stat=fs.lstatSync(file,{bigint:true});
  if(stat.isFile())return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join('/');
 }catch{/* An unavailable file is not a resource. */}
}

/** A per-list read-only view of the source reader's cache. Reuse proofs across
 * requests only while both the source record and its PDF keep their identity
 * and file times. The memo stores no paper text, and never initiates a fetch. */
export function savedPaperResourceLookup(store:Store) {
 const remember=verifiedLibraries.get(store)??new Map<string,MemoEntry>();
 verifiedLibraries.set(store,remember);
 const sourceDir=path.join(store.root,'sources'),pdfDir=path.join(store.root,'source-documents');
 let cachedFiles:Set<string>;
 try{cachedFiles=new Set(fs.readdirSync(sourceDir));}catch{cachedFiles=new Set();}
 const stamps=new Map<string,string|undefined>();
 const fileStamp=(file:string)=>{
  if(!stamps.has(file))stamps.set(file,stamp(file));
  return stamps.get(file);
 };
 const keep=(key:string,value:MemoEntry)=>{
  if(remember.size>=4096&&!remember.has(key))remember.delete(remember.keys().next().value!);
  remember.set(key,value);
 };
 const pdfValid=(source:Evidence)=>{
  const document=source.sourceDocument;
  if(!document)return true;
  if(document.mimeType!=='application/pdf'||!/^[a-f0-9]{64}$/.test(document.sha256)||document.fileName!==document.sha256+'.pdf')return false;
  const signature=fileStamp(path.join(pdfDir,document.fileName));
  if(!signature)return false;
  const key='pdf:'+document.sha256;
  if(remember.get(key)?.stamp===signature)return true;
  if(!documentValid(store,source))return false;
  keep(key,{stamp:signature,resource:{pdfFile:document.fileName}});return true;
 };
 const seenCache=new Map<string,AvailableSource|undefined>();
 const trustedForRun=(value:AvailableSource|undefined,notes:string[])=>{
  if(value?.textHash&&notes.some(note=>typeof note==='string'&&sha256(note.trim())===value.textHash))return;
  return value;
 };
 return (source:Evidence,hasOriginalText:boolean,notes:string[]):AvailableSource|undefined=>{
  if(hasOriginalText&&pdfValid(source))return {pdfFile:source.sourceDocument?.fileName};
  if(!cachedFiles.size)return;
  const key=sourceKey(source),fileName=key+'.json';
  if(!cachedFiles.has(fileName))return;
  if(seenCache.has(key))return trustedForRun(seenCache.get(key),notes);
  const signature=fileStamp(path.join(sourceDir,fileName));
  if(!signature)return;
  const old=remember.get(key);
  if(old?.stamp===signature&&(!old.resource.pdfFile||old.pdfStamp===fileStamp(path.join(pdfDir,old.resource.pdfFile)))){
   seenCache.set(key,old.resource);return trustedForRun(old.resource,notes);
  }
  const verified=cachedSource(store,source,key,pdfValid);
  const resource=verified?{pdfFile:verified.sourceDocument?.fileName,textHash:sha256(verified.text.trim())}:undefined;
  if(resource)keep(key,{stamp:signature,resource,pdfStamp:resource.pdfFile?fileStamp(path.join(pdfDir,resource.pdfFile)):undefined});
  seenCache.set(key,resource);return trustedForRun(resource,notes);
 };
}
function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const stop=()=>reject(signal.reason??new Error('原文读取已取消。'));signal.addEventListener('abort',stop,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
 });
}
function articleUrl(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port)return;url.hash='';return url.href;}catch{return;}
}
function initialUrls(source:Evidence):string[]{
 const urls=(source.fullTextUrls??[]).map(articleUrl).filter((value):value is string=>Boolean(value));
 const storedPmc=/^\s*(PMC\d+)(?=[；;\s]|$)/i.exec(source.location)?.[1]?.toUpperCase();
 if(storedPmc)urls.push(`https://www.ebi.ac.uk/europepmc/webservices/rest/${storedPmc}/fullTextXML`);
 // Old records may have a public PMC page or a previously audited XML location
 // but no newer fullTextUrls field. These are identity-bearing fixed routes.
 const locations=[source.url??'',...(source.location.match(/https:\/\/[^\s；]+/g)??[])];
 for(const value of locations){
  const safe=articleUrl(value);if(!safe)continue;const url=new URL(safe);
  if(['doi.org','dx.doi.org'].includes(url.hostname))continue;
  if(['europepmc.org','www.europepmc.org','pmc.ncbi.nlm.nih.gov','www.ebi.ac.uk'].includes(url.hostname)){
   const pmcid=/(?:^|\/)(PMC\d+)(?:\/|$)/i.exec(url.pathname)?.[1]?.toUpperCase();
   if(pmcid)urls.push(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`);
  }else if(value===source.url)urls.push(safe);
 }
 return [...new Set(urls)].slice(0,3);
}
async function openAlexLocations(doi:string,signal:AbortSignal):Promise<string[]>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('OpenAlex 论文定位超过 12 秒。')),12_000);
 const combined=AbortSignal.any([signal,controller.signal]);
 try{
  const url=new URL('https://api.openalex.org/works/'+encodeURIComponent('https://doi.org/'+doi));
  const response=await bounded(fetch(url,{signal:combined,redirect:'error',headers:{Accept:'application/json','User-Agent':'ZhicuiResearch/0.1 (identified source retrieval)'}}),combined);
  if(!response.ok){await response.body?.cancel();throw new Error(`OpenAlex 论文定位失败（HTTP ${response.status}）。`);}
  if(Number(response.headers.get('content-length')??0)>MAX_METADATA_BYTES){await response.body?.cancel();throw new Error('OpenAlex 论文元数据超过 2 MB。');}
  if(!response.body)throw new Error('OpenAlex 未返回论文元数据。');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
  try{while(true){const item=await bounded(reader.read(),combined);if(item.done)break;bytes+=item.value.byteLength;if(bytes>MAX_METADATA_BYTES){await reader.cancel();throw new Error('OpenAlex 论文元数据超过 2 MB。');}parts.push(item.value);}}finally{reader.releaseLock();}
  combined.throwIfAborted();const data=record(JSON.parse(Buffer.concat(parts).toString('utf8')));
  if(normalizedDoi(data.doi)!==doi)throw new Error('OpenAlex 返回的 DOI 与请求论文不匹配。');
  const urls:string[]=[];
  for(const candidate of [data.best_oa_location,...(Array.isArray(data.locations)?data.locations:[])]){
   const location=record(candidate);if(location.is_oa!==true)continue;
   for(const raw of [location.pdf_url,location.landing_page_url]){const url=articleUrl(raw);if(url&&!urls.includes(url))urls.push(url);if(urls.length===3)return urls;}
  }
  return urls;
 }finally{clearTimeout(timer);}
}
async function acquireSource(store:Store,source:Evidence,key:string,signal:AbortSignal):Promise<Evidence>{
 const timeout=new AbortController();const timer=setTimeout(()=>timeout.abort(new Error('原文定向读取超过 180 秒，未保存不完整来源。')),180_000);
 const combined=AbortSignal.any([signal,timeout.signal]);
 try{
  const abstract=source.abstract?.trim()?source.abstract:source.readScope==='abstract'?source.text:undefined;
  // A derived note or broken document pointer must not cause the lower-level
  // full-text fetcher to mistake this request for an already acquired body.
  const candidate:Evidence={...source,abstract,sourceDocument:undefined,text:abstract??'论文元数据；尚未取得原文。',readScope:abstract?'abstract':'metadata'};
  const attempt=async(urls:string[]):Promise<Evidence|undefined>=>{
   combined.throwIfAborted();
   try{
    const result=await bounded(fetchFullTextEvidence([{...candidate,fullTextUrls:urls}],combined,undefined,{maxResults:1,cacheDirectory:path.join(store.root,'source-documents')}),combined);
    combined.throwIfAborted();const body=result.evidence.find(entry=>entry.id===source.id);
    if(!body||sourceKey(body)!==key||!originalText(body)||!documentValid(store,body))return;
    return {...source,abstract,fullTextUrls:body.fullTextUrls,sourceDocument:body.sourceDocument,text:body.text,readScope:'full_text',location:body.location,retrievedAt:body.retrievedAt};
   }catch{combined.throwIfAborted();return;}
  };
  let found=await attempt(initialUrls(source));
  const doi=normalizedDoi(source.doi)??normalizedDoi(source.url);
  if(!found&&doi){
   let urls:string[]=[];try{urls=await openAlexLocations(doi,combined);}catch{combined.throwIfAborted();}
   if(urls.length)found=await attempt(urls);
   if(!found){
    try{const resolved=await bounded(resolveDoi(doi,combined),combined);combined.throwIfAborted();if(normalizedDoi(resolved.doi)===doi){const url=articleUrl(resolved.url);if(url)found=await attempt([url]);}}catch{combined.throwIfAborted();}
   }
  }
  combined.throwIfAborted();
  if(!found)throw new Error('尚未取得这篇论文可验证的原文正文。已按现有来源、开放获取位置及 DOI 定向核查；摘要、跳转页和研读笔记不会当作原文返回。');
  const cache:SourceCache={version:CACHE_VERSION,key,characters:found.text.length,textSha256:sha256(found.text),savedAt:new Date().toISOString(),evidence:found};
  // Independent view cache only: never write a stale evidence array back into a
  // live run, and never imply that displaying a source completed model reading.
  combined.throwIfAborted();atomicJson(path.join(store.root,'sources',key+'.json'),cache);return found;
 }finally{clearTimeout(timer);}
}
function subscribe(pending:PendingSource,signal:AbortSignal):Promise<{evidence:Evidence;cached:boolean}>{
 pending.subscribers++;
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(error?:unknown,evidence?:Evidence)=>{
   if(done)return;done=true;signal.removeEventListener('abort',stop);pending.subscribers--;
   if(!pending.settled&&pending.subscribers===0)pending.controller.abort(new Error('原文读取的全部观看请求已取消。'));
   if(error!==undefined)reject(error);else resolve({evidence:structuredClone(evidence!),cached:false});
  };
  const stop=()=>finish(signal.reason??new Error('原文读取已取消。'));
  signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  pending.promise.then(evidence=>finish(undefined,evidence),error=>finish(error));
 });
}

/** Resolve only a source identity already saved in this run. No caller URL is
 * accepted; successful view retrieval is isolated from research task state. */
export async function getEvidenceSource(store:Store,runId:string,evidenceId:string,signal:AbortSignal):Promise<{evidence:Evidence;cached:boolean}>{
 signal.throwIfAborted();const run=store.getSourceRun(runId);const matches=run.evidence.filter(entry=>entry.id===evidenceId);
 if(matches.length!==1)throw new Error('该任务中不存在唯一对应的证据，不能读取其他任务或任意地址。');
 const source=structuredClone(matches[0]);
 if(!['abstract','full_text','metadata'].includes(source.readScope))throw new Error('这项证据是上传材料或计算结果，不是可定向获取的外部论文。');
 const notes=run.reading?.entries.find(entry=>entry.evidenceId===source.id)?.notes;
 if(originalText(source,notes)&&documentValid(store,source))return {evidence:source,cached:true};
 const key=sourceKey(source),cached=cachedSource(store,source,key);if(cached)return {evidence:cached,cached:true};
 const pendingKey=store.root+'\0'+key;let pending=pendingSources.get(pendingKey);
 if(!pending||pending.controller.signal.aborted){
  const entry:PendingSource={controller:new AbortController(),promise:Promise.resolve(source),subscribers:0,settled:false};
  entry.promise=Promise.resolve().then(()=>acquireSource(store,source,key,entry.controller.signal)).finally(()=>{entry.settled=true;if(pendingSources.get(pendingKey)===entry)pendingSources.delete(pendingKey);});
  pending=entry;pendingSources.set(pendingKey,entry);
 }
 return subscribe(pending,signal);
}
