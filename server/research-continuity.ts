import type {Run,TaskContext,TaskPlan} from '../shared/types';
import {effectiveTaskPrompt,isExplicitNewTask} from './task-context';

type ContextRun=Pick<Run,'prompt'|'taskContext'|'materialIds'>&Partial<Pick<Run,'id'>>;
export type ResearchContinuation='same_research'|'evidence_only'|'none';
export interface ReferenceRequirementOverride {mode:'available';index:number;instruction:string;}

// Only user-authored instructions are inspected here. Quoted examples and
// conditional statements do not revoke a research requirement.
function clauses(prompt:string):{text:string;index:number}[]{
  const unquoted=prompt.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g,value=>' '.repeat(value.length));
  const output:{text:string;index:number}[]=[];
  const pattern=/[^，,。；;！!？?\n]+/g;
  for(const match of unquoted.matchAll(pattern)){
    const text=match[0].replace(/^\s*用户接续要求[：:]\s*/,'').trim();
    if(text)output.push({text,index:match.index+match[0].indexOf(text)});
  }
  return output;
}
const polite='(?:请|那|就|先|现在|好的|好|可以|直接)*';
const ending='(?:吧|即可|就行|就可以|好了|了)?';
const availableCount=new RegExp(`^${polite}(?:有什么(?:就)?写什么|有多少(?:合格|相关|可用|有效|真实)?(?:文献|论文|资料|证据)?(?:就)?(?:写|用|引用)多少|(?:不再要求|不用|不必|无需)(?:再)?(?:凑足|凑够|达到|满足)(?:至少)?[0-9零〇一二两三四五六七八九十百千]*(?:篇|条)?(?:参考文献|文献|论文|引用|数量|篇数)?|(?:参考文献|文献|引用)(?:数量|篇数|数目)?(?:不设下限|不设最低(?:数量|篇数)?|不再要求最低(?:数量|篇数)?)|(?:取消|撤销)(?:最低)?(?:引用|文献)(?:数量|篇数)(?:要求|限制))${ending}$`);
export function referenceRequirementOverride(prompt:string):ReferenceRequirementOverride|undefined{
  let result:ReferenceRequirementOverride|undefined;
  for(const clause of clauses(prompt)){
    if(/^(?:仍|还是|继续)按原(?:来|有)?(?:的)?(?:引用|文献)?数量要求$|^(?:不要|不得|不能)(?:再)?放宽(?:引用|文献)数量$/.test(clause.text)){result=undefined;continue;}
    if(availableCount.test(clause.text))result={mode:'available',index:clause.index,instruction:clause.text};
  }
  return result;
}

function context(run:ContextRun):TaskContext|undefined{return run.taskContext??(run.id?{rootRunId:run.id,rootPrompt:run.prompt,supplements:[]}:undefined);}
function sameMaterials(a:readonly string[],b:readonly string[]):boolean{return JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());}
function controlClause(text:string):boolean{
  return /^(?:好|好的|好了|可以|可以了|没问题|没有问题|确认|确认通过|同意|批准|通过|ok(?:ay)?|yes)$/i.test(text)
    ||/^(?:请|那|就|先|现在|直接)*(?:继续|接着|接续)(?:原任务|原研究|原主题|原综述|完成|写作|成文|执行|进行|下去|综述|任务|写正文|写全文|写文章|写)*(?:吧|即可|就行)?$/.test(text)
    ||/^(?:请)?按(?:当前|这个|这份|现有)清单继续(?:成文|写作|写正文|吧)?$/.test(text);
}
/** A pure control message can resume saved execution. Any actual requirement,
 * question, quoted command or condition must take the ordinary planning path. */
