import type {Evidence,Run} from '../shared/types';
import {outlineForModel,revisionForModel,writingRequest} from './engine';
import {manuscriptBoundaryIssues} from './manuscript-boundary';

/** Callers supply the already verified writing corpus. Preserve the original
 * words supporting a claim, but not the transport location or reading log. */
export function manuscriptEvidence(run:Run,evidence:Evidence[]){
 const notes=new Map(run.reading?.entries.map(entry=>[entry.evidenceId,entry]));
 return evidence.map(source=>{
  const identity={id:source.id,title:source.title,authors:source.authors,year:source.year,journal:source.journal,doi:source.doi,publicationType:source.publicationType,readScope:source.readScope};
  if(source.readScope!=='full_text')return {...identity,text:source.text};
  const note=notes.get(source.id);
  if(!note||note.notes!==source.text)throw new Error('全文证据与已核验的研究笔记不匹配，不能据此撰写论文。');
  return {...identity,contentKind:'full_text_notes',basis:'配对引文为逐字原文。摘录未涵盖的内容不能推定为论文缺失。',
   findings:note.findings.map(({claim,quote,start,end})=>({claim,quote,start,end})),
   // Free-form note limitations may describe extraction, images, or chunk
   // coverage. Only source-anchored caveats belong in the author's material.
   evidenceCaveats:note.limitations.filter(text=>note.findings.some(({quote})=>quote.includes(text))&&!manuscriptBoundaryIssues(text).length)};
 });
}

/** These are identifiable literature searches, not downloads or request-log
 * statistics. An incomplete search history cannot establish a review flow. */
function methodSearches(run:Run){
 if(!run.plan||!['review','paper'].includes(run.plan.taskType))return;
 const methods=run.plan.methods,protocol=methods.instructions;
 const explicitProtocol=/(?:系统(?:性)?综述|范围综述|systematic review|scoping review|PRISMA)/i.test(protocol)&&/(?:检索式|纳排|纳入|检索日期|search strateg|eligibility criteria)/i.test(protocol)&&!/(?:不用|不做|不采用|不要|无需).{0,12}(?:系统综述|范围综述|PRISMA)/i.test(protocol);
 if(!(methods.mode!=='replace'&&methods.cardIds.includes('02'))&&!explicitProtocol)return;
 const records=[run.retrieval,...(run.retrievalExpansionHistory??[]).map(batch=>batch.retrieval),run.retrievalExpansion?.retrieval];
 const searches=new Map<string,{database:string;query:string;date?:string}>();
 for(const record of records){
  for(const item of record?.diagnostics??[]){
   if(item.status!=='ok'||!item.query.trim())continue;
   let url:URL;try{url=new URL(item.url);}catch{continue;}
   const database=databaseSearches.get(url.hostname.toLowerCase()+url.pathname.replace(/\/$/,''));
   if(!database)continue;
   const date=/^\d{4}-\d{2}-\d{2}T/.test(item.retrievedAt)?item.retrievedAt.slice(0,10):undefined;
   const search={database,query:item.query,date};searches.set(JSON.stringify(search),search);
  }
 }
 return searches.size?{searches:[...searches.values()],scope:'已记录的文献检索，可以说明文献选择方法。这些记录本身不证明检索穷尽、研究纳排流程完整或完成偏倚评价。'}:undefined;
}

const databaseSearches=new Map([
 ['api.openalex.org/works','OpenAlex'],['api.crossref.org/works','Crossref'],
 ['www.ebi.ac.uk/europepmc/webservices/rest/search','Europe PMC'],
 ['eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi','PubMed'],['export.arxiv.org/api/query','arXiv'],
]);

/** Some historic outlines combine a real scientific limitation with a
 * workspace diagnostic in the same row. Filter this author-only projection
 * at clause granularity. The original outline, audit and source quotes remain
 * available to the reviewer. */
