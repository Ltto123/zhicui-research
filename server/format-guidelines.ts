import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {downloadPublicDocument,publicDocumentUrl,type PublicDocumentDownload} from './public-article';
import type {FormatGuideline} from '../shared/types';

export const MAX_FORMAT_GUIDELINES=3;
export const MAX_FORMAT_GUIDELINE_TEXT=60_000;
export interface FormatGuidelineDependencies {download?:typeof downloadPublicDocument;}
const GUIDE=/(?:instructions?\s+(?:for|to)\s+authors|authors?['’]?\s+guidelines?|submission\s+(?:guidelines?|instructions?|requirements)|guide\s+for\s+authors|manuscript\s+(?:preparation|submission)|投稿(?:须知|指南|要求)|作者(?:指南|须知)|稿件(?:准备|要求|格式)|撰稿须知)/i;
const BLOCKED=/^(?:sign\s*in|log\s*in|login|access denied|forbidden|unauthorized|404\b|403\b|page not found|not found|just a moment|checking your browser|verify you are human|登录|访问受限|页面不存在|找不到页面)/i;
function bounded<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void operation.catch(()=>{});return Promise.reject(signal.reason);}return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));});
}
function checked(text:string,title:string,headings:string[]):string{
 const result=text.replace(/\r\n?/g,'\n').replace(/[\t ]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
 if(result.length>MAX_FORMAT_GUIDELINE_TEXT)throw new Error('投稿规范正文超过 60000 字符，未截断或记为已完整取得。');
 if(result.replace(/\s/g,'').length<80||/[\u0000-\u0008\u000b\u000e-\u001f]/.test(result))throw new Error('投稿规范没有足够的可读正文，可能是空页、扫描件或链接目录。');
 if(BLOCKED.test(title.trim())||headings.some(heading=>BLOCKED.test(heading.trim())))throw new Error('来源返回登录、错误或访问限制页，未取得投稿规范。');
 const paperSections=headings.filter(heading=>/^(?:abstract|methods?|results?|摘要|研究方法|结果)\s*[:：]?$/i.test(heading.trim())).length;
 if(paperSections>=3&&/\bwe\s+(?:studied|conducted|surveyed|analysed|analyzed|investigated)|本研究(?:采用|调查|分析|发现)/i.test(result))throw new Error('页面呈现研究论文的摘要、方法与结果，不能将其当作投稿规范。');
 if(![title,...headings].some(value=>GUIDE.test(value)))throw new Error('未找到作者指南或投稿规范的文档标题，不能把普通论文或网页当作期刊要求。');
 if(!/\b(?:must|required|should|shall|maximum|limit|references|abstract|manuscript|words|font|margin)\b|不得|应|须|请|字数|字号|页边距|参考文献|摘要|图表/i.test(result))throw new Error('页面没有可识别的投稿要求正文，不能仅凭标题认定已取得规范。');
 return result;
}
function htmlText(bytes:Uint8Array,type:string):{title:string;text:string}{
 const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1]??'utf-8';let html:string;
 try{html=new TextDecoder(charset,{fatal:true}).decode(bytes);}catch{throw new Error('投稿规范网页编码无法可靠读取。');}
 const {document}=parseHTML(html);if(document.querySelectorAll('*').length>50_000)throw new Error('投稿规范网页节点过多，未尝试部分抽取。');
 // Linkedom's document.title/body getters can insert empty head/body nodes
 // when publisher markup puts scripts before its real head. Read existing nodes.
 const title=(document.querySelector('title')?.textContent||document.querySelector('h1')?.textContent||'').replace(/\s+/g,' ').trim().slice(0,1000);
 if(document.querySelector('input[type="password"]')||BLOCKED.test(title))throw new Error('来源返回登录或访问限制页，未取得投稿规范。');
 for(const node of Array.from(document.querySelectorAll('script,style,iframe,object,embed,nav,aside,footer,form,noscript,template,[hidden],[aria-hidden="true"],[role="navigation"]')))node.remove();
 for(const node of Array.from(document.querySelectorAll('[style]')))if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style')??''))node.remove();
 const bodies=document.querySelectorAll('body');if(bodies.length>1)throw new Error('投稿规范网页含多个正文区域，无法确认完整正文；未只取其中一部分。');
 const headings=Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(node=>node.textContent??'');
 const text=checked(bodies[0]?.innerText??'',title,headings);return {title:title||headings[0]?.trim()||'投稿规范网页',text};
}
async function pdfText(bytes:Uint8Array,signal:AbortSignal):Promise<{title:string;text:string}>{
 if(!Buffer.from(bytes.subarray(0,1024)).includes(Buffer.from('%PDF-')))throw new Error('投稿规范 PDF 文件头无效。');
 const {getDocument}=await bounded(import('pdfjs-dist/legacy/build/pdf.mjs'),signal);
 const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,useWasm:false,maxImageSize:1,stopAtErrors:true});
 const stop=()=>{void task.destroy().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
 try{
  const pdf=await bounded(task.promise,signal);if(pdf.numPages<1||pdf.numPages>100)throw new Error('投稿规范 PDF 页数超出 1–100 页范围，未截取部分冒充完整规范。');
  const pages:string[]=[];let count=0;
  for(let index=1;index<=pdf.numPages;index++){
   const page=await bounded(pdf.getPage(index),signal),content=await bounded(page.getTextContent(),signal);
   const text=content.items.map(item=>'str'in item?`${item.str}${item.hasEOL?'\n':' '}`:'').join('').trim();page.cleanup();
   if(text.replace(/[^\p{L}\p{N}]/gu,'').length<20)throw new Error('投稿规范 PDF 含缺失文本层的页面，可能是扫描页；未执行 OCR，不能省略其要求。');
   count+=text.length;if(count>MAX_FORMAT_GUIDELINE_TEXT)throw new Error('投稿规范正文超过 60000 字符，未截断。');pages.push(`[第 ${index} 页]\n${text}`);
  }
  const first=pages[0].split('\n').slice(1).join('\n'),title=first.split(/\n|[。.]/)[0].trim().slice(0,1000)||'投稿规范 PDF';
  return {title,text:checked(pages.join('\n\n'),title,[first.slice(0,1500)])};
 }finally{signal.removeEventListener('abort',stop);const closing=task.destroy().catch(()=>{});try{await bounded(closing,signal);}catch{/* Preserve the original timeout/cancellation. */}}
}

