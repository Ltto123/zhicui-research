import type {Evidence,Run} from '../shared/types';
import type {Store} from './store';
import {getEvidenceSource} from './sources';

export interface SourceAccessResult {checkedIds:string[];failures:{id:string;error:string}[];skippedIds:string[];}
export interface SourceAccessOptions {getSource?:typeof getEvidenceSource;}
function sameIdentity(expected:Evidence,received:Evidence):boolean{
 const doi=(value:string|undefined)=>value?.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
 return expected.id===received.id&&expected.title===received.title&&doi(expected.doi)===doi(received.doi);
}

/** Check actual cited source IDs only. Viewer acquisition writes its own cache;
 * the evidence passed to the model keeps its previous, honest reading scope. */
export async function ensureCitedSourcesOpenable(
 store:Store,run:Run,ids:readonly string[],signal:AbortSignal,progress:(message:string)=>void=()=>{},options:SourceAccessOptions={},
):Promise<SourceAccessResult>{
 signal.throwIfAborted();
 const saved=store.getRun(run.id),unique=[...new Set(ids)];
 const sourceMap=new Map<string,Evidence>();
 for(const id of unique){const matches=saved.evidence.filter(entry=>entry.id===id);if(matches.length!==1)throw new Error(`正文引用 ${id} 没有唯一对应的已保存来源，不能通过原文可打开核验。`);sourceMap.set(id,matches[0]);}
 const external=unique.filter(id=>['abstract','full_text','metadata'].includes(sourceMap.get(id)!.readScope));
 const skippedIds=unique.filter(id=>!external.includes(id));
 const checkedIds:string[]=[],failures:SourceAccessResult['failures']=[];
 let completed=0;const getSource=options.getSource??getEvidenceSource;
 progress(`核验最终引用的原文可打开性：0/${external.length} 篇外部论文；上传材料和计算结果单独保留，不冒充外部论文。`);
 for(let offset=0;offset<external.length;offset+=3){
  signal.throwIfAborted();const batch=external.slice(offset,offset+3);
  const results=await Promise.allSettled(batch.map(id=>(async()=>{
   signal.throwIfAborted();const source=sourceMap.get(id)!;
   progress(`正在核验引用原文 ${id}（已完成 ${completed}/${external.length}）。`);
   const result=await getSource(store,saved.id,id,signal);signal.throwIfAborted();
   const evidence=result.evidence,notes=saved.reading?.entries.find(entry=>entry.evidenceId===id)?.notes;
   if(!evidence||!sameIdentity(source,evidence)||evidence.readScope!=='full_text'||typeof evidence.text!=='string'||!evidence.text.trim()
    ||evidence.text===notes||/^\s*全文文字研读笔记[:：]/.test(evidence.text)||evidence.location?.includes('全文文字已分块研读'))throw new Error('未取得身份一致且可打开的原文正文，摘要或研读笔记不能替代原文。');
   return id;
  })().then(value=>{
   completed++;if(!signal.aborted)progress(`引用原文核验已完成 ${completed}/${external.length}：${id}已确认原文可打开。`);return value;
  },error=>{
   completed++;if(!signal.aborted)progress(`引用原文核验已完成 ${completed}/${external.length}：${id}原文未就绪，不能因此降低最低引用要求。`);throw error;
  })));
  signal.throwIfAborted();
  for(let index=0;index<results.length;index++){
   const result=results[index],id=batch[index];
   if(result.status==='fulfilled')checkedIds.push(id);
   else failures.push({id,error:(result.reason instanceof Error?result.reason.message:'原文核验失败').slice(0,1500)});
  }
 }
 return {checkedIds,failures,skippedIds};
}
