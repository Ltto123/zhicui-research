export type FormatItemStatus='configured'|'unresolved'|'conflict';
export interface ExportFormatSettings {
 pageSize:'A4'|'Letter';
 marginsMm:{top:number;bottom:number;left:number;right:number};
 fontEastAsia:string; fontLatin:string; bodyPt:number; lineSpacing:number;
 citationStyle:'gbt-numeric';
}
export interface ExportFormatProfile {
 version:1; instructions:string; bibliographyMode:'generated'|'preserved'; settings:ExportFormatSettings;
 items:{requirement:string;status:FormatItemStatus;detail:string;blocking?:boolean}[]; warnings:string[];
}
const EAST_ASIA=['宋体','黑体','仿宋','楷体','微软雅黑'];
const LATIN=['Times New Roman','Arial','Calibri','Cambria','Georgia'];
const eastAliases:Record<string,string>={simsun:'宋体',simhei:'黑体',fangsong:'仿宋',kaiti:'楷体','microsoft yahei':'微软雅黑'};
export function defaultExportFormatSettings():ExportFormatSettings {
 return {pageSize:'A4',marginsMm:{top:25.4,bottom:25.4,left:25.4,right:25.4},fontEastAsia:'宋体',fontLatin:'Times New Roman',bodyPt:10.5,lineSpacing:1.5,citationStyle:'gbt-numeric'};
}
function numberIn(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;}
/** Treat stored profiles as untrusted at the rendering boundary. Only closed
 * font/page names and bounded numeric values may be interpolated into CSS/XML. */
export function validatedExportFormatSettings(profile?:ExportFormatProfile):ExportFormatSettings {
 if(profile===undefined)return defaultExportFormatSettings();
 const s=profile?.settings;
 if(profile?.version!==1||typeof profile.instructions!=='string'||profile.instructions.length>10000||!['generated','preserved'].includes(profile.bibliographyMode)||!s||
  !['A4','Letter'].includes(s.pageSize)||!EAST_ASIA.includes(s.fontEastAsia)||!LATIN.includes(s.fontLatin)||
  s.citationStyle!=='gbt-numeric'||!numberIn(s.bodyPt,8,24)||!Number.isInteger(s.bodyPt*2)||!numberIn(s.lineSpacing,1,3)||
  !s.marginsMm||!['top','bottom','left','right'].every(key=>numberIn(s.marginsMm[key as keyof typeof s.marginsMm],5,50))||
  !Array.isArray(profile.items)||profile.items.length>330||!profile.items.every(item=>item&&typeof item.requirement==='string'&&typeof item.detail==='string'&&['configured','unresolved','conflict'].includes(item.status)&&(item.blocking===undefined||typeof item.blocking==='boolean'))||
  !Array.isArray(profile.warnings)||!profile.warnings.every(item=>typeof item==='string'))throw new Error('导出版式配置无效，未生成文件。');
 return {...s,marginsMm:{...s.marginsMm}};
}

/** Final publication gate only. Draft rendering and existing downloads remain
 * available; unverified prose is distinct from a known unmet requirement. */
export function assertDeliveryFormat(profile:ExportFormatProfile):void {
 validatedExportFormatSettings(profile);
 const blockers=profile.items.filter(item=>item.blocking===true||item.status==='conflict');
 if(blockers.length){
  const names=[...new Set(blockers.map(item=>item.requirement))];
  throw new Error(`格式尚未完成，稿件已保存：${names.slice(0,6).join('；').slice(0,400)}${names.length>6?`；另有 ${names.length-6} 项`:''}。这些要求尚未满足，不能按默认设置替代后正式交付。`);
 }
}

type Key='pageSize'|'fontEastAsia'|'fontLatin'|'bodyPt'|'lineSpacing'|'top'|'bottom'|'left'|'right';
const labels:Record<Key,string>={pageSize:'纸张',fontEastAsia:'中文字体',fontLatin:'外文字体',bodyPt:'正文字号',lineSpacing:'正文行距',top:'上页边距',bottom:'下页边距',left:'左页边距',right:'右页边距'};
const direction:Record<string,Key[]>={上:['top'],下:['bottom'],左:['left'],右:['right'],上下:['top','bottom'],左右:['left','right'],四边:['top','bottom','left','right'],全部:['top','bottom','left','right']};
const sizes:Record<string,number>={'小五':9,'五号':10.5,'小四':12,'四号':14,'小三':15,'三号':16,'小二':18,'二号':22};
/** Recognize a whole language instruction, not a font name or a partial clause.
 * Recognition preserves the content obligation; it never proves compliance. */
