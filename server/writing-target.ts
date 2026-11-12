import {z} from 'zod';
import type {TaskPlan} from '../shared/types';

const writingTargetSchema=z.object({
 taskType:z.enum(['review','proposal','report','paper']),
 title:z.string().trim().min(1).max(500),
 deliverable:z.string().trim().min(1).max(2000),
 workPlan:z.array(z.string().trim().min(1).max(2000)).min(1).max(8),
 requestQuote:z.string().trim().min(2).max(2000),
}).strict();
export type WritingTarget=z.infer<typeof writingTargetSchema>;
type Genre=WritingTarget['taskType'];

// These are names of output genres, independent of the research discipline.
// The tool supplies the new plan. The host checks its authority against an
// actual instruction, never a genre merely mentioned in background material.
const genreNames:Record<Genre,RegExp>={
 proposal:/开题报告|研究(?:方案|计划(?:书)?)|(?:research|study|project)\s+plan\b|\bproposal\b/i,
 review:/综述|\breview\b/i,
 paper:/论文|\b(?:paper|article|manuscript)\b/i,
 report:/报告|\breport\b/i,
};
function firstGenre(text:string):{kind:Genre;label:string}|undefined{
 let earliest=Infinity,found:{kind:Genre;label:string}|undefined;
 for(const [genre,pattern] of Object.entries(genreNames)){
  const match=pattern.exec(text);
  if(match&&match.index<earliest){earliest=match.index;found={kind:genre as Genre,label:match[0]};}
 }
 return found;
}
const change=/(?:改(?:写)?(?:成|为)|换(?:成|为)|转(?:换|写)?(?:成|为)|调整为|重写成|写成|(?:请|希望|想)(?:写|撰写|给我)(?:一份|一篇|一个)|(?:我?需要|我要)(?:一份|一篇)|\b(?:turn|convert|transform|rewrite|recast|change)\b.{0,90}?\b(?:as|into|to)\b|\b(?:write|prepare|draft|produce)\s+(?:me\s+)?(?:a|an|the)\s+)/i;
const nonInstruction=/不要|不用|不宜|不同意|不希望|不需要|不想|不必|不应|不能|没(?:有)?(?:要求|让|说)|从未|无需|无须|请勿|禁止|别把|别改|\b(?:not|never|don't|avoid)\b/i;
const hypothetical=/如果|假如|假设|例如|举例|示例|请解释|为什么|为何|是什么意思|有何区别|有什么区别|\b(?:if|why|suppose|example|explain|hypothetically)\b/i;
const localEdit=/术语|字样|词语|措辞|句子|表格|图题|表题|字体|字号|\b(?:term|phrase|sentence|caption|font)\b/i;
function directedGenre(message:string){
 // Quoted commands and examples do not authorize execution. A quoted genre
 // name following a real directive (改成“开题报告”) is still an ordinary name.
 const unquoted=message.replace(/```[\s\S]*?```|`[^`]*`/g,' ').replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g,quote=>change.test(quote)?' ':quote.slice(1,-1));
 let result:ReturnType<typeof firstGenre>;
 for(const sentence of unquoted.split(/[。；;！？!?\n]/)){
  if(/^\s*(?:如果|假如|假设|例如|举例|示例|if\b|suppose\b)/i.test(sentence))continue;
  for(const clause of sentence.split(/[，,]/)){
   if(hypothetical.test(clause))continue;
   if(/算了|(?:还是|仍然?|继续|请)\s*(?:保留|沿用|保持)(?:原|旧|现有|当前)|\b(?:never mind|keep the original)\b/i.test(clause)){result=undefined;continue;}
   const verb=change.exec(clause);
   if(!verb||nonInstruction.test(clause)||localEdit.test(clause.slice(0,verb.index)))continue;
   result=firstGenre(clause.slice(verb.index+verb[0].length,verb.index+verb[0].length+100))??result;
  }
 }
 return result;
}

function assignedTitle(message:string,title:string):boolean{
 return message.split(/[，,。；;！？!?\n]/).some(clause=>{
  const index=clause.indexOf(title);if(index<0)return false;
  const prefix=clause.slice(0,index).trim();
  return /^(?:请|将|把|新|本稿|稿件|报告|文章|成果|\s)*(?:(?:标题|题目|题名)(?:定为|改为|改成|设为|使用|采用|用|为|是|[:：])|题为|(?:new\s+)?title(?:d|\s+(?:it|is))?)\s*[:：]?\s*[《“"'「『]*$/i.test(prefix);
 });
}

export function verifiedWritingTarget(mode:string,provided:WritingTarget|undefined,message:string,previous?:TaskPlan):WritingTarget|undefined{
 const requested=directedGenre(message);
 if(!provided){
  if(previous&&requested&&requested.kind!==previous.taskType&&['continue','writing_update'].includes(mode))throw new Error('用户明确更改了交付体裁。请使用 writing_update 并提供有最新用户原文依据的 writingTarget。');
  return;
 }
 if(mode!=='writing_update'||!previous)throw new Error('只有已有研究的 writing_update 可更改写作目标。');
 const parsed=writingTargetSchema.safeParse(provided);
 if(!parsed.success)throw new Error('写作目标需包含受支持的体裁、标题、交付描述、1–8项写作步骤及真实用户原句。');
 const target=parsed.data;
 if(!message.includes(target.requestQuote)||requested?.kind!==target.taskType||directedGenre(target.requestQuote)?.kind!==target.taskType)throw new Error('目前的 writingTarget 与最新用户明确要求改变交付体裁的原句不匹配；继续、示例和被否定的修改不能授权换体裁。');
 if(!genreNames[target.taskType].test(target.title+'\n'+target.deliverable))throw new Error('新标题和交付描述没有体现用户指定的目标体裁。');
 // A real genre-change quote is not permission for the proposed metadata to
 // introduce another scientific topic. Ground free text in the prior question
 // or the user's actual wording; the outline can organize those instructions.
 const genreLabel=requested.label+(message.includes(requested.label+'框架')?'框架':message.includes(requested.label+'提纲')?'提纲':'');
 const subject=previous.question.trim().replace(/[。?？!！]+$/,'')||previous.title;
 const title=assignedTitle(message,target.title)?target.title:`${subject.slice(0,499-genreLabel.length)}：${genreLabel}`;
 const instructions=message.length<=2000?message:target.requestQuote;
 const positiveClauses=message.split(/[，,。；;！？!?\n]/).filter(clause=>!nonInstruction.test(clause)&&!hypothetical.test(clause)&&!/例文|示例|参考例/.test(clause));
 const grounded=(value:string)=>positiveClauses.some(clause=>clause.includes(value));
 const deliverable=grounded(target.deliverable)?target.deliverable:instructions;
 const workPlan=target.workPlan.every(grounded)?target.workPlan:[instructions];
 return {...target,title,deliverable,workPlan};
}

export function matchesWritingTarget(plan:TaskPlan|undefined,target:WritingTarget):boolean{
 return Boolean(plan&&plan.taskType===target.taskType&&plan.title===target.title&&plan.deliverable===target.deliverable&&
  plan.workPlan.length===target.workPlan.length&&plan.workPlan.every((step,index)=>step===target.workPlan[index]));
}
