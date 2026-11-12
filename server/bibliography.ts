import type {Evidence} from '../shared/types';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';

export interface GbtReference {text:string;missingFields:string[];warnings:string[];}
export const GBT_REFERENCE_STANDARD='GB/T 7714-2025';

// Treat only these exact, attribute-free formatting tags as presentation.
// Everything else remains literal metadata and is escaped by markdown().
const field=(value:string|undefined)=>value?.replace(/<\/?(?:sup|sub|i|em|b|strong)>/gi,'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()??'';
const markdown=(value:string)=>value.replace(/[\\`*_\[\]<>]/g,'\\$&');
const sentenceField=(value:string)=>markdown(value.replace(/[.。]+$/g,''));
const encodeSegment=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase());
function doiValue(raw:string|undefined):string|undefined{
 let value=raw?.trim();if(!value)return;
 if(/^https?:\/\//i.test(value)){
  try{const url=new URL(value);if(!['doi.org','dx.doi.org'].includes(url.hostname.toLowerCase())||url.username||url.password)return;value=decodeURIComponent(url.pathname.slice(1));}catch{return;}
 }
 return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(value)?value:undefined;
}
export function publicReferenceUrl(value:string|undefined):string|undefined{
 if(!value)return;
 try{
  const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return;
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
  if(!host||/(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host)||(!isIP(host)&&!host.includes('.')))return;
  if(isIP(host)){
   const address=ipaddr.parse(host);
   if(address.range()!=='unicast'||(address.kind()==='ipv6'&&(address as ipaddr.IPv6).isIPv4MappedAddress()))return;
  }
  // Saved-reader routes locate private application state, not a publication.
  if(url.pathname.replace(/\/+$/,'')==='/source'&&url.searchParams.has('runId')&&url.searchParams.has('evidenceId'))return;
  // Do not decode reserved delimiters or existing escapes. Only protect
  // Markdown delimiters that URL.href may leave literal.
  // IPv6 authority brackets are URL syntax rather than path data.
  return url.origin+url.href.slice(url.origin.length).replace(/[()\[\]<>\\`]/g,character=>encodeSegment(character));
 }catch{return;}
}
function accessDate(value:string):string|undefined{
 const match=/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);if(!match)return;
 const date=`${match[1]}-${match[2]}-${match[3]}`,time=Date.parse(date+'T00:00:00Z');
 return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===date?date:undefined;
}
function arxivPlatform(doi:string|undefined,url:string|undefined):boolean{
 if(/^10\.48550\/arxiv\./i.test(doi??''))return true;
 try{return ['arxiv.org','export.arxiv.org'].includes(new URL(url??'').hostname.toLowerCase());}catch{return false;}
}
function resourceType(source:Evidence,doi:string|undefined):string{
 const type=source.publicationType?.trim().toLowerCase();
 // Some indexes omit publicationType for these platforms. Use exact venue
 // identity only; an OA mirror URL or a title mentioning a platform is not a
 // reason to relabel a formally published journal article as a preprint.
 if(type==='preprint'||/^10\.48550\/arxiv\./i.test(doi??'')||['arxiv','medrxiv','biorxiv','chemrxiv'].includes(field(source.journal).toLowerCase()))return 'PP';
 const types:Record<string,string>={article:'J',review:'J','journal-article':'J',book:'M',monograph:'M','book-chapter':'M',chapter:'M',proceedings:'C','proceedings-article':'C','conference-paper':'C',dissertation:'D',thesis:'D',report:'R',standard:'S',dataset:'DS',software:'CP',webpage:'EB','web-page':'EB'};
 if(type&&types[type])return types[type];
 if(!doi&&arxivPlatform(undefined,source.url))return 'PP';
 if(!type&&field(source.journal))return 'J';
 return 'Z';
}

/** GB/T 7714-2025 sequential entries built only from stored metadata. Evidence
 * currently lacks volume/issue/pages and structured person names. Missing data
 * is returned for artifact audit, never filled with invented publication facts.
 * Standard status: https://std.samr.gov.cn/gb/search/gbDetailedCNF?id=4507EFE13D37CB6AE06397BE0A0A601F
 * Journal/preprint guidance: https://xuebao.gzy.edu.cn/info/1072/1486.htm */
export function renderGbtReference(source:Evidence,index:number):GbtReference{
 if(!Number.isSafeInteger(index)||index<1)throw new Error('参考文献序号必须为正整数。');
 const title=field(source.title);if(!title)throw new Error('文献题名缺失，不能生成可定位的参考文献。');
 const missingFields:string[]=[],warnings:string[]=[];
 const authors=field(source.authors),journal=field(source.journal),year=/^\d{4}$/.test(field(source.year))?field(source.year):'';
 const doi=doiValue(source.doi),url=doi?'https://doi.org/'+doi.split('/').map(encodeSegment).join('/'):publicReferenceUrl(source.url);
 const type=resourceType(source,doi),online=Boolean(url)||type==='PP',date=online?accessDate(source.retrievedAt):undefined;
 if(!authors)missingFields.push('作者');
 else if(/[A-Za-z]/.test(authors)){
  missingFields.push('作者姓/名结构');
  warnings.push('作者仅有原始展示姓名，保留其原序与拼写，未猜测姓/名或缩写；姓名次序及责任者数量仍需核对。');
 }
 if(!year)missingFields.push('出版年');
 if(!url)missingFields.push('可用 DOI 或访问地址');
 if(source.doi&&!doi)warnings.push('已有 DOI 字段格式无法确认，未据此编造标识符；仅保留可用的来源地址。');
 if(online&&!date)missingFields.push('引用日期');
 if(online&&date&&source.readScope!=='full_text')warnings.push('引用日期取已有检索记录日期；原始页面访问情况仍需核对，书目格式不代表已读全文。');
 let publication='';
 if(type==='J'){
  if(!journal)missingFields.push('期刊名');
  missingFields.push('卷号','期号','页码或文章号');
  publication=[sentenceField(journal),year].filter(Boolean).join(', ');
 }else if(type==='PP'){
  const platform=arxivPlatform(doi,source.url)?'arXiv':journal;
  if(!platform)missingFields.push('预印本出版平台');
  missingFields.push('预印本版本','完整发布日期');
  publication=sentenceField(platform)+(year?`(${year})`:'');
 }else{
  if(type==='Z')missingFields.push('文献类型');
  if(['M','C','D','R','S'].includes(type))missingFields.push('出版地','出版者或授予机构');
  if(type==='D')missingFields.push('引用页码');
  if(['book-chapter','chapter','proceedings-article','conference-paper'].includes(source.publicationType??''))missingFields.push('析出文献的所属文献题名及责任者','析出文献页码');
  publication=year;
 }
 if(online&&date)publication+=`[${date}]`;
 // A formal reference always points to its public bibliographic source.
 // Workbench navigation belongs to the application, never to the citation.
 const access=url?`[${markdown(url)}](${url})`:'';
 const pieces=[authors?sentenceField(authors):'',`${sentenceField(title)}[${type}${online?'/OL':''}]`,publication,access].filter(Boolean);
 const missing=[...new Set(missingFields)];
 if(missing.length)warnings.push(`现有书目元数据未提供或未结构化确认：${missing.join('、')}；条目未虚补这些字段，不能据此声称已完成完整国标书目核验。`);
 return {text:`[${index}] ${pieces.join('. ')}.`,missingFields:missing,warnings};
}
