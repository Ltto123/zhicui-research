import type {Evidence,Run} from '../shared/types';
import {researchRequest,reusableScreening,selectedEvidence} from './engine';
import {cachedReadingEvidence} from './reading';
import {fullTextRequiredForRun} from './task-policy';

export interface CitationReadiness {
 id:string;eligibleForWriting:boolean;reason:string;readScope:Evidence['readScope'];needsFullText:boolean;hasVerifiedNotes:boolean;
}

/** A raw record can exist and be readable without being eligible for synthesis.
 * This index reports that distinction; the writing tools retain final authority. */
export function citationReadiness(run:Run):CitationReadiness[]{
 const screened=reusableScreening({...run,retrievalExpansion:undefined}),selected=new Set(selectedEvidence(run).map(e=>e.id)),included=new Set(run.screening?.includedIds??[]);
 const counts=new Map<string,number>();for(const source of run.evidence)counts.set(source.id,(counts.get(source.id)??0)+1);
 return run.evidence.map(source=>{
  const paper=['abstract','full_text','metadata'].includes(source.readScope),needsFullText=paper&&fullTextRequiredForRun(run,source.id);
  const notes=source.readScope==='full_text'?cachedReadingEvidence([source],researchRequest(run),run.reading):undefined;
  const hasVerifiedNotes=Boolean(notes?.[0]?.text.trim());let reason='';
  if(counts.get(source.id)!==1)reason='来源编号重复，需先核对身份';
  else if(!source.text.trim())reason='尚无可读取内容';
  else if(source.readScope==='metadata')reason='只有书目信息，不能作为论据';
  else if(paper&&!screened)reason='当前候选尚未完成有效的相关性筛选';
  else if(paper&&!included.has(source.id))reason='该文献未被当前研究纳入';
  else if(needsFullText&&source.readScope!=='full_text')reason='本研究要求该文献全文，当前只取得摘要';
  else if(source.readScope==='full_text'&&!hasVerifiedNotes)reason='全文已取得，尚无当前研究可用的完整研读笔记';
  else if(!selected.has(source.id))reason='尚未满足当前研究的阅读范围要求';
  return {id:source.id,readScope:source.readScope,needsFullText,hasVerifiedNotes,eligibleForWriting:!reason,reason:reason||'可用于当前成稿，具体主张仍需符合已读证据'};
 });
}
