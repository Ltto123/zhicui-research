import {createHash} from 'node:crypto';
import type {Evidence,RetrievalDiagnostic} from '../../shared/types';
import {readLiteratureResponse} from './network';
import {checkedTotal,list,object,oneDoi,pageOptions,publicUrl,queryText,text} from './metadata-utils';

// Official metadata model and CC0 terms checked 2026-11-09.
// https://doaj.github.io/doaj-docs/master/data_models/IncomingAPIArticle.html
// https://doaj.org/terms/ and https://doaj.org/api/docs
export class DoajSearchError extends Error {
 constructor(message:string,readonly diagnostics:RetrievalDiagnostic[]){super(message);this.name='DoajSearchError';}
}
function checkedQuery(value:string):string {
 const query=queryText(value,'DOAJ');let quoted=false,depth=0;
 for(let i=0;i<query.length;i++){const ch=query[i];if(ch==='\\'){if(++i>=query.length)throw new Error('DOAJ 查询语法无效。');continue;}if(ch==='"')quoted=!quoted;if(!quoted&&ch==='(')depth++;if(!quoted&&ch===')'&&--depth<0)throw new Error('DOAJ 查询语法中的括号不匹配。');}
 if(quoted||depth)throw new Error('DOAJ 查询语法中的引号或括号不匹配。');return query;
}
export async function searchDoaj(query:string,signal:AbortSignal,options:{start?:number;size?:number;onProgress?:(message:string)=>void}={}):Promise<{evidence:Evidence[];diagnostics:RetrievalDiagnostic[];more:boolean;warnings:string[]}> {
 signal.throwIfAborted();const diagnostics:RetrievalDiagnostic[]=[],warnings:string[]=[];let url=new URL('https://doaj.org/api/search/articles/');
 try{
  const search=checkedQuery(query),{start,size,page}=pageOptions(options.start,options.size,'DOAJ');
  url=new URL('https://doaj.org/api/search/articles/'+encodeURIComponent(search));url.search=new URLSearchParams({page:String(page),pageSize:String(size)}).toString();
  const raw=await readLiteratureResponse(url,signal,{headers:{Accept:'application/json','User-Agent':'ZhicuiResearch/0.1 (metadata search)'},onFallback:message=>{warnings.push(message);diagnostics.push({source:'DOAJ',query,url:url.href,status:'error',returned:0,error:message,retrievedAt:new Date().toISOString()});options.onProgress?.(message);}});signal.throwIfAborted();
  let data:Record<string,unknown>;try{data=object(JSON.parse(raw));}catch{throw new Error('DOAJ 未返回有效 JSON。');}
  const total=checkedTotal(data.total,'DOAJ');if(!Array.isArray(data.results)||data.results.length>size||data.error||(data.page!==undefined&&data.page!==page)||(data.pageSize!==undefined&&data.pageSize!==size))throw new Error('DOAJ 响应列表或分页身份无效。');
  if(!data.results.length&&total>start)throw new Error('DOAJ 命中总数与空结果列表不一致。');
  const evidence:Evidence[]=[],at=new Date().toISOString(),seen=new Map<string,string>();
  for(const rawItem of data.results){
   const item=object(rawItem),record=object(item.bibjson),id=text(item.id),title=text(record.title);
   if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id)||!title)throw new Error('DOAJ 论文缺少有效标识或题名。');
   const sourceDoi=oneDoi(list(record.identifier).map(object).filter(value=>text(value.type).toLowerCase()==='doi').map(value=>value.id),'DOAJ');
   const paratext=/^(?:retraction|retracted|withdrawal|withdrawn|correction|corrigendum|erratum|expression of concern)\s*[:\[–-]/i.test(title);
   const abstract=text(record.abstract),authors=list(record.author).map(value=>text(object(value).name)).filter(Boolean).join(', '),year=text(record.year),journal=text(object(record.journal).title);
   const links=[...new Set(list(record.link).map(object).filter(value=>text(value.type).toLowerCase()==='fulltext').map(value=>publicUrl(value.url,sourceDoi)).filter((value):value is string=>Boolean(value)))].slice(0,6);
   const row:Evidence={id:'E-'+createHash('sha256').update(sourceDoi||'doaj:'+id).digest('hex').slice(0,12),title,url:`https://doaj.org/article/${id}`,...(sourceDoi?{doi:sourceDoi}:{}),...(authors?{authors}:{}),...(/^\d{4}$/.test(year)?{year}:{}),...(journal?{journal}:{}),publicationType:paratext?'paratext':'article',...(abstract&&!paratext?{abstract}:{}),...(links.length&&!paratext?{fullTextUrls:links}:{}),readScope:abstract&&!paratext?'abstract':'metadata',text:abstract&&!paratext?abstract:`文献元数据：${title}。${paratext?'更正、撤回或关注声明，不作为正常研究证据。':'未取得摘要。'}`,location:`DOAJ ${id}；${abstract&&!paratext?'原始摘要，未读取正文':'书目元数据'}；元数据 CC0；检索接口 ${url.href}`,retrievedAt:at};
   if(paratext)warnings.push(`DOAJ《${title.slice(0,80)}》属于更正或撤回声明，保留为元数据。`);
   const previous=seen.get(id);if(previous&&previous!==JSON.stringify(row))throw new Error('DOAJ 返回相同原始记录标识的冲突内容。');if(!previous){seen.set(id,JSON.stringify(row));evidence.push(row);}
  }
  diagnostics.push({source:'DOAJ',query,url:url.href,status:'ok',returned:data.results.length,retrievedAt:at});
  return {evidence,diagnostics,warnings,more:data.results.length>0&&start+data.results.length<Math.min(total,10_000)};
 }catch(error){signal.throwIfAborted();const message=error instanceof Error?error.message:'DOAJ 检索失败';diagnostics.push({source:'DOAJ',query,url:url.href,status:/timeout|timed out/i.test(message)?'timeout':'error',returned:0,error:message,retrievedAt:new Date().toISOString()});throw new DoajSearchError(message,diagnostics);}
}
export const probeDoaj=(signal:AbortSignal,onProgress?:(message:string)=>void)=>searchDoaj('education',signal,{size:1,onProgress});
