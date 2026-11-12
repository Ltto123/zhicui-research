import type {Evidence,Run} from '../../shared/types';
import {isPureContinuationInstruction} from '../../server/research-continuity';

const external=(source:Evidence)=>['abstract','full_text','metadata'].includes(source.readScope);
const distinct=(values:readonly string[])=>new Set(values).size;
const validCount=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;

/** New tasks pause at the writing outline; an existing run keeps its own setting. */
export function outlineReviewDefault(run:Run|undefined,continuing:boolean):boolean{
  return !run||!continuing?true:Boolean(run.plan?.waitForConfirmation);
}
export function awaitingWritingOutline(run:Run):boolean{
  return run.status==='awaiting_confirmation'&&Boolean(run.outline)&&!run.draft?.trim()&&!run.outlineConfirmed;
}
/** Collapse one tool's start/result pair, but retain repeated attempts as history. */
export function recentAgentSteps(run:Run){
  const steps:NonNullable<Run['agent']>['steps']=[];
  for(const step of run.agent?.steps??[]){
    const last=steps.at(-1);
    if(last?.action===step.action&&last.status==='running'&&step.status!=='running')steps[steps.length-1]=step;
    else steps.push(step);
  }
  return steps.slice(-6);
}

export function evidenceInventory(evidence:readonly Evidence[]){
  return {total:evidence.length,papers:evidence.filter(external).length,materials:evidence.filter(item=>item.readScope==='user_material').length,calculations:evidence.filter(item=>item.readScope==='computed').length};
}

export function progressCounts(run:Run){
  const papers=run.evidence.filter(external),ids=new Set(papers.map(item=>item.id));
  return {candidates:ids.size,related:run.screening?distinct(run.screening.includedIds.filter(id=>ids.has(id))):undefined,
    fullText:distinct(papers.filter(item=>item.readScope==='full_text'&&item.text.trim()).map(item=>item.id)),
    abstracts:distinct(papers.filter(item=>item.readScope==='abstract'&&item.text.trim()).map(item=>item.id)),
    metadata:distinct(papers.filter(item=>item.readScope==='metadata').map(item=>item.id)),
    savedReadings:distinct((run.reading?.entries??[]).filter(entry=>entry.complete&&ids.has(entry.evidenceId)).map(entry=>entry.evidenceId)),
    readingComplete:validCount(run.progress?.readingCompleteCount),writingReady:validCount(run.progress?.writingReadyCount)};
}

const hasSavedResearch=(run:Run)=>run.evidence.some(external)||Boolean(run.outline||run.draft?.trim()||run.reading?.entries.length);
function parentIds(run:Run){return [run.researchCheckpoint?.sourceRunId,run.revision?.baseRunId,run.taskContext?.parentRunId,run.taskContext?.rootRunId].filter((id):id is string=>Boolean(id)&&id!==run.id);}

/** Read-only provenance traversal: never infer continuity from recency or a similar title. */
export function deriveRunProgress(run:Run,runs:readonly Run[]){
  const byId=new Map(runs.filter(item=>item.conversationId===run.conversationId).map(item=>[item.id,item]));
  const visited=new Set([run.id]),queue=parentIds(run),ancestorIds:string[]=[];let inheritedFrom:Run|undefined;
  while(queue.length){const id=queue.shift()!;if(visited.has(id))continue;visited.add(id);const ancestor=byId.get(id);if(!ancestor)continue;ancestorIds.push(id);if(!inheritedFrom&&hasSavedResearch(ancestor))inheritedFrom=ancestor;queue.unshift(...parentIds(ancestor));}
  const awaitingHandoff=!run.evidence.some(external)&&!run.retrieval?.completedAt&&Boolean(inheritedFrom);
  return {current:progressCounts(run),inheritedFrom,ancestorIds,awaitingHandoff,displayRun:awaitingHandoff?inheritedFrom!:run};
}

/** A saved draft is discoverable by provenance, never by a nearby timestamp. */
export function savedDraftForRun(run:Run,runs:readonly Run[]):Run|undefined{
  if(run.draft?.trim())return run;
  if(!run.taskContext)return undefined;
  const byId=new Map(runs.filter(item=>item.conversationId===run.conversationId).map(item=>[item.id,item]));
  const {rootRunId,rootPrompt}=run.taskContext,visited=new Set([run.id]),queue=parentIds(run);
  while(queue.length){
    const id=queue.shift()!;if(visited.has(id))continue;visited.add(id);const source=byId.get(id);
    if(!source||(source.taskContext?.rootRunId??source.id)!==rootRunId||(source.taskContext?.rootPrompt??source.prompt)!==rootPrompt)continue;
    if(source.draft?.trim())return source;queue.unshift(...parentIds(source));
  }
  return undefined;
}

