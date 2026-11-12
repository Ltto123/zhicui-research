import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Evidence,RetrievalDiagnostic} from '../../shared/types';
import {readLiteratureResponse} from './network';

// Official API example and a live response were checked 2026-11-09.
// https://eric.ed.gov/pdf/Using_ERIC_API_for_Research_Topics.pdf
// e_fulltextauth=1 is an ERIC-hosted PDF location, not evidence of reading it.
const FIELDS='id,title,author,description,publicationdateyear,source,publicationtype,peerreviewed,e_fulltextauth,url';
const clean=(value:unknown)=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const strings=(value:unknown):string[]=>Array.isArray(value)?value.map(clean).filter(Boolean):clean(value)?[clean(value)]:[];
let queue:Promise<void>=Promise.resolve(),lastStart=-Infinity;
export class EricSearchError extends Error {
 constructor(message:string,readonly diagnostics:RetrievalDiagnostic[]){super(message);this.name='EricSearchError';}
}
export interface EricResult {evidence:Evidence[];diagnostics:RetrievalDiagnostic[];more:boolean;warnings:string[];}

async function slot(signal:AbortSignal):Promise<void>{
 // Courtesy throttle shared by searches and connection checks. Each transport
 // attempt (including a network fallback) obtains a separate request slot.
 const turn=queue.then(async()=>{signal.throwIfAborted();const pause=lastStart+500-Date.now();if(pause>0)await delay(pause,undefined,{signal});signal.throwIfAborted();lastStart=Date.now();});
 queue=turn.catch(()=>{});
 if(signal.aborted){void turn.catch(()=>{});signal.throwIfAborted();}
 await new Promise<void>((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});turn.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}
