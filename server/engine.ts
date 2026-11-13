import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type { ZodType } from 'zod';
import { Store } from './store';
import {resolveArtifactTitle} from './artifact-title';
import {assertOutlineConfirmation,type ConfirmationExpectation} from './outline-confirmation';
import { createProvider, safeModelUsage } from './providers';
import { searchEvidence, fetchFullTextEvidence, newIndependentEvidence, RETRIEVAL_VERSION } from './retrieval';
import { screenEvidence } from './screening';
import { readFullTextEvidence, cachedReadingEvidence } from './reading';
import { evidenceSummaryForModel, screeningForModel, retrievalForModel, fullTextForModel } from './evidence-context';
import { manuscriptWritingContext } from './manuscript-context';
import { manuscriptBoundaryIssues } from './manuscript-boundary';
import { calculateMaterials } from './calculations';
import { exportArtifact } from './export';
import {registerArtifactOutput} from './run-files';
import { effectiveMethods, educationReviewProfile } from './methods';
import {screeningMethodText} from './method-selection';
import { planSchema,outlineSchema,reviewSchema,generateStructuredJSON,ModelStructureError } from './schemas';
import { SYSTEM,PLAN,OUTLINE,DRAFT,REVIEW,REVIEW_FOLLOWUP } from './prompts';
import { buildTaskContext, effectiveTaskPrompt, isExplicitNewTask } from './task-context';
import { continuationTaskType, fullTextRequired, fullTextRequiredForRun, confirmationRequired, originalSourceAccessRequired } from './task-policy';
import { ensureCitedSourcesOpenable } from './source-access';
import { renderGbtReference } from './bibliography';
import {deliveryRequirements} from './delivery-requirements';
import {ensureTaskFormat,reviewFormatContent,resolvedExportFormat} from './research-tool-format';
import { formatSourceCitation } from './source-document-links';
import { reuseSourceEvidence } from './reuse-source-evidence';
import { buildRevisionContext } from './revision-context';
import { referenceRequirementOverride, classifyResearchContinuation, applyReferenceRequirement, isPureContinuationInstruction } from './research-continuity';
import type { ModelConfig, ModelProvider, Artifact, Evidence, Run, RunModelUse, ReviewIssue, ArgumentOutline, RunOptions, RevisionInput } from '../shared/types';

interface Dependencies { autonomous?:boolean;harness?:import('./research-harness').HarnessDependencies;provider?:(config:ModelConfig)=>ModelProvider;search?:typeof searchEvidence;fullText?:typeof fetchFullTextEvidence;screen?:typeof screenEvidence;export?:typeof exportArtifact; }
function scientificWarnings(run:Run,warnings:string[]):string[] {
  // Operational failures are already represented by the compact retrieval
  // audit. Exact membership preserves distinct scientific limitations.
  const batches=[...run.retrievalExpansionHistory??[],...(run.retrievalExpansion?[run.retrievalExpansion]:[])];
  const operational=new Set([...run.retrieval?.warnings??[],...run.fullTextRetrieval?.warnings??[],...batches.flatMap(batch=>[...batch.warnings,...batch.retrieval?.warnings??[],...(batch.error?[batch.error]:[])])]);
  return warnings.filter(warning=>!operational.has(warning));
}
export function outlineForModel(run:Run):ArgumentOutline|undefined {
  return run.outline?{...run.outline,gaps:scientificWarnings(run,run.outline.gaps)}:undefined;
}
export function constrainOutline(outline:ArgumentOutline,evidence:Evidence[]) {
  const known=new Map(evidence.map(e=>[e.id,e]));
  for(const row of outline.rows){
    const unknown=row.evidenceIds.filter(id=>!known.has(id));
    row.evidenceIds=row.evidenceIds.filter(id=>known.has(id));
    if(unknown.length){row.support='unclear';outline.gaps.push(`“${row.section}”的不存在证据已移除：${unknown.join(', ')}`);}
    const usable=row.evidenceIds.filter(id=>known.get(id)!.readScope!=='metadata');
    if(!usable.length&&['supported','partial'].includes(row.support)){row.support='unclear';outline.gaps.push(`“${row.section}”没有内容证据，书目信息不构成主张支持。`);}
    if(['unsupported','contradicted','unclear'].includes(row.support))outline.gaps.push(`“${row.section}”的主张支持状态为${row.support}，不能作为确定结论。`);
    if(row.limits.trim()&&!/^(无|无额外限制|不适用|none|n\/a)[。.]?$/i.test(row.limits.trim()))outline.gaps.push(`${row.section}：${row.limits}`);
  }
  outline.gaps=[...new Set(outline.gaps)];return outline;
}
function materialEvidence(store:Store,run:Run):Evidence[] {return store.selectedMaterials(run.conversationId,run.materialIds).filter(m=>m.role==='evidence').map((m,i)=>({id:`M${i+1}`,title:m.name,text:m.text,location:m.extraction,readScope:'user_material',materialId:m.id,retrievedAt:m.createdAt}));}
function referenceNumber(value:string):number {
  if(/^\d+$/.test(value))return Number(value);
  const digits:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  let total=0,current=0;
  for(const character of value){if(character in digits)current=digits[character];else {total+=(current||1)*({'十':10,'百':100,'千':1000}[character]??0);current=0;}}
  return total+current;
}
export function requestedReferenceCount(request:string):number|undefined {
  const count='([0-9零〇一二两三四五六七八九十百千]+)';
  const unit='(?:篇|条|个)?';
  const source='(?:参考(?:文献|引用)|文献(?:引用)?|引用|论文|全文|references?|citations?|sources?)';
  const change='(?:改为|改成|调整为|降低到|下调到|恢复到|恢复为|改回)';
  const patterns=[new RegExp(`${count}\\s*([多余]?)\\s*${unit}\\s*(?:及?以上)?(?:的)?\\s*${source}`,'gi'),new RegExp(`${source}(?:数量|数目|篇数|要求)?\\s*(?:至少(?:有)?|不少于|不低于|最少(?:有)?|最低(?:为)?|≥|>=|at least|${change}(?:至少)?)\\s*${count}\\s*([多余]?)`,'gi')];
  if(new RegExp(source,'i').test(request))patterns.push(new RegExp(`(?:^|[。；;！!\\n])\\s*(?:用户接续要求[：:]\\s*)?(?:请|现在)?${change}\\s*(?:至少)?${count}\\s*([多余]?)\\s*篇(?=[。；;！!\\n]|$)`,'gi'));
  const matches=patterns.flatMap(pattern=>[...request.matchAll(pattern)].map(match=>({index:match.index,text:match[0],value:referenceNumber(match[1])+(match[2]?1:0)}))).sort((a,b)=>a.index-b.index);
  const relaxation=referenceRequirementOverride(request);
  let minimum:number|undefined=relaxation?0:undefined;
  for(const match of matches){
    if(relaxation&&match.index<relaxation.index)continue;
    const prefix=request.slice(0,match.index).split(/[，,。；;！？!?\n]/).at(-1)??'';
    // Negative examples and descriptions of the current corpus are not a new target.
    if(/不要(?!少于|低于)|不能(?!少于|低于)|不应(?!少于|低于)|不是|并非|避免|拒绝|(?:^|\s)别/.test(prefix))continue;
    if(/(?:当前|目前|现有|已经|已)(?:有|得到|获得|找到|检索到|只有|仅有)|(?:又|另外)(?:找到|发现|获得)/.test(prefix))continue;
    const revised=/改为|改成|调整为|降低到|下调到|恢复到|恢复为|改回|只需|只要|instead|reduce to/i.test(prefix+match.text);
    minimum=revised?match.value:Math.max(minimum??0,match.value);
  }
  return minimum;
}
const isContentLiterature=(entry:Evidence)=>(entry.readScope==='abstract'||entry.readScope==='full_text')&&Boolean(entry.text.trim());
function literatureIdentity(entry:Evidence):string {return entry.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase().trim()||entry.url?.toLowerCase().replace(/\/$/,'')||entry.title.toLowerCase().replace(/\s+/g,' ').trim()||entry.id;}
function contentLiteratureCount(evidence:Evidence[]):number {return new Set(evidence.filter(isContentLiterature).map(literatureIdentity)).size;}
const needsFullText=(run:Pick<Run,'prompt'|'plan'>)=>fullTextRequiredForRun(run);
const eligibleEvidence=(run:Pick<Run,'prompt'|'plan'>,evidence:Evidence[])=>needsFullText(run)?evidence.filter(entry=>entry.readScope!=='abstract'&&entry.readScope!=='metadata'):evidence;
const referenceRequestHash=(prompt:string)=>createHash('sha256').update(prompt).digest('hex');
/** Resolve only persisted user inputs, in their actual task order. A plan's
 * proposed count is not evidence that the user requested a quota. */