function canContinueDraft(run:Run,saved:Run):boolean{
  if(saved.id===run.id)return true;
  if(['completed','limited'].includes(saved.status)||!run.taskContext)return false;
  if(JSON.stringify([...run.materialIds].sort())!==JSON.stringify([...saved.materialIds].sort()))return false;
  const previous=saved.taskContext?.supplements??[],next=run.taskContext.supplements;
  if(previous.some((value,index)=>next[index]!==value))return false;
  const added=next.slice(previous.length);if(!added.length||!added.every(isPureContinuationInstruction))return false;
  if(run.evidence.length&&run.researchCheckpoint?.kind==='evidence_only'){
    const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
    const originals=new Map(saved.evidence.map(entry=>[entry.id,entry]));
    if(run.reading?.entries.length||run.evidence.some(entry=>!same(entry,originals.get(entry.id))))return false;
    if((['screening','fullTextRetrieval','retrievalExpansion','retrievalExpansionHistory'] as const).some(key=>run[key]!==undefined&&!same(run[key],saved[key])))return false;
    if(run.retrieval?.completedAt&&!same(run.retrieval,saved.retrieval))return false;
  }
  // Planner prose is not the user's saved options. The resume endpoint checks
  // durable method/format options; current composer edits take label priority.
  return true;
}

export function runStageSummary(run:Run,runs:readonly Run[]){
  const saved=savedDraftForRun(run,runs),failure=runFailure(run);
  if(run.status==='running'||run.status==='queued'){
    return {label:run.stage||'准备开始',detail:run.status==='queued'?'任务已排队，等待执行。':'系统自动处理，无需逐步确认；切换对话不会停止。'};
  }
  if(awaitingWritingOutline(run))return {label:'等待审校写作提纲',detail:'请审校章节安排与主要论点，可补充调整意见；通过后系统自动成稿、修订和复查，无需逐步确认。'};
  if(run.status==='awaiting_confirmation')return {label:'内部处理已暂停',detail:'当前记录不属于首稿前的提纲审校节点。无需手工修改草稿；接续后由系统核验保存状态并继续内部处理。'};
  if(run.status==='completed'||run.status==='limited')return {label:run.status==='limited'?'已交付 · 保留边界':'已交付',detail:'正式成果已保存，可在成果区查看与下载。'};
  if(saved&&canContinueDraft(run,saved))return {label:run.status==='cancelled'&&saved.id!==run.id?'已停止 · 此前稿件已保存':'稿件已保存 · 等待接续',detail:`${saved.id===run.id?'本轮':'同一研究此前'}稿件 ${saved.draft!.length} 字符，尚未作为本轮正式成果交付。${failure?`本轮停在：${failure.stage}。`:''}`};
  if(saved)return {label:run.status==='cancelled'?'已停止':'执行未完成',detail:`同一研究的旧稿可查看；当前要求需重新评估，不能据此认定旧稿可直接接续。停止位置：${failure?.stage??run.stage}。`};
  if(run.outline)return {label:'论证清单已保存 · 待成稿',detail:`本轮停在：${failure?.stage??run.stage}。接续将先核验已有清单与资料。`};
  return {label:run.status==='cancelled'?'已停止':run.status==='interrupted'?'运行已中断':'执行未完成',detail:`停止位置：${failure?.stage??run.stage}。已有资料保留，不会自动继续。`};
}

const terminalStage=/^(?:执行失败|已停止|成果已保存|服务关闭|运行已中断|准备开始)/;
const researchStage=/^(?:理解目标|读取证据|阅读摘要|按摘要判断|分篇研读|根据已读|同步修订|生成指定|保留原文|对照原文|自动审查|按实质问题|复查修订|逐条核验|生成可编辑|仅筛选|仅获取|正文尚差)/;
export function runFailure(run:Run){
  if(!['failed','interrupted','cancelled'].includes(run.status))return undefined;
  const stage=run.failure?.stage||(!terminalStage.test(run.stage)&&run.stage?run.stage:undefined)||[...run.events].reverse().find(event=>event.type==='progress'&&researchStage.test(event.message))?.message||'未记录具体阶段';
  const detail=run.failure?.message||run.error||'';
  let evidenceShortage=false;
  let reason=run.status==='cancelled'?'已按你的操作停止。':run.status==='interrupted'?'执行过程被中断，已保存的资料仍保留。':'本轮执行未完成，已保存的资料仍保留。';
  if(/\b402\b|insufficient.?balance|余额不足/i.test(detail))reason='模型服务余额不足，本轮已结束；处理余额后可手动接续。';
  else if(/\b401\b|invalid.?api.?key|unauthorized/i.test(detail))reason='模型或来源服务未通过身份验证，请检查相应配置后手动接续。';
  else if(/\b429\b|rate.?limit/i.test(detail))reason='服务暂时限制请求频率，本轮已结束，可稍后手动接续。';
  else if(/timeout|timed.?out|超时/i.test(detail))reason='本轮请求超时，未完成的步骤已停止。';
  else if(/可用|可用于|可支持|最低|至少|门槛/.test(detail)&&/文献|正文|证据|篇/.test(detail)){evidenceShortage=true;reason='现有证据尚未达到成文条件；这不等于只检索到了这些文献。';}
  const resumePoint=/研读|摘录|笔记/.test(stage)?'接续时先核验已保存的研读记录，再处理尚未完成或未通过校验的部分。':/审查|复查|修订|同步/.test(stage)?'接续时先核验已保存的稿件与论证清单，再处理未完成的修订或审查。':/生成可编辑|原文/.test(stage)&&Boolean(run.draft)?'接续时先核验已保存的稿件，再处理原文核验或文件生成。':'接续时会先核验已保存的进度，再按当前研究要求继续处理。';
  return {stage,reason,detail,resumePoint,evidenceShortage};
}

