import {ArrowUpRight,ChevronDown,FileCheck2} from 'lucide-react';
import type {Artifact,Run} from '../../shared/types';
import {awaitingWritingOutline,deriveRunProgress,progressCounts,recentAgentSteps,retrievalLink,runContinuation,runStageSummary,savedDraftForRun} from '../lib/run-progress';
import {CopyMessageButton} from './CopyMessageButton';
import {Markdown} from './Markdown';
import {currentRun} from '../lib/current-run';
import styles from './ResearchProgress.module.css';

export function AgentExecutionSummary({run}:{run:Run}){
  const agent=run.agent;if(!agent)return null;
  const count=(value:number)=>Number.isSafeInteger(value)&&value>=0?String(value):'—';
  const running=run.status==='running'||run.status==='queued';
  const delivered=run.status==='completed'||run.status==='limited';
  const steps=recentAgentSteps(run),issues=run.review?.issues.filter(issue=>issue.severity==='error')??[];
  const recordedTime=(value:string)=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'时间未记录';};
  return <section className="saved-progress-note" aria-label="持续研究执行状态">
    <details className={styles.records}><summary>查看执行记录<ChevronDown size={12}/></summary>
    <strong>持续研究模式</strong>
    {agent.lastAction&&<p>{running?'当前动作':'最近动作'}：{agent.lastAction}</p>}
    <p>本次模型调用 {`${count(agent.calls)} / ${count(agent.callLimit)} 次`}（含决策与研究步骤，不是金额，也不是完成百分比）。</p>
    {running&&<p>系统自动执行研究、修订和复查；当前无需你逐项处理。</p>}
    {steps.length>0&&<div className="agent-recent-steps"><strong>最近执行步骤</strong><ol>{steps.map((step,index)=><li key={`${step.action}-${step.at}-${index}`}><span>{step.status==='ok'?'已完成':step.status==='error'?'遇到问题':running&&index===steps.length-1?'处理中':'已记录开始'}</span><p>{step.message}</p><time dateTime={Number.isFinite(Date.parse(step.at))?step.at:undefined}>{recordedTime(step.at)}</time></li>)}</ol></div>}
    {running&&issues.length>0&&<div className="agent-review-summary"><strong>上次自动审查：{issues.length} 项实质问题</strong><p>以下是上次保存的审查结果，不表示这些问题仍未修改或已解决；处理结果以最新核对记录为准。系统按实际变更范围核对，无需手工逐项修改。</p><ul>{issues.slice(0,3).map((issue,index)=><li key={index}><strong>{issue.location}：</strong>{issue.issue}</li>)}</ul>{issues.length>3&&<p>这里只列出前 3 项；全部问题见下方自动审查记录。</p>}</div>}
    {delivered&&agent.pauseReason&&<p>此前暂停原因：{agent.pauseReason}</p>}
    {delivered&&agent.nextAction&&<p>此前接续安排：{agent.nextAction}</p>}
    </details>
  </section>;
}