function doiFromUrl(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||!['doi.org','dx.doi.org'].includes(url.hostname)||url.search||url.hash)return;const doi=decodeURIComponent(url.pathname.slice(1)).toLowerCase();return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/.test(doi)?doi:undefined;}catch{return;}
}
function publicationType(types:string[]):string|undefined{
 if(types.includes('Journal Articles'))return 'article';
 if(types.some(type=>/^Reports\b/i.test(type)))return 'report';
 if(types.some(type=>/^Dissertations\/Theses\b/i.test(type)))return 'dissertation';
 if(types.some(type=>/^Books\b/i.test(type)))return 'book';
 if(types.some(type=>/^Speeches\/Meeting Papers\b/i.test(type)))return 'conference-paper';
 return types.length?`ERIC: ${types.join('; ')}`:undefined;
}
function parse(raw:string,start:number,size:number,url:string):{evidence:Evidence[];returned:number;more:boolean}{
 const fail=(reason='响应结构或文献字段无效'):never=>{throw new Error(`ERIC ${reason}，未将其导入为论文。`);};
 let data:Record<string,unknown>;try{data=object(JSON.parse(raw));}catch{fail('未返回有效 JSON');}
 if(data!.error||data!.errors)fail('返回查询错误');
 const response=object(data!.response),total=response.numFound,rows=response.docs;
 if(!Number.isSafeInteger(total)||Number(total)<0||!Array.isArray(rows)||rows.length>size)fail();
 if(response.start!==undefined&&response.start!==start)fail('返回的分页位置与请求不符');
 if(!(rows as unknown[]).length&&Number(total)>start)fail('命中总数与空结果列表不一致');
 if(Number(total)<start+(rows as unknown[]).length&&(rows as unknown[]).length)fail('分页总数与返回记录不符');
 const found=new Map<string,Evidence>(),at=new Date().toISOString();
 for(const rawRow of rows as unknown[]){
  const row=object(rawRow),id=clean(row.id),title=clean(row.title);if(!/^E[DJ]\d{3,12}$/.test(id)||!title)fail();
  const notice=/^(?:retraction|retracted|withdrawal|withdrawn|correction|corrigendum|erratum|expression of concern)\s*[:\[–-]/i.test(title);
  const abstract=notice?'':clean(row.description),authors=strings(row.author).join('; '),types=strings(row.publicationtype),type=notice?'paratext':publicationType(types),source=clean(row.source);
  const rawYear=typeof row.publicationdateyear==='number'?String(row.publicationdateyear):clean(row.publicationdateyear),year=/^(?:1\d{3}|20\d{2})$/.test(rawYear)?rawYear:undefined;
  const doi=doiFromUrl(row.url),hasPdf=!notice&&(row.e_fulltextauth===1||row.e_fulltextauth==='1'||row.e_fulltextauth===true);
  const review=row.peerreviewed==='T'?'是':row.peerreviewed==='F'?'否':'未提供';
  const evidence:Evidence={id:'E-'+createHash('sha256').update(doi||`eric:${id.toLowerCase()}`).digest('hex').slice(0,12),title,url:`https://eric.ed.gov/?id=${id}`,
   ...(doi?{doi}:{}),...(authors?{authors}:{}),...(year?{year}:{}),...(type?{publicationType:type}:{}),...(source&&type==='article'?{journal:source}:{}),
   ...(abstract?{abstract}:{}),...(hasPdf?{fullTextUrls:[`https://files.eric.ed.gov/fulltext/${id}.pdf`]}:{}),
   text:abstract||`文献元数据：${title}。${notice?'更正、撤回或关注声明，不作为正常研究证据。':'尚未取得摘要，不能据此判断论文的具体发现。'}`,readScope:abstract?'abstract':'metadata',retrievedAt:at,
   location:`ERIC ${id}；${types.length?'原始文献类型 '+types.join(' / ')+'；':''}${source?'来源 '+source+'；':''}ERIC 同行评审标记：${review}；${abstract?'已取得原始摘要，未读取正文':notice?'仅保留更正或撤回声明题录':'仅书目元数据'}${hasPdf?'；提供 ERIC 全文入口，正文尚未获取核验':''}；检索接口 ${url}`};
  if(found.has(id)&&JSON.stringify(found.get(id))!==JSON.stringify(evidence))fail('同一标识返回冲突记录');found.set(id,evidence);
 }
 return {evidence:[...found.values()],returned:(rows as unknown[]).length,more:(rows as unknown[]).length>0&&start+(rows as unknown[]).length<Number(total)};
}

export async function searchEric(query:string,signal:AbortSignal,options:{start?:number;size?:number;onProgress?:(message:string)=>void}={}):Promise<EricResult>{
 signal.throwIfAborted();
 if(!query.trim()||query.length>4000||/[\u0000-\u001f\u007f]/.test(query))throw new EricSearchError('ERIC 查询语法无效：内容为空、含控制字符或超过 4000 字符，未截断改变检索语义。',[]);
 const start=options.start??0;if(!Number.isSafeInteger(start)||start<0||start>1_000_000)throw new EricSearchError('ERIC 分页起点必须为 0–1000000 的整数。',[]);
 const size=Number.isFinite(options.size)?Math.min(50,Math.max(1,Math.floor(options.size!))):50;
 const url=new URL('https://api.ies.ed.gov/eric/');url.search=new URLSearchParams({search:query,format:'json',rows:String(size),start:String(start),fields:FIELDS}).toString();
 const diagnostics:RetrievalDiagnostic[]=[],warnings:string[]=[];const combined=AbortSignal.any([signal,AbortSignal.timeout(25_000)]);
 try{
  const raw=await readLiteratureResponse(url,combined,{headers:{Accept:'application/json','User-Agent':'ZhicuiResearch/0.1 (education metadata search)'},maximumBytes:4_000_000,beforeRequest:()=>slot(combined),onFallback:message=>{
   warnings.push(message);diagnostics.push({source:'ERIC',query,url:url.href,status:'error',returned:0,error:message,retrievedAt:new Date().toISOString()});if(options.onProgress)options.onProgress(message);else console.warn(message);
  }});
  combined.throwIfAborted();const parsed=parse(raw,start,size,url.href);diagnostics.push({source:'ERIC',query,url:url.href,status:'ok',returned:parsed.returned,retrievedAt:new Date().toISOString()});
  return {evidence:parsed.evidence,diagnostics,warnings,more:parsed.more};
 }catch(error){
  signal.throwIfAborted();const message=error instanceof Error?error.message:'ERIC 请求失败';diagnostics.push({source:'ERIC',query,url:url.href,status:combined.aborted||/TIMEOUT|timed out|超时/i.test(message)?'timeout':'error',returned:0,error:message,retrievedAt:new Date().toISOString()});throw new EricSearchError(message,diagnostics);
 }
}