export function referenceRequirementForRun(store:Store,run:Run):NonNullable<Run['referenceRequirement']>{
  const conversation=store.getConversation(run.conversationId),lineage:Run[]=[run],seen=new Set([run.id]);let parentId=run.taskContext?.parentRunId;
  // Same-run resume historically records itself as parent. Recover its actual
  // predecessor from the persisted same-task order, never another task.
  const preceding=(owner:Run)=>conversation.runs.slice(0,conversation.runs.indexOf(owner)).findLast(item=>(item.taskContext?.rootRunId??item.id)===(run.taskContext?.rootRunId??run.id));
  if(parentId===run.id)parentId=preceding(run)?.id;
  while(parentId&&!seen.has(parentId)){
    seen.add(parentId);const parent=conversation.runs.find(item=>item.id===parentId);
    if(!parent||(parent.taskContext?.rootRunId??parent.id)!==(run.taskContext?.rootRunId??run.id))break;
    lineage.unshift(parent);parentId=parent.taskContext?.parentRunId===parent.id?preceding(parent)?.id:parent.taskContext?.parentRunId;
  }
  let result:NonNullable<Run['referenceRequirement']>={minimumReferences:0,source:'unspecified',requestHash:referenceRequestHash(run.prompt)};
  let beforeRelaxation:typeof result|undefined;
  const accept=(text:string,source:typeof result.source,sourceId:string)=>{
    // The previous requirement supplies context for a terse "改为20篇" edit.
    const count=requestedReferenceCount(text)??(result.source!=='unspecified'?requestedReferenceCount('参考文献\n'+text):undefined);
    if(count===undefined&&beforeRelaxation&&!referenceRequirementOverride('有多少写多少\n'+text)){
      result=beforeRelaxation;beforeRelaxation=undefined;
    }else if(count!==undefined){
      if(count===0&&referenceRequirementOverride(text))beforeRelaxation??=result;
      else if(count>0)beforeRelaxation=undefined;
      result={...result,minimumReferences:count,source,sourceId};
    }
  };
  const selectedRequirements=new Map(store.selectedMaterials(run.conversationId,run.materialIds).filter(item=>item.role!=='evidence').map(item=>[item.id,item]));
  let previousMaterials=new Set<string>();
  const optionKeys=['methodInstructions','formatInstructions'] as const;
  for(const [index,owner] of lineage.entries()){
    // An unchanged selected guideline is inherited, not a new instruction that
    // can overwrite a later relaxation. Newly selected requirements apply now.
    for(const id of owner.materialIds){const material=selectedRequirements.get(id);if(material&&!previousMaterials.has(id))accept(material.text,'user_material',id);}
    previousMaterials=new Set(owner.materialIds);
    const explicit=store.runRequirementOptions(owner.id);
    const texts=optionKeys.filter(key=>!lineage.slice(index+1).some(later=>store.runRequirementOptions(later.id)[key]!==undefined)).map(key=>explicit[key]).filter((text):text is string=>text!==undefined);
    if(texts.length)accept(texts.join('\n'),'user_options',owner.id);
    const messages=conversation.messages.filter(message=>message.role==='user'&&message.runId===owner.id);
    if(messages.length)for(const message of messages)accept(message.content,'user_prompt',message.id);
    else accept(owner.prompt,'user_prompt',owner.id);
  }
  return result;
}
export function minimumReferences(run:Pick<Run,'prompt'|'plan'|'referenceRequirement'>):number {
  return run.referenceRequirement?.requestHash===referenceRequestHash(run.prompt)?run.referenceRequirement.minimumReferences:requestedReferenceCount(run.prompt)??0;
}
export function requiredEvidenceCount(run:Pick<Run,'prompt'|'plan'|'evidence'|'referenceRequirement'>):number {
  if(run.plan?.taskType!=='review')return run.plan?.requiresResearchEvidence?1:0;
  const hasSelectedResearch=run.evidence.some(entry=>entry.readScope==='user_material'&&entry.materialId&&entry.text.trim());
  return Math.max(minimumReferences(run),run.plan.searchQueries.length||!hasSelectedResearch?1:0);
}
const externalEvidence=(evidence:Evidence[])=>evidence.filter(entry=>['abstract','full_text','metadata'].includes(entry.readScope));
// Cache identity follows the research question, while writing uses the latest
// user requirements. Only the validated same-research continuation sets this.
export const researchRequest=(run:Run)=>run.researchCheckpoint?.kind==='same_research'?run.researchCheckpoint.sourcePrompt:run.prompt;
export const screeningRequest=(run:Run)=>researchRequest(run)+(run.plan?'\n本次实际生效的科学方法（用于纳入、排除及全文必要性判断；不按格式要求筛选）：\n'+screeningMethodText(run.plan.methods):'');
export function writingRequest(run:Run):string {
  return referenceRequirementOverride(run.prompt)&&minimumReferences(run)===0
    ?run.prompt+'\n当前生效的用户要求：按已有、相关且经过核验的证据成文，不再设置最低引用篇数；旧要求中的篇数已被用户后续要求取消。不能凑数或虚构引用。'
    :run.prompt;
}
function evidenceHash(evidence:Evidence[]):string {
  const rows=[...evidence].sort((a,b)=>a.id.localeCompare(b.id)).map(entry=>[
    entry.id,entry.title,entry.authors,entry.year,entry.journal,entry.publicationType,entry.doi,entry.url,entry.readScope,entry.text,entry.location,
  ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function discoveryHash(evidence:Evidence[]):string{
  return createHash('sha256').update(JSON.stringify([...evidence].sort((a,b)=>a.id.localeCompare(b.id)).map(entry=>[entry.id,entry.title,entry.authors,entry.year,entry.journal,entry.publicationType,entry.doi,entry.url,entry.readScope==='metadata'?'metadata':'content',entry.abstract??entry.text,entry.fullTextUrls]))).digest('hex');
}
function reusableRetrieval(run:Run):boolean {
  const saved=run.retrieval;
  return Boolean(run.plan?.taskType==='review'&&saved?.version===RETRIEVAL_VERSION&&saved.completedAt&&saved.evidenceHash
    &&JSON.stringify(saved.queries)===JSON.stringify(run.plan.searchQueries)
    &&saved.evidenceHash===discoveryHash(externalEvidence(run.evidence)));
}
export function screeningInputHash(run:Run,evidence=run.evidence):string {
  return createHash('sha256').update(JSON.stringify([screeningRequest(run),discoveryHash(evidence.filter(isContentLiterature))])).digest('hex');
}
const hasAbstract=(entry:Evidence)=>['abstract','full_text'].includes(entry.readScope)&&Boolean((entry.abstract?.trim()?entry.abstract:entry.readScope==='abstract'?entry.text:'').trim());
const pendingExpansionEvidence=(run:Run)=>newIndependentEvidence(externalEvidence(run.evidence),run.retrieval?.pendingEvidence??[]).filter(hasAbstract);
export function reusableScreening(run:Run,evidence=run.evidence):boolean {
  // Newly discovered abstracts have their own pending screening phase. A
  // restart must retain the completed decisions for the original corpus.
  if(run.retrievalExpansion?.stage==='screening'){const pending=new Set(run.retrievalExpansion.candidateIds);evidence=evidence.filter(entry=>!pending.has(entry.id));}
  const saved=run.screening;if(!saved||saved.inputHash!==screeningInputHash(run,evidence))return false;
  const expected=new Set(evidence.filter(hasAbstract).map(entry=>entry.id));
  const judged=[...saved.includedIds,...saved.excluded.map(entry=>entry.id)];
  return saved.screenedCount===expected.size&&judged.length===expected.size&&new Set(judged).size===expected.size
    &&judged.every(id=>expected.has(id))&&saved.excluded.every(entry=>Boolean(entry.reason.trim()))
    &&Array.isArray(saved.fullTextIds)&&new Set(saved.fullTextIds).size===saved.fullTextIds.length&&saved.fullTextIds.every(id=>saved.includedIds.includes(id))
    &&Boolean(saved.fullTextReasons)&&judged.every(id=>Boolean(saved.fullTextReasons?.[id]?.trim()))
    &&(!needsFullText(run)||saved.includedIds.every(id=>saved.fullTextIds!.includes(id)));
}
export function expansionForModel(run:Run){
  const record=run.retrievalExpansion;if(!record)return undefined;
  return {stage:record.stage,discovery:record.discovery,previousBatchCount:run.retrievalExpansionHistory?.length??0,attemptedAt:record.attemptedAt,completedAt:record.completedAt,gapBefore:record.gapBefore,targetCount:record.targetCount,
    newCandidateCount:record.candidateIds.length,requestedCount:record.requestedIds.length,acquiredCount:record.acquiredIds.length,reusedCount:record.reusedIds.length,
    retrieval:retrievalForModel(record.retrieval),hasStageError:Boolean(record.error),
    bodyAcquisition:fullTextForModel({inputHash:'',completedAt:record.completedAt??'',requestedIds:record.requestedIds,acquiredIds:record.acquiredIds,warnings:[...record.warnings,...(record.error?[record.error]:[])],diagnostics:record.diagnostics}),
    scope:'一次补充检索与新增候选的摘要筛选、正文获取；与首次检索分开统计，复用原文不是本轮新下载；本阶段正文请求已包含在总fullTextRetrieval审计中，不能重复相加。'};
}
function screenedEvidence(run:Run):Evidence[] {
  if(!run.screening)return run.evidence;
  const included=new Set(run.screening.includedIds);
  return run.evidence.filter(entry=>included.has(entry.id)||entry.readScope==='user_material'||entry.readScope==='computed');
}
export function selectedEvidence(run:Run):Evidence[] {
  return screenedEvidence(run).filter(entry=>entry.readScope!=='metadata'&&(entry.readScope!=='abstract'||!fullTextRequiredForRun(run,entry.id)));
}
function assertRevisionCache(run:Run):void {
  if(!run.revision)return;
  if(!run.plan||!run.outline||!run.draft?.trim()||(run.plan.taskType==='review'&&run.plan.searchQueries.length&&!reusableRetrieval(run))||(run.evidence.some(hasAbstract)&&!reusableScreening(run)))throw new Error('定向修订的原稿或已存检索筛选缓存未通过校验；已保留资料，未自动改题、重搜或覆盖原成果。');
}
export function revisionForModel(run:Run){return run.revision?{baseRunId:run.revision.baseRunId,issues:run.revision.issues,proofs:run.revision.proofs,scope:'修订意见需逐项对照原文判断；proofs只是宿主逐字核验位置的原文片段，不代表人工或科学验证。原研读笔记如与片段冲突，应依据原文纠正文稿，不复制已指出的错误。'}:undefined;}
function enforceCandidateEvidence(run:Run,evidence=run.evidence){
  const required=requiredEvidenceCount(run),available=contentLiteratureCount(evidence);
  if(required>available)throw new Error(`摘要检索与相关性筛选尚未满足综述要求：需要至少 ${required} 篇含内容的相关候选，本次 ${available} 篇。原目标与检索记录已保存，不能用书目或无关文献凑数。`);
}
export function enforceReviewEvidence(run:Run,evidence=run.evidence,afterReading=false) {
  const required=requiredEvidenceCount(run),available=contentLiteratureCount(eligibleEvidence(run,evidence));
  const pending=pendingExpansionEvidence(run).length;
  const nextBatch=run.retrievalExpansion?.stage==='complete'&&pending?` 本批已处理 ${run.retrievalExpansion.candidateIds.length} 条新增候选，仍差 ${Math.max(0,required-available)} 篇；另有 ${pending} 条含摘要的独立候选待筛。下次手动接续将只处理下一批，不重做本批或重试已失败的旧来源。`:'';
  if(required>available)throw new Error(afterReading
    ?`研读后的可用证据不足：最低引用要求 ${required} 篇，目前 ${available} 篇有可用于成文的研读发现。已经检索的文献、取得的正文和完成的笔记均已保存；未形成相关发现的论文不能凑作引用。继续将复用已有进度；也可以明确调整最低篇数，按已有证据成文。${nextBatch}`
    :`选中文献的证据尚未齐备：最低引用要求 ${required} 篇，目前 ${available} 篇${needsFullText(run)?'已取得正文':'达到摘要筛选后要求的阅读范围'}。这不是数据库总命中数；已有文献与阅读记录均已保存。可补充缺少的原文，或明确调整最低篇数，不能用未取得正文或仅书目信息凑数。${nextBatch}`);
}
export function draftBody(draft:string):{body:string;hasBibliography:boolean} {
  const number='[0-9零〇一二两三四五六七八九十百千万]+';
  const numbering=`(?:(?:第[ \\t]*${number}[ \\t]*(?:章|节|部分)|[（(][ \\t]*${number}[ \\t]*[）)]|${number})[.、．:：）) \\t]*)?`;
  // Match the complete heading, not ordinary titles such as “参考文献的研究”.
  const heading=new RegExp('^(?:#{1,6}[ \\t]*)?(?:\\*\\*)?'+numbering+'(?:\\*\\*)?(?:参考文献|依据与参考文献|references|bibliography)(?:\\*\\*)?[ \\t]*[:：]?[ \\t]*$','im').exec(draft);
  return {body:heading?draft.slice(0,heading.index).trimEnd():draft,hasBibliography:Boolean(heading)};
}
const CITATION_PATTERN=/\[([A-Za-z0-9_-]+(?:\s*[,，;；]\s*[A-Za-z0-9_-]+)*)\](?!\()/g;
export function bodyCitationIds(body:string):Set<string>{return new Set([...body.matchAll(CITATION_PATTERN)].flatMap(match=>match[1].split(/\s*[,，;；]\s*/)));}
export function missingOutlineCitationCount(draft:string,outline:ArgumentOutline,evidence:Evidence[]):number{
  const known=new Set(evidence.map(entry=>entry.id)),covered=new Set(outline.rows.flatMap(row=>row.evidenceIds));
  // Unknown IDs remain citation errors, not invented evidence for the outline.
  return [...bodyCitationIds(draftBody(draft).body)].filter(id=>known.has(id)&&!covered.has(id)).length;
}
export function citationAudit(draft:string,evidence:Evidence[],required=0){
  const {body,hasBibliography}=draftBody(draft);const citedIds=bodyCitationIds(body);const known=new Set(evidence.map(entry=>entry.id));
  const scopes=new Map<string,'abstract'|'full_text'>();
  for(const source of evidence){
    if(!citedIds.has(source.id)||!isContentLiterature(source))continue;
    const identity=literatureIdentity(source);
    if(source.readScope==='full_text'||!scopes.has(identity))scopes.set(identity,source.readScope as 'abstract'|'full_text');
  }
  const citedLiteratureReadScopeCounts={full_text:0,abstract:0};for(const scope of scopes.values())citedLiteratureReadScopeCounts[scope]++;
  return {minimumReferences:required,distinctCitedLiteratureCount:scopes.size,citedLiteratureReadScopeCounts,unknownIds:[...citedIds].filter(id=>!known.has(id)),hasModelBibliography:hasBibliography,bibliographyGeneratedAtExport:true};
}
export function citationIssues(draft:string,evidence:Evidence[],required=0):ReviewIssue[] {
  const issues:ReviewIssue[]=[];const audit=citationAudit(draft,evidence,required);
  if(audit.hasModelBibliography)issues.push({severity:'error',location:'参考文献',issue:'模型自行添加了参考文献表；其中条目不构成正文引用，书目应由系统从实际引用生成',suggestion:'删除自写参考文献表，在正文真正使用相关证据的位置使用来源ID引用'});
  for(const id of audit.unknownIds)issues.push({severity:'error',location:`[${id}]`,issue:'正文引用ID没有对应的实际证据',suggestion:'移除该引用及无依据主张，或改为提供的真实证据ID'});
  if(required>0){
    const count=audit.distinctCitedLiteratureCount;
    if(count<required)issues.push({severity:'error',location:'正文引用',issue:`最低引用要求为 ${required} 篇含摘要或全文的不同文献，当前正文仅实际引用 ${count} 篇；重复引用、未知ID和仅书目元数据不计数`,suggestion:'只在相关内容实际支持主张的位置补充已读取的不同文献并完成主题综合；不得附加无关引用凑数'});
  }
  if(!draft.trim() || draft.trim().length<30)issues.push({severity:'error',location:'全文',issue:'成果为空或不足以独立交付',suggestion:'根据材料完成指定成果'});
  return issues;
}
export function withReferences(draft:string,evidence:Evidence[],sourceContext?:{runId:string;baseUrl?:string}) {
  draft=draftBody(draft).body;
  const byId=new Map(evidence.map(e=>[e.id,e]));
  const pattern=CITATION_PATTERN;
  const ids=[...bodyCitationIds(draft)].filter(id=>byId.has(id));
  const cited=ids.map(id=>byId.get(id)!);
  if(!cited.length)return draft;
  const external=(entry:Evidence)=>['abstract','full_text','metadata'].includes(entry.readScope);
  const numbered=draft.replace(pattern,(full,group:string)=>{
    const grouped=group.split(/\s*[,，;；]\s*/);if(!grouped.every(id=>ids.includes(id)))return full;
    return sourceContext?formatSourceCitation(grouped.map(id=>({index:ids.indexOf(id)+1,evidenceId:external(byId.get(id)!)?id:undefined})),sourceContext.runId,sourceContext.baseUrl):`[${grouped.map(id=>ids.indexOf(id)+1).join(', ')}]`;
  });
  return numbered+'\n\n## 参考文献\n\n'+cited.map((entry,index)=>renderGbtReference(entry,index+1).text).join('\n\n');
}
function approvesOutline(run:Run,instruction:string):boolean {
  // A retry before an outline was shown cannot approve unseen content.
  if(run.status!=='awaiting_confirmation'&&!run.outlineConfirmed)return false;
  const text=instruction.trim();
  // Empty text comes from the dedicated confirmation / saved-progress button.
  if(!text)return true;
  const asksToWait=/(?:等|等待).{0,16}(?:确认|批准|回复)|(?:不要|暂不|暂时不|先不|尚不|还不|不能|不可|别|不必|无需|不想|不打算|不准备|不需要|不希望|暂停|暂缓|停止).{0,10}(?:继续|开始|成文|写作|写|生成)|(?:不|未|没有|尚未|暂未|无法).{0,5}(?:确认|同意|批准)|wait.{0,24}(?:confirm|approv)|(?:do not|don't|not yet).{0,12}(?:continue|write|proceed)/i;
  const asksToReview=/(?:核查|核对|核验|检查|复核|修改|调整|补充|重写|替换|删除|删掉|修订|改成|改为|拆成|拆分|合并|移动|增加|新增|调换|重排|是否|是不是|有没有|能否)|(?:请|帮我|麻烦).{0,6}确认|\b(?:check|verify|review|revise|adjust|edit|split|merge|move|add|remove|reorder|whether)\b/i;
  if(asksToWait.test(text)||asksToReview.test(text)||/[?？]/.test(text))return false;
  const standalone=/^(?:确认(?:继续)?|确认通过|同意|批准|好的?|可以|没问题|没有问题|通过|继续(?:吧)?|ok(?:ay)?|yes|approved|proceed)[。.!！\s]*$/i;
  const writingInstruction=/(?:继续(?:成文|成稿|写作|写正文|写全文|写文章|完成正文|完成全文)|开始(?:成文|成稿|写作|写正文|写全文|写文章)|(?:继续|开始)生成(?:正文|全文|文章)|按(?:当前|这个|这份|现有)清单继续)/;
  return isPureContinuationInstruction(text)||standalone.test(text)||writingInstruction.test(text)||/^(?:请)?(?:继续|开始)写[吧。.!！\s]*$/.test(text);
}
export class ResearchEngine {
  private live=new Map<string,AbortController>();
  constructor(private store:Store,private config:()=>ModelConfig,private dependencies:Dependencies={}){}
  revise(baseRunId:string,input:RevisionInput){return this.store.createRevisionRun(baseRunId,input,this.config());}
  submit(conversationId:string,content:string,options:RunOptions={},confirmation?:ConfirmationExpectation) {
    this.store.assertConversationWritable(conversationId);
    const conversation=this.store.getConversation(conversationId);
    const active=conversation.runs.find(run=>['queued','running','awaiting_confirmation'].includes(run.status));
    // Validate synchronously before cancelling. No await may separate admission
    // from creation, so two HTTP submissions cannot both claim the same parent.
    this.store.selectedMaterials(conversationId,options.materialIds);
    effectiveTaskPrompt(buildTaskContext(conversation.runs,content,options.taskIntent,randomUUID()));
    if(active&&(options.taskIntent==='new'||isExplicitNewTask(content)))throw new Error('本对话的任务尚未结束；请先停止，或在新对话单独提问');
    const approvalTarget=active??conversation.runs.at(-1);
    const changesOptions=options.methodMode!==undefined||options.methodInstructions!==undefined||options.formatInstructions!==undefined||options.waitForConfirmation!==undefined||(options.materialIds!==undefined&&JSON.stringify([...options.materialIds].sort())!==JSON.stringify([...(approvalTarget?.materialIds??[])].sort()));
    // A stale approval must not become a new user turn after another client
    // stopped or replaced the waiting run. Substantive feedback remains a turn.
    if(confirmation&&approvalTarget&&!changesOptions&&approvesOutline({...approvalTarget,status:'awaiting_confirmation'},content)
      &&(confirmation.expectedConfirmationToken!==undefined||approvalTarget.status==='awaiting_confirmation'))assertOutlineConfirmation(approvalTarget,confirmation);
    if(active?.status==='awaiting_confirmation'&&!changesOptions&&approvesOutline(active,content)){
      this.validateResume(active.id,content,confirmation);
      this.store.message(conversationId,'user',content,undefined,active.id);
      return this.store.updateRun(active.id,{status:'queued',outlineConfirmed:true,error:undefined});
    }
    const config=this.config();
    if(active)this.cancel(active.id);
    const run=this.store.createRun(conversationId,content,config,options,!this.dependencies.autonomous);
    if(run.taskContext?.supplements.length)this.store.event(run.id,'status','已收到补充要求，将保留原研究目标并按累积要求继续。');
    return run;
  }
  cancel(id:string) {const r=this.store.getRun(id);if(['completed','limited','failed','cancelled'].includes(r.status))return r;this.store.updateRun(id,{status:'cancelled',stage:'已停止'});this.live.get(id)?.abort();this.store.event(id,'status','任务已停止，已保存的材料和中间结果保留。');return r;}
  async cancelAndWait(ids:string[],timeoutMs=30000):Promise<void>{
    for(const id of ids){this.cancel(id);this.live.get(id)?.abort();}
    const deadline=Date.now()+timeoutMs;
    while(ids.some(id=>this.live.has(id))){
      if(Date.now()>=deadline)throw new Error('任务仍在保存或关闭，尚未清理文件；请稍后重新操作');
      await delay(25);
    }
  }
  validateResume(id:string,instruction='',confirmation?:ConfirmationExpectation):Run {
    const r=this.store.getRun(id);this.store.assertConversationWritable(r.conversationId); if(!['awaiting_confirmation','interrupted','failed','cancelled'].includes(r.status))throw new Error('该任务当前不能接续');
    if(this.live.has(id))throw new Error('上一轮执行尚未结束，请等停止完成后再继续');
    const c=this.store.getConversation(r.conversationId);if(c.runs.some(other=>other.id!==id&&['running','queued','awaiting_confirmation'].includes(other.status)))throw new Error('本对话已有其他任务正在执行');
    // A stopped child still owns the user's newer requirements. A stale tab
    // must not revive its ancestor or approve an outdated outline instead.
    const rootId=r.taskContext?.rootRunId??r.id;
    if(c.runs.slice(c.runs.findIndex(other=>other.id===id)+1).some(other=>(other.taskContext?.rootRunId??other.id)===rootId))throw new Error('本任务已有更新的要求与进度，旧记录不能接续；请刷新并从最新进度继续。');
    if(r.revision&&instruction.trim())throw new Error('定向修订任务只能原样接续；修改研究要求请另发补充消息，不能混入已有修订缓存');
    assertRevisionCache(r);
    if(confirmation&&(confirmation.expectedConfirmationToken!==undefined||r.status==='awaiting_confirmation'&&approvesOutline(r,instruction)))assertOutlineConfirmation(r,confirmation);
    return r;
  }
  async resume(id:string,instruction='',confirmation?:ConfirmationExpectation) {
    const r=this.validateResume(id,instruction,confirmation),c=this.store.getConversation(r.conversationId);
    if(this.dependencies.autonomous){
      // Intent and checkpoint selection belong to the persistent agent. Preserve
      // saved scientific work until it has interpreted the actual instruction.
      const confirmed=approvesOutline(r,instruction);
      if(instruction.trim()){
        const checkpointPrompt=researchRequest(r);
        const taskContext=buildTaskContext([r],instruction,'continue',r.id);
        this.store.inheritRunOptions(id);
        this.store.message(c.id,'user',instruction,undefined,id);
        this.store.updateRun(id,{taskContext,prompt:effectiveTaskPrompt(taskContext),agent:{...(r.agent??{version:1,executionId:'pending',startedAt:new Date().toISOString(),calls:0,callLimit:256,steps:[]}),checkpointPrompt}});
      }
      this.store.updateRun(id,{status:'queued',error:undefined,failure:undefined,outlineConfirmed:confirmed},true);
      await this.execute(id);return r;
    }
    this.store.restoreResearchCheckpoint(id);
    if(r.revision?.phase==='applied'&&missingOutlineCitationCount(r.draft!,r.outline!,selectedEvidence(r))>0){
      this.store.updateRun(id,{revision:{...r.revision,phase:'draft_saved'}});
      this.store.event(id,'status','既有论证清单未覆盖正文实际引用；保留旧清单并仅重新同步，已保存正文与研究资料不变。');
    }
    const confirmed=approvesOutline(r,instruction);
    if(instruction.trim()){
      const previous=structuredClone(r);
      const taskContext=buildTaskContext([r],instruction,'continue',r.id);
      const prompt=effectiveTaskPrompt(taskContext);
      this.store.inheritRunOptions(id);
      const same=classifyResearchContinuation(previous,{...r,prompt,taskContext})==='same_research';
      const preserveWork=same&&isPureContinuationInstruction(instruction);
      this.store.message(c.id,'user',instruction,undefined,id);this.store.updateRun(id,{taskContext,prompt,...(!preserveWork?{outline:undefined,draft:undefined,review:undefined,progress:undefined}:{}),...(same?{researchCheckpoint:{sourceRunId:previous.researchCheckpoint?.sourceRunId??previous.id,sourcePrompt:researchRequest(previous),kind:'same_research' as const}}:{plan:undefined,methodText:undefined,retrieval:undefined,screening:undefined,fullTextRetrieval:undefined,retrievalExpansion:undefined,retrievalExpansionHistory:undefined,researchCheckpoint:undefined})});
    }
    else if(!r.revision&&(r.plan?.taskType==='review'&&r.plan.searchQueries.length&&!reusableRetrieval(r)))this.store.updateRun(id,{outline:undefined,draft:undefined,review:undefined,retrieval:undefined,screening:undefined});
    else if(!r.revision&&r.plan?.taskType==='review'&&r.evidence.some(hasAbstract)&&!reusableScreening(r))this.store.updateRun(id,{outline:undefined,draft:undefined,review:undefined,screening:undefined});
    this.store.updateRun(id,{status:'queued',error:undefined,failure:undefined,outlineConfirmed:confirmed},true);await this.execute(id);return r;
  }
  async execute(id:string) {
    if(this.live.has(id))throw new Error('任务已经在执行');
    const run=this.store.getRun(id);if(run.status!=='queued')return;
    const controller=new AbortController();this.live.set(id,controller);const signal=controller.signal;
    const guard=()=>{if(signal.aborted||run.status==='cancelled')throw new Error('任务已停止');};
    const progress=(message:string)=>{if(!signal.aborted){this.store.event(id,'progress',message);}};
    const stage=(name:string)=>{guard();this.store.updateRun(id,{stage:name});progress(name);};
    try {
      const existing=this.store.getConversation(run.conversationId).artifacts.find(a=>a.runId===id);
      if(existing){this.store.updateRun(id,{status:existing.status,stage:'已恢复保存的成果'});return;}
      const referenceRequirement=referenceRequirementForRun(this.store,run);
      this.store.updateRun(id,{referenceRequirement,...(run.plan?{plan:{...run.plan,minimumReferences:referenceRequirement.minimumReferences}}:{})});
      assertRevisionCache(run);
      if(this.dependencies.autonomous){
        // A supplement cancels its predecessor synchronously, but the SDK still
        // has to flush tool results and close its persistent session. Wait for
        // that execution to leave the live map before opening the same JSONL.
        const rootId=run.taskContext?.rootRunId??run.id,deadline=Date.now()+15_000;
        let announced=false;
        while([...this.live.keys()].some(otherId=>{if(otherId===id)return false;const other=this.store.getRun(otherId);return other.conversationId===run.conversationId&&(other.taskContext?.rootRunId??other.id)===rootId;})){
          guard();if(Date.now()>=deadline)throw new Error('上一次执行仍在保存或关闭，当前补充及原进度已保留，尚未发出新的模型请求。');
          if(!announced){stage('正在接续：等待上一项操作保存并结束');announced=true;}
          await delay(25,undefined,{signal});
        }
        guard();
        const {executeResearchHarness}=await import('./research-harness');
        await executeResearchHarness(this.store,id,this.config(),signal,{provider:this.dependencies.provider,search:this.dependencies.search,fullText:this.dependencies.fullText,screen:this.dependencies.screen,export:this.dependencies.export,...this.dependencies.harness});
        return;
      }
      const budgeted=process.env.ZHICUI_BUDGET_RUN_ID===run.id;
      const configuredLimit=process.env.ZHICUI_MODEL_CALL_LIMIT?.trim();
      if(budgeted&&!/^[1-4]$/.test(configuredLimit??''))throw new Error('本次任务已启用调用预算；ZHICUI_MODEL_CALL_LIMIT 必须明确设为 1–4 的整数，尚未调用模型。');
      const modelExecution=budgeted?{id:randomUUID(),startedAt:new Date().toISOString(),callLimit:Number(configuredLimit),calls:[] as NonNullable<Run['modelExecution']>['calls']}:undefined;
      if(modelExecution){this.store.updateRun(id,{modelExecution});progress(`本次执行最多 ${modelExecution.callLimit} 次模型调用（含结构修复）；已关闭连接重试。token 用量仅记录服务返回的数字，缺失用量为未知，不代表账单或免费。`);}
      const revisionBase=budgeted&&run.revision?this.store.getRun(run.revision.baseRunId):undefined;
      const incrementalContext=(evidence:Evidence[])=>{
        if(!revisionBase)throw new Error('预算模式需要同一任务已成功复查的修订基线；未调用模型，也不会自动回退为完整研究。');
        return buildRevisionContext(run,revisionBase,evidence,[...bodyCitationIds(draftBody(run.draft??'').body)],[...bodyCitationIds(draftBody(revisionBase.draft??'').body)]);
      };
      // Validate the baseline before any paid step, including plan/reading repairs.
      const incrementalScope='本轮为增量复查：对照前后完整稿件及纠正原文片段核对变化，未改内容沿用已完成的基线审查；本轮未重新通读全部论文，模型核对不等于独立科学验证。';
      if(budgeted){incrementalContext(selectedEvidence(run));progress(incrementalScope);}
      const config=this.config(),provider=(this.dependencies.provider??createProvider)(config);
      const modelIdentity={model:config.model,provider:config.kind,connectionId:config.connectionId,connectionName:config.connectionName};
      this.store.updateRun(id,{status:'running',...modelIdentity,error:undefined,failure:undefined});
      const options=this.store.runExplicitOptions(id),inheritedOptions=this.store.runOptions(id),c=this.store.getConversation(run.conversationId),materials=this.store.selectedMaterials(c.id,run.materialIds);
      if(materials.reduce((n,m)=>n+m.text.length,0)>180000)throw new Error('所选材料超过本版单次读取上限（18万字符）。请减少所选材料，系统没有截断后冒充完整读取。');
      const sessionDir=path.join(this.store.root,'sessions',id);fs.mkdirSync(sessionDir,{recursive:true});
      let callNo=0;
      let modelUse:RunModelUse|undefined;
      const generate=async(prompt:string,system=SYSTEM)=>{
        guard();
        if(modelExecution&&callNo>=modelExecution.callLimit)throw new Error(`本次执行已达到 ${modelExecution.callLimit} 次模型调用上限；已保存当前进度，未发出下一次请求，也不会自动重试。`);
        const index=++callNo;
        const callStage=/^STAGE: (PLAN|OUTLINE|DRAFT|REVIEW|READ_FULL_TEXT|VERIFY_READING_NOTES|SCREEN|SUMMARIZE_FULL_TEXT)\b/.exec(prompt)?.[1]??'OTHER';
        const call={index,stage:callStage,usage:[] as NonNullable<Run['modelExecution']>['calls'][number]['usage']};
        if(modelExecution){modelExecution.calls.push(call);this.store.updateRun(id,{modelExecution});progress(`本次模型调用 ${index}/${modelExecution.callLimit}（${callStage}）。`);}
        const timeoutMs=minimumReferences(run)>=50&&/^STAGE: (?:DRAFT|REVIEW)/.test(prompt)?600_000:180_000;
        // A configuration selection is not a model call. Append only when a
        // request is actually attempted, leaving earlier cached work attributed
        // to its original execution after a manual model switch/resume.
        if(!modelUse){modelUse={...modelIdentity,executionId:modelExecution?.id??randomUUID(),startedAt:new Date().toISOString(),calls:0};run.modelHistory=[...run.modelHistory??[],modelUse];}
        modelUse.calls++;this.store.updateRun(id,{modelHistory:run.modelHistory});
        const result=await provider.generate({system,prompt,signal,sessionDir:path.join(sessionDir,`${Date.now()}-${index}`),timeoutMs,onProgress:progress,...(modelExecution?{disableTransientRetries:true,onUsage:(raw:unknown)=>{
          const usage=safeModelUsage(raw);if(!usage||signal.aborted||run.status==='cancelled')return;
          call.usage.push(usage);this.store.updateRun(id,{modelExecution});progress(`模型调用 ${index} token 用量（非账单）：${Object.entries(usage).map(([key,value])=>`${key}=${value}`).join('，')}。`);
        }}:{})});guard();return result;
      };
      const structured=<T>(prompt:string,schema:ZodType<T>,system=SYSTEM)=>generateStructuredJSON(next=>generate(next,system),prompt,schema,progress);
      const rootIndex=run.taskContext?c.runs.findIndex(r=>r.id===run.taskContext!.rootRunId):0;
      const relatedRuns=c.runs.slice(Math.max(0,rootIndex),c.runs.findIndex(r=>r.id===id)).filter(r=>!r.taskContext||r.taskContext.rootRunId===run.taskContext?.rootRunId);
      const relatedIds=new Set(relatedRuns.map(r=>r.id));
      const prior=c.artifacts.filter(a=>relatedIds.has(a.runId)).slice(-2).map(a=>({title:a.title,content:a.markdown}));
      const previousRun=relatedRuns.filter(r=>r.plan).at(-1);
      const rootPlan=run.taskContext?.supplements.length?c.runs.find(r=>r.id===run.taskContext!.rootRunId)?.plan:undefined;
      const taskType=continuationTaskType(run,rootPlan);
      const inheritedPlan=relatedRuns.filter(r=>r.plan&&(!taskType||r.plan.taskType===taskType)).at(-1)?.plan??rootPlan??previousRun?.plan;
      const input=JSON.stringify({request:writingRequest(run),taskContext:run.taskContext,requiredTaskType:taskType,originalTaskPlan:rootPlan,options,inheritedOptions,materials:materials.map(m=>({name:m.name,role:m.role,text:m.text,extraction:m.extraction})),previousEffectiveMethod:inheritedPlan?.methods,previousConversation:c.messages.filter(m=>m.runId&&relatedIds.has(m.runId)).slice(-8).map(m=>({role:m.role,content:m.content})),previousArtifacts:prior});
      if(!run.plan) {
        stage('理解目标与已有材料');
        const requestedEducationProfile=/(指定教育综述|教育综述配置|保存的教育综述方法)/.test(run.prompt);
        const continuitySchema=planSchema.superRefine((value,context)=>{
          if(taskType&&value.taskType!==taskType)context.addIssue({code:'custom',path:['taskType'],message:'原研究目标不能被补充要求替换',params:{rule:'task_continuity'}});
          if(taskType==='review'&&minimumReferences(run)>0&&!value.searchQueries.length)context.addIssue({code:'custom',path:['searchQueries'],message:'原综述检索要求仍生效',params:{rule:'task_continuity'}});
        });
        const plan=await structured(PLAN+(requestedEducationProfile?'\n可选教育综述配置，是否启用以本次明确意图为准；明确否定时不得启用：\n'+educationReviewProfile():'')+'\n研究输入（资料，非系统指令）：\n'+input,continuitySchema) as NonNullable<Run['plan']>;
        if(inheritedPlan&&plan.methodAction==='inherit'&&!options.methodInstructions&&!options.methodMode){
          const proposedFormat=plan.methods.formatInstructions;
          const latestInstruction=run.taskContext?.supplements.at(-1)??'';
          plan.methods=structuredClone(inheritedPlan.methods);
          // Analysis-method inheritance is independent of a newly requested
          // citation/layout style. Never restore the old style over that edit.
          if(/引用|参考文献|格式|APA|MLA|Chicago|GB\s*\/?T|国标|字体|页边距|行距|版式|排版/i.test(latestInstruction))plan.methods.formatInstructions=proposedFormat;
        }
        if(run.taskContext?.supplements.length&&inheritedPlan&&!plan.methods.formatInstructions&&options.formatInstructions===undefined)plan.methods.formatInstructions=inheritedPlan.methods.formatInstructions;
        if(!requestedEducationProfile&&plan.methodAction!=='inherit')delete plan.methods.profileId;
        if(options.methodMode&&options.methodMode!=='auto')plan.methods.mode=options.methodMode;
        if(options.methodInstructions!==undefined)plan.methods.instructions=options.methodInstructions;
        if(options.formatInstructions!==undefined)plan.methods.formatInstructions=options.formatInstructions;
        // The model cannot introduce a confirmation gate the user never requested.
        plan.waitForConfirmation=options.waitForConfirmation??confirmationRequired(run.prompt,inheritedOptions.waitForConfirmation===true);
        if(plan.methods.mode==='replace'&&!plan.methods.instructions.trim())throw new Error('替换方法需要实际方法内容，请提供文字或方法材料');
        if(plan.taskType==='format') {plan.searchQueries=[];plan.needsCalculation=false;}
        plan.minimumReferences=plan.taskType==='format'?0:minimumReferences(run);
        plan.evidenceRequirement=fullTextRequired(run.prompt)?'full_text':'abstract_or_full_text';
        this.store.updateRun(id,{plan,methodText:effectiveMethods(plan.methods)});
        this.store.message(c.id,'assistant',`本次交付：${plan.deliverable}\n\n${plan.workPlan.map((p,i)=>`${i+1}. ${p}`).join('\n')}\n\n采用方法：${plan.methods.summary}`,'plan',id);
      }
      let plan=run.plan!;const methodText=run.methodText??effectiveMethods(plan.methods);
      const formatContext={store:this.store,runId:id,signal,generate,progress,stage};
      await ensureTaskFormat(formatContext);guard();
      let preparedEvidence:Evidence[]|undefined;
      const prepareEvidence=async()=>{
        if(preparedEvidence)return preparedEvidence;
        const selected=selectedEvidence(run);
        if((!budgeted||needsFullText(run)||run.fullTextRetrieval)&&selected.some(entry=>entry.readScope==='full_text')){
          const cached=cachedReadingEvidence(selected,researchRequest(run),run.reading);
          if(cached){
            stage('复用已完成的论文研读记录');
            progress(`已核验并复用 ${selected.filter(source=>source.readScope==='full_text').length} 篇已完成的研读笔记；沿用已保存的原文与摘录，本步没有重新调用模型研读。`);preparedEvidence=cached;
          }else{
            stage('分篇研读论文正文与核对摘录');
            const read=await readFullTextEvidence(selected,researchRequest(run),prompt=>{if(run.revision)throw new Error('定向修订的全文研读缓存未通过当前校验；已保留原文，未自动重读或改写研究问题。');return generate(prompt);},progress,{saved:run.reading,signal,onSave:reading=>{guard();this.store.updateRun(id,{reading});}});guard();
            this.store.updateRun(id,{reading:read.record});preparedEvidence=read.evidence;
          }
        }else preparedEvidence=selected;
        this.store.updateRun(id,{progress:{readingCompleteCount:run.reading?.entries.filter(entry=>entry.complete&&entry.semanticReview?.version===1).length??0,writingReadyCount:contentLiteratureCount(eligibleEvidence(run,preparedEvidence))}});
        enforceReviewEvidence(run,preparedEvidence,Boolean(run.reading));return preparedEvidence;
      };
      // Saved plans from older versions still receive the user's deterministic constraint.
      if(plan.taskType!=='format'&&plan.minimumReferences!==minimumReferences(run)){
        plan=applyReferenceRequirement(plan,run.prompt,minimumReferences(run));this.store.updateRun(id,{plan});
      }
      if(minimumReferences(run)>200)throw new Error(`本次要求至少 ${minimumReferences(run)} 篇引用，超过当前单次可处理的 200 篇文献上限，不能降低要求后冒充完成。`);
      if(run.outline&&plan.taskType==='review'&&plan.searchQueries.length&&!reusableRetrieval(run))this.store.updateRun(id,{outline:undefined,draft:undefined,review:undefined,retrieval:undefined,screening:undefined});
      if(run.outline&&plan.taskType==='review'&&run.evidence.some(hasAbstract)&&!reusableScreening(run))this.store.updateRun(id,{outline:undefined,draft:undefined,review:undefined,screening:undefined});
      if(!run.outline) {
        stage('读取证据与必要分析');
        let evidence=materialEvidence(this.store,run);
        // Prior artifacts are clearly derivative sources, never new independent studies.
        for(const [i,a] of prior.entries())evidence.push({id:`P${i+1}`,title:a.title,text:a.content,location:'同一对话的已交付成果；非独立原始研究',readScope:'user_material',retrievedAt:new Date().toISOString()});
        const warnings:string[]=[];let replayedRetrieval=false;
        if(plan.searchQueries.length){
          const saved=run.retrieval;
          const reusable=reusableRetrieval(run);
          if(reusable){
            replayedRetrieval=true;
            evidence.push(...externalEvidence(run.evidence));
            warnings.push(...saved!.warnings);
            progress(`沿用 ${saved!.attemptedAt} 已成功保存的文献检索，从后续筛选与写作继续。`);
          }else{
          const targetCount=plan.taskType==='review'?Math.min(200,Math.max(30,minimumReferences(run)*2)):12;
          const retrieval={version:RETRIEVAL_VERSION,attemptedAt:new Date().toISOString(),queries:plan.searchQueries,minimumReferences:minimumReferences(run),targetCount,retrievedCount:0,usableCount:0,warnings:[] as string[]};
          this.store.updateRun(id,{retrieval,screening:undefined,fullTextRetrieval:undefined,retrievalExpansion:undefined,retrievalExpansionHistory:undefined});
          const found=await(this.dependencies.search??searchEvidence)(plan.searchQueries,signal,progress,{topic:run.prompt,targetCount,maxResults:plan.taskType==='review'?200:24,maxQueries:plan.taskType==='review'?24:6,abstractOnly:true,preferFullTextSources:needsFullText(run)});guard();
          evidence.push(...found.evidence);warnings.push(...found.warnings);
          // The evidence and success marker are committed together. A failed
          // refresh cannot relabel the previous corpus as newly retrieved.
          this.store.updateRun(id,{evidence,retrieval:{...retrieval,completedAt:new Date().toISOString(),evidenceHash:discoveryHash(found.evidence),retrievedCount:found.evidence.length,usableCount:contentLiteratureCount(found.evidence),warnings:found.warnings,diagnostics:found.diagnostics,pendingEvidence:found.pendingEvidence,discoveredCount:found.discoveredCount,rawReturnedCount:found.rawReturnedCount}});
          }
        }
        if(plan.needsCalculation){const calculated=await calculateMaterials(materials,signal);guard();evidence.push(...calculated);if(!calculated.length)warnings.push('未找到可由本版确定性计算器复算的数据；不能宣称已完成计算核验。');}
        evidence=[...new Map(evidence.map(e=>[e.id,e])).values()];
        this.store.updateRun(id,{evidence});
        for(const warning of warnings)progress(`${replayedRetrieval&&run.retrieval?.warnings.includes(warning)?'此前检索记录：':''}${warning}`);
        if(plan.taskType==='review'&&evidence.some(isContentLiterature)){
          if(reusableScreening(run,evidence))progress(`沿用完整的 ${run.screening!.screenedCount} 篇相关性筛选；研究问题和文献内容均未变化。`);
          else {
          stage('阅读摘要并判断是否需要全文');
          const screening=await(this.dependencies.screen??screenEvidence)(evidence,screeningRequest(run),minimumReferences(run),prompt=>generate(prompt),progress,{decideFullText:true,requireFullText:needsFullText(run),saved:run.screeningCheckpoint,signal,onSave:checkpoint=>{guard();this.store.updateRun(id,{screeningCheckpoint:checkpoint});}});guard();
          if(needsFullText(run)&&!screening.fullTextIds)screening.fullTextIds=[...screening.includedIds];
          this.store.updateRun(id,{screening:{...screening,inputHash:screeningInputHash(run,evidence)}});
          progress(`已筛选 ${screening.screenedCount} 篇含内容候选，保留 ${screening.includedIds.length} 篇相关文献，排除 ${screening.excluded.length} 篇；保留文献仍须逐项对应主张。`);
          }
          // Counts are enforced after the bounded candidate batch below. A
          // short initial result or relevance filter must not hide saved work.
        }
        const requestedIds=new Set(run.screening?.fullTextIds??[]);
        let candidates=screenedEvidence(run).filter(entry=>requestedIds.has(entry.id));
        if(candidates.length&&!run.retrievalExpansion){
          const reused=reuseSourceEvidence(this.store,candidates,relatedRuns);if(reused.reusedIds.length){const byId=new Map(reused.evidence.map(entry=>[entry.id,entry]));this.store.updateRun(id,{evidence:run.evidence.map(entry=>byId.get(entry.id)??entry)});candidates=reused.evidence;progress(`复用同一任务已有的 ${reused.reusedIds.length} 篇原文；当前摘要判断保留，随后按本轮问题重新研读，未称为本轮新下载。`);}
          const inputHash=discoveryHash(candidates);
          const saved=run.fullTextRetrieval;
          if(saved?.inputHash===inputHash&&saved.completedAt){
            const acquiredIds=candidates.filter(entry=>entry.readScope==='full_text'&&entry.text.trim()).map(entry=>entry.id);
            if(JSON.stringify(saved.acquiredIds)!==JSON.stringify(acquiredIds))this.store.updateRun(id,{fullTextRetrieval:{...saved,acquiredIds}});
            progress(`沿用已完成的正文获取记录；保留 ${acquiredIds.length} 篇原文，不重复尝试本轮已失败的来源。`);
          }
          else{
            stage('按摘要判断获取选中文献的正文');
            const found=await(this.dependencies.fullText??fetchFullTextEvidence)(candidates,signal,progress,{maxResults:200,cacheDirectory:path.join(this.store.root,'source-documents'),onResult:entry=>{
              guard();
              if(!requestedIds.has(entry.id)||entry.readScope!=='full_text'||!entry.text.trim())throw new Error('不能保存未选中或未确认正文的检索结果');
              this.store.updateRun(id,{evidence:run.evidence.map(previous=>previous.id===entry.id?entry:previous)});
            }});guard();
            const byId=new Map(found.evidence.map(entry=>[entry.id,entry]));
            evidence=run.evidence.map(entry=>byId.get(entry.id)??entry);
            const acquiredIds=found.evidence.filter(entry=>entry.readScope==='full_text'&&entry.text.trim()).map(entry=>entry.id);
            this.store.updateRun(id,{evidence,fullTextRetrieval:{inputHash,completedAt:new Date().toISOString(),requestedIds:[...requestedIds],acquiredIds,warnings:found.warnings,diagnostics:found.diagnostics}});
            warnings.push(...found.warnings);for(const warning of found.warnings)progress(warning);
            progress(`摘要筛选后决定读取 ${requestedIds.size} 篇正文，实际取得 ${acquiredIds.length} 篇；未取得的正文不冒充已读。`);
          }
        }
        // A previous completed reading can legitimately withdraw every claim
        // from a paper. Use only fully validated current notes, never a stale
        // progress counter, to decide the next manual batch's actual deficit.
        const usableForExpansion=cachedReadingEvidence(selectedEvidence(run),researchRequest(run),run.reading)??selectedEvidence(run);
        const availableForExpansion=contentLiteratureCount(usableForExpansion),sufficientSelected=availableForExpansion>=requiredEvidenceCount(run);
        const skipUnneededExpansion=sufficientSelected&&(requiredEvidenceCount(run)<(run.retrieval?.minimumReferences??requiredEvidenceCount(run))||Boolean(run.retrievalExpansion&&['failed','searching'].includes(run.retrievalExpansion.stage)));
        if(skipUnneededExpansion&&run.retrievalExpansion&&run.retrievalExpansion.stage!=='complete')progress('当前选中文献已达到生效的篇数要求；保留此前补充检索的失败记录，继续核验已有证据，不重复补搜。');
        const pending=pendingExpansionEvidence(run);
        if(plan.taskType==='review'&&(plan.searchQueries.length||pending.length)&&!skipUnneededExpansion&&(run.retrievalExpansion||!sufficientSelected)){
          const previousBatch=run.retrievalExpansion;
          const nextSavedBatch=!sufficientSelected&&pending.length>0&&previousBatch&&['complete','failed','searching'].includes(previousBatch.stage);
          if(!previousBatch||nextSavedBatch){
            const gapBefore=requiredEvidenceCount(run)-availableForExpansion,targetCount=Math.min(60,Math.max(30,gapBefore*3)),attemptedAt=new Date().toISOString();
            // One bounded new batch per execute. Only a later manual execution
            // can archive this batch and consume more saved candidates. A
            // completed/failed network search is never silently repeated.
            this.store.updateRun(id,{...(previousBatch?{retrievalExpansionHistory:[...run.retrievalExpansionHistory??[],structuredClone(previousBatch)]}:{}),retrievalExpansion:{stage:'searching',discovery:pending.length?'pending':'network',attemptedAt,gapBefore,targetCount,candidateIds:[],requestedIds:[],acquiredIds:[],reusedIds:[],warnings:[]}});
            stage(`可用证据尚差 ${gapBefore} 篇，${pending.length?'处理一批已发现的待筛摘要':'进行一次有界补充摘要检索'}`);
            try{
              const found=pending.length?{evidence:pending.slice(0,targetCount),warnings:['本批候选来自上轮已发现但尚未筛选的记录，没有重新检索。'],diagnostics:[] as NonNullable<Run['retrieval']>['diagnostics'],pendingEvidence:[] as Evidence[],discoveredCount:pending.length,rawReturnedCount:0}:await(this.dependencies.search??searchEvidence)(plan.searchQueries,signal,progress,{topic:researchRequest(run),targetCount,maxResults:targetCount,maxQueries:24,abstractOnly:true,preferFullTextSources:needsFullText(run),excludeEvidence:externalEvidence(run.evidence)});guard();
              const additions=newIndependentEvidence(externalEvidence(run.evidence),externalEvidence(found.evidence)).slice(0,60),combined=[...run.evidence,...additions];
              const remaining=newIndependentEvidence(externalEvidence(combined),[...run.retrieval?.pendingEvidence??[],...found.evidence,...found.pendingEvidence??[]]);
              const retrieval={version:RETRIEVAL_VERSION,attemptedAt,completedAt:new Date().toISOString(),queries:[...plan.searchQueries],minimumReferences:minimumReferences(run),targetCount,retrievedCount:found.evidence.length,usableCount:contentLiteratureCount(found.evidence),warnings:found.warnings,diagnostics:found.diagnostics,evidenceHash:discoveryHash(found.evidence),discoveredCount:found.discoveredCount,rawReturnedCount:found.rawReturnedCount,pendingEvidence:found.pendingEvidence};
              this.store.updateRun(id,{evidence:combined,retrieval:run.retrieval?{...run.retrieval,evidenceHash:discoveryHash(externalEvidence(combined)),pendingEvidence:remaining}:undefined,retrievalExpansion:{...run.retrievalExpansion!,stage:'screening',retrieval,candidateIds:additions.map(entry=>entry.id),warnings:[...found.warnings,...(!additions.length?['本次补充检索没有新的独立候选作品。']:[])]}});
              progress(`补充检索返回 ${found.evidence.length} 条，去除既有ID与重复作品后新增 ${additions.length} 条候选；原检索与筛选记录保留。`);
            }catch(error){guard();this.store.updateRun(id,{retrievalExpansion:{...run.retrievalExpansion!,stage:'failed',error:error instanceof Error?error.message:'补充检索失败'}});throw error;}
          }
          if(run.retrievalExpansion!.stage==='searching'||run.retrievalExpansion!.stage==='failed')throw new Error('本次有界补充检索已尝试但未完成，已保存原文与原目标；不会在恢复时反复从零检索。'+(run.retrievalExpansion!.error??''));
          if(run.retrievalExpansion!.stage==='screening'){
            const ids=new Set(run.retrievalExpansion!.candidateIds),additions=run.evidence.filter(entry=>ids.has(entry.id));
            stage('仅筛选补充检索的新摘要');
            const screened=await(this.dependencies.screen??screenEvidence)(additions,screeningRequest(run),minimumReferences(run),prompt=>generate(prompt),progress,{decideFullText:true,requireFullText:needsFullText(run),saved:run.screeningCheckpoint,signal,onSave:checkpoint=>{guard();this.store.updateRun(id,{screeningCheckpoint:checkpoint});}});guard();
            const requested=screened.fullTextIds??(needsFullText(run)?screened.includedIds:[]),base=run.screening??{includedIds:[],excluded:[],screenedCount:0};
            const merged={includedIds:[...base.includedIds,...screened.includedIds],includedReasons:{...base.includedReasons,...screened.includedReasons},excluded:[...base.excluded,...screened.excluded],screenedCount:base.screenedCount+screened.screenedCount,fullTextIds:[...(base.fullTextIds??[]),...requested],fullTextReasons:{...base.fullTextReasons,...screened.fullTextReasons},inputHash:screeningInputHash(run)};
            this.store.updateRun(id,{screening:merged,retrievalExpansion:{...run.retrievalExpansion!,stage:'fetching',requestedIds:requested}});
          }
          if(run.retrievalExpansion!.stage==='fetching'){
            const requested=new Set(run.retrievalExpansion!.requestedIds),selected=run.evidence.filter(entry=>requested.has(entry.id));
            const reused=reuseSourceEvidence(this.store,selected,relatedRuns),reusedMap=new Map(reused.evidence.map(entry=>[entry.id,entry]));
            this.store.updateRun(id,{evidence:run.evidence.map(entry=>reusedMap.get(entry.id)??entry),retrievalExpansion:{...run.retrievalExpansion!,reusedIds:[...new Set([...run.retrievalExpansion!.reusedIds,...reused.reusedIds])]}});
            if(reused.reusedIds.length)progress(`新增候选中复用 ${reused.reusedIds.length} 篇同一任务的原文缓存；仍按当前问题重新研读。`);
            stage('仅获取新增选中文献的正文');
            const found=selected.length?await(this.dependencies.fullText??fetchFullTextEvidence)(reused.evidence,signal,progress,{maxResults:60,cacheDirectory:path.join(this.store.root,'source-documents'),onResult:entry=>{
              guard();if(!requested.has(entry.id)||entry.readScope!=='full_text'||!entry.text.trim())throw new Error('补充正文结果不属于已筛选新增来源');
              this.store.updateRun(id,{evidence:run.evidence.map(previous=>previous.id===entry.id?entry:previous),retrievalExpansion:{...run.retrievalExpansion!,acquiredIds:[...new Set([...run.retrievalExpansion!.acquiredIds,entry.id])]}});
            }}):{evidence:[] as Evidence[],warnings:[] as string[],diagnostics:undefined};guard();
            const byId=new Map(found.evidence.map(entry=>[entry.id,entry]));evidence=run.evidence.map(entry=>byId.get(entry.id)??entry);
            const allRequested=new Set(run.screening!.fullTextIds??[]),allCandidates=evidence.filter(entry=>allRequested.has(entry.id)),completedAt=new Date().toISOString();
            const priorFull=run.fullTextRetrieval;
            this.store.updateRun(id,{evidence,retrievalExpansion:{...run.retrievalExpansion!,stage:'complete',completedAt,acquiredIds:evidence.filter(entry=>requested.has(entry.id)&&isContentLiterature(entry)&&entry.readScope==='full_text').map(entry=>entry.id),warnings:[...run.retrievalExpansion!.warnings,...found.warnings],diagnostics:found.diagnostics},fullTextRetrieval:{inputHash:discoveryHash(allCandidates),completedAt,requestedIds:[...allRequested],acquiredIds:allCandidates.filter(entry=>entry.readScope==='full_text'&&entry.text.trim()).map(entry=>entry.id),warnings:[...(priorFull?.warnings??[]),...found.warnings],diagnostics:[...(priorFull?.diagnostics??[]),...(found.diagnostics??[])]}});
            progress(`本批补充阶段完成：处理 ${run.retrievalExpansion!.candidateIds.length} 条新候选，其中 ${requested.size} 篇需正文，取得 ${run.retrievalExpansion!.acquiredIds.length} 篇原文；目前 ${contentLiteratureCount(selectedEvidence(run))} 篇达到选定阅读范围，仍须研读核验，最低要求 ${requiredEvidenceCount(run)} 保持不变。`);
          }
          warnings.push(...run.retrievalExpansion!.warnings);
        }
        enforceReviewEvidence(run,selectedEvidence(run));
        evidence=await prepareEvidence();
        stage('根据已读文献组织论证');
        const outline=await structured(OUTLINE+'\n生效方法：\n'+methodText+'\n'+JSON.stringify(manuscriptWritingContext(run,evidence)),outlineSchema);
        outline.gaps=[...new Set(scientificWarnings(run,outline.gaps).filter(gap=>!manuscriptBoundaryIssues(gap).length))];
        constrainOutline(outline,evidence);
        this.store.updateRun(id,{outline});this.store.event(id,'outline','论证清单已形成；可在侧边查看证据位置、支持范围和缺口。');
        this.store.message(c.id,'assistant',`已形成论证清单，共 ${outline.rows.length} 项。${outline.gaps.length?'已记录 '+outline.gaps.length+' 项边界或缺口。':''}${plan.waitForConfirmation&&!run.outlineConfirmed?'按你的要求，等待确认后成文。':'现在按清单继续成文与自动审查。'}`,'outline',id);
      }
      const workingEvidence=await prepareEvidence();
      enforceReviewEvidence(run,workingEvidence);
      this.store.updateRun(id,{outline:constrainOutline(run.outline!,workingEvidence)});
      if(plan.waitForConfirmation&&!run.outlineConfirmed){this.store.updateRun(id,{status:'awaiting_confirmation',stage:'等待你确认论证清单'});return;}
      const buildContext=()=>{
        const author=manuscriptWritingContext(run,budgeted?[]:workingEvidence,workingEvidence.map(source=>source.id));
        return JSON.stringify({
          ...(budgeted?incrementalContext(workingEvidence):{materials:materials.filter(m=>m.role!=='evidence').map(m=>({role:m.role,text:m.text}))}),
          ...author,evidence:budgeted?undefined:author.evidence,
          formatGuidelines:run.formatGuidelines,formatResolution:run.formatResolution,
        });
      };
      let context=buildContext();
      const system=SYSTEM+'\n本次实际生效方法（所有阶段共用）：\n'+methodText+(budgeted?'\n本次为已有完整原文审查基线上的增量核对。未实质改变的内容沿用baseline，不声称重新研读全文；不能仅因本轮sourceIndex未重复原文而新增缺原文错误。新增或实质改变的事实必须由本次及基线corrections的原文片段支持；证据不足须报实质问题，来源ID相同本身不证明支持。':'');
      const synchronizeOutline=async()=>{
        stage('同步修订后的论证清单');
        const completeOutlineSchema=outlineSchema.superRefine(outline=>{
          const missing=missingOutlineCitationCount(run.draft!,outline,workingEvidence);
          if(missing)throw new ModelStructureError(`论证清单必须覆盖完整正文实际引用的全部有效证据ID；当前缺少${missing}个。请按主题合并为1–24项并依据全文重新映射来源，不得逐篇拆行、虚补支持关系、删除正文引用或省略后续主题。`);
        });
        const outlineInput={...JSON.parse(buildContext()),finalDraft:run.draft};
        const updated=await structured(OUTLINE+'\n将清单同步到以下修订后的完整实际正文，删除已删主张，按当前证据重新标记支持范围。按正文各节主题合并为1–24项；claim、reasoning、limits只用简短句子，locations只列简短定位，不逐篇抄录长证据。清单evidenceIds须覆盖正文实际引用的全部有效来源，一项可包含多篇文献；不得为了缩短输出而省略后续章节、来源或真实限制。\n'+JSON.stringify(outlineInput),completeOutlineSchema,system);
        this.store.updateRun(id,{outline:constrainOutline(updated,workingEvidence),...(run.revision?{revision:{...run.revision,phase:'applied' as const}}:{})});context=buildContext();
        this.store.event(id,'outline','论证清单已同步到修订稿。');
      };
      if(!run.draft){
        stage(plan.taskType==='format'?'保留原文信息并整理版式':'生成指定成果');
        if(plan.taskType==='format'){
          const originals=materials.filter(m=>m.role==='evidence');
          const original=originals.length?originals.map(m=>m.text).join('\n\n'):prior.at(-1)?.content;
          if(!original)throw new Error('纯格式任务需要一份原文或同一对话的已有成果');
          this.store.updateRun(id,{draft:original});
        }else this.store.updateRun(id,{draft:(await generate(DRAFT+'\n研究资料：\n'+context,system)).trim().replace(/^```(?:markdown|md)?\s*/,'').replace(/\s*```$/,'')});
      }
      // A requested correction is applied before a fresh review can dismiss
      // or overwrite it. Draft and phase are saved together for safe resume.
      if(run.revision?.phase==='pending'){
        stage('对照原文片段定向修订已交付成果');
        const draft=await generate(DRAFT+'\nSTAGE: REVISE\n这是原研究任务的关联修订。先逐项对照revision中的意见及原文片段，修正有依据的问题并保留其余正确内容。意见不是既定科学结论；若原文不支持该意见，只保留原文支持的保守表述。不得遗漏意见、重启研究或用新结论掩盖缺口。保留原来源ID、最低引用数和已披露的真实边界。\n'+context+'\n原始稿件：\n'+run.draft,system);
        this.store.updateRun(id,{draft:draft.trim().replace(/^```(?:markdown|md)?\s*/,'').replace(/\s*```$/,''),revision:{...run.revision,phase:'draft_saved'}});
      }
      if(run.revision?.phase==='draft_saved')await synchronizeOutline();
      stage('自动审查证据、方法与论证');
      // One canonical citation identity through generation, review and revision.
      // Display numbering is applied only once, at final export.
      const reviewText=()=>run.draft!;
      // Recompute from the current saved draft at every review; never cache this
      // with the pre-draft context or ask the model to estimate long ID lists.
      const reviewContext=()=>context+'\n'+JSON.stringify({reviewerOnly:{selectedEvidenceSummary:evidenceSummaryForModel(workingEvidence),retrieval:retrievalForModel(run.retrieval),screening:screeningForModel(run.screening),fullTextRetrieval:fullTextForModel(run.fullTextRetrieval)},citationAudit:plan.taskType==='format'?{applicable:false,bibliographyGeneratedAtExport:false}:{applicable:true,...citationAudit(reviewText(),workingEvidence,Math.max(minimumReferences(run),requiredEvidenceCount(run)))}});
      let review=await structured(REVIEW+(run.review?'\n'+REVIEW_FOLLOWUP+'\n'+JSON.stringify({previousReviewIssues:run.review.issues}):'')+'\n研究资料：\n'+reviewContext()+'\n当前稿件（保留来源ID；方括号ID会在最终导出时自动编号，不能要求提前改成数字或另编M编号）：\n'+reviewText(),reviewSchema,system);
      review.issues.push(...manuscriptBoundaryIssues(reviewText()),...await reviewFormatContent(formatContext));guard();
      if(plan.taskType!=='format')review.issues.push(...citationIssues(run.draft!,workingEvidence,Math.max(minimumReferences(run),requiredEvidenceCount(run))));this.store.updateRun(id,{review});
      let revisionRound=0;
      while(review.issues.some(issue=>issue.severity==='error')&&plan.taskType!=='format'&&revisionRound<2){
        revisionRound++;
        const previousReviewIssues=review.issues;
        stage(`按实质问题定向修订（${revisionRound}/2）`);
        const draft=await generate(DRAFT+'\nSTAGE: REVISE\n只修复下列有依据的实质错误，保持目标、正确表述和已有效内容。不要为普通提醒或新文风偏好改写全文，不用增加新结论掩盖缺口。\n'+context+'\n待修复实质问题：'+JSON.stringify({issues:previousReviewIssues.filter(issue=>issue.severity==='error')})+'\n原稿：\n'+run.draft,system);
        this.store.updateRun(id,{draft:draft.trim().replace(/^```(?:markdown|md)?\s*/,'').replace(/\s*```$/,''),...(run.revision?{revision:{...run.revision,phase:'draft_saved' as const}}:{})});
        await synchronizeOutline();
        stage(`复查修订稿（${revisionRound}/2）`);review=await structured(REVIEW+'\n'+REVIEW_FOLLOWUP+'\n'+JSON.stringify({previousReviewIssues})+'\n'+reviewContext()+'\n修订稿（保留同一来源ID，导出时统一编号，不得另编数字或M编号）：\n'+reviewText(),reviewSchema,system);
        review.issues.push(...manuscriptBoundaryIssues(reviewText()),...await reviewFormatContent(formatContext));guard();
        review.issues.push(...citationIssues(run.draft!,workingEvidence,Math.max(minimumReferences(run),requiredEvidenceCount(run))));this.store.updateRun(id,{review});
      }
      this.store.event(id,'review',`自动审查完成：${review.checks.length} 类检查，${review.issues.length} 项未消除问题。审查结论不等于科学验证。`);
      if(review.issues.some(i=>i.severity==='error'))throw new Error((revisionRound===2?'经过 2 轮定向修订后，':'')+'复查仍有需要修复的实质错误，草稿已保存但未正式交付：'+review.issues.filter(i=>i.severity==='error').map(i=>i.location+'：'+i.issue).join('；').slice(0,1200));
      // A draft and its checklist are kept consistent after targeted repair.
      if(review.issues.some(i=>i.severity==='error'))run.outline!.gaps.push(...review.issues.filter(i=>i.severity==='error').map(i=>`${i.location}：${i.issue}`));
      const limitations=[...new Set([...(run.outline?.gaps??[]),...review.limitations,...review.issues.map(i=>`${i.location}：${i.issue}`)])];
      if(budgeted)limitations.push(incrementalScope);
      const delivery=deliveryRequirements(plan,workingEvidence,bodyCitationIds(draftBody(run.draft!).body),materials,resolvedExportFormat(run,materials),run.draft);
      limitations.push(...delivery.limitations);
      if(plan.taskType!=='format'&&originalSourceAccessRequired(run.prompt)){
        stage('逐条核验最终引用可打开的原文');
        const access=await ensureCitedSourcesOpenable(this.store,run,[...bodyCitationIds(draftBody(run.draft!).body)],signal,progress);guard();
        if(access.failures.length)throw new Error(`最终引用中仍有 ${access.failures.length} 篇未取得可打开原文，草稿与已取得来源已保存，未降低最低引用要求或正式交付：`+access.failures.map(item=>`${item.id}：${item.error}`).join('；').slice(0,1800));
        progress(`最终引用的 ${access.checkedIds.length} 篇外部论文已逐条确认原文可打开；原文已保存，模型阅读范围保持原记录。`);
      }
      stage('生成可编辑稿与阅读版');
      const artifact:Artifact={id:randomUUID(),runId:id,title:resolveArtifactTitle(run.draft!,plan.title),markdown:plan.taskType==='format'?run.draft!:withReferences(run.draft!,workingEvidence,{runId:id}),createdAt:new Date().toISOString(),status:limitations.length?'limited':'completed',formats:[],limitations,format:delivery.format};
      registerArtifactOutput(this.store.root,id,artifact.id);
      const exported=await(this.dependencies.export??exportArtifact)(artifact,path.join(this.store.root,'artifacts'));guard();
      artifact.formats=exported.formats;artifact.limitations=[...new Set([...artifact.limitations,...exported.warnings])];if(exported.warnings.length)artifact.status='limited';
      if(!artifact.formats.length)throw new Error('没有成功生成可下载文件，保留正文以便重试导出');
      this.store.addArtifact(c.id,artifact);
      this.store.updateRun(id,{status:artifact.status,stage:'成果已保存'});
      this.store.event(id,'artifact',artifact.title);
      this.store.message(c.id,'assistant',`已交付《${artifact.title}》。可在成果栏下载文件。`,'result',id);
    }catch(error){
      if(!signal.aborted&&this.store.getRun(id).status!=='cancelled'){
        const message=error instanceof Error?error.message:'执行失败',failedStage=run.stage;
        this.store.updateRun(id,{status:'failed',error:message,failure:{stage:failedStage,message},stage:`暂停在：${failedStage}`});this.store.event(id,'status',message);
        this.store.message(run.conversationId,'assistant',`本次停在“${failedStage}”：${message}\n\n已保存当前材料与中间结果。任务不会自动继续，点击继续后从已保存进度接续。`,'notice',id);
      }
    }finally{this.live.delete(id);}
  }
  stopAll(){for(const [id,controller] of this.live){try{if(['running','queued'].includes(this.store.getRun(id).status))this.store.updateRun(id,{status:'interrupted',stage:'服务关闭，已保存进度待接续'});}finally{controller.abort();}}}
}
