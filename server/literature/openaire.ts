import {createHash} from 'node:crypto';
import type {Evidence,RetrievalDiagnostic} from '../../shared/types';
import {readLiteratureResponse} from './network';
import {checkedTotal,list,object,oneDoi,pageOptions,publicUrl,queryText,text} from './metadata-utils';

// Official contracts checked 2026-11-09. Anonymous calls: 60 per hour.
// https://graph.openaire.eu/docs/apis/terms/
// https://graph.openaire.eu/docs/apis/graph-api/research-products/
// https://graph.openaire.eu/docs/data-model/entities/research-product/
const requestStarts:number[]=[];
function reserveRequest(signal:AbortSignal):void {
 signal.throwIfAborted();const now=Date.now();while(requestStarts.length&&requestStarts[0]<=now-3_600_000)requestStarts.shift();
 if(requestStarts.length>=60)throw new Error('OpenAIRE 本服务已达到匿名访问每小时 60 次上限，本次跳过此来源；其他来源可继续。');
 requestStarts.push(now);
}
export class OpenAireSearchError extends Error {
 constructor(message:string,readonly diagnostics:RetrievalDiagnostic[]){super(message);this.name='OpenAireSearchError';}
}
function checkedQuery(value:string):string {
 const query=queryText(value,'OpenAIRE');
 // The documented `search` parameter is keyword search. Do not pretend its
 // semantics are interchangeable with another index's Boolean/field syntax.
 if(/\b(?:AND|OR|NOT|ANDNOT)\b|[:()\[\]{}"\\]/.test(query))throw new Error('OpenAIRE 查询语法当前支持纯关键词，布尔条件或字段表达式不能安全转换；请提供不含布尔运算的关键词查询。');
 return query;
}
export async function searchOpenAire(query:string,signal:AbortSignal,options:{start?:number;size?:number;onProgress?:(message:string)=>void}={}):Promise<{evidence:Evidence[];diagnostics:RetrievalDiagnostic[];more:boolean;warnings:string[]}> {
 signal.throwIfAborted();const diagnostics:RetrievalDiagnostic[]=[],warnings:string[]=[];const url=new URL('https://api.openaire.eu/graph/v3/research-products');
 try{
  const search=checkedQuery(query),{start,size,page}=pageOptions(options.start,options.size,'OpenAIRE');url.search=new URLSearchParams({search,type:'publication',page:String(page),pageSize:String(size)}).toString();
  const raw=await readLiteratureResponse(url,signal,{headers:{Accept:'application/json','User-Agent':'ZhicuiResearch/0.1 (metadata search)'},beforeRequest:async()=>reserveRequest(signal),onFallback:message=>{warnings.push(message);diagnostics.push({source:'OpenAIRE',query,url:url.href,status:'error',returned:0,error:message,retrievedAt:new Date().toISOString()});options.onProgress?.(message);}});signal.throwIfAborted();
  let data:Record<string,unknown>;try{data=object(JSON.parse(raw));}catch{throw new Error('OpenAIRE 未返回有效 JSON。');}
  const header=object(data.header),total=checkedTotal(header.numFound,'OpenAIRE');if(!Array.isArray(data.results)||data.results.length>size||data.error||(header.page!==undefined&&header.page!==page)||(header.pageSize!==undefined&&header.pageSize!==size))throw new Error('OpenAIRE 响应列表或分页身份无效。');
  if(!data.results.length&&total>start)throw new Error('OpenAIRE 命中总数与空结果列表不一致。');
  const evidence:Evidence[]=[],at=new Date().toISOString(),seen=new Map<string,string>();
  for(const rawItem of data.results){
   const item=object(rawItem);if(item.type!=='publication'){warnings.push('OpenAIRE 返回非 publication 记录，已排除数据集、软件或其他类型。');continue;}
   const id=text(item.id),title=text(item.mainTitle);if(!id||id.length>300||!title)throw new Error('OpenAIRE 论文缺少有效标识或题名。');
   let sourceDoi:string|undefined;
   try{sourceDoi=oneDoi(list(item.pids).map(object).filter(value=>text(value.scheme).toLowerCase()==='doi').map(value=>value.value),'OpenAIRE');}
   catch{warnings.push(`OpenAIRE ${id} 聚合记录出现冲突 DOI，已跳过此条身份不明记录。`);continue;}
   const descriptions=[...new Set(list(item.descriptions).map(text).filter(Boolean))],abstract=descriptions.join('\n\n');
   const authors=list(item.authors).map(value=>text(object(value).fullName)).filter(Boolean).join(', '),date=text(item.publicationDate),year=/^(\d{4})(?:-|$)/.exec(date)?.[1],journal=text(object(item.container).name);
   const instances=list(item.instances).map(object),types=instances.map(instance=>text(instance.type));
   const paratext=types.some(type=>/retract|corrigend|erratum|withdraw|expression of concern/i.test(type))||/^(?:retraction|retracted|withdrawal|withdrawn|correction|corrigendum|erratum|expression of concern)\s*[:\[–-]/i.test(title);
   const publicationType=paratext?'paratext':types.some(type=>/preprint/i.test(type))&&!types.some(type=>/^article$/i.test(type))?'preprint':types.some(type=>/chapter|part of book/i.test(type))?'book-chapter':types.some(type=>/^book$/i.test(type))?'book':types.some(type=>/^article$/i.test(type))?'article':undefined;
   const links=[...new Set(instances.filter(instance=>{const access=object(instance.accessRight);return access.code==='c_abf2'||/^(?:OPEN|OPEN ACCESS)$/i.test(text(access.label));}).flatMap(instance=>{
    let identity:string|undefined;
    try{identity=oneDoi([...list(instance.pids),...list(instance.alternateIdentifiers)].map(object).filter(value=>text(value.scheme).toLowerCase()==='doi').map(value=>value.value),'OpenAIRE 原文版本');}
    catch{warnings.push(`OpenAIRE ${id} 的一个原文版本出现冲突 DOI，已跳过该版本链接。`);return [];}
    if(sourceDoi&&identity&&identity!==sourceDoi){warnings.push('OpenAIRE 原文版本 DOI 与主记录不一致，该版本链接未采用。');return [];}
    return list(instance.urls).map(value=>publicUrl(value,sourceDoi)).filter((value):value is string=>Boolean(value));
   }))].slice(0,6);
   const row:Evidence={id:'E-'+createHash('sha256').update(sourceDoi||'openaire:'+id).digest('hex').slice(0,12),title,url:sourceDoi?'https://doi.org/'+sourceDoi:links[0]??`https://api.openaire.eu/graph/v3/research-products/${encodeURIComponent(id)}`,...(sourceDoi?{doi:sourceDoi}:{}),...(authors?{authors}:{}),...(year?{year}:{}),...(journal?{journal}:{}),...(publicationType?{publicationType}:{}),...(abstract&&!paratext?{abstract}:{}),...(links.length&&!paratext?{fullTextUrls:links}:{}),readScope:abstract&&!paratext?'abstract':'metadata',text:abstract&&!paratext?abstract:`文献元数据：${title}。${paratext?'更正、撤回或关注声明，不作为正常研究证据。':'未取得摘要或描述。'}`,location:`OpenAIRE Graph ${id}；${abstract&&!paratext?'原始摘要/描述，未读取正文':'书目元数据'}；元数据来源 OpenAIRE（CC-BY）；检索接口 ${url.href}`,retrievedAt:at};
   if(paratext)warnings.push(`OpenAIRE《${title.slice(0,80)}》属于更正或撤回声明，保留为元数据。`);
   const previous=seen.get(id);if(previous&&previous!==JSON.stringify(row))throw new Error('OpenAIRE 返回相同原始记录标识的冲突内容。');if(!previous){seen.set(id,JSON.stringify(row));evidence.push(row);}
  }
  diagnostics.push({source:'OpenAIRE',query,url:url.href,status:'ok',returned:data.results.length,retrievedAt:at});return {evidence,diagnostics,warnings,more:data.results.length>0&&start+data.results.length<Math.min(total,10_000)};
 }catch(error){signal.throwIfAborted();const message=error instanceof Error?error.message:'OpenAIRE 检索失败';diagnostics.push({source:'OpenAIRE',query,url:url.href,status:/timeout|timed out/i.test(message)?'timeout':'error',returned:0,error:message,retrievedAt:new Date().toISOString()});throw new OpenAireSearchError(message,diagnostics);}
}
export const probeOpenAire=(signal:AbortSignal,onProgress?:(message:string)=>void)=>searchOpenAire('education',signal,{size:1,onProgress});