export function writingLanguageRequirement(value:string):'zh'|'en'|undefined {
 const clause=value.trim().replace(/[。.!！]+$/u,'').replace(/\s+/g,'');
 const match=/^(?:请)?(?:(?:(?:全文|正文|文章|稿件|本稿件?)?(?:采用|使用|用|以)?)(中文|英文)(?:写作|撰写|书写|编写)|(?:全文|正文|文章|稿件|本稿件?)(?:采用|使用|用|以)(中文|英文)|(?:写作|撰写)?语言[:：]?(?:采用|使用|为)?(中文|英文))$/.exec(clause);
 const language=match?.slice(1).find(Boolean);return language==='中文'?'zh':language==='英文'?'en':undefined;
}
function builtInNumericBibliography(clause:string):boolean {
 // Match the entire affirmative clause. Other years, author-year styles and
 // appended requirements must reach the unresolved/unsupported branches.
 return /^(?:请)?(?:参考文献|引用|书目)?(?:著录)?(?:格式|体例)?[:：]?(?:采用|使用|执行|按照|按|遵循|遵照|为)?(?:GB\/?T(?:7714(?:[-—]?2025)?)?|国标)(?:国标)?(?:标准)?(?:格式|体例)?(?:顺序编码(?:制|引用)?(?:格式)?|数字编号)?(?:格式)?(?:著录(?:参考文献|引用|书目)?)?$/i.test(clause.replace(/\s+/g,''));
}
const filler='(?:采用|使用|设为|设置为|为|用)?\\s*';
const num='(-?\\d+(?:\\.\\d+)?)';
const unit='(mm|毫米|cm|厘米|in(?:ch(?:es)?)?|英寸)';
function marginValue(value:string,unit:string):number{return Number((Number(value)*(/cm|厘米/i.test(unit)?10:/in|英寸/i.test(unit)?25.4:1)).toFixed(3));}

/** Compile only explicit, bounded clauses. Unparsed prose remains visible;
 * journal names never imply that their current submission guide was checked. */