export function isPureContinuationInstruction(text:string):boolean{
  if(/[?？`“”「」『』"]/.test(text))return false;
  const parts=clauses(text);return parts.length>0&&parts.every(part=>controlClause(part.text));
}
function researchNeutral(text:string):boolean{
  if(availableCount.test(text)||controlClause(text))return true;
  return /^(?:请|那|就|先|现在|直接)*(?:继续|接着|接续)(?:原任务|原研究|原主题|原综述|完成|写作|成文|执行|进行|下去|综述|任务)*(?:吧|即可|就行)?$/.test(text)
    ||/^(?:请|那|就|先|现在|直接)*(?:按|用|基于)(?:已(?:有|取得|获取|获得|找到|检索到)|现有)(?:的)?(?:相关|可用|有效|真实)?(?:资料|文献|论文|证据|内容)(?:来)?(?:继续)?(?:完成|成文|写作|写|生成)(?:原任务|任务|综述|文章)?(?:吧|即可|就行)?$/.test(text)
    ||/^(?:请)?(?:不要|不用|不必|无需)(?:再)?(?:重新|从头|重启|再次)?(?:检索|搜索|重搜)(?:文献|论文|资料)?$/.test(text)
    ||/^(?:请)?(?:不要|不能|不得)(?:编造|捏造|凑数)(?:文献|论文|引用|证据)?$/.test(text)
    ||/^(?:请)?如实(?:说明|披露)(?:不足|限制|局限)$/.test(text)
    ||/^(?:请|现在|那|就|先)*(?:(?:参考文献|文献|引用)(?:数量|数目|篇数|要求)?(?:改为|改成|改回|恢复为?|恢复到|调整为|降低到|下调到|至少|不少于|不低于|最少|最低为)|(?:改为|改成|改回|恢复为?|恢复到|调整为|降低到|下调到))[0-9零〇一二两三四五六七八九十百千]+(?:篇|条)(?:参考文献|文献|论文|引用)?(?:即可|就行|吧)?$/.test(text);
}

/** A changed goal cannot borrow scientific judgments. An unknown refinement
 * may keep source documents, but must repeat planning and relevance judgments. */
export function classifyResearchContinuation(previous:ContextRun,next:ContextRun):ResearchContinuation{
  const before=context(previous),after=context(next);
  if(!before||!after||before.rootRunId!==after.rootRunId||before.rootPrompt!==after.rootPrompt)return 'none';
  if(effectiveTaskPrompt(before)!==previous.prompt||effectiveTaskPrompt(after)!==next.prompt)return 'none';
  if(before.supplements.some((value,index)=>after.supplements[index]!==value))return 'none';
  const added=after.supplements.slice(before.supplements.length);
  if(added.some(isExplicitNewTask))return 'none';
  const parts=added.flatMap(clauses).map(clause=>clause.text);
  if(parts.some(text=>/^(?:请)?(?:把|将)?(?:研究)?(?:主题|课题|问题)(?:改为|改成|换为|换成|调整为)/.test(text)))return 'none';
  if(parts.some(text=>!researchNeutral(text)&&/(?:重新|从头|重启|再次)(?:进行)?(?:文献)?(?:检索|搜索|搜集|研究)|补充检索|扩大检索|重新搜|\b(?:restart|redo|rerun)\b.{0,20}\b(?:search|research)\b/i.test(text)))return 'none';
  return sameMaterials(previous.materialIds,next.materialIds)&&parts.every(researchNeutral)?'same_research':'evidence_only';
}

/** Update only explicit reference-count wording; never remove other scientific
 * instructions, invent a new topic, or mutate the baseline plan. */
export function applyReferenceRequirement(plan:TaskPlan,prompt:string,minimumReferences?:number):TaskPlan{
  const minimum=minimumReferences??(referenceRequirementOverride(prompt)?0:plan.minimumReferences);
  if(minimum===undefined)return structuredClone(plan);
  const updated=structuredClone(plan);updated.minimumReferences=minimum;
  const number='[0-9零〇一二两三四五六七八九十百千]+';
  const pattern=new RegExp(`(?:(?:至少|不少于|不低于|最低(?:为)?|最少|≥|>=)\\s*)?${number}\\s*(?:篇|条)(?:\\s*(?:真实|相关|有效|可用))?(?:参考文献|文献|引用|来源)`,'g');
  const replacement=minimum===0?'已有可用且相关的文献（不设最低引用篇数）':`至少${minimum}篇可用且相关的文献`;
  const revise=(value:string)=>value.replace(/已有可用且相关的文献（不设最低引用篇数）|至少[0-9]+篇可用且相关的文献/g,replacement).replace(pattern,replacement);
  updated.deliverable=revise(updated.deliverable);
  updated.workPlan=updated.workPlan.map(revise);
  return updated;
}