/** Fetches source text only. Neither a model-supplied URL nor a guide-shaped
 * document proves publisher identity, applicable article type or compliance. */
export async function readFormatGuideline(url:string,signal:AbortSignal,progress?:(message:string)=>void,dependencies:FormatGuidelineDependencies={}):Promise<FormatGuideline>{
 signal.throwIfAborted();const original=publicDocumentUrl(url,true).href,total=new AbortController(),timer=setTimeout(()=>total.abort(new Error('投稿规范读取超过 30 秒，已停止等待。')),30_000),overall=AbortSignal.any([signal,total.signal]);
 try{
  const result:PublicDocumentDownload=await bounded((dependencies.download??downloadPublicDocument)(original,overall,{allowHttp:true,onProgress:progress}),overall);overall.throwIfAborted();
  const finalUrl=publicDocumentUrl(result.finalUrl,true).href;if(result.bytes.byteLength>8*1024*1024)throw new Error('投稿规范超过 8 MB，未读取。');
  const isPdf=/application\/pdf/i.test(result.contentType)||Buffer.from(result.bytes.subarray(0,1024)).includes(Buffer.from('%PDF-'));
  if(!isPdf&&!/text\/html|application\/xhtml\+xml/i.test(result.contentType))throw new Error('投稿规范来源不是可读取的 HTML 或 PDF。');
  const content=isPdf?await pdfText(result.bytes,overall):htmlText(result.bytes,result.contentType);overall.throwIfAborted();
  const contentHash=createHash('sha256').update(content.text).digest('hex');
  return {id:'guide-'+createHash('sha256').update(finalUrl+'\n'+contentHash).digest('hex').slice(0,20),url:original,finalUrl,...content,retrievedAt:new Date().toISOString(),contentHash,sourceLabel:'待核对的网页来源',sourceKind:'web',identityStatus:'unverified'};
 }finally{clearTimeout(timer);}
}