/** Conservative display hint only; the engine performs authoritative identity and relevance checks. */
function hasUnscreenedContent(run:Run):boolean {
  const keys=(source:Evidence)=>{
    const doi=source.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').trim().toLowerCase();
    const title=source.title.trim().toLowerCase().replace(/\s+/g,' ');
    const abstract=(source.abstract??(source.readScope==='abstract'?source.text:'')).trim().replace(/\s+/g,' ');
    let url='';try{if(source.url){const parsed=new URL(source.url);parsed.hash='';url=parsed.href.replace(/\/$/,'');}}catch{/* An invalid URL cannot establish identity. */}
    return [`id:${source.id}`,...(doi?[`doi:${doi}`]:[]),...(title?[`title:${title}`]:[]),...(url?[`url:${url}`]:[]),...(abstract.length>=240?[`abstract:${abstract}`]:[])];
  };
  const known=new Set(run.evidence.filter(external).flatMap(keys));
  for(const id of [...run.screening?.includedIds??[],...(run.screening?.excluded??[]).map(item=>item.id)])known.add(`id:${id}`);
  return (run.retrieval?.pendingEvidence??[]).some(source=>(source.readScope==='abstract'||source.readScope==='full_text')&&Boolean((source.abstract?.trim()?source.abstract:source.readScope==='abstract'?source.text:'').trim())&&!keys(source).some(key=>known.has(key)));
}

export function runContinuation(run:Run,options:{hasDraft?:boolean;hasChanges?:boolean}={},runs:readonly Run[]=[run]){
  const failure=runFailure(run);if(!failure)return undefined;
  const candidateDraft=savedDraftForRun(run,runs),savedDraft=candidateDraft&&canContinueDraft(run,candidateDraft)?candidateDraft:undefined;
  const batchPending=run.retrievalExpansion&&run.retrievalExpansion.stage!=='complete';
  const laterStage=/研读|摘录|笔记|审查|复查|修订|生成/.test(failure.stage)||/研读后/.test(failure.detail);
  const hostReadingShortage=failure.detail.startsWith('研读后的可用证据不足：');
  const canScreen=failure.evidenceShortage&&(!laterStage||hostReadingShortage)&&!run.outline&&!run.draft?.trim()&&!batchPending&&hasUnscreenedContent(run);
  const label=options.hasDraft?'提交补充并接续':options.hasChanges?'应用设置并接续':savedDraft?'继续处理并交付':run.outline?'继续生成稿件':canScreen?'继续筛选剩余候选':'从已保存的进度接续';
  const nextStep=options.hasDraft||options.hasChanges?'将先接收本次补充或设置，再核验哪些已有记录可按新要求复用。'
    :savedDraft?'已有同一份完整稿件可选查看。接续时先核验当前要求与稿件、研读缓存是否匹配；已完成且仍有效的检查会复用，只处理未完成步骤或受变更影响的内容，不另起一份稿件或固定重复整篇审校。'
    :run.outline?'论证清单已保存；接续时先核验清单和研究资料，再进入成稿与复查。'
    :canScreen?`还有 ${run.retrieval!.pendingEvidence!.length} 条待处理记录（可能包含仅书目信息）。接续后系统先核验已有进度，再自动按缺口处理剩余候选，不保证这些候选全部合格或一定达到篇数要求。已有通过校验的筛选和正文记录可复用；可执行的内部步骤会自动继续。`
    :batchPending?'将先核验当前补充批次的保存状态，处理其未完成步骤；不会据剩余候选数承诺已经补齐。'
    :failure.resumePoint;
  return {failure,label,nextStep,counts:progressCounts(run)};
}

export function retrievalLink(value:string):string|undefined{
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}
}
