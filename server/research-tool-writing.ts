import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {resolveArtifactTitle} from './artifact-title';
import type {ArgumentOutline,Artifact,Evidence,ReviewIssue,ReviewResult,Run} from '../shared/types';
import type {Store} from './store';
import {selectedEvidence,researchRequest,writingRequest,requiredEvidenceCount,minimumReferences,enforceReviewEvidence,
  draftBody,bodyCitationIds,missingOutlineCitationCount,revisionForModel,reusableScreening,
  citationAudit,citationIssues,withReferences,outlineForModel,constrainOutline,expansionForModel} from './engine';
import {cachedReadingEvidence} from './reading';
import {evidenceForModel,evidenceSummaryForModel,retrievalForModel,screeningForModel,fullTextForModel} from './evidence-context';
import {effectiveMethods} from './methods';
import {SYSTEM,DRAFT,OUTLINE,REVIEW,REVIEW_FOLLOWUP} from './prompts';
import {generateStructuredJSON,ModelStructureError,outlineSchema,reviewSchema,normalizeReviewResult} from './schemas';
import {exportArtifact} from './export';
import {registerArtifactOutput} from './run-files';
import {ensureCitedSourcesOpenable} from './source-access';
import {originalSourceAccessRequired} from './task-policy';
import {deliveryRequirements} from './delivery-requirements';
import {ensureTaskFormat,reviewFormatContent,resolvedExportFormat} from './research-tool-format';
import {isPureContinuationInstruction} from './research-continuity';
import {applyDraftEdits,type DraftEdit} from './draft-edits';
import {citationReadiness} from './citation-readiness';
import {INCREMENTAL_REVIEW_SCOPE,incrementalReviewContext,writingCitations} from './writing-review-context';
import {genreMethodUse,manuscriptWritingContext} from './manuscript-context';
import {manuscriptBoundaryIssues} from './manuscript-boundary';
import {z} from 'zod';

/** Server-owned capabilities only. No action accepts a client-provided Run,
 * source document, review stamp, or replacement evidence collection. */
export interface ActionContext {
 store:Store;
 runId:string;
 signal:AbortSignal;
 generate:(prompt:string,system?:string)=>Promise<string>;
 progress:(message:string)=>void;
 stage:(message:string)=>void;
 export?:typeof exportArtifact;
 sourceAccess?:typeof ensureCitedSourcesOpenable;
}
export interface WritingInstruction {instruction?:string;}
const MACHINE_ONLY_CHECK='本次只执行程序引用与修订前置核验，未调用模型复查全文';
const READER_POLICY_VERSION=1 as const;

