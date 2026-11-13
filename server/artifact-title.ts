import {Marked,type Token} from 'marked';
import {DOMParser} from 'linkedom';

const parser=new Marked({gfm:true});
const MAX_TITLE_LENGTH=300;

function normalize(value:string):string {
 return value.replace(/\s+/gu,' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\uFEFF]/gu,'').trim();
}

function decodeText(value:string):string {
 if(!value.includes('&'))return value;
 // Parse only escaped text to decode entities. Linkedom neither executes script
 // nor loads resources, and no title-provided HTML is inserted as markup.
 return new DOMParser().parseFromString('<html><body>'+value.replaceAll('<','&lt;').replaceAll('>','&gt;')+'</body></html>','text/html').body.textContent??'';
}

function plainText(tokens:Token[]):string {
 return tokens.map(token=>{
  if(token.type==='html')return '';
  if(token.type==='br')return ' ';
  if('tokens' in token&&Array.isArray(token.tokens))return plainText(token.tokens);
  if(token.type==='codespan'||token.type==='escape')return token.text;
  return 'text' in token?decodeText(String(token.text)):'';
 }).join('');
}

/** The document's leading H1 owns the delivered title, not its old task plan.
 * Only inspect the beginning: later headings can be sections, quoted papers or
 * examples. Never alter the manuscript while deriving its display metadata. */
export function resolveArtifactTitle(markdown:string,fallback:string):string {
 const previous=normalize(fallback)||'研究成果';
 const tokens=parser.lexer(markdown.replace(/^\uFEFF/u,'').slice(0,8192));
 const first=tokens.find(token=>token.type!=='space');
 if(first?.type!=='heading'||first.depth!==1)return previous;
 const title=normalize(plainText(first.tokens??[]));
 return title&&Array.from(title).length<=MAX_TITLE_LENGTH?title:previous;
}
