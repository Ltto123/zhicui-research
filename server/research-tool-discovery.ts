import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Run,Evidence,MethodSelection,Material} from '../shared/types';
import {prepared,type ResearchToolContext} from './research-tool-context';
import {researchRequest,screeningRequest,writingRequest,referenceRequirementForRun,minimumReferences,requiredEvidenceCount,selectedEvidence,citationAudit,discoveryHash,screeningInputHash,reusableScreening} from './engine';
import {effectiveMethods} from './methods';
import {PLAN,SYSTEM} from './prompts';
import {planSchema,generateStructuredJSON} from './schemas';
import {searchEvidence,fetchFullTextEvidence,newIndependentEvidence,RETRIEVAL_VERSION} from './retrieval';
import {screenEvidence} from './screening';
import {readFullTextEvidence,cachedReadingEvidence} from './reading';
import {calculateMaterials} from './calculations';
import {confirmationRequired,continuationTaskType,fullTextRequired} from './task-policy';
import {adoptReviewedCheckpoint} from './research-tool-writing';
import {citationReadiness} from './citation-readiness';
import {applyExplicitMethodOptions,resolveMethodUpdate} from './method-selection';
import {matchesWritingTarget,verifiedWritingTarget,type WritingTarget} from './writing-target';

const papers=(evidence:Evidence[])=>evidence.filter(e=>['abstract','full_text','metadata'].includes(e.readScope));
const abstract=(e:Evidence)=>['abstract','full_text'].includes(e.readScope)&&Boolean(e.abstract?.trim()||(e.readScope==='abstract'&&e.text.trim()));
// The agent owns the complete current corpus, including a legacy expansion that
// stopped between discovery and screening; the legacy pipeline's partial-corpus
// exemption must not hide those newly saved candidates from these tools.
const currentScreening=(run:Run)=>reusableScreening({...run,retrievalExpansion:undefined});
const at=()=>new Date().toISOString();
function addSelectedMaterials(evidence:Evidence[],materials:Material[]):Evidence[]{
 const selected=new Map(materials.map(material=>[material.id,material])),next=[...evidence],ids=new Set(evidence.map(entry=>entry.id));
 for(const entry of evidence.filter(entry=>entry.readScope==='user_material'&&entry.materialId)){
  const material=selected.get(entry.materialId!);
  if(!material||material.role!=='evidence'||material.text!==entry.text)throw new Error('已有材料被移除、换用或内容已改变，请用 research_update 重新评估，未覆盖原稿和原资料');
 }
 for(const material of materials.filter(material=>material.role==='evidence')){
  if(next.some(entry=>entry.readScope==='user_material'&&(entry.materialId===material.id||(entry.materialId&&selected.get(entry.materialId)?.sha256===material.sha256&&entry.text===material.text))))continue;
  let index=1;while(ids.has(`M${index}`))index++;const id=`M${index}`;ids.add(id);
  next.push({id,materialId:material.id,title:material.name,text:material.text,location:material.extraction,readScope:'user_material',retrievedAt:material.createdAt});
 }
 return next;
}
export class TaskPreparationConflict extends Error {
 readonly domain='task_continuation';
 readonly nextActions=['get_state','prepare_task','read_saved','screen_candidates','read_papers','sync_outline'];
 constructor(message='同一用户回合已确认接续已有研究，不能为修复工具或缓存错误改判为 research_update/new_task。计划、筛选、研读及论证清单均已保留。先 get_state 核对状态；新执行尚未准备时用 prepare_task(continue) 接续当前记录。随后 read_saved 核对具体缺口，筛选或研读不匹配时仅处理缺失条目，再 sync_outline 继续写作；只有新的实际用户要求或材料变化才能重新评估研究范围。'){super(message);}
}
function ancestors(ctx:ResearchToolContext){
 const run=ctx.store.getRun(ctx.runId),c=ctx.store.getConversation(run.conversationId),result:Run[]=[run],seen=new Set([run.id]);let id=run.taskContext?.parentRunId;
 while(id&&!seen.has(id)){seen.add(id);const source=c.runs.find(r=>r.id===id);if(!source||(source.taskContext?.rootRunId??source.id)!==(run.taskContext?.rootRunId??run.id))break;result.push(source);id=source.taskContext?.parentRunId;}
 return result;
}
export function getResearchState(ctx:ResearchToolContext){
 const run=ctx.store.getRun(ctx.runId),c=ctx.store.getConversation(run.conversationId),lineage=ancestors(ctx),ids=new Set(lineage.map(r=>r.id));
 const readiness=new Map(citationReadiness(run).map(entry=>[entry.id,entry]));
 return {runId:run.id,request:writingRequest(run),latestMessage:run.taskContext?.supplements.at(-1)??run.prompt,stage:run.stage,status:run.status,plan:run.plan,
  agent:run.agent,progress:run.progress,review:run.review,needsGenreRewrite:Boolean(run.pendingWritingTarget),formatGuidelines:run.formatGuidelines?.map(item=>({id:item.id,title:item.title,url:item.url,finalUrl:item.finalUrl,identityStatus:item.identityStatus,providedByUser:item.providedByUser})),formatResolution:run.formatResolution,hasOutline:Boolean(run.outline),draftCharacters:run.draft?.length??0,minimumReferences:minimumReferences(run),
  citationAudit:run.draft?citationAudit(run.draft,selectedEvidence(run),minimumReferences(run)):undefined,
  counts:{candidates:papers(run.evidence).length,pending:run.retrieval?.pendingEvidence?.length??0,screened:run.screening?.screenedCount??0,fullTexts:run.evidence.filter(e=>e.readScope==='full_text').length,readings:run.reading?.entries.length??0},
  paperIndex:papers(run.evidence).map(e=>({id:e.id,title:e.title,year:e.year,doi:e.doi,readScope:e.readScope,characters:e.text.length,...readiness.get(e.id)})),
  checkpoints:lineage.map(r=>({id:r.id,status:r.status,stage:r.stage,draftCharacters:r.draft?.length??0,readings:r.reading?.entries.length??0,outlineRows:r.outline?.rows.length??0,evidenceCount:r.evidence.length,issues:r.review?.issues,sourcePrompt:r.researchCheckpoint?.sourcePrompt??r.prompt})),
  conversation:c.messages.filter(m=>m.runId&&ids.has(m.runId)).slice(-16).map(m=>({role:m.role,text:m.content,kind:m.kind})),
  materials:ctx.store.selectedMaterials(c.id,run.materialIds).map(m=>({id:m.id,name:m.name,role:m.role,characters:m.text.length})),
  scope:'这是程序保存的实际状态。待处理记录不是已引用文献；已有草稿未必通过复查。用 read_saved 获取需要的具体材料，不要假定缺失。'};
}
export function prepareTask(ctx:ResearchToolContext,args:{mode:'continue'|'writing_update'|'research_update'|'new_task';sourceRunId?:string;reason:string;writingTarget?:WritingTarget}){
 ctx.signal.throwIfAborted();const run=ctx.store.getRun(ctx.runId);if(!run.agent)throw new Error('缺少当前智能体执行记录');
 const lineage=ancestors(ctx),source=args.sourceRunId?lineage.find(r=>r.id===args.sourceRunId):lineage.find(r=>r.draft||r.outline||r.reading?.entries.length||r.reading?.partialEntries?.length||r.screeningCheckpoint?.batches.length)||run;
 if(!source)throw new Error('只能使用当前研究明确关联的已保存记录');
 const latestUserRecord=()=>ctx.store.getConversation(run.conversationId).messages.findLast(message=>message.role==='user'&&message.runId===run.id);
 const latestUserMessage=()=>latestUserRecord()?.content??run.taskContext?.supplements.at(-1)??run.prompt;
 const latestMessage=latestUserMessage();
 // Bind an accepted interpretation to the actual user turn, not a model's
 // explanation or a scientific-cache hash that changes during normal work.
 const selectedMaterials=ctx.store.selectedMaterials(run.conversationId,run.materialIds);
 const addedMaterials=selectedMaterials.filter(material=>!source.materialIds.includes(material.id));
 const appendOnlyMaterials=Boolean(source.plan)&&source.materialIds.every(id=>run.materialIds.includes(id))&&addedMaterials.length>0&&addedMaterials.every(material=>material.role==='evidence');
 const savedWriting=Boolean(source.draft?.trim()||source.outline);
 const normalizedContinuation=args.mode==='continue'&&appendOnlyMaterials&&savedWriting;
 if(normalizedContinuation)args={...args,mode:'writing_update'};
 const requestHash=createHash('sha256').update(JSON.stringify({message:latestUserRecord(),prompt:run.prompt,taskContext:run.taskContext,materials:selectedMaterials.toSorted((a,b)=>a.id.localeCompare(b.id)),options:ctx.store.runOptions(run.id),explicit:ctx.store.runExplicitOptions(run.id)})).digest('hex');
 const accepted=run.agent.acceptedPreparation;
 if((args.mode==='research_update'||args.mode==='new_task')&&accepted?.requestHash===requestHash&&(accepted.mode==='continue'||accepted.mode==='writing_update'))throw new TaskPreparationConflict();
 const target=verifiedWritingTarget(args.mode,args.writingTarget,latestMessage,source.plan);
 if(accepted?.requestHash===requestHash&&(accepted.mode==='continue'||accepted.mode==='writing_update')&&(args.mode==='continue'||args.mode==='writing_update')){
  // A repeated preparation acknowledges the current checkpoint. Re-adopting
  // the parent here would roll back newer outlines, reviews or screening.
  if(run.agent.turnIntent&&accepted.mode===args.mode&&(!target||matchesWritingTarget(run.plan,target)))return getResearchState(ctx);
  if(source.id!==run.id)throw new Error('本轮已接续并保存当前工作，不能再次从旧记录覆盖；请将 sourceRunId 设为当前任务，保留新的提纲、筛选与复查结果。');
 }
 // Replaying this tool in the same execution must not roll back a newly saved
 // outline or re-mark a successfully rewritten manuscript as the original.
 if(target&&run.agent.turnIntent==='update'&&matchesWritingTarget(run.plan,target))return getResearchState(ctx);
 const options=ctx.store.runOptions(run.id),oldOptions=ctx.store.runOptions(source.id);
 const explicitOptions=ctx.store.runExplicitOptions(run.id);
 const sameMaterials=isDeepStrictEqual([...run.materialIds].sort(),[...source.materialIds].sort());
 const supplementalMaterials=args.mode==='writing_update'&&appendOnlyMaterials;
 const materialChangeAllowed=sameMaterials||supplementalMaterials;
 // Resolve new natural-language requirements before adopting or changing any
 // saved work. Cancellation or parsing failure leaves the prior plan intact.
 const apply=(updatedMethods?:MethodSelection)=>{
 ctx.signal.throwIfAborted();
 if(args.mode==='continue'||args.mode==='writing_update'){
  if(!materialChangeAllowed)throw new Error('所选材料已改变，请用 research_update 重新评估，已有原文仍保留');
  const supplemented=args.mode==='writing_update'?addSelectedMaterials(source.evidence,selectedMaterials):undefined;
  if(args.mode==='continue'&&(['methodMode','methodInstructions','formatInstructions'] as const).some(key=>options[key]!==oldOptions[key]))throw new Error('方法或格式已改变，请区分 writing_update 与 research_update，不得静默忽略');
  if(source.id!==run.id){
   const output=(record:Run)=>record.plan&&{taskType:record.plan.taskType,title:record.plan.title,deliverable:record.plan.deliverable,workPlan:record.plan.workPlan};
   const hasWritingContract=run.plan&&(run.pendingWritingTarget||run.outline||run.draft?.trim());
   if((hasWritingContract&&!isDeepStrictEqual(output(run),output(source)))||(run.pendingWritingTarget&&!isDeepStrictEqual(run.pendingWritingTarget,source.pendingWritingTarget)))throw new Error('本轮已保存不同的写作目标或正在改写稿件；请选择当前任务接续，不可用旧目标覆盖。');
   if(run.draft&&run.draft!==source.draft)throw new Error('本轮已有不同草稿，不能用旧稿覆盖；请基于当前稿处理');
   if(run.formatGuidelines?.some(entry=>!source.formatGuidelines?.some(old=>isDeepStrictEqual(old,entry)))||(['formatResolution','formatReview'] as const).some(key=>run[key]!==undefined&&!isDeepStrictEqual(run[key],source[key])))throw new Error('本轮已有新的格式规范或核对记录，不能用旧记录覆盖；请选择当前记录');
   if(run.evidence.some(entry=>!source.evidence.some(old=>isDeepStrictEqual(old,entry)))||run.reading?.entries.some(entry=>!source.reading?.entries.some(old=>isDeepStrictEqual(old,entry))))throw new Error('本轮有新的来源或研读进度，不能被旧记录覆盖；请选择当前记录');
   if(run.reading?.partialEntries?.some(entry=>!source.reading?.partialEntries?.some(old=>isDeepStrictEqual(old,entry)))||run.screeningCheckpoint?.batches.some(batch=>run.screeningCheckpoint?.contextHash!==source.screeningCheckpoint?.contextHash||!source.screeningCheckpoint?.batches.some(old=>isDeepStrictEqual(old,batch))))throw new Error('本轮已有新的分块研读或筛选检查点，不能用旧记录覆盖；请选择当前记录');
   const patch:Partial<Run>={};for(const key of ['plan','methodText','evidence','retrieval','screening','screeningCheckpoint','fullTextRetrieval','retrievalExpansion','retrievalExpansionHistory','reading','outline','draft','review','progress','writingReview','writingReviewCheckpoint','writingPatch','writingCitations','writingOutline','outlineConfirmed','formatGuidelines','formatResolution','formatReview','pendingWritingTarget'] as const)Object.assign(patch,{[key]:structuredClone(source[key])});
   ctx.store.updateRun(run.id,{...patch,researchCheckpoint:{sourceRunId:source.id,sourcePrompt:researchRequest(source),kind:'same_research'}});
  }else{
   const sourcePrompt=run.agent!.checkpointPrompt??researchRequest(run);
   if(researchRequest(run)!==sourcePrompt)ctx.store.updateRun(run.id,{researchCheckpoint:{sourceRunId:run.id,sourcePrompt,kind:'same_research'}});
  }
  if(args.mode==='writing_update'){
   const plan=run.plan&&structuredClone(run.plan),retargeting=Boolean(target&&plan&&!matchesWritingTarget(plan,target));
   if(plan){
    plan.methods=updatedMethods??applyExplicitMethodOptions(plan.methods,explicitOptions);
    plan.minimumReferences=referenceRequirementForRun(ctx.store,run).minimumReferences;
    if(target){plan.requiresResearchEvidence=requiredEvidenceCount(source)>0;plan.taskType=target.taskType;plan.title=target.title;plan.deliverable=target.deliverable;plan.workPlan=[...target.workPlan];}
   }
   const targetPatch:Partial<Run>=retargeting?{outline:undefined,outlineConfirmed:false,writingOutline:undefined,writingCitations:undefined,
    pendingWritingTarget:run.draft?.trim()?{previousDraftHash:createHash('sha256').update(JSON.stringify(run.draft)).digest('hex')}:undefined}:{};
   ctx.store.updateRun(run.id,{plan,evidence:supplemented!,methodText:plan?effectiveMethods(plan.methods):run.methodText,review:undefined,writingReview:undefined,writingReviewCheckpoint:undefined,writingPatch:undefined,formatReview:undefined,...(!run.draft?.trim()&&!supplementalMaterials?{outlineConfirmed:false}:{}),...targetPatch});
  }
 }else{
  // Historical originals stay available, but no previous scientific judgment is adopted.
  const evidence=newIndependentEvidence([],papers(run.evidence.length?run.evidence:source.evidence));
  ctx.store.updateRun(run.id,{evidence,plan:undefined,outline:undefined,outlineConfirmed:false,draft:undefined,review:undefined,writingReview:undefined,writingReviewCheckpoint:undefined,writingPatch:undefined,writingCitations:undefined,writingOutline:undefined,pendingWritingTarget:undefined,reading:undefined,screening:undefined,screeningCheckpoint:undefined,retrieval:undefined,retrievalExpansion:undefined,retrievalExpansionHistory:undefined,fullTextRetrieval:undefined,progress:undefined,researchCheckpoint:undefined,formatGuidelines:args.mode==='new_task'?undefined:structuredClone(run.formatGuidelines??source.formatGuidelines),formatResolution:undefined,formatReview:undefined});
 }
 const referenceRequirement=referenceRequirementForRun(ctx.store,run);ctx.store.updateRun(run.id,{referenceRequirement});
 const plan=run.plan;if(plan){const next=structuredClone(plan);next.minimumReferences=referenceRequirement.minimumReferences;next.waitForConfirmation=explicitOptions.waitForConfirmation??confirmationRequired(run.prompt,options.waitForConfirmation??plan.waitForConfirmation);ctx.store.updateRun(run.id,{plan:next,...(next.waitForConfirmation&&!plan.waitForConfirmation?{outlineConfirmed:false}:{})});}
 ctx.store.updateRun(run.id,{agent:{...run.agent!,turnIntent:args.mode==='continue'?'continue':args.mode==='new_task'?'new':'update',checkpointRunId:source.id,acceptedPreparation:{mode:args.mode,requestHash,executionId:run.agent!.executionId},...(args.mode==='research_update'||args.mode==='new_task'?{checkpointPrompt:undefined}:{})}});
 ctx.progress(`智能体判断本轮意图：${args.reason}。${args.mode==='continue'?'保留已有工作，从保存的阶段继续。':'已有原文保留，仅重新处理受要求变化影响的步骤。'}`);
 const adoptedReview=args.mode==='continue'?adoptReviewedCheckpoint(ctx,source.id):undefined;
 return {...getResearchState(ctx),adoptedReview,...(normalizedContinuation?{preparation:{requestedMode:'continue',appliedMode:'writing_update',reason:'仅追加背景材料，已保留原稿、提纲、文献及研读记录；新增材料只进入写作与相关复查。'}}:{})};
 };
 if(args.mode==='writing_update'&&source.plan){
  if(!materialChangeAllowed)throw new Error('所选材料已改变，请用 research_update 重新评估，已有原文仍保留');
  const previous=structuredClone(source.plan.methods);
  const snapshot=(owner:Run)=>structuredClone({plan:owner.plan,methodText:owner.methodText,draft:owner.draft,outline:owner.outline,pendingTarget:owner.pendingWritingTarget,prompt:owner.prompt,taskContext:owner.taskContext,materialIds:owner.materialIds,materials:ctx.store.selectedMaterials(owner.conversationId,owner.materialIds),formatGuidelines:owner.formatGuidelines,formatResolution:owner.formatResolution,formatReview:owner.formatReview,options:ctx.store.runOptions(owner.id),explicit:ctx.store.runExplicitOptions(owner.id),executionId:owner.agent?.executionId});
  const sourceBefore=snapshot(source),targetBefore=snapshot(run);
  return resolveMethodUpdate({request:writingRequest(run),latestMessage,previous,options:explicitOptions,inheritedOptions:options,materials:ctx.store.selectedMaterials(run.conversationId,run.materialIds).filter(material=>material.role!=='evidence').map(material=>({name:material.name,role:material.role,text:material.text}))},prompt=>ctx.generate(prompt,SYSTEM),ctx.progress).then(methods=>{
   ctx.signal.throwIfAborted();if(latestUserMessage()!==latestMessage||!isDeepStrictEqual(snapshot(ctx.store.getRun(source.id)),sourceBefore)||!isDeepStrictEqual(snapshot(ctx.store.getRun(run.id)),targetBefore))throw new Error('要求解析期间目标、计划、稿件或执行已改变，结果已过期，未覆盖当前工作，请重新接续');return apply(methods);
  });
 }
 return apply();
}
export async function planResearch(ctx:ResearchToolContext){
 const run=prepared(ctx),referenceRequirement=referenceRequirementForRun(ctx.store,run);ctx.store.updateRun(run.id,{referenceRequirement});
 if(run.plan){ctx.store.updateRun(run.id,{plan:{...run.plan,minimumReferences:referenceRequirement.minimumReferences}});return structuredClone(run.plan!);}ctx.stage('根据原目标与最新补充安排研究');
 const materials=ctx.store.selectedMaterials(run.conversationId,run.materialIds),options=ctx.store.runExplicitOptions(run.id),inheritedOptions=ctx.store.runOptions(run.id);
 const rootPlan=ancestors(ctx).toReversed().find(r=>r.plan)?.plan;
 const previousEffectiveMethod=ancestors(ctx).find(r=>r.id!==run.id&&r.plan)?.plan?.methods;
 const expectedType=continuationTaskType(run,rootPlan)??(/综述|literature review/i.test(run.taskContext?.rootPrompt??run.prompt)?'review':undefined);
 const schema=planSchema.superRefine((plan,context)=>{if(expectedType&&plan.taskType!==expectedType)context.addIssue({code:'custom',message:`原研究交付类型为 ${expectedType}，不能用其他任务类型绕过研究要求`});if(plan.taskType==='review'&&minimumReferences(run)>0&&!plan.searchQueries.length)context.addIssue({code:'custom',message:'文献综述必须提供主题相关的检索式'});});
 const plan:NonNullable<Run['plan']>=await generateStructuredJSON(p=>ctx.generate(p,SYSTEM),PLAN+'\n'+JSON.stringify({request:writingRequest(run),state:getResearchState(ctx),options,inheritedOptions,previousEffectiveMethod,materials:materials.map(m=>({name:m.name,role:m.role,text:m.text}))}),schema,ctx.progress);
 ctx.signal.throwIfAborted();plan.minimumReferences=minimumReferences(run);
 const defaultOutlineReview=rootPlan?.waitForConfirmation??!['local','format'].includes(plan.taskType);
 plan.waitForConfirmation=options.waitForConfirmation??confirmationRequired(run.prompt,inheritedOptions.waitForConfirmation??defaultOutlineReview);
 plan.evidenceRequirement=fullTextRequired(run.prompt)?'full_text':'abstract_or_full_text';
 if(previousEffectiveMethod&&plan.methodAction==='inherit')plan.methods={...structuredClone(previousEffectiveMethod),formatInstructions:plan.methods.formatInstructions};
 plan.methods=applyExplicitMethodOptions(plan.methods,options);
 const own=materials.filter(m=>m.role==='evidence').map((m,i):Evidence=>({id:`M${i+1}`,materialId:m.id,title:m.name,text:m.text,location:m.extraction,readScope:'user_material',retrievedAt:m.createdAt}));
 ctx.store.updateRun(run.id,{plan,methodText:effectiveMethods(plan.methods),evidence:[...run.evidence.filter(e=>e.readScope!=='user_material'),...own],writingReview:undefined});
 ctx.store.message(run.conversationId,'assistant',`本次交付：${plan.deliverable}\n\n${plan.workPlan.map((step,i)=>`${i+1}. ${step}`).join('\n')}`,'plan',run.id);return plan;
}
export async function searchMore(ctx:ResearchToolContext,args:{queries?:string[];limit?:number;usePending?:boolean}={}){
 const run=prepared(ctx);if(!run.plan)throw new Error('先安排研究计划');const limit=Math.min(60,Math.max(1,args.limit??30));
 const pending=newIndependentEvidence(papers(run.evidence),run.retrieval?.pendingEvidence??[]).filter(abstract),usePending=args.usePending!==false&&pending.length>0;
 ctx.stage(usePending?'处理已发现的下一批候选':'智能体补充检索论文摘要');
 const queries=args.queries?.length?args.queries:run.plan.searchQueries;if(!usePending&&!queries.length)throw new Error('提供与研究问题有关的检索式');
 const found=usePending?{evidence:pending.slice(0,limit),warnings:[] as string[],diagnostics:[],pendingEvidence:[] as Evidence[],discoveredCount:pending.length,rawReturnedCount:0}:await(ctx.search??searchEvidence)(queries,ctx.signal,ctx.progress,{topic:researchRequest(run),targetCount:limit,maxResults:limit,maxQueries:24,abstractOnly:true,excludeEvidence:papers(run.evidence)});
 ctx.signal.throwIfAborted();const additions=newIndependentEvidence(papers(run.evidence),found.evidence),evidence=[...run.evidence,...additions],remaining=newIndependentEvidence(papers(evidence),[...run.retrieval?.pendingEvidence??[],...found.evidence,...found.pendingEvidence??[]]);
 const retrieval={version:RETRIEVAL_VERSION,attemptedAt:run.retrieval?.attemptedAt??at(),completedAt:at(),queries:[...new Set([...run.retrieval?.queries??[],...queries])],minimumReferences:minimumReferences(run),targetCount:limit,retrievedCount:papers(evidence).length,usableCount:papers(evidence).filter(e=>e.readScope!=='metadata').length,evidenceHash:discoveryHash(papers(evidence)),warnings:[...run.retrieval?.warnings??[],...found.warnings],diagnostics:[...run.retrieval?.diagnostics??[],...found.diagnostics??[]],pendingEvidence:remaining};
 ctx.store.updateRun(run.id,{evidence,retrieval,writingReview:undefined});return {added:additions.length,remaining:remaining.length,usedSavedCandidates:usePending,warnings:found.warnings,next:'筛选新增摘要；无新增时可调整检索式或处理已有资料，不能把无结果解释为领域没有文献。'};
}
export async function screenCandidates(ctx:ResearchToolContext){
 const run=prepared(ctx);if(!run.plan)throw new Error('先安排研究计划');ctx.stage('筛选候选摘要并决定需要哪些全文');
 if(currentScreening(run))return {reused:true,screened:run.screening!.screenedCount};
 const inputs=run.evidence.filter(abstract),judged=new Set([...(run.screening?.includedIds??[]),...(run.screening?.excluded??[]).map(e=>e.id)]),fresh=inputs.filter(e=>!judged.has(e.id));
 const oldPool=run.evidence.filter(e=>!fresh.some(n=>n.id===e.id));
 // A legacy run has no per-batch checkpoint. Reuse its complete judgments only
 // after validating the exact former corpus, question, coverage and scope.
 const base=fresh.length&&currentScreening({...run,evidence:oldPool})?structuredClone(run.screening):undefined;
 const saveCheckpoint=(record:NonNullable<Run['screeningCheckpoint']>)=>{
  ctx.signal.throwIfAborted();const write=()=>ctx.store.updateRun(run.id,{screeningCheckpoint:record});
  // Notify the host before pending sibling responses can request more work.
  if(ctx.persist)ctx.persist(write);else write();
 };
 const result=await(ctx.screen??screenEvidence)(base?fresh:inputs,screeningRequest(run),minimumReferences(run),p=>ctx.generate(p,SYSTEM),ctx.progress,{decideFullText:true,requireFullText:run.plan.evidenceRequirement==='full_text'||fullTextRequired(run.prompt),saved:run.screeningCheckpoint,signal:ctx.signal,onSave:saveCheckpoint});
 ctx.signal.throwIfAborted();const screening={...result,includedIds:[...base?.includedIds??[],...result.includedIds],includedReasons:{...base?.includedReasons,...result.includedReasons},excluded:[...base?.excluded??[],...result.excluded],screenedCount:(base?.screenedCount??0)+result.screenedCount,fullTextIds:[...base?.fullTextIds??[],...result.fullTextIds??[]],fullTextReasons:{...base?.fullTextReasons,...result.fullTextReasons},inputHash:screeningInputHash(run)};
 ctx.store.updateRun(run.id,{screening,writingReview:undefined});return {screened:screening.screenedCount,retained:screening.includedIds.length,needsFullText:screening.fullTextIds.length};
}
export async function acquireFullTexts(ctx:ResearchToolContext,args:{limit?:number;retryMissing?:boolean}={}){
 const run=prepared(ctx);if(!currentScreening(run))throw new Error('必须先完成当前摘要筛选并决定是否需要全文');
 const requested=new Set(run.screening!.fullTextIds??[]),attempted=new Set(run.fullTextRetrieval?.requestedIds??[]);
 const inputs=run.evidence.filter(e=>requested.has(e.id)&&e.readScope!=='full_text'&&(args.retryMissing||!attempted.has(e.id))).slice(0,Math.min(60,Math.max(1,args.limit??12)));
 if(!inputs.length)return {newFullTexts:0,remaining:run.evidence.filter(e=>requested.has(e.id)&&e.readScope!=='full_text').length,note:'已取得正文不重复下载；失败来源只在明确 retryMissing 时重试，可改为补充其他论文。'};
 const expected=new Map(inputs.map(e=>[e.id,structuredClone(e)]));
 const validate=(entry:Evidence,fullOnly=false):Evidence=>{
  const original=expected.get(entry.id);if(!original)throw new Error('正文结果身份不符：不是本批指定来源');
  for(const key of ['title','authors','year','journal','publicationType','doi','url','fullTextUrls','materialId'] as const)if(!isDeepStrictEqual(entry[key],original[key]))throw new Error('正文结果身份不符：书目信息发生变化');
  if(entry.readScope!=='full_text'){if(fullOnly||!isDeepStrictEqual(entry,original))throw new Error('正文结果不是原候选或真实全文');return original;}
  const originalAbstract=original.abstract??(original.readScope==='abstract'?original.text:undefined);
  if(typeof entry.text!=='string'||!entry.text.trim()||!entry.location?.trim()||!entry.retrievedAt?.trim()||(entry.abstract!==undefined&&entry.abstract!==originalAbstract))throw new Error('正文结果缺少真实内容或改变原摘要');
  return {...original,text:entry.text,readScope:'full_text',location:entry.location,retrievedAt:entry.retrievedAt,abstract:originalAbstract,...(entry.sourceDocument?{sourceDocument:entry.sourceDocument}:{})};
 };
 ctx.stage(`获取本批 ${inputs.length} 篇选定论文的正文`);
 const found=await(ctx.fullText??fetchFullTextEvidence)(structuredClone(inputs),ctx.signal,ctx.progress,{maxResults:inputs.length,cacheDirectory:path.join(ctx.store.root,'source-documents'),onResult:entry=>{ctx.signal.throwIfAborted();const valid=validate(entry,true);ctx.store.updateRun(run.id,{evidence:run.evidence.map(e=>e.id===valid.id?valid:e),writingReview:undefined});}});
 ctx.signal.throwIfAborted();if(new Set(found.evidence.map(e=>e.id)).size!==found.evidence.length)throw new Error('正文结果含重复来源');const valid=found.evidence.map(e=>validate(e));
 const byId=new Map(valid.map(e=>[e.id,e]));ctx.store.updateRun(run.id,{evidence:run.evidence.map(e=>{const next=byId.get(e.id);return next?.readScope==='full_text'||e.readScope!=='full_text'?next??e:e;})});
 ctx.store.updateRun(run.id,{fullTextRetrieval:{inputHash:discoveryHash(run.evidence.filter(e=>requested.has(e.id))),completedAt:at(),requestedIds:[...new Set([...attempted,...inputs.map(e=>e.id)])],acquiredIds:run.evidence.filter(e=>requested.has(e.id)&&e.readScope==='full_text').map(e=>e.id),warnings:[...run.fullTextRetrieval?.warnings??[],...found.warnings],diagnostics:[...run.fullTextRetrieval?.diagnostics??[],...found.diagnostics??[]]},writingReview:undefined});
 return {newFullTexts:run.evidence.filter(e=>expected.has(e.id)&&e.readScope==='full_text').length,remaining:run.evidence.filter(e=>requested.has(e.id)&&e.readScope!=='full_text').length,warnings:found.warnings};
}
function readingProgress(run:Run){
 const selected=selectedEvidence(run),ready:Evidence[]=[];let readingCompleteCount=0;
 for(const entry of selected){if(entry.readScope!=='full_text'){ready.push(entry);continue;}const cached=cachedReadingEvidence([entry],researchRequest(run),run.reading);if(cached){readingCompleteCount++;ready.push(...cached);}}
 return {readingCompleteCount,writingReadyCount:citationAudit(ready.map(e=>`[${e.id}]`).join(' '),ready).distinctCitedLiteratureCount};
}
export async function readPapers(ctx:ResearchToolContext,args:{limit?:number}={}){
 const run=prepared(ctx);if(!currentScreening(run)&&run.evidence.some(abstract))throw new Error('先完成当前候选筛选');
 const selected=selectedEvidence(run),unread=selected.filter(e=>e.readScope==='full_text'&&!cachedReadingEvidence([e],researchRequest(run),run.reading));
 if(!unread.length){const progress=readingProgress(run);ctx.store.updateRun(run.id,{progress});return {reused:true,readings:progress.readingCompleteCount,remaining:0};}
 const targets=unread.slice(0,Math.min(10,Math.max(1,args.limit??4))),ids=new Set(targets.map(e=>e.id));ctx.stage(`研读本批 ${targets.length} 篇尚未完成的论文`);
 const save=(record:NonNullable<Run['reading']>)=>{ctx.signal.throwIfAborted();ctx.store.updateRun(run.id,{reading:{...record,entries:[...run.reading?.entries.filter(e=>!ids.has(e.evidenceId))??[],...record.entries],partialEntries:[...run.reading?.partialEntries?.filter(e=>!ids.has(e.evidenceId))??[],...record.partialEntries??[]]},writingReview:undefined});ctx.store.updateRun(run.id,{progress:readingProgress(run)});};
 const read=await readFullTextEvidence(targets,researchRequest(run),p=>ctx.generate(p,SYSTEM),ctx.progress,{saved:run.reading,signal:ctx.signal,onSave:save});save(read.record);
 ctx.store.updateRun(run.id,{writingReview:undefined,progress:readingProgress(run)});
 return {completed:targets.length,remaining:unread.length-targets.length,readings:run.reading?.entries.length};
}
export function readSaved(ctx:ResearchToolContext,args:{id:string;offset?:number;length?:number}){
 const run=ctx.store.getRun(ctx.runId),source=run.evidence.find(e=>e.id===args.id),material=ctx.store.selectedMaterials(run.conversationId,run.materialIds).find(m=>m.id===args.id),text=args.id==='draft'?run.draft:args.id==='outline'?JSON.stringify(run.outline):source?.text??material?.text;
 if(text===undefined)throw new Error('资料不存在或不属于当前任务');const start=Math.max(0,args.offset??0),length=Math.min(24000,Math.max(1,args.length??8000));return {id:args.id,totalCharacters:text.length,offset:start,text:text.slice(start,start+length),hasMore:start+length<text.length,scope:source?.readScope??'saved_work',...(source?{citationReadiness:citationReadiness(run).find(item=>item.id===source.id),notice:'查看已有内容不会自动改变筛选或阅读资格；引用须使用满足当前成稿条件的来源。'}:{})};
}
export async function analyzeData(ctx:ResearchToolContext){const run=prepared(ctx);ctx.stage('从所选数据执行可复核的计算');const computed=await calculateMaterials(ctx.store.selectedMaterials(run.conversationId,run.materialIds),ctx.signal);ctx.signal.throwIfAborted();ctx.store.updateRun(run.id,{evidence:[...run.evidence.filter(e=>e.readScope!=='computed'),...computed],writingReview:undefined});return {results:computed};}