function digest(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function guard(context:ActionContext):Run{
 context.signal.throwIfAborted();
 const run=context.store.getRun(context.runId);
 if(run.status==='cancelled'||run.status==='interrupted')throw new Error('本次执行已经停止，不能写入迟到的模型结果。');
 return run;
}
function mutable(context:ActionContext):Run{
 const run=guard(context);
 if(['completed','limited'].includes(run.status))throw new Error('本轮已交付；请创建关联修订后修改，不能覆盖已交付成果。');
 return run;
}
function materials(context:ActionContext,run:Run){return context.store.selectedMaterials(run.conversationId,run.materialIds);}
function reviewRequest(run:Run,value:string):string{
 const task=run.taskContext;if(!task)return value;
 // Normalize only an exact recorded goal/prefix, never arbitrary prose. Pure
 // control messages change execution bookkeeping, not the scientific review.
 let prefix=task.rootPrompt,substantive=task.rootPrompt;
 if(value===prefix)return substantive;
 for(const supplement of task.supplements){
  prefix+='\n用户接续要求：'+supplement;
  if(!isPureContinuationInstruction(supplement))substantive+='\n用户接续要求：'+supplement;
  if(value===prefix)return substantive;
 }
 return value;
}
/** Excludes execution bookkeeping, includes all scientific inputs and their
 * interpretation. A saved review is authorization for exactly this snapshot. */
function reviewInputs(context:ActionContext,run:Run){
 const task=run.taskContext,canonical=task?task.rootPrompt+task.supplements.map(value=>'\n用户接续要求：'+value).join(''):undefined;
 const taskContext=task&&canonical===run.prompt?{rootRunId:task.rootRunId,rootPrompt:task.rootPrompt,supplements:task.supplements.filter(value=>!isPureContinuationInstruction(value))}:task;
 return {version:1,runId:run.id,prompt:reviewRequest(run,run.prompt),taskContext,researchQuestion:reviewRequest(run,researchRequest(run)),
  plan:run.plan,methodText:run.methodText,materials:materials(context,run),options:context.store.runOptions(run.id),formatGuidelines:run.formatGuidelines,formatResolution:run.formatResolution,formatReview:run.formatReview,
  draft:run.draft,outline:run.outline,writingOutline:run.writingOutline,outlineConfirmed:run.outlineConfirmed,evidence:run.evidence,reading:run.reading,
  retrieval:run.retrieval,screening:run.screening,fullTextRetrieval:run.fullTextRetrieval,
  retrievalExpansion:run.retrievalExpansion,retrievalExpansionHistory:run.retrievalExpansionHistory,revision:run.revision,pendingWritingTarget:run.pendingWritingTarget};
}
function inputHash(context:ActionContext,run:Run):string{return digest(reviewInputs(context,run));}
function scientificHash(context:ActionContext,run:Run):string{
 const {draft,writingOutline,formatReview,...inputs}=reviewInputs(context,run);
 const revision=inputs.revision?{...inputs.revision,phase:undefined}:undefined;
 return digest({...inputs,revision});
}
function unchanged(context:ActionContext,expected:string):Run{
 const run=guard(context);
 if(inputHash(context,run)!==expected)throw new Error('稿件、证据或要求在本次操作期间发生变化；未写回过期结果，请基于最新状态继续。');
 return run;
}
function reviewCurrent(context:ActionContext,run:Run):boolean{
 const stamp=run.writingReview;
 return Boolean(run.review&&stamp?.version===1&&stamp.inputHash===inputHash(context,run)&&stamp.reviewHash===digest(run.review));
}
function writingEvidence(context:ActionContext,run:Run):Evidence[]{
 if(!run.plan)throw new Error('尚未保存有效研究计划，请先规划任务。');
 if(new Set(run.evidence.map(entry=>entry.id)).size!==run.evidence.length)throw new Error('证据ID不唯一，不能可靠核对引用，请先修复证据身份。');
 if(run.plan.taskType!=='format'&&run.evidence.some(entry=>['abstract','full_text'].includes(entry.readScope))&&!reusableScreening({...run,retrievalExpansion:undefined})){
  throw new Error('当前证据尚无完整且匹配本研究的筛选判断；请先完成摘要筛选，不能直接将全部候选当作相关文献。');
 }
 const selected=selectedEvidence(run);
 const projected=selected.some(entry=>entry.readScope==='full_text')?cachedReadingEvidence(selected,researchRequest(run),run.reading):selected;
 if(!projected)throw new Error('选中文献尚有缺失或过期的完整研读笔记；请先完成研读和笔记核对，原文不能直接冒充已核验笔记。');
 const evidence=projected.filter(entry=>entry.text.trim());
 enforceReviewEvidence(run,evidence,true);
 return evidence;
}
function required(run:Run):number{return Math.max(minimumReferences(run),requiredEvidenceCount(run));}
function checkConfirmed(run:Run):void{
 if(run.plan?.waitForConfirmation&&!run.outlineConfirmed&&!run.draft?.trim())throw new Error('用户要求先确认论证清单；尚未确认，不能开始首稿。请等待用户确认。');
}
function system(run:Run):string{return [SYSTEM,'本次实际生效方法：',run.methodText??effectiveMethods(run.plan!.methods),genreMethodUse(run)].filter(Boolean).join('\n');}
function authorContext(context:ActionContext,run:Run,evidence:Evidence[]){
 return {...manuscriptWritingContext(run,evidence),materials:materials(context,run).filter(material=>material.role!=='evidence').map(({role,text})=>({role,text})),
  formatGuidelines:run.formatGuidelines?.map(({title,text})=>({title,text})),formatInstructions:run.formatResolution?.instructions};
}
function reviewContext(context:ActionContext,run:Run,evidence:Evidence[]){
 return {request:writingRequest(run),plan:run.plan,methodText:run.methodText,evidence:evidenceForModel(evidence),
  citationReadiness:citationReadiness(run),citationBoundary:'只有evidence中的ID可支持本次成文；citationAudit.unknownIds表示不在当前可引用集合，其中可能是候选库已有但未满足筛选/阅读要求的来源，不等于文献不存在。请根据citationReadiness区分，read_saved不会提升资格。',
  selectedEvidenceSummary:evidenceSummaryForModel(evidence),retrieval:retrievalForModel(run.retrieval),screening:screeningForModel(run.screening),
  fullTextRetrieval:fullTextForModel(run.fullTextRetrieval),retrievalExpansion:expansionForModel(run),outline:outlineForModel(run),writingCitations:run.writingCitations,outlineScope:'outline为已审校的写作提纲，不要求逐条列齐正文文献；writingCitations由程序从正文解析，仅定位实际引用，不证明语义支持。审查稿件是否遵循提纲、主张是否被原文支持，不因提纲未逐篇列ID要求重做提纲。',revision:revisionForModel(run),
  materials:materials(context,run).filter(material=>material.role!=='evidence').map(material=>({role:material.role,text:material.text})),formatGuidelines:run.formatGuidelines,formatResolution:run.formatResolution};
}
function instruction(input:WritingInstruction):string{
 if(input.instruction===undefined)return '';
 if(typeof input.instruction!=='string'||input.instruction.length>12000)throw new Error('写作工具的局部指示必须是至多12000字符的文字。');
 return '\n本次局部处理指示（不能替换原研究目标、证据或用户要求）：\n'+JSON.stringify(input.instruction);
}
function cleanDraft(value:string):string{
 const draft=value.trim().replace(/^```(?:markdown|md)?\s*/,'').replace(/\s*```$/,'').trim();
 if(draft.length<30)throw new Error('模型没有返回可独立阅读的完整稿件；未替换已有稿件。');
 return draft;
}
function currentCitationIssues(run:Run,evidence:Evidence[]):ReviewIssue[]{
 const issues=citationIssues(run.draft??'',evidence,required(run)),known=new Set(run.evidence.map(entry=>entry.id));
 const unknown=new Set(citationAudit(run.draft??'',evidence,required(run)).unknownIds);
 return issues.map(issue=>{
  const id=issue.location.startsWith('[')&&issue.location.endsWith(']')?issue.location.slice(1,-1):'';
  if(!unknown.has(id))return issue;
  return {...issue,issue:known.has(id)?'该来源存在于候选库，但尚未满足本稿的筛选或阅读要求，当前不可引用':'该来源ID在当前任务资料中不存在',suggestion:known.has(id)?'先取得该来源要求的正文并完成核验，或仅局部撤回依赖它的主张；read_saved查看摘要不会改变引用资格':'核对真实来源身份；不能猜测替换ID。无法追溯时局部撤回无依据主张'};
 });
}
function readerIssues(run:Run):ReviewIssue[]{
 const issues=manuscriptBoundaryIssues(run.draft??'');
 if(run.pendingWritingTarget)issues.push({severity:'error',location:'稿件体裁与交付目标',issue:'当前保留的是此前体裁的稿件，尚未依最新目标重写。',suggestion:'依据新目标和提纲重新组织完整正文，完成复查后再交付。'});
 return issues;
}
function scientificCheckpoint(context:ActionContext,run:Run,review:ReviewResult,reviewedAt:string,policy?:1){
 return {version:1 as const,contextHash:scientificHash(context,run),draftHash:digest(run.draft!),draft:run.draft!,review:structuredClone(review),reviewHash:digest(review),reviewedAt,...(policy?{readerPolicyVersion:policy}:{})};
}
function savePreflight(context:ActionContext,run:Run,issues:ReviewIssue[]):ReviewResult{
 // Older saved manuscripts may already have a valid scientific review from
 // before this reader-facing policy. Preserve that baseline for local edits.
 const prior=reviewCurrent(context,run)?run.review:undefined;
 const baseline=prior&&!prior.checks.includes(MACHINE_ONLY_CHECK)&&run.draft?scientificCheckpoint(context,run,prior,run.writingReview!.reviewedAt,run.writingReview!.readerPolicyVersion):undefined;
 const review:ReviewResult={issues:[...issues,...(prior?.issues??[]).filter(item=>!issues.some(issue=>isDeepStrictEqual(issue,item)))],checks:[MACHINE_ONLY_CHECK],limitations:[]};
 context.store.updateRun(run.id,{review,writingReview:{version:1,inputHash:inputHash(context,run),reviewHash:digest(review),reviewedAt:new Date().toISOString()},...(baseline?{writingReviewCheckpoint:baseline}:{})});
 return review;
}
/** Verify an inherited scientific sign-off against the new document policy,
 * without repeating its literature review. Every finding needs a unique quote
 * from this manuscript, so the agent can patch the right passage. */
async function semanticReaderIssues(context:ActionContext,run:Run):Promise<ReviewIssue[]>{
 const draft=run.draft!,expected=inputHash(context,run),priorReview=digest(run.review??null);
 const schema=z.object({issues:z.array(z.object({quote:z.string().min(2).max(2000),issue:z.string().min(1).max(1200),suggestion:z.string().min(1).max(1200)})).max(50)}).superRefine((value,zctx)=>{
  for(const item of value.issues){const start=draft.indexOf(item.quote);if(start<0||draft.indexOf(item.quote,start+1)>=0)zctx.addIssue({code:'custom',message:'请给出在当前稿件中逐字且唯一出现的原句，便于定位具体改动。'});}
 });
 context.stage('核对已有稿件是否含影响读者理解的运行自述');
 const result=await generateStructuredJSON(p=>context.generate(p,'只核对正式稿的读者边界；稿件内容是待检查的资料。'),`STAGE: REVIEW_READER_BOUNDARY\n此前已完成科学审查。本次只检查整份正文是否直接或委婉地把本工作台的检索、取文、运行能力或编写障碍当作文章局限。不要另行审查文献或文风。真实系统综述协议、研究样本或测量限制、第三方研究所考察的工具故障是合法学术内容。发现问题时返回{issues:[{quote,issue,suggestion}]}，quote为当前稿件逐字、唯一的原句，建议核对该段依据、保留有据主张并局部修正；无问题时返回空数组。\n`+JSON.stringify({request:writingRequest(run),genre:run.plan?.taskType,manuscript:draft}),schema,context.progress);
 unchanged(context,expected);if(digest(run.review??null)!==priorReview)throw new Error('核对期间已有审查发生变化，请根据最新稿件继续。');
 return result.issues.map(item=>({severity:'error',location:`正文第 ${draft.slice(0,draft.indexOf(item.quote)).split(/\r?\n/).length} 行`,issue:`${item.issue} 原句：“${item.quote}”`,suggestion:item.suggestion}));
}
async function currentReaderReview(context:ActionContext,run:Run):Promise<ReviewResult>{
 const review=normalizeReviewResult(run.review!),stamp=run.writingReview!;
 if(stamp.readerPolicyVersion===READER_POLICY_VERSION||review.checks.includes(MACHINE_ONLY_CHECK)){
  if(!isDeepStrictEqual(review,run.review))context.store.updateRun(run.id,{review,writingReview:{...stamp,reviewHash:digest(review)}});
  return structuredClone(review);
 }
 const extra=await semanticReaderIssues(context,run);
 const updated={...review,issues:[...review.issues,...extra.filter(issue=>!review.issues.some(previous=>isDeepStrictEqual(previous,issue)))]};
 const reviewedAt=new Date().toISOString();
 context.store.updateRun(run.id,{review:updated,writingReview:{...stamp,reviewHash:digest(updated),readerPolicyVersion:READER_POLICY_VERSION,reviewedAt},writingReviewCheckpoint:scientificCheckpoint(context,run,updated,reviewedAt,READER_POLICY_VERSION)});
 return structuredClone(updated);
}
function changedTargetBody(previous:string,next:string):boolean{
 const substantive=(text:string)=>draftBody(text).body.split(/\r?\n/).filter(line=>!/^\s{0,3}#{1,6}\s/.test(line)).join('').replace(/\[[^\]\n]+\]/g,'').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
 const before=substantive(previous),after=substantive(next),minimum=Math.min(80,Math.max(12,Math.ceil(before.length*.02)));
 if(after.length<12)return false;
 if(Math.abs(before.length-after.length)>=minimum)return true;
 // Bounded shortest edit path: a pair of distant spelling changes still costs
 // just a few insertions/deletions. The capped threshold avoids a full diff.
 const frontier=new Int32Array(2*minimum+3),origin=minimum+1;
 for(let edits=0;edits<minimum;edits++)for(let diagonal=-edits;diagonal<=edits;diagonal+=2){
  const k=origin+diagonal;
  let x=diagonal===-edits||(diagonal!==edits&&frontier[k-1]<frontier[k+1])?frontier[k+1]:frontier[k-1]+1,y=x-diagonal;
  while(x<before.length&&y<after.length&&before[x]===after[y]){x++;y++;}
  frontier[k]=x;if(x>=before.length&&y>=after.length)return false;
 }
 return true;
}
function validateDraftChange(run:Run,evidence:Evidence[],draft:string){
 if(draft.trim().length<30)throw new Error('修订结果不足以独立交付，未替换已有稿件');
 const before=citationAudit(run.draft??'',evidence,required(run)),after=citationAudit(draft,evidence,required(run));
 if(after.unknownIds.some(id=>!before.unknownIds.includes(id)))throw new Error('修订新增了不存在或不满足阅读要求的引用ID，未替换原稿；请只用可引用来源');
 if(after.hasModelBibliography&&!before.hasModelBibliography)throw new Error('修订不得自行新增参考文献表；编号与书目由导出程序生成');
 if(before.distinctCitedLiteratureCount>=required(run)&&after.distinctCitedLiteratureCount<required(run))throw new Error('修订使原本已达标的实际引用数低于最低要求，未替换原稿');
}
function saveDraftChange(context:ActionContext,run:Run,evidence:Evidence[],draft:string,edits?:DraftEdit[]){
 if(run.pendingWritingTarget&&(edits||!changedTargetBody(run.draft??'',draft)))throw new Error('新体裁需要重写实质正文；仅换标题、引用或少量字符不能完成该交付，已保留原稿。');
 if(draft===run.draft)return {changed:false,draftCharacters:draft.length,draftHash:digest(draft),outlineSyncRequired:false,reviewRequired:!reviewCurrent(context,run)};
 validateDraftChange(run,evidence,draft);
 let patch:Run['writingPatch'];const existing=run.writingReviewCheckpoint;
 const base=existing?.contextHash===scientificHash(context,run)?existing:(reviewCurrent(context,run)&&!run.review!.checks.includes(MACHINE_ONLY_CHECK)?scientificCheckpoint(context,run,run.review!,run.writingReview!.reviewedAt,run.writingReview!.readerPolicyVersion):undefined);
 if(edits&&base&&base.contextHash===scientificHash(context,run)){
  const prior=base.draftHash===digest(run.draft)?[]:run.writingPatch?.baseDraftHash===base.draftHash?run.writingPatch.edits:undefined;
  if(prior)patch={version:1,baseDraftHash:base.draftHash,edits:[...prior,...edits.toSorted((a,b)=>run.draft!.indexOf(b.before)-run.draft!.indexOf(a.before))]};
 }
 context.store.updateRun(run.id,{draft,writingOutline:{version:1,draftHash:digest(draft)},writingCitations:writingCitations(draft),writingPatch:patch,writingReviewCheckpoint:base,writingReview:undefined,...(run.pendingWritingTarget?{pendingWritingTarget:undefined,writingReviewCheckpoint:undefined,writingPatch:undefined}:{}),...(run.revision?{revision:{...run.revision,phase:'draft_saved' as const}}:{})});
 return {changed:true,draftCharacters:draft.length,draftHash:digest(draft),outlineSyncRequired:false,reviewRequired:true};
}
function outlineIssues(run:Run,evidence:Evidence[]):ReviewIssue[]{
 const issues:ReviewIssue[]=[];
 if(!isDeepStrictEqual(run.writingCitations,writingCitations(run.draft??'')))issues.push({severity:'error',location:'正文引用索引',issue:'当前正文的引用位置索引尚未同步',suggestion:'由程序同步当前正文引用索引，不重新生成用户已审校的写作提纲'});
 if(!run.outline)issues.push({severity:'error',location:'论证清单',issue:'当前稿件没有对应论证清单',suggestion:'调用同步清单工具，依据当前完整稿件和证据生成清单'});
 if(run.revision&&run.revision.phase!=='applied')issues.push({severity:'error',location:'定向修订',issue:'已要求的定向修订尚未完成修稿及清单同步',suggestion:run.revision.phase==='pending'?'先对照原文执行定向修订，再同步清单并复查':'同步已修订稿件的论证清单，再进行复查'});
 return issues;
}

export function getDraft(context:ActionContext){
 context.signal.throwIfAborted();const run=context.store.getRun(context.runId);
 const current=reviewCurrent(context,run);
 return {draft:run.draft,draftHash:run.draft?digest(run.draft):undefined,outline:run.outline,writingCitations:run.writingCitations,review:run.review,reviewCurrent:current,reviewStale:Boolean(run.review&&!current),revision:run.revision,manuscriptIssues:readerIssues(run),
  citationReadiness:citationReadiness(run),citationBoundary:'eligibleForWriting=true只表示满足当前筛选与阅读要求，语义支持仍需逐条核对。原文候选中存在、read_saved读到摘要或有下载链接，均不自动取得引用资格。旧reviewStale=true的意见仅为历史记录，不能当当前未解决问题再次整稿改写。',
  editBoundary:'小范围错误优先patch_draft，使用本次draftHash及原稿中唯一的before片段；多处替换同时基于当前完整原稿定位，其余内容逐字保留。',
  minimumReferences:run.plan?required(run):undefined,status:run.status};
}

/** Host-applied local edits are atomic and make no model/network requests. */
export function patchDraft(context:ActionContext,input:{draftHash:string;edits:DraftEdit[]}){
 const run=mutable(context);checkConfirmed(run);
 if(!run.draft?.trim())throw new Error('尚无保存稿件可局部修订');
 if(run.pendingWritingTarget)throw new Error('既有稿件属于旧体裁，需先按新目标重新组织完整正文，不能用局部替换跳过重写。');
 if(run.plan?.taskType==='format')throw new Error('纯格式任务不能通过局部修订工具改写原文');
 if(!input||input.draftHash!==digest(run.draft))throw new Error('稿件版本已变化，未应用过期修改；请重新读取当前稿件');
 const draft=applyDraftEdits(run.draft,input.edits),evidence=writingEvidence(context,run);
 return saveDraftChange(context,run,evidence,draft,input.edits);
}

/** Rebind only a genuinely unchanged, previously approved checkpoint. The
 * agent's intention label alone cannot authorize reuse of scientific approval. */
export function adoptReviewedCheckpoint(context:ActionContext,sourceRunId:string):{reused:boolean;reason?:string}{
 const run=mutable(context),decline=(reason:string)=>({reused:false,reason});
 if(run.agent?.turnIntent!=='continue')return decline('只有原样继续才可沿用通过的审查。');
 if(run.id===sourceRunId)return {reused:reviewCurrent(context,run)};
 const conversation=context.store.getConversation(run.conversationId),seen=new Set([run.id]);let parentId=run.taskContext?.parentRunId,source:Run|undefined;
 while(parentId&&!seen.has(parentId)){
  seen.add(parentId);const parent=conversation.runs.find(candidate=>candidate.id===parentId);if(!parent)break;
  if(parent.id===sourceRunId){source=parent;break;}parentId=parent.taskContext?.parentRunId;
 }
 if(!source||!source.taskContext||!run.taskContext||source.taskContext.rootRunId!==run.taskContext.rootRunId||source.taskContext.rootPrompt!==run.taskContext.rootPrompt)return decline('来源不是同一研究的明确祖先。');
 const before=source.taskContext.supplements,after=run.taskContext.supplements,added=after.slice(before.length);
 if(before.some((value,index)=>after[index]!==value)||!added.length||!added.every(isPureContinuationInstruction))return decline('本轮包含未确认保持原样的要求，不能直接沿用旧通过标记。');
 if(researchRequest(source)!==researchRequest(run)||required(source)!==required(run))return decline('研究问题或最低引用要求已经改变。');
 if(!reviewCurrent({...context,runId:source.id},source))return decline('来源审查已过期或无法核验。');
 const payload=(candidate:Run)=>{
  const {version,runId,prompt,taskContext,options,...scientific}=reviewInputs(context,candidate);
  // taskIntent is a submission-routing flag; selected materials are compared
  // by their actual saved objects rather than omitted/explicit input syntax.
  const {taskIntent,materialIds,...effectiveOptions}=options;
  return {...scientific,options:effectiveOptions};
 };
 if(!isDeepStrictEqual(payload(source),payload(run))||!isDeepStrictEqual(source.review,run.review))return decline('稿件、科学输入、方法、材料、确认状态或审查内容不一致。');
 const sourceStamp=source.writingReview!;
 context.store.updateRun(run.id,{writingReview:{version:1,inputHash:inputHash(context,run),reviewHash:digest(run.review),reviewedAt:sourceStamp.reviewedAt,readerPolicyVersion:sourceStamp.readerPolicyVersion},...(!run.review!.checks.includes(MACHINE_ONLY_CHECK)?{writingReviewCheckpoint:scientificCheckpoint(context,run,run.review!,sourceStamp.reviewedAt,sourceStamp.readerPolicyVersion),writingPatch:undefined}:{})});
 context.progress('已核对本轮与此前审查的稿件及科学输入完全一致；沿用已完成的审查记录，实质问题仍需自动修复，未重复调用全文复查。');
 return {reused:true};
}

/** Exactly one drafting action; it does not search, read, review or publish. */
export async function writeDraft(context:ActionContext,input:WritingInstruction={}){
 const run=mutable(context),evidence=writingEvidence(context,run);checkConfirmed(run);
 if(run.draft?.trim())throw new Error('已有保存稿件；请读取并使用定向修订工具，不要重新生成覆盖已有进度。');
 if(!run.outline&&run.plan!.taskType!=='format')throw new Error('请先生成论证清单，再依据清单写稿。');
 await ensureTaskFormat(context);
 const expected=inputHash(context,run);context.stage('生成指定成果');
 let draft:string;
 if(run.plan!.taskType==='format'){
  const originals=materials(context,run).filter(material=>material.role==='evidence');
  if(!originals.length)throw new Error('纯格式任务需要选中的原文材料；不能由模型补造原文。');
  draft=originals.map(material=>material.text).join('\n\n');
 }else draft=cleanDraft(await context.generate(DRAFT+instruction(input)+'\n研究资料：\n'+JSON.stringify(authorContext(context,run,evidence)),system(run)));
 unchanged(context,expected);context.store.updateRun(run.id,{draft,review:undefined,writingReview:undefined,writingPatch:undefined,writingReviewCheckpoint:undefined,...(run.plan!.taskType!=='format'?{writingOutline:{version:1 as const,draftHash:digest(draft)},writingCitations:writingCitations(draft)}:{})});
 return {draftCharacters:draft.length,reviewRequired:true};
}

/** A separate visible tool, so the agent owns ordering and call accounting. */
export async function syncOutline(context:ActionContext,input:WritingInstruction={}){
 const run=mutable(context),evidence=writingEvidence(context,run),expected=inputHash(context,run);
 const adjustment=input.instruction?.trim()?instruction(input):'';
 if(adjustment&&run.draft?.trim())throw new Error('已有稿件时不能以首稿前提纲指示重做提纲；请只处理实际受影响的写作内容');
 if(run.outline&&!adjustment){
  const current=reviewCurrent(context,run),review=run.review&&normalizeReviewResult(run.review);
  const missing=run.draft?missingOutlineCitationCount(run.draft,run.outline,evidence):0;
  const legacy=[{severity:'error',location:'论证清单',issue:'当前稿件已生成或修改，论证清单尚未同步到这一版完整正文',suggestion:'调用同步清单工具，按当前稿件重新核对主题、主张与来源，即使引用ID没有变化也必须同步'},...(missing||run.outline.rows.some(row=>row.evidenceIds.some(id=>!evidence.some(e=>e.id===id)))?[{severity:'error',location:'论证清单',issue:`当前清单缺少 ${missing} 个正文实际引用来源，或包含无对应证据的ID`,suggestion:'同步当前稿件的清单，保留全部实际引用和主题，不虚补证据关系'}]:[])];
  context.store.updateRun(run.id,{...(run.draft?{writingOutline:{version:1 as const,draftHash:digest(run.draft)},writingCitations:writingCitations(run.draft)}:{}),...(run.revision?.phase==='draft_saved'?{revision:{...run.revision,phase:'applied' as const}}:{})});
  if(current&&review){review.issues=review.issues.filter(issue=>!legacy.some(host=>isDeepStrictEqual(issue,host)));context.store.updateRun(run.id,{review,writingReview:{...run.writingReview!,inputHash:inputHash(context,run),reviewHash:digest(review)},...(run.draft&&!review.checks.includes(MACHINE_ONLY_CHECK)?{writingReviewCheckpoint:scientificCheckpoint(context,run,review,run.writingReview!.reviewedAt,run.writingReview!.readerPolicyVersion)}:{})});}
  context.progress('已由程序同步正文引用位置；保留已有写作提纲，不重复调用模型生成清单。引用索引不证明主张得到支持。');
  return {outline:run.outline,writingCitations:run.writingCitations,reused:true,confirmationRequired:Boolean(!run.draft?.trim()&&run.plan!.waitForConfirmation&&!run.outlineConfirmed)};
 }
 context.stage(run.draft?'同步当前稿件的论证清单':'形成论证清单');
 const known=new Set(evidence.map(entry=>entry.id));
 const schema=outlineSchema.superRefine(value=>{
  if(value.rows.some(row=>row.evidenceIds.some(id=>!known.has(id))))throw new ModelStructureError('论证清单使用了不存在或未满足当前阅读要求的证据ID；只能依据提供的证据。');
 });
 const outline=await generateStructuredJSON(prompt=>context.generate(prompt,system(run)),OUTLINE+adjustment+'\n按研究主题合并为1–24项；claim、reasoning、limits使用简短句子。若提供finalDraft，保留当前稿件的主要主题和真实限制，但不要求在提纲逐条列齐全部引用。正文实际引用位置由程序索引独立记录，不得为补齐ID强塞论据关系。\n'+JSON.stringify({...authorContext(context,run,evidence),finalDraft:run.pendingWritingTarget?undefined:run.draft}),schema,context.progress);
 unchanged(context,expected);
 const updated=constrainOutline(outline,evidence);
 context.store.updateRun(run.id,{outline:updated,writingOutline:{version:1,draftHash:digest(run.draft??'')},writingReview:undefined,...(adjustment?{outlineConfirmed:false,writingReviewCheckpoint:undefined,writingPatch:undefined}:{}),...(run.revision?.phase==='draft_saved'?{revision:{...run.revision,phase:'applied' as const}}:{})});
 context.store.event(run.id,'outline',run.draft?'论证清单已同步到当前稿件。':'论证清单已保存。');
 if(run.draft)context.store.updateRun(run.id,{writingCitations:writingCitations(run.draft)});
 return {outline:updated,writingCitations:run.writingCitations,reused:false,confirmationRequired:Boolean(!run.draft?.trim()&&run.plan!.waitForConfirmation&&!run.outlineConfirmed)};
}

/** Scientific issues are data returned to the persistent agent, not a reason
 * to terminate its entire run after an arbitrary number of revisions. */
export async function reviewDraft(context:ActionContext):Promise<ReviewResult>{
 const run=mutable(context),evidence=writingEvidence(context,run);
 if(!run.draft?.trim())throw new Error('尚无稿件，请先生成或恢复已有稿件。');
 const boundary=readerIssues(run);
 if(boundary.length){
  context.progress('已定位稿件中需要调整的具体位置，可保留原稿并修正相应内容。');
  return savePreflight(context,run,[...boundary,...(run.plan!.taskType==='format'?[]:currentCitationIssues(run,evidence))]);
 }
 await ensureTaskFormat(context);
 if(reviewCurrent(context,run)&&reviewSchema.safeParse(run.review).success){
  if(run.plan!.taskType!=='format'&&run.outline)await syncOutline(context);
  return currentReaderReview(context,run);
 }
 const mechanical=run.plan!.taskType==='format'?[]:currentCitationIssues(run,evidence);
 if(run.revision?.phase==='pending')mechanical.push({severity:'error',location:'定向修订',issue:'已要求的定向修订尚未应用到当前稿件',suggestion:'对照原文完成局部修订，再自动同步清单和内部复查，无需再次向用户请求修稿许可'});
 if(mechanical.some(issue=>issue.severity==='error')){
  context.progress('程序已定位当前引用或修订前置问题；请自动局部修复，未为已知问题重复调用全文审查。');return savePreflight(context,run,mechanical);
 }
 if(run.plan!.taskType!=='format'&&outlineIssues(run,evidence).length)await syncOutline(context);
 const formatIssues=await reviewFormatContent(context);
 const expected=inputHash(context,run);context.stage('审查当前稿件与证据');
 const incremental=run.plan!.taskType==='format'?undefined:incrementalReviewContext(run,scientificHash(context,run));
 let review:ReviewResult;
 if(incremental){
  context.progress(INCREMENTAL_REVIEW_SCOPE);
  const previousErrors=incremental.previousReview.issues.flatMap((issue,issueIndex)=>issue.severity==='error'?[{issueIndex,issue}]:[]);
  const schema=reviewSchema.and(z.object({resolutions:z.array(z.object({issueIndex:z.number().int().min(0),status:z.enum(['resolved','unresolved']),editIndexes:z.array(z.number().int().min(0)),reason:z.string().min(1)}))})).superRefine((value,context)=>{
   const ids=value.resolutions.map(item=>item.issueIndex),expectedIds=previousErrors.map(item=>item.issueIndex);
   if(ids.length!==expectedIds.length||new Set(ids).size!==ids.length||ids.some(id=>!expectedIds.includes(id)))context.addIssue({code:'custom',message:'必须逐一处理此前每条实质问题，不能遗漏或编造issueIndex'});
   for(const item of value.resolutions)if(item.editIndexes.some(index=>index>=incremental.changes.length)||(item.status==='resolved'&&!item.editIndexes.length))context.addIssue({code:'custom',message:'已解决问题必须指向本轮真实修改片段，不能用不存在的editIndex'});
  });
  const affected=evidence.filter(entry=>incremental.sourceIds.includes(entry.id));
  const result=await generateStructuredJSON(prompt=>context.generate(prompt,system(run)),`STAGE: REVIEW_INCREMENTAL\n${INCREMENTAL_REVIEW_SCOPE}\n仅复查变动段落中的科学主张、引用、体裁和读者所需内容。changes是按顺序执行的精确修改轨迹，currentPassages是最终版本。已有未解决errors必须逐项判定；只有相关修改和提供的原文支持时才可resolved，未受修改影响的问题保留unresolved。不能凭标题、目录或旧审查结论给新主张补支持，不增添与本轮无关的文风要求。保留仍适用的局限，撤回被修改实际解决的旧误判。返回{issues,checks,limitations,resolutions:[{issueIndex,status:'resolved'|'unresolved',editIndexes:number[],reason}]}；issueIndex沿用previousErrors，editIndexes是changes的0起算editIndex。\n`+JSON.stringify({reviewScope:'changed_sections',...manuscriptWritingContext(run,affected),...incremental,previousErrors,citationAudit:citationAudit(run.draft,evidence,required(run))}),schema,context.progress);
  review={issues:result.issues,checks:result.checks,limitations:[...result.limitations,INCREMENTAL_REVIEW_SCOPE]};
  for(const resolution of result.resolutions)if(resolution.status==='unresolved'){const issue=incremental.previousReview.issues[resolution.issueIndex];if(!review.issues.some(item=>isDeepStrictEqual(item,issue)))review.issues.push(issue);}
  if(run.writingReviewCheckpoint?.readerPolicyVersion!==READER_POLICY_VERSION)review.issues.push(...await semanticReaderIssues(context,run));
 }else{
  review=await generateStructuredJSON(prompt=>context.generate(prompt,system(run)),REVIEW+(run.review?'\n'+REVIEW_FOLLOWUP+'\n'+JSON.stringify({previousReviewIssues:run.review.issues,previousReviewIsHistorical:true}):'')+'\n研究资料（审计信息仅用于核对，不要求作者向论文读者复述工作台操作）：\n'+JSON.stringify({...reviewContext(context,run,evidence),citationAudit:run.plan!.taskType==='format'?{applicable:false,bibliographyGeneratedAtExport:false}:{applicable:true,...citationAudit(run.draft,evidence,required(run))}})+'\n当前完整稿件（来源ID由导出程序统一编号）：\n'+run.draft,reviewSchema,context.progress);
 }
 unchanged(context,expected);
 review.issues.push(...formatIssues);
 unchanged(context,expected);
 if(run.plan!.taskType!=='format')review.issues.push(...currentCitationIssues(run,evidence),...outlineIssues(run,evidence));
 const writingReview={version:1 as const,inputHash:expected,reviewHash:digest(review),reviewedAt:new Date().toISOString(),readerPolicyVersion:READER_POLICY_VERSION};
 context.store.updateRun(run.id,{review,writingReview,writingPatch:undefined,writingReviewCheckpoint:scientificCheckpoint(context,run,review,writingReview.reviewedAt,READER_POLICY_VERSION)});
 context.store.event(run.id,'review',`当前稿件审查已保存：${review.issues.filter(issue=>issue.severity==='error').length} 项实质问题；代理可继续修复，尚未发布。`);
 return review;
}

export async function reviseDraft(context:ActionContext,input:WritingInstruction={}){
 const run=mutable(context),evidence=writingEvidence(context,run);checkConfirmed(run);
 if(!run.draft?.trim())throw new Error('尚无保存稿件可修订，请先写稿。');
 if(run.plan!.taskType==='format')throw new Error('纯格式任务不能由修稿工具改写事实或原文。');
 if(run.pendingWritingTarget&&!run.outline)throw new Error('请先依据最新体裁和交付目标形成新提纲，再重新组织正文；此前稿件已保存。');
 if(run.pendingWritingTarget&&run.pendingWritingTarget.previousDraftHash!==digest(run.draft))throw new Error('待重写的旧稿版本与当前稿件不一致；请根据最新保存的稿件重新确定接续位置。');
 const issues=reviewCurrent(context,run)?run.review?.issues.filter(issue=>issue.severity==='error')??[]:[];
 if(!issues.length&&!run.revision?.issues.length&&!input.instruction?.trim()&&!run.pendingWritingTarget)throw new Error('没有当前有效的实质修订问题；旧审查可能已过期。小修请读取现稿并用局部修订，勿反复依据旧意见整稿重写。');
 const expected=inputHash(context,run);context.stage('按具体问题修订当前稿件');
 const revisionGoal=run.pendingWritingTarget?'当前保存的稿件采用旧体裁。按最新交付目标与新提纲重写完整正文，保留仍有依据的论点和引用，不能只替换标题。':'只修复有原文依据的实质问题，保持其余正确内容、原目标、引用数量与证据范围。';
 const draft=cleanDraft(await context.generate(DRAFT+'\nSTAGE: REVISE\n'+revisionGoal+'审查意见不是事实，需对照证据；不能靠删除引用、降低门槛或新增无依据结论掩盖错误。'+instruction(input)+'\n研究资料：\n'+JSON.stringify({...authorContext(context,run,evidence),previousReviewIssues:issues})+'\n当前完整稿件：\n'+run.draft,system(run)));
 unchanged(context,expected);return saveDraftChange(context,run,evidence,draft);
}

export async function publishDraft(context:ActionContext){
 const run=guard(context);
 const existing=context.store.getConversation(run.conversationId).artifacts.find(artifact=>artifact.runId===run.id);
 if(existing)return {artifactId:existing.id,status:existing.status,formats:existing.formats,limitations:existing.limitations};
 const boundary=readerIssues(run);
 if(boundary.length){
  if(!['completed','limited'].includes(run.status))savePreflight(context,run,boundary);
  throw new Error('稿件尚有必须修正的具体内容：'+boundary.map(issue=>`${issue.location}：${issue.issue}`).join('；').slice(0,1800));
 }
 if(!['completed','limited'].includes(run.status))await ensureTaskFormat(context);
 if(!reviewCurrent(context,run))throw new Error('当前稿件没有匹配的有效审查，或稿件、证据、要求已变化；请重新审查后发布。');
 await currentReaderReview(context,run);
 if(run.review!.issues.some(issue=>issue.severity==='error'))throw new Error('当前审查仍有实质错误，未通过发布门槛；请继续修复，不能以有限制成果绕过。');
 if(run.draft&&run.outline&&!isDeepStrictEqual(run.writingCitations,writingCitations(run.draft)))context.store.updateRun(run.id,{writingCitations:writingCitations(run.draft)});
 const evidence=writingEvidence(context,run);checkConfirmed(run);
 const blockers=run.plan!.taskType==='format'?[]:[...citationIssues(run.draft!,evidence,required(run)),...outlineIssues(run,evidence)];
 if(blockers.some(issue=>issue.severity==='error'))throw new Error('当前稿件未通过引用或清单完整性门槛：'+blockers.map(issue=>issue.issue).join('；'));
 const expected=inputHash(context,run),reviewHash=digest(run.review);
 const recheck=()=>{const current=unchanged(context,expected);if(!reviewCurrent(context,current)||digest(current.review)!==reviewHash)throw new Error('发布期间审查记录发生变化，未登记过期成果。');};
 const cited=[...bodyCitationIds(draftBody(run.draft!).body)];
 if(run.plan!.taskType!=='format'&&originalSourceAccessRequired(run.prompt)){
  context.stage('逐条核验最终引用可打开的原文');
  const access=await(context.sourceAccess??ensureCitedSourcesOpenable)(context.store,run,cited,context.signal,context.progress);recheck();
  if(access.failures.length)throw new Error('最终引用仍有未取得可打开原文的来源：'+access.failures.map(item=>`${item.id}：${item.error}`).join('；').slice(0,1800));
 }
 const limitations=[...new Set([...run.review!.limitations,...run.review!.issues.map(issue=>`${issue.location}：${issue.issue}`)])];
 const delivery=deliveryRequirements(run.plan!,evidence,cited,materials(context,run),resolvedExportFormat(run,materials(context,run)),run.draft);
 limitations.push(...delivery.limitations);
 const artifact:Artifact={id:randomUUID(),runId:run.id,title:resolveArtifactTitle(run.draft!,run.plan!.title),markdown:run.plan!.taskType==='format'?run.draft!:withReferences(run.draft!,evidence,{runId:run.id}),createdAt:new Date().toISOString(),status:limitations.length?'limited':'completed',formats:[],limitations,format:delivery.format};
 context.stage('生成可编辑稿与阅读版');
 registerArtifactOutput(context.store.root,run.id,artifact.id);
 const exported=await(context.export??exportArtifact)(artifact,path.join(context.store.root,'artifacts'));recheck();
 if(!exported.formats.length)throw new Error('未生成可下载文件；已保留稿件和审查，未登记交付。');
 artifact.formats=exported.formats;artifact.limitations=[...new Set([...artifact.limitations,...exported.warnings])];if(exported.warnings.length)artifact.status='limited';
 context.store.addArtifact(run.conversationId,artifact);context.store.updateRun(run.id,{status:artifact.status,stage:'成果已保存',error:undefined,failure:undefined});
 context.store.event(run.id,'artifact',artifact.title);
 context.store.message(run.conversationId,'assistant',`已交付《${artifact.title}》，可在成果区下载。`,'result',run.id);
 return {artifactId:artifact.id,status:artifact.status,formats:artifact.formats,limitations:artifact.limitations};
}
