import type {ReviewIssue} from '../shared/types';

function abstractText(draft:string,english:boolean):string|undefined{
 const lines=draft.split(/\r?\n/);let start=-1,level=0;const content:string[]=[];
 for(let index=0;index<lines.length;index++){
  const line=lines[index].replace(/\*\*|__/g,'').trim();
  const match=/^(#{1,6}\s*)?(摘要|Abstract)\s*(?:[:：]\s*(.*))?$/i.exec(line);
  if(match&&((match[2].toLowerCase()==='abstract')===english)){start=index;level=match[1]?.trim().length??0;if(match[3])content.push(match[3]);break;}
 }
 if(start<0)return;
 for(const raw of lines.slice(start+1)){
  const line=raw.replace(/\*\*|__/g,'').trim(),heading=/^(#{1,6})\s/.exec(line);
  if((heading&&(!level||heading[1].length<=level))||/^(?:关键词|Keywords|引言|Introduction)\s*[:：]/i.test(line))break;
  content.push(line);
 }
 return content.join('\n').trim();
}

/** Small deterministic checks with explicitly stated counting rules. Anything
 * outside these patterns remains in semantic review rather than guessed. */
export function mechanicalFormatContentIssues(draft:string,requirements:string[]):ReviewIssue[]{
 const issues:ReviewIssue[]=[];
 for(const requirement of requirements){
  const match=/(?:摘要|abstract)[^。;；\n]{0,40}?(?:不超过|最多|至多|≤|no more than|maximum(?:\s+of)?|up to)\s*(\d{1,5})\s*(字|词|words?|characters?)/i.exec(requirement)
   ??/(?:摘要|abstract)[^。;；\n]{0,20}?\b(\d{1,5})\s*(words?|characters?)\s*(?:maximum|max\b|or fewer)/i.exec(requirement);
  if(!match)continue;
  const maximum=Number(match[1]),unit=match[2],english=/words?|characters?/i.test(unit)||/英文摘要/i.test(requirement);
  const text=abstractText(draft,english);
  if(!text){issues.push({severity:'error',location:'摘要篇幅',issue:'未能定位要求核对的摘要，不能判定篇幅已满足规范。',suggestion:'按要求补齐或明确标出摘要，再由程序重新计数。'});continue;}
  const words=/words?|词/i.test(unit);
  const count=words?(text.match(/\p{L}+(?:['’\-]\p{L}+)*|\p{N}+/gu)?.length??0):Array.from(text.replace(/\s/g,'')).length;
  if(count>maximum)issues.push({severity:'error',location:'摘要篇幅',issue:`摘要程序计数为 ${count} ${words?'词':'个非空白字符（含标点）'}，超过要求的 ${maximum}。`,suggestion:'保留必要信息并压缩摘要，随后自动重新计数；不得用模型估计替代实际计数。'});
 }
 return issues;
}