export function compileExportFormat(instructions:string,options:{preserveBibliography?:boolean}={}):ExportFormatProfile {
 if(typeof instructions!=='string'||instructions.length>10000)throw new Error('格式要求必须是至多10000字符的文字。');
 const profile:ExportFormatProfile={version:1,instructions,bibliographyMode:options.preserveBibliography?'preserved':'generated',settings:defaultExportFormatSettings(),items:[],warnings:[]};
 const proposals=new Map<Key,{index:number;value:string|number}[]>();
 const add=(requirement:string,values:Partial<Record<Key,string|number>>,detail:string)=>{
  const index=profile.items.push({requirement,status:'configured',detail})-1;
  for(const [key,value]of Object.entries(values)){const list=proposals.get(key as Key)??[];list.push({index,value});proposals.set(key as Key,list);}
 };
 const unresolved=(requirement:string,detail:string,blocking=false)=>profile.items.push({requirement,status:'unresolved',detail,...(blocking?{blocking:true}:{})});
 // Do not split decimal points or slash-containing font/style names.
 const clauses=instructions.split(/[；;\n\r，,。]+/).map(text=>text.trim()).filter(Boolean);
 if(clauses.length>300)throw new Error('格式要求条目过多，请合并重复要求。');
 for(const clause of clauses){
  let match:RegExpMatchArray|null;
  if(writingLanguageRequirement(clause)){unresolved(clause,'写作语言属于稿件内容要求，需依据实际稿件核对；不据此推定语言已经满足。');continue;}
  if((match=clause.match(new RegExp(`^(?:纸张|纸型|页面大小)?\\s*[:：]?\\s*${filler}(A4|Letter)(?:\\s*(?:纸|纸张|页面))?$`,'i')))){
   const value=match[1].toLowerCase()==='a4'?'A4':'Letter';add(clause,{pageSize:value},`导出纸张：${value}`);continue;
  }
  const margins=clause.match(new RegExp(`^(?:(四边|全部|上下|左右|上|下|左|右)\\s*(?:页边距|边距)?|(?:页边距|边距)\\s*(四边|全部|上下|左右|上|下|左|右)?)\\s*[:：]?\\s*${filler}(?:各|均)?\\s*${num}\\s*${unit}$`,'i'));
  if(margins){
   const value=marginValue(margins[3],margins[4]),keys=direction[margins[1]||margins[2]||'四边'];
   if(!numberIn(value,5,50)){unresolved(clause,'支持的单边页边距为 5–50 mm；本项未应用。',true);continue;}
   add(clause,Object.fromEntries(keys.map(key=>[key,value])),`${keys.map(key=>labels[key]).join('、')}：${value} mm`);continue;
  }
  if((match=clause.match(/^(外文数字|英文和数字|英文及数字|中文|英文|外文)(正文)?(字体)?\s*[:：]?\s*(采用|使用|设为|设置为|为|用)?\s*(.+)$/i))){
   const raw=match[5].trim(),east=match[1]==='中文';
   const value=east?(EAST_ASIA.find(font=>font===raw)??eastAliases[raw.toLowerCase()]):LATIN.find(font=>font.toLowerCase()===raw.toLowerCase());
   if(value){add(clause,{[east?'fontEastAsia':'fontLatin']:value},`${east?'中文':'外文与数字'}字体：${value}（渲染仍依赖本机字体可用性）`);continue;}
   // "中文写作" / "英文摘要" are not declarations of a font. A named
   // unsupported font remains blocking when the clause actually asks for one.
   const fontIntent=Boolean(match[3]||match[4])||/体(?:字)?$/.test(raw)||/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(raw);
   if(fontIntent){unresolved(clause,`该字体尚未支持；当前保留${east?'宋体':'Times New Roman'}，未按指定字体完成。`,!/不要|不用|不再|无需|禁止|避免/.test(raw));continue;}
  }
  if((match=clause.match(new RegExp(`^正文(?:字号|字体大小)?\\s*[:：]?\\s*${filler}${num}\\s*(?:pt|磅|磅字号)$`,'i')))){
   const value=Number(match[1]);if(!numberIn(value,8,24)||!Number.isInteger(value*2)){unresolved(clause,'正文字号支持 8–24 磅，以 0.5 磅为单位；本项未应用。',true);continue;}
   add(clause,{bodyPt:value},`正文字号：${value} 磅`);continue;
  }
  if((match=clause.match(/^(?:正文(?:字号)?\s*[:：]?\s*(?:为|用)?\s*)(小五|五号|小四|四号|小三|三号|小二|二号)(?:字)?$/))){const value=sizes[match[1]];add(clause,{bodyPt:value},`正文字号：${value} 磅`);continue;}
  match=clause.match(new RegExp(`^(?:正文)?(?:行距\\s*[:：]?\\s*${filler}${num}\\s*倍|${num}\\s*倍(?:行距)?)$`,'i'));
  if(match){const value=Number(match[1]??match[2]);if(!numberIn(value,1,3)){unresolved(clause,'正文行距支持 1–3 倍；本项未应用。',true);continue;}add(clause,{lineSpacing:value},`正文行距：${value} 倍`);continue;}
  if(builtInNumericBibliography(clause)){
   if(options.preserveBibliography)unresolved(clause,'纯格式任务保留原文引用与书目，未执行引文体例转换；不能称已按指定体例完成。',true);
   else add(clause,{},'生成稿书目采用 GB/T 7714-2025 顺序编码结构；元数据完整性仍单独核对。');continue;
  }
  if(/^(?:正文按实际引用顺序编号|引用须与已取得证据对应|引用采用顺序编号|由程序按实际证据生成书目)$/.test(clause.replace(/\s+/g,''))){
   if(options.preserveBibliography)unresolved(clause,'纯格式任务保留原文引用与书目，未执行引用重排或新的证据对应核验。',true);
   else add(clause,{},'生成稿由宿主按实际引用顺序编号，并在交付门禁核对引用与可用证据身份；不代替科学支持判断。');continue;
  }
  if(/APA|MLA|Chicago|Harvard|Vancouver|IEEE|GB\s*\/?T\s*7714|著者.?出版年|作者.?年份|国标/i.test(clause)){
   if(/^(?:请)?(?:不要|不再|无需|不用|禁止|避免|取消|介绍|解释|比较|说明|什么是)|(?:是什么|有什么|区别|示例|举例)/.test(clause))unresolved(clause,'该条包含体例名称，但未识别为明确转换要求；已保留原文，尚未自动核验。');
   else unresolved(clause,options.preserveBibliography?'纯格式任务保留原文引用与书目，未执行引文体例转换；本项指定体例尚未实现。':'当前生成稿书目仅支持 GB/T 7714-2025 顺序编码结构；本项指定体例尚未实现，不能称已按该体例完成。',true);continue;
  }
  unresolved(clause,'已保留原要求；尚未转为可自动执行和核验的版式规则。仅有期刊名称不表示已读取或核验投稿规范。');
 }
 for(const [key,values]of proposals){
  if(new Set(values.map(entry=>entry.value)).size>1){
   for(const {index}of values){profile.items[index].status='conflict';profile.items[index].blocking=true;profile.items[index].detail+=`；${labels[key]}要求冲突，该参数保留项目默认值，未采用最后一项覆盖。`;}
   continue;
  }
  const value=values[0].value;if(key==='top'||key==='bottom'||key==='left'||key==='right')profile.settings.marginsMm[key]=value as number;
  else Object.assign(profile.settings,{[key]:value});
 }
 profile.warnings=profile.items.filter(item=>item.status!=='configured').map(item=>`${item.requirement}：${item.detail}`);
 validatedExportFormatSettings(profile);return profile;
}
