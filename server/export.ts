import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Marked, type Token } from 'marked';
import katex from 'katex';
import { DOMParser } from '@xmldom/xmldom';
import { AlignmentType, BorderStyle, BuilderElement, Document, ExternalHyperlink, HeadingLevel, LineRuleType, Math as WordMath, MathFraction, MathRadical, MathRun, MathSubScript, MathSuperScript, MathSubSuperScript, createMathBase, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType, type IRunOptions, type MathComponent, type ParagraphChild } from 'docx';
import { chromium, type Browser } from 'playwright';
import type { Artifact } from '../shared/types.ts';
import {formalExportMarkdown} from './formal-export';
import {manuscriptBoundaryIssues} from './manuscript-boundary';
import {defaultExportFormatSettings,validatedExportFormatSettings,type ExportFormatSettings} from '../shared/export-format';

const font=(settings:ExportFormatSettings)=>({ascii:settings.fontLatin,hAnsi:settings.fontLatin,eastAsia:settings.fontEastAsia,cs:settings.fontLatin});
const twips=(mm:number)=>Math.round(mm/25.4*1440);
const pageMillimetres=(settings:ExportFormatSettings)=>settings.pageSize==='Letter'?{width:215.9,height:279.4}:{width:210,height:297};
const BORDER = {style:BorderStyle.SINGLE,size:4,color:'D9D9D9'};
const escape = (value:string) => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
interface MathRendering { count:number; failed:number; format?:ExportFormatSettings; }
const markdown=new Marked({gfm:true});
markdown.use({extensions:[
  {name:'mathBlock',level:'block',start(source){return source.search(/\\\[|\$\$/);},tokenizer(source){
    const match=source.match(/^\\\[([\s\S]{1,8000}?)\\\][ \t]*(?:\n|$)/)??source.match(/^\$\$([\s\S]{1,8000}?)\$\$[ \t]*(?:\n|$)/);
    if(match)return {type:'mathBlock',raw:match[0],text:match[1],display:true};
  }},
  {name:'mathInline',level:'inline',start(source){return source.search(/\\\(|\\\[|\$/);},tokenizer(source){
    const explicit=source.match(/^\\\(([\s\S]{1,8000}?)\\\)/)??source.match(/^\\\[([\s\S]{1,8000}?)\\\]/)??source.match(/^\$\$([\s\S]{1,8000}?)\$\$/);
    if(explicit)return {type:'mathInline',raw:explicit[0],text:explicit[1],display:source.startsWith('\\[')||source.startsWith('$$')};
    const dollars=source.match(/^\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?![\w$])/);
    if(dollars&&dollars[1].trim()===dollars[1])return {type:'mathInline',raw:dollars[0],text:dollars[1],display:false};
  }},
]});

function mathMarkup(token:Token):string {
  const source=String('text' in token?token.text:'');
  if(source.length>8000||/\\(?:href|url|includegraphics|html\w*|class|style)\b/.test(source))throw new Error('不支持带外部资源或样式的公式');
  return katex.renderToString(source,{output:'mathml',displayMode:Boolean('display' in token&&token.display),throwOnError:true,strict:'error',trust:false,maxExpand:100,maxSize:20});
}

function renderMath(token:Token,context:MathRendering):string {
  context.count++;
  try {
    const math=mathMarkup(token);
    return `<span class="${'display' in token&&token.display?'math-display':'math-inline'}">${math}</span>`;
  } catch {
    context.failed++;
    return `<code class="math-unrendered">${escape(token.raw)}</code>`;
  }
}

function safeHref(value:string):string|undefined {
  try { const url=new URL(value); return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password ? url.href : undefined; } catch { return undefined; }
}

function renderTokens(tokens:Token[]|undefined,context:MathRendering):string {
  let bibliography=false;
  return (tokens??[]).map(token=>{
    switch(token.type) {
      case 'space': return '';
      case 'heading': bibliography=/^(参考文献|依据与参考文献|references|bibliography)$/i.test(token.text.trim());return `<h${token.depth}>${renderTokens(token.tokens,context)}</h${token.depth}>`;
      case 'paragraph': return `<p${bibliography?' style="margin-left:2em;text-indent:-2em;text-align:left;margin-bottom:5pt;line-height:1.3;break-inside:avoid"':''}>${renderTokens(token.tokens,context)}</p>`;
      case 'text': return 'tokens' in token && token.tokens ? renderTokens(token.tokens,context) : escape(token.text);
      case 'strong': return `<strong>${renderTokens(token.tokens,context)}</strong>`;
      case 'em': return `<em>${renderTokens(token.tokens,context)}</em>`;
      case 'del': return `<del>${renderTokens(token.tokens,context)}</del>`;
      case 'mathInline': case 'mathBlock': return renderMath(token,context);
      case 'codespan': return `<code>${escape(token.text)}</code>`;
      case 'code': return `<pre><code>${escape(token.text)}</code></pre>`;
      case 'blockquote': return `<blockquote>${renderTokens(token.tokens,context)}</blockquote>`;
      case 'br': return '<br>';
      case 'hr': return '<hr>';
      case 'link': { const href=safeHref(token.href); const label=renderTokens(token.tokens,context); return href?`<a href="${escape(href)}" rel="noreferrer noopener">${label}</a>`:label; }
      case 'image': return `<span class="image-reference">[图像说明：${escape(token.text || '未提供说明')}；外部图像未嵌入]</span>`;
      case 'html': return escape(token.text);
      case 'list': { const tag=token.ordered?'ol':'ul'; return `<${tag}>${token.items.map((item:Token & {tokens:Token[]})=>`<li>${renderTokens(item.tokens,context)}</li>`).join('')}</${tag}>`; }
      case 'table': return `<table><thead><tr>${token.header.map((cell:{tokens:Token[]})=>`<th>${renderTokens(cell.tokens,context)}</th>`).join('')}</tr></thead><tbody>${token.rows.map((row:{tokens:Token[]}[])=>`<tr>${row.map(cell=>`<td>${renderTokens(cell.tokens,context)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      default: return escape('text' in token ? String(token.text) : token.raw ?? '');
    }
  }).join('');
}

function renderHtml(artifact:Artifact,context:MathRendering):string {
  if(artifact.markdown.length>500000) throw new Error('成果文本超过导出上限。');
  const settings=validatedExportFormatSettings(artifact.format),page=pageMillimetres(settings),margins=settings.marginsMm;
  const marginCss=[margins.top,margins.right,margins.bottom,margins.left].map(value=>value+'mm').join(' ');
  const body=renderTokens(markdown.lexer(artifact.markdown),context);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(artifact.title)}</title><style>
@page{size:${settings.pageSize};margin:${marginCss}}*{box-sizing:border-box}html{background:#eceee9}body{max-width:${page.width}mm;min-height:${page.height}mm;margin:24px auto;padding:${marginCss};background:white;color:#111;font:${settings.bodyPt}pt/${settings.lineSpacing} '${settings.fontLatin}','${settings.fontEastAsia}',serif;overflow-wrap:anywhere}h1,h2,h3,h4,h5,h6{color:#000;font-weight:bold;line-height:1.4;break-after:avoid}h1{font-size:18pt;text-align:center;margin:0 0 20pt}h2{font-size:12pt;margin:16pt 0 6pt}h3,h4,h5,h6{font-size:10.5pt;margin:12pt 0 4pt}p{text-align:justify;text-indent:2em;margin:0;orphans:3;widows:3}ul,ol{padding-left:2em;margin:6pt 0}li p{text-indent:0}table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:9pt;margin:10pt 0}thead{display:table-header-group}th,td{border:1px solid #d9d9d9;padding:6pt;overflow-wrap:anywhere;vertical-align:middle}th{background:#f0f2f0;font-weight:bold}tr{break-inside:avoid}blockquote{margin:9pt 1em;padding-left:1em;border-left:2px solid #ddd}blockquote p{text-indent:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:10pt;background:#f5f5f3;font:9pt/1.4 '${settings.fontLatin}','${settings.fontEastAsia}',serif}code{font-family:inherit}a{color:inherit;text-decoration:underline}hr{border:0;border-top:1px solid #ddd}.image-reference{color:#555}math{font-size:1em}.math-inline{white-space:nowrap}.math-display{display:block;text-align:center;margin:8pt 0;text-indent:0}.math-unrendered{white-space:pre-wrap}@media print{html{background:white}body{padding:0;margin:0;max-width:none;min-height:0}a{text-decoration:none}}@media screen and (max-width:700px){body{padding:24px;margin:0;min-height:100vh}table{font-size:9pt}}
</style></head><body>${body}</body></html>`;
}

function formalManuscript(artifact:Artifact):Artifact {
  const markdown= formalExportMarkdown(artifact.markdown);
  const [issue]=manuscriptBoundaryIssues(markdown);
  if(issue)throw new Error(`${issue.location}：${issue.issue}。${issue.suggestion}`);
  return {...artifact,markdown};
}

export function renderArtifactHtml(artifact:Artifact):string {return renderHtml(formalManuscript(artifact),{count:0,failed:0});}

class UprightMathRun extends MathRun {
  constructor(text:string) {
    super(text);
    this.root.unshift(new BuilderElement({name:'m:rPr',children:[new BuilderElement({name:'m:nor'})]}));
  }
}

/** Only parse MathML emitted by our bounded KaTeX call, never arbitrary input XML. */
function wordEquation(token:Token,context:MathRendering):WordMath|TextRun {
  context.count++;
  try {
    const xml=mathMarkup(token);
    const fail=()=>{throw new Error('不支持的数学结构');};
    const parsed=new DOMParser({errorHandler:{warning:fail,error:fail,fatalError:fail}}).parseFromString(xml,'application/xml');
    const root=parsed.getElementsByTagName('math')[0];
    if(!root)throw new Error('缺少MathML根节点');
    let visited=0;
    const convert=(node:Element,depth=0):MathComponent[]=>{
      if(++visited>1000||depth>50)throw new Error('公式结构过大');
      const children=Array.from(node.childNodes).filter((child):child is Element=>child.nodeType===1);
      const part=(index:number)=>{if(!children[index])throw new Error('公式缺少操作数');return convert(children[index],depth+1);};
      const all=()=>children.flatMap(child=>convert(child,depth+1));
      switch(node.localName){
        case 'math': case 'mrow': return all();
        case 'semantics': return part(0); // Annotation carries original TeX, not another operand.
        case 'mi': case 'mn': case 'mo': case 'mtext': {
          const variant=node.getAttribute('mathvariant');
          if(variant&&variant!=='normal')throw new Error('未实现该数学字体语义');
          const text=node.textContent??'';
          if(variant==='normal'||node.localName==='mtext')return [new UprightMathRun(text)];
          return [new MathRun(text)];
        }
        case 'mfrac': if(children.length!==2||node.hasAttribute('linethickness'))throw new Error('未支持该分式结构');return [new MathFraction({numerator:part(0),denominator:part(1)})];
        case 'msqrt': return [new MathRadical({children:all()})];
        case 'mroot': if(children.length!==2)throw new Error('根式结构无效');return [new MathRadical({children:part(0),degree:part(1)})];
        case 'msub': if(children.length!==2)throw new Error('下标结构无效');return [new MathSubScript({children:part(0),subScript:part(1)})];
        case 'msup': if(children.length!==2)throw new Error('上标结构无效');return [new MathSuperScript({children:part(0),superScript:part(1)})];
        case 'msubsup': if(children.length!==3)throw new Error('上下标结构无效');return [new MathSubSuperScript({children:part(0),subScript:part(1),superScript:part(2)})];
        case 'mover': {
          if(children.length!==2||node.getAttribute('accent')!=='true'||!['ˉ','¯','‾'].includes(children[1].textContent??''))throw new Error('当前仅支持横线重音');
          return [new BuilderElement({name:'m:bar',children:[new BuilderElement({name:'m:barPr',children:[new BuilderElement({name:'m:pos',attributes:{value:{key:'m:val',value:'top'}}})]}),createMathBase({children:part(0)})]})];
        }
        default: throw new Error('未支持的MathML节点：'+node.localName);
      }
    };
    return new WordMath({children:convert(root)});
  } catch {
    context.failed++;
    return new TextRun({text:token.raw});
  }
}

function inlineRuns(tokens:Token[]|undefined, style:IRunOptions={},math:MathRendering):ParagraphChild[] {
  return (tokens??[]).flatMap(token=>{
    if(token.type==='strong') return inlineRuns(token.tokens,{...style,bold:true},math);
    if(token.type==='em') return inlineRuns(token.tokens,{...style,italics:true},math);
    if(token.type==='del') return inlineRuns(token.tokens,{...style,strike:true},math);
    if(token.type==='br') return [new TextRun({...style,break:1})];
    if(token.type==='image') return [new TextRun({...style,text:`[图像说明：${token.text}；外部图像未嵌入]`})];
    if(token.type==='mathInline'||token.type==='mathBlock')return [wordEquation(token,math)];
    if(token.type==='link') { const runs=inlineRuns(token.tokens,style,math); const href=safeHref(token.href); return href?[new ExternalHyperlink({children:runs,link:href})]:runs; }
    if('tokens' in token&&token.tokens) return inlineRuns(token.tokens,style,math);
    return [new TextRun({...style,text:'text' in token?String(token.text):token.raw??''})];
  });
}

function paragraph(tokens:Token[], overrides:ConstructorParameters<typeof Paragraph>[0]={},math:MathRendering):Paragraph {
  const options=typeof overrides==='object'?overrides:{};
  const settings=math.format??defaultExportFormatSettings();
  return new Paragraph({children:options.children??inlineRuns(tokens,{},math),alignment:AlignmentType.JUSTIFIED,spacing:{before:0,after:0,line:Math.round(settings.lineSpacing*240),lineRule:LineRuleType.AUTO},indent:{firstLine:Math.round(settings.bodyPt*40)},...options});
}

function documentBlocks(tokens:Token[]|undefined,math:MathRendering):(Paragraph|Table)[] {
  const settings=math.format??defaultExportFormatSettings();
  let bibliography=false;
  return (tokens??[]).flatMap<(Paragraph|Table)>(token=>{
    switch(token.type) {
      case 'space': return [];
      case 'heading': {
        bibliography=/^(参考文献|依据与参考文献|references|bibliography)$/i.test(token.text.trim());
        return [new Paragraph({heading:token.depth===1?HeadingLevel.TITLE:token.depth===2?HeadingLevel.HEADING_1:HeadingLevel.HEADING_2,children:inlineRuns(token.tokens,{},math),alignment:token.depth===1?AlignmentType.CENTER:AlignmentType.LEFT,keepNext:true,spacing:{before:token.depth===1?0:180,after:120},indent:{firstLine:0}})];
      }
      case 'paragraph': case 'text': return [paragraph('tokens' in token&&token.tokens?token.tokens:[token],bibliography?{alignment:AlignmentType.LEFT,indent:{left:420,hanging:420},keepLines:true,spacing:{before:0,after:60,line:276,lineRule:LineRuleType.AUTO}}:{},math)];
      case 'code': return [new Paragraph({children:[new TextRun({text:token.text,size:18})],indent:{firstLine:0},spacing:{before:100,after:100,line:300},shading:{fill:'F5F5F3'}})];
      case 'mathBlock': return [new Paragraph({children:[wordEquation(token,math)],alignment:AlignmentType.CENTER,indent:{firstLine:0},spacing:{before:100,after:100,line:360}})];
      case 'blockquote': return documentBlocks(token.tokens,math);
      case 'list': return token.items.flatMap((item:{tokens:Token[]},index:number)=>{
        const text=item.tokens.map(t=>'text' in t?String(t.text):t.raw).join('\n');
        return [new Paragraph({children:[new TextRun(token.ordered?`${(Number(token.start)||1)+index}. `:'• '),...inlineRuns(markdown.lexer(text),{},math)],indent:{left:420,hanging:210},keepLines:bibliography,spacing:bibliography?{before:0,after:60,line:276,lineRule:LineRuleType.AUTO}:{before:50,after:50,line:Math.round(settings.lineSpacing*240)}})];
      });
      case 'table': {
        const count=token.header.length;
        if(count>12) return [new Paragraph({children:[new TextRun('下表列数较多，请同时查看 Markdown 原稿。')]}),paragraph([{type:'text',raw:token.raw,text:token.raw}],{},math)];
        const tableRows=[token.header,...token.rows];
        return [new Table({width:{size:100,type:WidthType.PERCENTAGE},layout:TableLayoutType.FIXED,columnWidths:Array.from({length:count},()=>Math.floor((twips(pageMillimetres(settings).width)-twips(settings.marginsMm.left)-twips(settings.marginsMm.right))/count)),borders:{top:BORDER,bottom:BORDER,left:BORDER,right:BORDER,insideHorizontal:BORDER,insideVertical:BORDER},rows:tableRows.map((row:{tokens:Token[]}[],index:number)=>new TableRow({tableHeader:index===0,children:row.map(cell=>new TableCell({width:{size:100/count,type:WidthType.PERCENTAGE},margins:{top:90,bottom:90,left:90,right:90},shading:index===0?{fill:'F0F2F0'}:undefined,children:[paragraph(cell.tokens,{indent:{firstLine:0},children:inlineRuns(cell.tokens,{size:18,bold:index===0},math),spacing:{line:300},alignment:AlignmentType.LEFT},math)]}))}))}),new Paragraph({text:'',spacing:{after:100}})];
      }
      case 'hr': return [new Paragraph({text:'',spacing:{after:100}})];
      default: return [paragraph([{type:'text',text:'text' in token?String(token.text):token.raw,raw:token.raw}],{},math)];
    }
  });
}

async function makeDocx(artifact:Artifact,math:MathRendering):Promise<Buffer> {
  const settings=validatedExportFormatSettings(artifact.format),page=pageMillimetres(settings);
  math.format=settings;
  const children=documentBlocks(markdown.lexer(artifact.markdown),math);
  const doc=new Document({creator:'智萃科研',title:artifact.title,description:'研究成果；科学局限见正文，运行与导出边界保留在应用成果侧栏',styles:{default:{document:{run:{font:font(settings),size:settings.bodyPt*2,color:'000000'},paragraph:{spacing:{line:Math.round(settings.lineSpacing*240),lineRule:LineRuleType.AUTO},indent:{firstLine:Math.round(settings.bodyPt*40)}}},title:{run:{font:font(settings),size:36,bold:true,color:'000000'},paragraph:{spacing:{after:240},indent:{firstLine:0}}},heading1:{run:{font:font(settings),size:24,bold:true,color:'000000'},paragraph:{keepNext:true,indent:{firstLine:0}}},heading2:{run:{font:font(settings),size:21,bold:true,color:'000000'},paragraph:{keepNext:true,indent:{firstLine:0}}}}},sections:[{properties:{page:{size:{width:twips(page.width),height:twips(page.height)},margin:{top:twips(settings.marginsMm.top),bottom:twips(settings.marginsMm.bottom),left:twips(settings.marginsMm.left),right:twips(settings.marginsMm.right)}}},children}]});
  return Packer.toBuffer(doc);
}

async function atomicFile(file:string,data:string|Buffer):Promise<void> {
  const temporary=`${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary,data,{flag:'wx',mode:0o600}); await fs.rename(temporary,file); }
  finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
}

async function launchBrowser():Promise<Browser> {
  const paths=process.platform==='win32'?[
    path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe'),
    path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
  ]:[];
  const executablePath=paths.find(candidate=>existsSync(candidate));
  return chromium.launch({headless:true,...executablePath?{executablePath}:{},timeout:15000});
}

export async function exportArtifact(artifact:Artifact,outputDir:string):Promise<{formats:Artifact['formats'];warnings:string[]}> {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(artifact.id)) throw new Error('成果 ID 无效。');
  const settings=validatedExportFormatSettings(artifact.format);
  artifact=formalManuscript(artifact);
  const directory=path.resolve(outputDir); await fs.mkdir(directory,{recursive:true});
  const math:MathRendering={count:0,failed:0};
  const html=renderHtml(artifact,math);
  const formats:Artifact['formats']=[]; const warnings:string[]=[...(artifact.format?.warnings??[])];
  const target=(format:string)=>path.join(directory,`${artifact.id}.${format}`);
  await atomicFile(target('md'),artifact.markdown); formats.push('md');
  await atomicFile(target('html'),html); formats.push('html');
  const wordMath:MathRendering={count:0,failed:0};
  await atomicFile(target('docx'),await makeDocx(artifact,wordMath)); formats.push('docx');
  if(/!\[[^\]]*\]\(/.test(artifact.markdown)) warnings.push('外部图片未嵌入导出文件，已保留图像说明；需要上传图像后完成最终图版。');
  if(wordMath.failed)warnings.push(`Word 中有 ${wordMath.failed} 处公式超出当前可编辑公式转换范围，已完整保留 TeX 源文本；HTML 与 PDF 使用 MathML 排版可解析的公式。`);
  if(math.failed)warnings.push(`有 ${math.failed} 处公式不能安全解析，HTML 与 PDF 已保留其原始 TeX 文本，需修正后重新导出。`);
  let browser:Browser|undefined;
  try {
    browser=await launchBrowser();
    const context=await browser.newContext({javaScriptEnabled:false,offline:true});
    await context.route('**/*',route=>route.abort());
    const page=await context.newPage();
    await page.setContent(html,{waitUntil:'load',timeout:15000});
    await page.emulateMedia({media:'print'});
    const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    if(dimensions.scroll>dimensions.width+2) warnings.push('阅读版检测到横向溢出，请检查长公式或表格。');
    let pdfTimer:ReturnType<typeof setTimeout>|undefined;
    const pdf=await Promise.race([
      page.pdf({format:settings.pageSize,margin:{top:settings.marginsMm.top+'mm',bottom:settings.marginsMm.bottom+'mm',left:settings.marginsMm.left+'mm',right:settings.marginsMm.right+'mm'},printBackground:true,preferCSSPageSize:true}),
      new Promise<never>((_,reject)=>{ pdfTimer=setTimeout(()=>reject(new Error('PDF 渲染超时')),20000); }),
    ]).finally(()=>{ if(pdfTimer) clearTimeout(pdfTimer); });
    if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-'))) throw new Error('PDF 输出无效');
    await atomicFile(target('pdf'),pdf); formats.push('pdf');
    await context.close();
  } catch {
    warnings.push('PDF 阅读版未生成：本机浏览器不可用或渲染失败；可下载 Word 和 HTML。');
  } finally { await browser?.close().catch(()=>{}); }
  return {formats,warnings};
}