export function ResearchProgress({run,runs,artifacts,onArtifact}:{run:Run;runs:readonly Run[];artifacts:readonly Artifact[];onArtifact?:(artifact:Artifact)=>void}){
  const progress=deriveRunProgress(run,runs),savedIds=new Set([run.id,...progress.ancestorIds]);
  const savedArtifacts=artifacts.filter(artifact=>savedIds.has(artifact.runId));
  const prior=progress.inheritedFrom,savedDraft=savedDraftForRun(run,runs);
  const draftDelivered=savedDraft&&artifacts.some(artifact=>artifact.runId===savedDraft.id);
  const draftErrors=savedDraft?.review?.issues.filter(issue=>issue.severity==='error').length??0;
  const running=run.status==='running'||run.status==='queued';
  const needsAttention=!running&&run.status!=='completed'&&run.status!=='limited';
  const counts=progressCounts(progress.displayRun);
  const progressText=progress.awaitingHandoff?'此前研究资料已保存。':counts.readingComplete!==undefined&&counts.readingComplete>0?`已研读${counts.readingComplete}篇文献`:counts.fullText>0?`已取得${counts.fullText}篇正文`:counts.candidates>0?`已保存${counts.candidates}条候选记录`:'';
  const draftLabel=draftDelivered?'已交付成果对应的工作稿':running?'自动保存的过程稿':draftErrors?'未通过复查的草稿':'未正式交付的草稿';
  return <>
    {running&&progressText&&<p className={styles.progress}>{progressText}</p>}
    {needsAttention&&run.agent?.pauseReason&&<p><strong>暂停原因：</strong>{run.agent.pauseReason}</p>}
    {needsAttention&&run.agent?.nextAction&&<p><strong>下一步：</strong>{run.agent.nextAction}</p>}
    <details className={styles.records}><summary>查看研究进度<ChevronDown size={12}/></summary>
    <AgentExecutionSummary run={run}/>
    {savedDraft&&<details id={`saved-draft-${savedDraft.id}`} className={styles.records} aria-label="已保存草稿"><summary>查看已保存草稿（可选）<ChevronDown size={12}/></summary>
      <strong>{draftLabel}</strong><p>{savedDraft.id===run.id?'本轮保存':'来自同一研究此前任务'} · {savedDraft.draft!.length} 字符。{draftDelivered?'正式文件请从已保存成果入口下载。':'这是同一文稿的自动保存版本，尚未正式交付；以当前审查与交付状态为准。'}</p>
      <p>{running?'系统会自动处理内部修订，无需手工改写；可选查看过程稿。':'查看过程稿是可选操作，不要求你手工修改；接续入口会说明实际停止原因。'}</p>
      <p>已保存研读笔记 {progressCounts(savedDraft).savedReadings} 篇（保存数量，不表示本轮已重新核验）。{draftErrors>0?`上次审查记录有 ${draftErrors} 项待复查，不代表当前稿的最终审查结果。`:!savedDraft.review?'草稿复查尚未完成。':''}</p>
      <p>展示自动保存的完整过程稿，保留来源 ID。查看、复制和下载不会启动任务或调用模型。</p>
        <div className="saved-draft-actions"><CopyMessageButton text={savedDraft.draft!}/><a href={`data:text/markdown;charset=utf-8,${encodeURIComponent(savedDraft.draft!.toWellFormed())}`} download={`草稿-${savedDraft.id}.md`}>下载草稿 Markdown</a></div>
        <div className="saved-draft-preview"><Markdown text={savedDraft.draft!} preferredRunId={savedDraft.id} sources={savedDraft.evidence.map(source=>({runId:savedDraft.id,id:source.id,doi:source.doi,url:source.url,fullTextUrls:source.fullTextUrls}))}/></div>
    </details>}
    {prior&&<details className={styles.records} aria-label="此前保存的研究进度"><summary>查看此前保存进度<ChevronDown size={12}/></summary>
      <strong>此前已保存的研究进度仍在</strong>
      {progress.awaitingHandoff?<p>本轮尚未接入此前记录。下方展示上轮已保存的资料，不代表本轮重新检索，也不表示已完成本轮复用校验。</p>:<p>下方统计本轮当前保存的资料，可能包含沿用的记录，不等于本轮新检索或新下载的数量。</p>}
      <p>{prior.draft?.trim()?'此前正文草稿已保存。':prior.outline?'此前论证清单已保存。':'此前资料已保存。'}{!progress.awaitingHandoff&&` 上轮保存候选 ${progressCounts(prior).candidates} 条、正文 ${progressCounts(prior).fullText} 篇。`}</p>
    </details>}
    {savedArtifacts.length>0&&<details className="saved-artifacts"><summary>查看已保存成果（{savedArtifacts.length} 份）<ChevronDown size={12}/></summary><p>此前成果仍可打开；本轮接续不会把旧成果视为新成果。</p>{savedArtifacts.map(artifact=><button key={artifact.id} className="text-button" disabled={!onArtifact} onClick={()=>onArtifact?.(artifact)}><FileCheck2 size={15}/>{artifact.title}<span>{artifact.formats.map(format=>format.toUpperCase()).join(' / ')}</span><ArrowUpRight size={13}/></button>)}</details>}
    <RetrievalSummary run={progress.displayRun} inherited={progress.awaitingHandoff} currentMinimum={run.plan?.minimumReferences}/>
    {run.events.length>0&&<details className={styles.records}><summary>查看任务记录<ChevronDown size={12}/></summary><ul>{run.events.map((event,index)=><li key={index}>{event.message}</li>)}</ul></details>}
    {run.review&&<details className="review-details"><summary>查看上次自动审查记录<ChevronDown size={12}/></summary><ul>{run.review.checks.map((check,index)=><li key={index}>{check}</li>)}{run.review.issues.map((issue,index)=><li key={`issue-${index}`}><strong>{issue.location}：</strong>{issue.issue} {issue.suggestion}</li>)}</ul>{run.review.limitations.length>0&&<p>{run.review.limitations.join('；')}</p>}<small>这是上次保存的审查记录，内部问题由系统自动处理；不等于当前稿已通过复查，也不等同于科学结论已被独立验证。</small></details>}
    </details>
  </>;
}