function scholarlyOutlineText(value:string){
 const namedTransport=/(?:OpenAlex|Europe\s*PMC|PubMed|Crossref|arXiv).{0,18}(?:请求|接口|检索|下载).{0,12}(?:失败|超时|限速|上限)|(?:全文|正文)(?:获取|下载|请求|缺失).{0,12}\d+\s*(?:条|篇)|(?:检索|候选池).{0,12}(?:候选|结果|记录)上限|imagesVerified\s*=\s*false/i;
 const attribution=/(?:该研究|原研究|作者|研究人员|实验组|对照组|the study|researchers|experiment)/i;
 const readingLabel=/^\s*(?:图像未(?:经)?核验|(?:文献\s*)?E-[a-f\d]{6,}\s*仅(?:有)?摘要)\s*[。；;，,]?\s*$/i;
 return value.split(/(?<=[。！？；;，,\n])/u).filter(clause=>!readingLabel.test(clause)&&!manuscriptBoundaryIssues(clause).length&&(!namedTransport.test(clause)||attribution.test(clause))).join('').replace(/[；;，,\s]+$/u,'').trim();
}

export function genreMethodUse(run:Run){
 const plan=run.plan;if(!plan)return;
 if(plan.methods.mode==='replace')return `当前交付目标为《${plan.title}》：${plan.deliverable}。保留用户明确指定的替换方法及适用范围，按最新体裁组织各节。`;
 const priorGenre=plan.taskType!=='review'&&plan.methods.cardIds.some(id=>['01','02'].includes(id))||plan.taskType!=='paper'&&plan.methods.cardIds.includes('07');
 if(priorGenre){
  const sections=plan.taskType==='proposal'?'方案需给出研究问题、设计、时间安排与预期成果。':plan.taskType==='report'?'报告需围绕任务、资料依据、结果及其解释安排正文。':'各节按当前指定体裁组织论证。';
  return `当前交付目标为《${plan.title}》：${plan.deliverable}。原综述或技术论文方法卡服务于本稿的研究背景比较、证据判断和方法依据。${sections}`;
 }
}

export function manuscriptWritingContext(run:Run,evidence:Evidence[],outlineSourceIds:readonly string[]=evidence.map(source=>source.id)){
 const plan=run.plan,outline=outlineForModel(run);
 const ids=new Set(outlineSourceIds),revision=revisionForModel(run);
 const outlineRows=outline?.rows.map(row=>({section:scholarlyOutlineText(row.section),purpose:scholarlyOutlineText(row.purpose),claim:scholarlyOutlineText(row.claim),reasoning:scholarlyOutlineText(row.reasoning),limits:scholarlyOutlineText(row.limits),support:row.support,evidenceIds:row.evidenceIds.filter(id=>ids.has(id))})).filter(row=>row.section||row.claim||row.purpose);
 const writingSteps=plan?.workPlan.map(scholarlyOutlineText).filter(step=>step&&(run.pendingWritingTarget||/(研究问题|研究设计|目的|目标|解释|论证|实证|方法|背景|章节|贡献|分歧|时间表|预期成果|研究进度|研究结果|研究发现|结论|hypothes|interpret|discuss|method|aims?|findings|conclusion|timeline)/i.test(step)));
 return {request:writingRequest(run),plan:plan&&{question:plan.question,title:plan.title,deliverable:plan.deliverable,taskType:plan.taskType,methods:plan.methods,minimumReferences:plan.minimumReferences,writingSteps},methodText:run.methodText,methodApplication:genreMethodUse(run),
  evidence:manuscriptEvidence(run,evidence),citationBoundary:'此处只列可引用资料。每项具体主张仍需相应研究的发现或原文支持，摘要只支持摘要中明确报告的事实。',
  methods:methodSearches(run),outline:outline&&{question:outline.question,deliverable:outline.deliverable,rows:outlineRows,gaps:outline.gaps.map(scholarlyOutlineText).filter(Boolean)},
  revision:revision&&{issues:revision.issues,proofs:revision.proofs}};
}
