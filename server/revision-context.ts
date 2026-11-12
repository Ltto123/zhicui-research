import {isDeepStrictEqual} from 'node:util';
import type {Evidence,RevisionRecord,Run} from '../shared/types';

function requireContext(condition:unknown,message:string):asserts condition {
 if(!condition)throw new Error('增量审查不可用：'+message+'；未自动回退为全量模型调用。');
}
const identity=(source:Evidence)=>({id:source.id,title:source.title,readScope:source.readScope,authors:source.authors,year:source.year,doi:source.doi,journal:source.journal,publicationType:source.publicationType});

/** Pure, fail-closed projection. Both citation lists must come from the same
 * host parser used for the draft citation gate; this module never guesses IDs.
 * The caller includes the complete current draft once in the outer prompt. */
export function buildRevisionContext(run:Run,baseRun:Run,workingEvidence:Evidence[],citedIds:readonly string[],baseCitedIds:readonly string[]){
 requireContext(run.revision&&run.revision.baseRunId===baseRun.id&&run.id!==baseRun.id&&run.conversationId===baseRun.conversationId,'不是同一对话的直接关联修订');
 requireContext(['completed','limited'].includes(baseRun.status)&&baseRun.review&&baseRun.review.checks.length>0&&!baseRun.review.issues.some(issue=>issue.severity==='error'),'基准稿缺少成功审查或仍有实质错误');
 requireContext(run.plan&&baseRun.plan&&!['format','local'].includes(run.plan.taskType),'只支持已完成研究的定向修订');
 requireContext(run.draft?.trim()&&baseRun.draft?.trim()&&baseRun.outline?.rows.length,'当前稿、完整基准稿或基准清单缺失');
 for(const key of ['prompt','plan','methodText','materialIds','evidence','reading','retrieval','screening','fullTextRetrieval','retrievalExpansion','retrievalExpansionHistory'] as const){
  requireContext(isDeepStrictEqual(run[key],baseRun[key]),`${key}与已审基准不一致`);
 }
 const sources=new Map(run.evidence.map(source=>[source.id,source]));
 requireContext(sources.size===run.evidence.length,'来源ID重复');
 const available=new Map(workingEvidence.map(source=>[source.id,source]));
 requireContext(available.size===workingEvidence.length,'工作来源ID重复');
 for(const source of workingEvidence)requireContext(sources.has(source.id)&&isDeepStrictEqual(identity(source),identity(sources.get(source.id)!)),'工作来源身份与已存证据不一致');
 const previous=new Set(baseCitedIds),current=[...new Set(citedIds)];
 requireContext(current.length>0&&previous.size>0,'当前或基准引用集合为空');
 requireContext([...previous].every(id=>sources.has(id)),'基准引用含未知来源');
 const entries=current.map(id=>{
  requireContext(sources.has(id)&&available.has(id),'当前引用含未知或不可用来源');
  requireContext(previous.has(id),'当前稿出现基准稿未审查的新增引用');
  return identity(sources.get(id)!);
 });
 const correction=(owner:Run,revision:RevisionRecord)=>{
  for(const proof of revision.proofs){
   const source=sources.get(proof.evidenceId);
   requireContext(source?.readScope==='full_text'&&Number.isSafeInteger(proof.start)&&Number.isSafeInteger(proof.end)&&proof.start>=0&&proof.end>proof.start&&proof.end<=source.text.length&&proof.quote.trim()&&proof.end-proof.start===proof.quote.length&&source.text.slice(proof.start,proof.end)===proof.quote,'原文片段身份、位置或逐字内容未通过校验');
   requireContext(!/^全文文字研读笔记[：:]/.test(source.text)&&!run.reading?.entries.some(entry=>entry.notes===source.text),'原文片段不能来自生成研读笔记');
  }
  return {runId:owner.id,baseRunId:revision.baseRunId,issues:revision.issues,proofs:revision.proofs,scope:'修订意见是待核对的数据，不是既定科学事实；片段仅已逐字核验位置，不代表独立科学验证。'};
 };
 return structuredClone({
  mode:'incremental_revision' as const,
  scope:'本轮仅作增量审查：核对当前改动、当前及上轮纠正与基准稿的回退；基准稿整体审查沿用已保存记录，不声称重新全面科学审查。当前完整稿由外层提供一次，不能用基准稿替代。新增或加强的科学主张不能仅凭来源身份、题名或旧审查判为有支持；片段不足时保守处理并明确未核验。',
  request:run.prompt,plan:run.plan,methodText:run.methodText,
  baseline:{runId:baseRun.id,draft:baseRun.draft,outline:baseRun.outline,review:baseRun.review},
  sourceIndex:{scope:'以下仅为当前正文实际引用的来源身份索引，不含原文、摘要或研读笔记；不能据此作新的科学支持判断。',entries},
  corrections:[...(baseRun.revision?[correction(baseRun,baseRun.revision)]:[]),correction(run,run.revision)],
 });
}