export function RunContinuation({run,runs=[run],hasDraft=false,hasChanges=false,disabled=false,onResume,showAction=true}:{run:Run;runs?:readonly Run[];hasDraft?:boolean;hasChanges?:boolean;disabled?:boolean;onResume:()=>void;showAction?:boolean}){
  const continuation=runContinuation(run,{hasDraft,hasChanges},runs);if(!continuation)return null;
  const {failure,counts,label,nextStep}=continuation;
  const hasSnapshot=counts.candidates>0||Boolean(run.retrieval?.completedAt);
  return <section className="run-failure-explanation" aria-label="本轮停止原因与接续位置">
    <p><strong>{run.status==='cancelled'?'停止位置':'未完成阶段'}：</strong>{failure.stage}</p>
    <p>{failure.reason}</p>{failure.detail&&<p className="run-error"><strong>具体原因：</strong>{failure.detail}</p>}
    <details className={styles.records}><summary>查看保存进度与接续安排<ChevronDown size={12}/></summary>
    {hasSnapshot?<p>本轮已保存：候选 {counts.candidates} 条；{counts.related===undefined?'相关保留数待核验':`相关保留 ${counts.related} 篇`}；正文 {counts.fullText} 篇；{counts.readingComplete===undefined?'研读完成数待核验':`研读完成 ${counts.readingComplete} 篇`}。{counts.writingReady===undefined?'可用于成文的数量待核验。':`可用于成文 ${counts.writingReady} 篇。`}</p>:<p>本轮候选快照尚未保存，不能据此判断已有研究进度为零；此前记录如有保存，可在上方查看。</p>}
    <p><strong>下一步：</strong>{nextStep}</p></details><p>本轮已停止，不会自动继续或重试。</p>
    {showAction&&currentRun(runs.filter(item=>item.conversationId===run.conversationId))?.id===run.id&&<button className="text-button" disabled={disabled} onClick={onResume}>{label}<ArrowUpRight size={15}/></button>}
  </section>;
}

export function RunStageStatus({run,runs,hasDraft=false,hasChanges=false,disabled=false,onResume}:{run:Run;runs:readonly Run[];hasDraft?:boolean;hasChanges?:boolean;disabled?:boolean;onResume:()=>void}){
  const latest=currentRun(runs.filter(item=>item.conversationId===run.conversationId));
  // A historical component may keep rendering during reconciliation; its
  // callback still belongs to the old run, so it must not approve the new one.
  if(latest&&latest.id!==run.id){const stage=runStageSummary(latest,runs);return <section className="composer-stage" aria-label="当前任务阶段" aria-live="polite"><div><strong>当前阶段：{stage.label}</strong><p>{stage.detail}</p></div></section>;}
  const stage=runStageSummary(run,runs),continuation=runContinuation(run,{hasDraft,hasChanges},runs);
  const label=run.status==='awaiting_confirmation'?(hasDraft?(awaitingWritingOutline(run)?'提交提纲调整意见':'提交补充并继续'):hasChanges?'应用设置并继续':awaitingWritingOutline(run)?'提纲已审校，继续成稿':'继续自动处理'):continuation?.label;
  return <section className="composer-stage" aria-label="当前任务阶段" aria-live="polite">
    <div><strong>当前阶段：{stage.label}</strong><p>{stage.detail}</p></div>
    {label&&<div className="composer-stage-actions"><button className="primary-button" disabled={disabled} onClick={onResume}>{label}<ArrowUpRight size={14}/></button></div>}
  </section>;
}

