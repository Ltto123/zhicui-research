import {Marked,type Token} from 'marked';
import {publicReferenceUrl} from './bibliography';

const parser=new Marked({gfm:true});
const escapeLabel=(value:string)=>value.replace(/[\\`*_\[\]<>]/g,'\\$&');
const literalLabel=(value:string)=>value.replace(/\\([\\`*_\[\]<>])/g,'$1');

function children(token:Token):Token[]{
 if(['code','codespan','html','image'].includes(token.type))return [];
 if(token.type==='table')return [...token.header,...token.rows.flat()].flatMap(cell=>cell.tokens);
 if(token.type==='list')return token.items;
 return 'tokens' in token&&Array.isArray(token.tokens)?token.tokens as Token[]:[];
}

function publicLabelUrl(label:string):string|undefined{
 const url=publicReferenceUrl(label);if(url)return url;
 if(/^10\.\d{4,9}\/[^\s<>]+$/i.test(label))return publicReferenceUrl('https://doi.org/'+label.split('/').map(segment=>encodeURIComponent(segment).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())).join('/'));
}
function savedReader(value:string):boolean{
 try{const url=new URL(value,'https://workbench.invalid');return url.pathname.replace(/\/+$/,'')==='/source'&&url.searchParams.has('runId')&&url.searchParams.has('evidenceId');}catch{return false;}
}

/** Remove UI-only navigation from formal files, including saved older artifacts.
 * Citation labels and original prose stay intact; this never looks up a source
 * or invents publication metadata. Code examples are not interpreted as links. */
export function formalExportMarkdown(markdown:string):string{
 const source=markdown.replace(/\r\n/g,'\n');
 function rewrite(token:Token):string{
  if(token.type==='def'&&!publicReferenceUrl(token.href))return '';
  if(token.type==='image'&&!publicReferenceUrl(token.href))throw new Error('正式文件包含无效或内部图片地址，未导出；请使用已上传的图像。');
  if(token.type==='html'){
   for(const match of token.raw.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)){
    const href=(match[1]??match[2]??match[3]).replace(/&amp;/gi,'&').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(_,hex:string,decimal:string)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(hex??decimal,hex?16:10))));
    if(!href.startsWith('#')&&!publicReferenceUrl(href))throw new Error('正式文件包含未经处理的 HTML 内部导航链接，未导出。');
   }
  }
  if(token.type==='link'&&!publicReferenceUrl(token.href)){
   // Old bibliography links displayed the public locator but linked to /source.
   // Only that exact generated suffix is removed; prose is never globally edited.
   const original=literalLabel(token.text).trim();
   const generated=/^(.+?)\s+[·—–-]\s+工作台原文$/u.exec(original);
   const label=savedReader(token.href)&&generated&&publicLabelUrl(generated[1])?generated[1]:original;
   const url=publicLabelUrl(label);
   if(url)return `[${escapeLabel(label)}](${url})`;
   if(savedReader(token.href)&&original==='工作台原文')return '';
   return sequence(token.text,children(token));
  }
  return sequence(token.raw,children(token));
 }
 function sequence(raw:string,tokens:Token[]):string{
  const edits:{start:number;end:number;text:string}[]=[];let cursor=0;
  function locate(items:Token[]){
   for(const token of items){
    if(!token.raw)continue;
    const start=raw.indexOf(token.raw,cursor);
    if(start<0){locate(children(token));continue;}
    const text=rewrite(token),end=start+token.raw.length;
    if(text!==token.raw)edits.push({start,end,text});
    cursor=end;
   }
  }
  locate(tokens);
  let result=raw;for(const edit of edits.toReversed())result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  return result;
 }
 const result=sequence(source,parser.lexer(source));
 // A new Markdown construct must fail closed rather than silently leaking a
 // private navigation target into Word relationships or an exported PDF.
 parser.walkTokens(parser.lexer(result),token=>{
  if(token.type==='link'&&!publicReferenceUrl(token.href))throw new Error('正式文件仍有无效或内部导航链接，未导出；请检查来源链接。');
 });
 return result;
}
