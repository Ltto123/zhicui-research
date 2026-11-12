import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Evidence,Run} from '../shared/types';
import type {Store} from './store';

const excludedTypes=new Set(['dataset','software','paratext']);
const titleKey=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function doiKey(value:string|undefined):string|undefined{
 if(!value?.trim())return;
 const normalized=value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
 return /^10\.\d{4,9}\/[^\s\u0000-\u001f]+$/i.test(normalized)?normalized:undefined;
}
function urlKey(value:string|undefined):string|undefined{
 if(!value)return;
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return;return url.href;}catch{return;}
}
function matches(current:Evidence,previous:Evidence):boolean{
 const title=titleKey(current.title);if(!title||title!==titleKey(previous.title))return false;
 const currentDoi=doiKey(current.doi),previousDoi=doiKey(previous.doi);
 if(current.doi?.trim()||previous.doi?.trim())return Boolean(currentDoi&&previousDoi&&currentDoi===previousDoi);
 const url=urlKey(current.url);return Boolean(url&&url===urlKey(previous.url));
}
function isOriginal(source:Evidence,notes?:string):boolean{
 return source.readScope==='full_text'&&typeof source.text==='string'&&Boolean(source.text.trim())&&source.text!==notes
  &&!excludedTypes.has(source.publicationType??'')&&!/^10\.6084\/m9\.figshare\.c\.\d+/i.test(doiKey(source.doi)??'')
  &&!/^\s*全文文字研读笔记[:：]/.test(source.text)
  &&!/(?:全文文字已分块研读|研读笔记|派生(?:资料|内容|笔记)|非独立原始研究|同一对话的已交付成果)|\bderived\b|\b(?:AI|model)[ -]*(?:generated[ -]*)?(?:notes|summary)\b/i.test(source.location);
}
function validDocument(store:Store,source:Evidence):boolean{
 const document=source.sourceDocument;if(!document)return true;
 if(document.mimeType!=='application/pdf'||!/^[a-f0-9]{64}$/.test(document.sha256)||document.fileName!==document.sha256+'.pdf')return false;
 try{const file=path.join(store.root,'source-documents',document.fileName),stat=fs.statSync(file);return stat.isFile()&&stat.size>0&&stat.size<=8*1024*1024&&createHash('sha256').update(fs.readFileSync(file)).digest('hex')===document.sha256;}catch{return false;}
}
function reusedLocation(source:Evidence):string{
 const marker='；复用同一任务已保存的原文缓存；非本轮重新下载';
 const position=source.location.indexOf('；检索接口 ');
 return position<0?source.location+marker:source.location.slice(0,position)+marker+source.location.slice(position);
}

/** The caller supplies only prior runs from the current task lineage and only
 * candidates whose abstracts were screened and selected for full-text reading.
 * No network, run mutation, or inherited model notes are involved in reuse. */
export function reuseSourceEvidence(store:Store,candidates:readonly Evidence[],priorRuns:readonly Run[]):{evidence:Evidence[];reusedIds:string[]}{
 if(new Set(candidates.map(entry=>entry.id)).size!==candidates.length)throw new Error('待复用原文的候选包含重复证据 ID，不能混用原文。');
 const originals:Evidence[]=[];const seen=new Set<string>();
 for(const prior of [...priorRuns].reverse()){
  if(seen.has(prior.id))continue;seen.add(prior.id);
  // Read the saved run, not a replacement corpus attached to a caller object.
  const saved=store.getRun(prior.id);
  for(const source of saved.evidence){
   const notes=saved.reading?.entries.find(entry=>entry.evidenceId===source.id)?.notes;
   if(isOriginal(source,notes))originals.push(source);
  }
 }
 const reusedIds:string[]=[];
 const evidence=candidates.map(candidate=>{
  const current=structuredClone(candidate);
  if(isOriginal(current)&&validDocument(store,current))return current;
  // An old body without an abstract cannot bypass current abstract screening.
  const abstract=current.abstract?.trim()?current.abstract:current.readScope==='abstract'?current.text:undefined;
  if(!abstract?.trim()||!['abstract','full_text'].includes(current.readScope)||excludedTypes.has(current.publicationType??''))return current;
  const previous=originals.find(source=>matches(current,source)&&validDocument(store,source));
  if(!previous)return current;
  reusedIds.push(current.id);
  return {...current,abstract,text:previous.text,readScope:'full_text' as const,location:reusedLocation(previous),retrievedAt:previous.retrievedAt,sourceDocument:previous.sourceDocument?structuredClone(previous.sourceDocument):undefined};
 });
 return {evidence,reusedIds};
}