export function RetrievalSummary({run,inherited=false,currentMinimum}:{run:Run;inherited?:boolean;currentMinimum?:number}){
  const retrieval=run.retrieval,counts=progressCounts(run),expansion=run.retrievalExpansion;
  if(!retrieval&&counts.candidates===0)return null;
  const running=run.status==='running'||run.status==='queued';
  const acquiredIds=new Set(run.evidence.filter(item=>item.readScope==='full_text'&&item.text.trim()).map(item=>item.id));
  const diagnostics=[...(retrieval?.diagnostics??[]),...(expansion?.retrieval?.diagnostics??[]),...(run.fullTextRetrieval?.diagnostics??[])];
  const errors=diagnostics.filter(item=>item.status==='error'||item.status==='timeout');
  const discovery=retrieval;
  const minimum=currentMinimum??(!inherited?run.plan?.minimumReferences:undefined);
  const counters=<dl className="retrieval-counts research-pipeline">
      <div><dt>候选入库</dt><dd>{counts.candidates}</dd></div><div><dt>相关保留</dt><dd>{counts.related??'—'}</dd></div>
      <div><dt>正文已取</dt><dd>{counts.fullText}</dd></div><div><dt>研读完成</dt><dd>{counts.readingComplete??'—'}</dd></div><div><dt>可用于成文</dt><dd>{counts.writingReady??'—'}</dd></div>
    </dl>;
  return <section className="retrieval-summary" aria-label={inherited?'此前保存的文献进度':'本轮文献处理进度'}>
    <details className={styles.records}><summary>{inherited?'查看此前文献处理记录':'查看文献处理记录'}<ChevronDown size={12}/></summary>
    {counters}
    <p>候选入库 → 相关性筛选 → 获取正文 → 研读核验 → 成文。各阶段数量不能互相替代；“可用于成文”不是检索总数，也不等于最终引用数。</p>
    {counts.readingComplete===undefined&&<p>已保存研读记录 {counts.savedReadings} 篇；当前记录未提供最终研读核验数，显示“—”而非零。可成文数量{counts.writingReady===undefined?'待核验':'以已保存核验结果为准'}。</p>}
    <p>当前保存摘要 {counts.abstracts} 篇、正文 {counts.fullText} 篇、仅书目信息 {counts.metadata} 条。相关性保留不等于已读全文；仅书目信息不能支持研究结论。</p>
    {discovery?.rawReturnedCount!==undefined||discovery?.discoveredCount!==undefined?<p>首轮检索：{discovery.rawReturnedCount!==undefined?`来源原始返回 ${discovery.rawReturnedCount} 条（可能重复）；`:''}{discovery.discoveredCount!==undefined?`汇总去重发现 ${discovery.discoveredCount} 条；`:''}首批候选 {retrieval!.retrievedCount} 条。{discovery.pendingEvidence===undefined&&discovery.discoveredCount!==undefined&&discovery.discoveredCount>retrieval!.retrievedCount?`其中 ${discovery.discoveredCount-retrieval!.retrievedCount} 条未进入首批候选（历史差额）；当前待处理数量未记录，不能据此判为不相关。`:''}</p>:<p>候选数只统计工作台已保存的记录，不代表数据库全部命中；旧记录未保存截取候选池之前的完整去重数量。</p>}
    {retrieval?.pendingEvidence!==undefined&&<p>尚有 {retrieval.pendingEvidence.length} 条已发现候选待后续处理，不计入上方当前候选池，也不等于已排除文献。</p>}
    <p>{minimum===undefined?'当前引用篇数要求尚未记录，历史检索目标不能替代本轮要求。':minimum===0?'当前按已有有效证据成文，不设固定引用篇数；不相关或无支持资料仍不能计入。':`当前要求至少 ${minimum} 篇有效参考引用，成稿后还会核验实际引用。`}{retrieval&&!retrieval.completedAt&&running?'检索仍在进行，当前数量尚未定稿。':''}</p>
    {expansion&&<details className="retrieval-details"><summary>补充检索：新增 {expansion.candidateIds.length} 条候选，取得 {expansion.acquiredIds.length} 篇原文<ChevronDown size={12}/></summary><p>复用此前原文 {expansion.reusedIds.length} 篇；复用不算新下载。当前阶段：{{searching:'查找新摘要',screening:'筛选新摘要',fetching:'获取选中原文',complete:'补充阶段完成',failed:'补充阶段未完成'}[expansion.stage]}。</p>{expansion.error&&<p className="retrieval-warning">{expansion.error}</p>}{expansion.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
    {run.screening&&<details className="retrieval-details"><summary>相关性筛选：保留 {run.screening.includedIds.length} 篇，排除 {run.screening.excluded.length} 篇<ChevronDown size={12}/></summary><p>已检查 {run.screening.screenedCount} 篇；尚未筛选的候选不能计为排除。</p>{run.screening.includedReasons&&<details><summary>纳入依据</summary><ul>{Object.entries(run.screening.includedReasons).map(([id,reason])=><li key={id}>{run.evidence.find(item=>item.id===id)?.title||id}：{reason}</li>)}</ul></details>}<h4>排除依据</h4><ul>{run.screening.excluded.map(item=><li key={item.id}>{run.evidence.find(source=>source.id===item.id)?.title||item.id}：{item.reason}</li>)}</ul></details>}
    {run.screening?.fullTextIds&&<details className="retrieval-details"><summary>正文阅读安排：决定读取 {run.screening.fullTextIds.length} 篇，已取得 {run.screening.fullTextIds.filter(id=>acquiredIds.has(id)).length} 篇<ChevronDown size={12}/></summary><p>获取正文与研读核验分别记录；完整正文已保存不代表已有可用于写作的有效笔记。</p><ul>{Object.entries(run.screening.fullTextReasons??{}).map(([id,reason])=><li key={id}><strong>{run.evidence.find(item=>item.id===id)?.title||id}</strong>：{run.screening!.fullTextIds!.includes(id)?'需要正文':'本轮不读正文'}。{reason}{run.screening!.fullTextIds!.includes(id)&&`（${acquiredIds.has(id)?'正文已取得':'正文未取得'}）`}</li>)}</ul>{run.fullTextRetrieval?.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}
    {errors.length>0&&<p className="retrieval-warning">历史请求异常 {errors.length} 次，涉及 {new Set(errors.map(item=>item.source)).size} 个来源标签；重试可能已成功，不代表该数据库当前不可用。详情保留每次请求结果。</p>}
    {Boolean(retrieval?.warnings.length)&&<details className="retrieval-details"><summary>检索限制与提醒（{retrieval!.warnings.length}）<ChevronDown size={12}/></summary><ul>{retrieval!.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}
    {(retrieval||diagnostics.length>0)&&<details className="retrieval-details"><summary>查看检索式与请求记录<ChevronDown size={12}/></summary><h4>检索式</h4><ol>{retrieval?.queries.map((query,index)=><li key={index}>{query}</li>)}</ol><p>以下接口链接用于查看数据库机器响应，不是论文原文。点击会重新请求数据库，不是当时响应的快照；论文请从资料列表“打开原文”阅读。</p><h4>已保存的请求记录</h4>{diagnostics.length?<ul className="retrieval-diagnostics">{diagnostics.map((item,index)=><li key={`${item.source}-${index}`}><div><strong>{item.source}</strong><span className={item.status==='error'||item.status==='timeout'?'retrieval-warning':''}>{item.status==='ok'?`返回 ${item.returned} 条`:item.status==='not_attempted'?'尚未尝试':item.status==='timeout'?'请求超时':'请求失败'}</span></div><p>{item.query}</p><small>记录时间：{item.retrievedAt}</small>{item.error&&<p className="retrieval-warning">{item.error}</p>}{retrievalLink(item.url)&&<a href={retrievalLink(item.url)} target="_blank" rel="noopener noreferrer">重新打开数据库接口<ArrowUpRight size={11}/></a>}</li>)}</ul>:<p>{running?'请求记录尚未保存。':'未保存请求记录，不能据此解释为没有相关研究。'}</p>}</details>}
    </details>
  </section>;
}
