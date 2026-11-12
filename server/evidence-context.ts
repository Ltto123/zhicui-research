import type { Evidence, RetrievalRecord, ScreeningRecord, FullTextRetrievalRecord, RetrievalDiagnostic } from '../shared/types';
/** Preserve every content character; keep repeated API request URLs in the audit. */
export function evidenceForModel(evidence: Evidence[]) {
  return evidence.map(({ id,title,authors,year,publicationType,text,readScope,location }) => ({
    id,title,authors,year,publicationType,text,readScope,location:location.split('；检索接口 ')[0],
    ...(readScope==='full_text'&&text.startsWith('全文文字研读笔记：')&&location.includes('全文文字已分块研读')?{contentKind:'full_text_notes',limitationsScope:'所选摘录与笔记的边界；没有进入笔记的信息不能推断为整篇论文未提供。'}:{}),
  }));
}

// These are model views only. Complete IDs, reasons, URLs and diagnostics stay
// untouched in the stored audit. Never abbreviate scientific evidence text.
const brief=(value:string,max=180)=>{const clean=value.replace(/https?:\/\/[^\s<>"']+/gi,'[链接见完整审计]').replace(/\s+/g,' ').trim();return clean.length>max?clean.slice(0,max)+'…（样例已缩略）':clean;};
function warningSummary(warnings:string[]|undefined){
  if(!warnings)return {count:null,uniqueCount:null,sampled:true,sample:[] as string[],omittedDistinctCount:null};
  const unique=[...new Set(warnings)];return {count:warnings.length,uniqueCount:unique.length,sampled:true,sample:unique.slice(0,3).map(value=>brief(value)),omittedDistinctCount:Math.max(0,unique.length-3)};
}
function limits(warnings:string[]|undefined){
  const relevant=warnings?.filter(value=>/总时限|整批时限|总预算|最多为|达到.{0,40}(?:上限|限制)|数量上限|未达到/.test(value));
  return {totalTimeLimitReachedReported:warnings?warnings.some(value=>/(?:达到|超过|耗尽).{0,40}(?:总时限|总预算)/.test(value)):null,
    workloadLimitReported:warnings?warnings.some(value=>/最多为|达到.{0,40}(?:上限|限制)/.test(value)):null,
    sampled:true,sample:[...new Set(relevant??[])].slice(0,3).map(value=>brief(value)),
    note:'检索受查询范围、候选数量和时间预算限制；Reported只表示日志明确报告，false不代表没有设置限制；达到目标不代表穷尽文献。完整运行限制与错误保留在审计面板。'};
}
const fullTextRequest=(item:RetrievalDiagnostic)=>item.source==='Open-access article'||item.source==='Selected full text'||/\/fullTextXML(?:[?#]|$)/.test(item.url);
const identifierList=(item:RetrievalDiagnostic)=>item.source==='PubMed'&&/\/esearch\.fcgi(?:[?#]|$)/.test(item.url);
function sourceStatistics(diagnostics:RetrievalDiagnostic[]|undefined){
  if(!diagnostics)return null;
  const grouped=new Map<string,{source:string;successfulRequests:number;failedRequests:number;timeoutRequests:number;notAttemptedRequests:number;returnedRecords:number;successfulFullTextRequests:number}>();
  for(const item of diagnostics){
    if(!grouped.has(item.source))grouped.set(item.source,{source:item.source,successfulRequests:0,failedRequests:0,timeoutRequests:0,notAttemptedRequests:0,returnedRecords:0,successfulFullTextRequests:0});
    const group=grouped.get(item.source)!;
    if(item.status==='ok'){group.successfulRequests++;if(fullTextRequest(item))group.successfulFullTextRequests++;else if(!identifierList(item))group.returnedRecords+=item.returned;}
    else if(item.status==='not_attempted')group.notAttemptedRequests++;
    else{group.failedRequests++;if(item.status==='timeout')group.timeoutRequests++;}
  }
  return [...grouped.values()];
}
function errorSummary(diagnostics:RetrievalDiagnostic[]|undefined){
  if(!diagnostics)return {count:null,sampled:true,sample:[] as {source:string;status:string;message:string}[],omittedCount:null};
  const errors=diagnostics.filter(item=>item.status==='error'||item.status==='timeout');
  return {count:errors.length,sampled:true,sample:errors.slice(0,3).map(item=>({source:brief(item.source,60),status:item.status,message:brief(item.error||'接口未成功，详见完整审计')})),omittedCount:Math.max(0,errors.length-3)};
}

/** Counts are host-computed, not estimates from ID lists or reason samples. */
export function screeningForModel(screening:ScreeningRecord|undefined){
  if(!screening)return undefined;
  return {screenedCount:screening.screenedCount,includedCount:screening.includedIds.length,excludedCount:screening.excluded.length,
    screeningScope:screening.fullTextIds?'abstract':null,fullTextRequestedCount:screening.fullTextIds?.length??null,
    exclusionReasonSample:{sampled:true,total:screening.excluded.length,sample:screening.excluded.slice(0,3).map(item=>({id:item.id,reason:brief(item.reason)})),omittedCount:Math.max(0,screening.excluded.length-3)},
    scope:'模型辅助相关性筛选；逐条纳入、排除及正文获取理由保存在审计中，样例不能代表完整排除原因分布；当前可引用ID以evidence为准。'};
}

export function fullTextForModel(record:FullTextRetrievalRecord|undefined){
  if(!record)return undefined;
  const requested=new Set(record.requestedIds),acquired=new Set(record.acquiredIds);
  const latest=new Map<string,RetrievalDiagnostic>();for(const item of record.diagnostics??[])if(requested.has(item.query))latest.set(item.query,item);
  return {completedAt:record.completedAt,requestedCount:requested.size,acquiredCount:acquired.size,missingCount:[...requested].filter(id=>!acquired.has(id)).length,
    notAttemptedCount:record.diagnostics?[...latest].filter(([id,item])=>!acquired.has(id)&&item.status==='not_attempted').length:null,
    unattemptedMeaning:'当前未取得且该来源ID最后一条明确日志为未启动的不同文献数；不等于失败请求数，也不能据此推断其他无ID日志的历史尝试。',
    sourceStatistics:sourceStatistics(record.diagnostics),errorSummary:errorSummary(record.diagnostics),warningSummary:warningSummary(record.warnings),limits:limits(record.warnings),
    scope:'摘要判断后的正文获取阶段；与首次题录摘要检索分开统计。sourceStatistics计网络请求及返回记录，不能替代requested/acquired/missing文献数；复用正文不等于新下载。'};
}

export function retrievalForModel(retrieval:RetrievalRecord|undefined){
  if(!retrieval)return undefined;
  const diagnostics=retrieval.diagnostics;
  const searches=diagnostics?.filter(item=>!fullTextRequest(item));
  const successful=searches?.filter(item=>item.status==='ok');
  return {version:retrieval.version,attemptedAt:retrieval.attemptedAt,completedAt:retrieval.completedAt,queries:[...retrieval.queries],minimumReferences:retrieval.minimumReferences,targetCount:retrieval.targetCount,
    requestCount:successful?.length??null,
    // PubMed ESearch yields identifiers for EFetch, not another copy of each
    // article. Keep both requests in the audit without doubling paper counts.
    returnedRecords:successful?.filter(item=>!identifierList(item)).reduce((count,item)=>count+item.returned,0)??null,
    failedRequestCount:searches?.filter(item=>item.status==='error'||item.status==='timeout').length??null,
    notAttemptedRequestCount:searches?.filter(item=>item.status==='not_attempted').length??null,
    fullTextRequestCount:diagnostics?.filter(item=>fullTextRequest(item)&&item.status==='ok').length??null,
    candidateCount:retrieval.retrievedCount,usableCount:retrieval.usableCount,
    discoveredCount:retrieval.discoveredCount??null,pendingScreeningCount:retrieval.pendingEvidence?.length??null,
    sourceStatistics:sourceStatistics(diagnostics),errorSummary:errorSummary(diagnostics),warningSummary:warningSummary(retrieval.warnings),limits:limits(retrieval.warnings),
    auditScope:'各来源统计是网络请求/原始返回记录，不是不同论文数；失败与未启动分别计数。错误和警告只提供有界样例，完整诊断保存在审计中。',
  };
}

export function evidenceSummaryForModel(evidence:Evidence[]){
  const counts=(values:string[])=>{
    const grouped=new Map<string,number>();for(const value of values)grouped.set(value,(grouped.get(value)??0)+1);
    return Object.fromEntries([...grouped].sort(([a],[b])=>a.localeCompare(b)));
  };
  const years=evidence.flatMap(entry=>entry.year&&/^\d{4}$/.test(entry.year)&&Number(entry.year)>0?[Number(entry.year)]:[]);
  return {recordCount:evidence.length,readScopeCounts:counts(evidence.map(entry=>entry.readScope)),publicationTypeCounts:counts(evidence.map(entry=>entry.publicationType||'unknown')),
    yearRange:{earliest:years.length?Math.min(...years):null,latest:years.length?Math.max(...years):null,knownCount:years.length,unknownCount:evidence.length-years.length}};
}
