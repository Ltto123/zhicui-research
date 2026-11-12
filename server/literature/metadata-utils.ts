import {isIP} from 'node:net';

/** Small shared helpers for public metadata adapters. Retrieval still verifies
 * DNS, redirects, article identity and bytes before obtaining any full text. */
export const text=(value:unknown):string=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
export const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
export function doi(value:unknown):string|undefined {
 const normalized=text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
 return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/.test(normalized)?normalized:undefined;
}
export function oneDoi(values:unknown[],source:string):string|undefined {
 const found=[...new Set(values.map(doi).filter((value):value is string=>Boolean(value)))];
 if(found.length>1)throw new Error(`${source} 同一记录出现冲突 DOI，未合并论文身份。`);return found[0];
}
export function publicUrl(value:unknown,expectedDoi?:string):string|undefined {
 if(typeof value!=='string'||/[\u0000-\u0020\u007f\\]/.test(value))return;
 try{
  const url=new URL(value),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(url.protocol!=='https:'||url.username||url.password||url.port||!host.includes('.')||isIP(host)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host))return;
  if(expectedDoi&&['doi.org','dx.doi.org'].includes(host)&&doi(decodeURIComponent(url.pathname.slice(1)))!==expectedDoi)return;
  url.hash='';return url.href;
 }catch{return;}
}
export function pageOptions(startValue:number|undefined,sizeValue:number|undefined,source:string):{start:number;size:number;page:number} {
 const start=startValue??0,size=sizeValue??20;
 if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(size)||size<1||size>100||start%size!==0||start+size>10_000)throw new Error(`${source} 分页要求 start 为 size 的非负整数倍，size 为 1–100，且不超过前 10000 条。`);
 return {start,size,page:start/size+1};
}
export function queryText(value:string,source:string):string {
 const clean=value.trim();if(!clean||clean.length>4000||/[\u0000-\u001f\u007f]/.test(clean))throw new Error(`${source} 查询语法无效：查询为空、过长或含无效控制字符。`);return clean;
}
export function checkedTotal(value:unknown,source:string):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error(`${source} 响应缺少有效总数。`);return value;
}
