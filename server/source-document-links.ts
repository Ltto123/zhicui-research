const LOCAL_WORKBENCH_ORIGIN='http://127.0.0.1:3000';

/** Saved workbench previews may use an absolute configured origin. Formal file
 * exports remove this navigation and retain public bibliographic locators.
 * Only explicit configuration supplies the origin; request headers do not. */
function workbenchOrigin(configured:string|undefined):string {
 const value=configured?.trim()||LOCAL_WORKBENCH_ORIGIN;
 try{
  if(!/^https?:\/\//i.test(value)||/[\\\u0000-\u0020]/.test(value))throw new Error();
  const url=new URL(value);
  if(!url.hostname||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error();
  return url.origin;
 }catch{throw new Error('工作台公开地址必须是无凭据、路径、查询或片段的 HTTP(S) origin。');}
}

export function sourceDocumentUrl(runId:string,evidenceId:string,baseUrl?:string):string {
 if(typeof runId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)||typeof evidenceId!=='string'||!/^[a-z0-9_-]{1,200}$/i.test(evidenceId))throw new Error('文献原文的任务或证据标识无效。');
 const url=new URL('/source',workbenchOrigin(baseUrl??process.env.ZHICUI_PUBLIC_URL));
 url.searchParams.set('runId',runId);url.searchParams.set('evidenceId',evidenceId);
 return url.href;
}

/** Keep the GB/T visible bracket group. Non-literature references such as user
 * uploads or calculated records deliberately omit evidenceId and stay plain. */
export function formatSourceCitation(entries:{index:number;evidenceId?:string}[],runId:string,baseUrl?:string):string {
 const numbers=entries.map(({index,evidenceId})=>{
  if(!Number.isSafeInteger(index)||index<1)throw new Error('参考文献序号必须为正整数。');
  return evidenceId===undefined?String(index):`[${index}](${sourceDocumentUrl(runId,evidenceId,baseUrl)})`;
 });
 // Marked keeps these outer brackets as text around the individual links.
 // Never emit a TeX opener: even an escaped opener alone could pair with a
 // later real display equation and swallow the intervening citation/prose.
 return `[${numbers.join(', ')}]`;
}
