import {createHash} from 'node:crypto';
import {DOMParser} from '@xmldom/xmldom';
import {readLiteratureResponse,LiteratureNetworkError} from './network';
import type {Evidence,RetrievalDiagnostic} from '../../shared/types';

// Official contracts checked 2026-10-28:
// https://www.ncbi.nlm.nih.gov/books/NBK25499/
// https://eutilities.github.io/site/API_Key/usageandkey/
const BASE='https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const INTERVAL=350,TOTAL_TIMEOUT=35_000,MAX_BYTES=4*1024*1024;
let queue:Promise<void>=Promise.resolve(),lastStart=-Infinity;
class InvalidResponse extends Error {}
export class PubmedSearchError extends Error {
 constructor(message:string,readonly diagnostics:RetrievalDiagnostic[]){super(message);this.name='PubmedSearchError';}
}
export interface PubmedResult {evidence:Evidence[];diagnostics:RetrievalDiagnostic[];more:boolean;warnings:string[];}

function cancelled():DOMException{return new DOMException('PubMed 请求已取消。','AbortError');}
function waitFor<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void promise.catch(()=>{});return Promise.reject(cancelled());}
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(cancelled());};const cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}
function delay(ms:number,signal:AbortSignal):Promise<void>{
 if(signal.aborted)return Promise.reject(cancelled());
 return new Promise((resolve,reject)=>{const finish=()=>{signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(cancelled());};signal.addEventListener('abort',abort,{once:true});});
}
async function slot(signal:AbortSignal){
 // An aborted waiter cannot release a later ticket before the previous ticket.
 // Only request starts are serialized; all starts across callers are >=350ms apart.
 const turn=queue.then(async()=>{if(signal.aborted)throw cancelled();const ms=lastStart+INTERVAL-Date.now();if(ms>0)await delay(ms,signal);if(signal.aborted)throw cancelled();lastStart=Date.now();});
 queue=turn.catch(()=>{});await waitFor(turn,signal);
}
const clean=(value:string)=>value.replace(/\s+/g,' ').trim();
const children=(element:Element|undefined,name:string):Element[]=>{
 const result:Element[]=[];if(element)for(let child=element.firstChild;child;child=child.nextSibling)if(child.nodeType===1&&(child as Element).tagName===name)result.push(child as Element);return result;
};
const child=(element:Element|undefined,name:string)=>children(element,name)[0];
const value=(element:Element|undefined)=>clean(element?.textContent??'');
function doi(value:string):string|undefined {const normalized=value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/.test(normalized)?normalized:undefined;}
function uniqueIdentifier(values:string[],label:string):string|undefined{const unique=[...new Set(values.filter(Boolean))];if(unique.length>1)throw new InvalidResponse(`PubMed 记录含冲突的 ${label}，未混用文章身份。`);return unique[0];}
function parseArticles(xml:string,requested:Set<string>,at:string,url:string):Evidence[]{
 const fail=():never=>{throw new InvalidResponse('PubMed XML 无效、含错误响应或结构不完整。');};
 if(/<!ENTITY\b/i.test(xml)||/<!DOCTYPE[^>]*\[/i.test(xml))fail();
 let document:Document;
 try{document=new DOMParser({errorHandler:{warning:fail,error:fail,fatalError:fail}}).parseFromString(xml,'application/xml');}catch{fail();}
 const root=document!.documentElement;if(root?.tagName!=='PubmedArticleSet')fail();
 const records:Element[]=[];let visited=0;const stack:Node[]=[root];
 while(stack.length){const node=stack.pop()!;if(++visited>100_000)fail();if(node.nodeType===1&&/^(ERROR|ErrorList)$/i.test(node.nodeName))fail();for(let entry=node.lastChild;entry;entry=entry.previousSibling)stack.push(entry);}
 for(let node=root.firstChild;node;node=node.nextSibling)if(node.nodeType===1){if(!['PubmedArticle','PubmedBookArticle'].includes(node.nodeName))fail();records.push(node as Element);}
 const found=new Map<string,Evidence>();
 for(const record of records){
  const book=record.tagName==='PubmedBookArticle';const citation=child(record,book?'BookDocument':'MedlineCitation');const article=book?citation:child(citation,'Article');
  const pmid=value(child(citation,'PMID'));if(!/^[1-9]\d*$/.test(pmid)||!requested.has(pmid)||!article)throw new InvalidResponse('PubMed EFetch 返回了未知或缺失的 PMID，未导入邻近文章。');
  const bookNode=child(article,'Book'),title=value(child(article,'ArticleTitle'))||(book?value(child(bookNode,'BookTitle')):'');if(!title)throw new InvalidResponse('PubMed 记录缺少题名。');
  const ids=[...children(child(child(record,book?'PubmedBookData':'PubmedData'),'ArticleIdList'),'ArticleId'),...(book?children(child(article,'ArticleIdList'),'ArticleId'):[])];
  const idPmids=ids.filter(id=>id.getAttribute('IdType')==='pubmed').map(value);if(idPmids.some(id=>id!==pmid))throw new InvalidResponse('PubMed 记录中的 PMID 标识不一致。');
  const articleDoi=uniqueIdentifier([...ids.filter(id=>id.getAttribute('IdType')==='doi').map(id=>doi(value(id))??''),...children(article,'ELocationID').filter(id=>id.getAttribute('EIdType')==='doi').map(id=>doi(value(id))??'')],'DOI');
  const pmcid=uniqueIdentifier(ids.filter(id=>id.getAttribute('IdType')==='pmc').map(value).filter(id=>/^PMC[1-9]\d*$/.test(id)),'PMCID');
  const authors=children(child(article,'AuthorList'),'Author').map(author=>value(child(author,'CollectiveName'))||[value(child(author,'ForeName'))||value(child(author,'Initials')),value(child(author,'LastName')),value(child(author,'Suffix'))].filter(Boolean).join(' ')).filter(Boolean).join(', ');
  const journal=child(article,'Journal'),pubDate=book?child(bookNode,'PubDate'):child(child(journal,'JournalIssue'),'PubDate');
  const date=value(child(pubDate,'Year'))||value(child(pubDate,'MedlineDate'))||value(child(child(article,'ArticleDate'),'Year'));const year=date.match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/)?.[0];
  const sections=children(child(article,'Abstract'),'AbstractText').map(section=>{const body=value(section);if(!body)return '';const label=clean(section.getAttribute('Label')||section.getAttribute('NlmCategory')||'');return label&&label!=='UNASSIGNED'?`${label}: ${body}`:body;}).filter(Boolean);
  const abstract=sections.join('\n\n');const types=children(child(article,'PublicationTypeList'),'PublicationType').map(value);
  const paratext=types.some(type=>/^(?:Published Erratum|Retraction of Publication|Retracted Publication|Expression of Concern)$/i.test(type));
  const publicationType=book?(child(article,'ArticleTitle')?'book-chapter':'book'):paratext?'paratext':types.some(type=>/Review|Meta-Analysis/i.test(type))?'review':types.includes('Preprint')?'preprint':types.includes('Journal Article')?'article':undefined;
  const evidence:Evidence={id:'E-'+createHash('sha256').update(articleDoi||`pubmed:${pmid}`).digest('hex').slice(0,12),title,url:`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,...(articleDoi?{doi:articleDoi}:{}),...(authors?{authors}:{}),...(year?{year}:{}),...(value(child(journal,'Title'))?{journal:value(child(journal,'Title'))}:{}),...(publicationType?{publicationType}:{}),...(abstract&&!paratext?{abstract}:{}),...(pmcid?{fullTextUrls:[`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`]}:{}),readScope:abstract&&!paratext?'abstract':'metadata',text:abstract&&!paratext?abstract:`文献元数据：${title}。${paratext?'记录为撤稿、更正或关注声明，未计作可支持综述的研究摘要。':'未取得摘要，不能据此宣称原文支持内容性主张。'}`,location:`PubMed PMID: ${pmid}${pmcid?`；PMCID: ${pmcid}（仓储标识与待验证正文入口，开放访问状态未核验）`:''}；${abstract&&!paratext?'已读取 EFetch 完整摘要文本，未读取正文':'书目元数据，未读取正文'}；检索接口 ${url}`,retrievedAt:at};
  if(found.has(pmid)&&JSON.stringify(found.get(pmid))!==JSON.stringify(evidence))throw new InvalidResponse('PubMed 同一 PMID 返回冲突内容，未任意选择记录。');found.set(pmid,evidence);
 }
 return [...found.values()];
}

export async function searchPubmed(query:string,signal:AbortSignal,options:{start?:number;size?:number;onProgress?:(message:string)=>void}={}):Promise<PubmedResult>{
 if(signal.aborted)throw cancelled();if(!query.trim()||query.length>8000)throw new PubmedSearchError('PubMed 查询为空或超过 8000 字符，未截断改变检索语义。',[]);
 const start=options.start??0;if(!Number.isSafeInteger(start)||start<0||start>=10_000)throw new PubmedSearchError('PubMed retstart 必须位于 0–9999；超过前 10000 条需另行分区检索。',[]);
 const size=Math.min(50,10_000-start,Number.isFinite(options.size)?Math.max(1,Math.floor(options.size!)):50);
 const secrets=[process.env.NCBI_EMAIL,process.env.NCBI_API_KEY].filter((entry):entry is string=>Boolean(entry));
 const safe=(text:string)=>secrets.reduce((clean,secret)=>[secret,encodeURIComponent(secret),new URLSearchParams({v:secret}).toString().slice(2)].reduce((s,v)=>s.split(v).join('[redacted]'),clean),text);
 const diagnostics:RetrievalDiagnostic[]=[],warnings:string[]=[];const total=new AbortController(),timer=setTimeout(()=>total.abort(),TOTAL_TIMEOUT);const combined=AbortSignal.any([signal,total.signal]);
 const request=async<T>(endpoint:string,params:Record<string,string>,parse:(raw:string,url:string)=>{value:T;returned:number}):Promise<T>=>{
  const url=BASE+endpoint,body=new URLSearchParams({db:'pubmed',tool:'ZhicuiResearch',...params});const auditUrl=safe(url+'?'+body.toString());
  if(process.env.NCBI_EMAIL)body.set('email',process.env.NCBI_EMAIL);if(process.env.NCBI_API_KEY)body.set('api_key',process.env.NCBI_API_KEY);
  try{
   const raw=await waitFor(readLiteratureResponse(new URL(url),combined,{method:'POST',body:body.toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:endpoint==='esearch.fcgi'?'application/json':'application/xml','User-Agent':'ZhicuiResearch/0.1'},maximumBytes:MAX_BYTES,beforeRequest:()=>slot(combined),onFallback:message=>{
    const warning=safe(message);warnings.push(warning);diagnostics.push({source:'PubMed',query:safe(query),url:auditUrl,status:/TIMEOUT/.test(warning)?'timeout':'error',returned:0,error:warning,retrievedAt:new Date().toISOString()});if(options.onProgress)options.onProgress(warning);else console.warn(warning);
   }}),combined);
   if(combined.aborted)throw cancelled();const parsed=parse(raw,auditUrl);diagnostics.push({source:'PubMed',query:safe(query),url:auditUrl,status:'ok',returned:parsed.returned,retrievedAt:new Date().toISOString()});return parsed.value;
  }catch(error){
   if(signal.aborted)throw cancelled();const category=error instanceof LiteratureNetworkError?error.category:'';const timedOut=total.signal.aborted||/TIMEOUT/.test(category);const message=timedOut?'PubMed 请求或队列等待达到时限。':error instanceof InvalidResponse?safe(error.message):category.startsWith('HTTP_')?'PubMed HTTP '+category.slice(5):category==='RESPONSE_TOO_LARGE'?'PubMed 响应超过 4 MiB 上限，未截断后导入。':error instanceof LiteratureNetworkError?safe(error.message):'PubMed 请求失败或返回内容无法解析。';diagnostics.push({source:'PubMed',query:safe(query),url:auditUrl,status:timedOut?'timeout':'error',returned:0,error:message,retrievedAt:new Date().toISOString()});throw new PubmedSearchError(message,[...diagnostics]);
  }
 };
 try{
  const search=await request('esearch.fcgi',{term:query,retmode:'json',retstart:String(start),retmax:String(size)},raw=>{
   let data:any;try{data=JSON.parse(raw);}catch{throw new InvalidResponse('PubMed ESearch 未返回有效 JSON。');}
   const result=data?.esearchresult;if(data?.error||result?.errorlist||result?.ERROR)throw new InvalidResponse('PubMed ESearch 返回查询错误，未将其当作零命中。');
   if(!result||!/^\d+$/.test(String(result.count))||!Number.isSafeInteger(Number(result.count))||!Array.isArray(result.idlist)||result.idlist.some((id:unknown)=>typeof id!=='string'||!/^[1-9]\d*$/.test(id))||result.idlist.length>size)throw new InvalidResponse('PubMed ESearch 响应缺少有效总数或 PMID 列表。');
   if(!result.idlist.length&&Number(result.count)>start)throw new InvalidResponse('PubMed ESearch 总数与空 PMID 列表不一致。');
   if(result.warninglist&&Object.keys(result.warninglist).length)warnings.push('PubMed ESearch 返回查询提示：'+safe(JSON.stringify(result.warninglist)).slice(0,2000));
   if(typeof result.querytranslation==='string'&&result.querytranslation!==query)warnings.push('PubMed 实际查询翻译：'+safe(result.querytranslation));
   if(Number(result.count)>10_000)warnings.push(`PubMed 报告 ${Number(result.count)} 条命中；本接口仅可分页取得前 10000 条，未声明检索穷尽。`);
   return {value:{ids:[...new Set<string>(result.idlist)],count:Number(result.count),returned:result.idlist.length},returned:result.idlist.length};
  });
  if(!search.ids.length)return {evidence:[],diagnostics,more:false,warnings};
  const at=new Date().toISOString();const evidence=await request('efetch.fcgi',{id:search.ids.join(','),retmode:'xml'},(raw,url)=>{const entries=parseArticles(raw,new Set(search.ids),at,url);return {value:entries,returned:entries.length};});
  const returned=new Set(evidence.map(entry=>/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/$/.exec(entry.url??'')?.[1]));const missing=search.ids.filter(id=>!returned.has(id));
  if(missing.length){const warning='PubMed EFetch 未返回请求的 PMID：'+missing.join(', ')+'；本页获取不完整。';warnings.push(warning);diagnostics.push({source:'PubMed',query:safe(query),url:BASE+'efetch.fcgi',status:'error',returned:0,error:warning,retrievedAt:new Date().toISOString()});}
  return {evidence,diagnostics,more:start+search.returned<Math.min(search.count,10_000),warnings};
 }finally{clearTimeout(timer);}
}
