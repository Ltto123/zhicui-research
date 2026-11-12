import type {Artifact,Evidence,Material,TaskPlan} from '../shared/types';
import {assertDeliveryFormat,compileExportFormat} from '../shared/export-format';
import {GBT_REFERENCE_STANDARD,renderGbtReference} from './bibliography';
import {checkWritingLanguage} from './writing-language';

/** One delivery boundary for both execution paths. This describes what the
 * exporter can apply, not a model's assertion that a journal accepted the file. */
export function deliveryRequirements(plan:TaskPlan,evidence:Evidence[],citedIds:Iterable<string>,materials:Material[]=[],resolved?:Artifact['format'],draft?:string){
 const original=compileExportFormat(plan.methods.formatInstructions,{preserveBibliography:plan.taskType==='format'});
 assertDeliveryFormat(original);
 const format=structuredClone(resolved??original);
 for(const item of original.items){
  const checked=checkWritingLanguage(draft,item.requirement);if(!checked)continue;
  if(!checked.met)throw new Error(`正文语言尚未满足“${item.requirement}”，稿件已保存：${checked.detail}请仅修正语言，不必重新检索资料。`);
  const target=format.items.find(candidate=>candidate.requirement===item.requirement);
  if(target){target.status='configured';target.detail=checked.detail;delete target.blocking;}
  else format.items.push({requirement:item.requirement,status:'configured',detail:checked.detail});
  format.warnings=format.warnings.filter(warning=>!warning.startsWith(item.requirement+'：'));
 }
 const limitations=[...format.warnings];
 if(plan.taskType!=='format'){
  const cited=new Set(citedIds);
  const incomplete=evidence.filter(entry=>cited.has(entry.id)).map((entry,index)=>renderGbtReference(entry,index+1)).filter(reference=>reference.missingFields.length);
  if(incomplete.length)limitations.push(`参考文献按 ${GBT_REFERENCE_STANDARD} 顺序编码结构生成；${incomplete.length} 条仍有元数据待核对：${[...new Set(incomplete.flatMap(reference=>reference.missingFields))].join('、')}。未补造缺失的出版信息；可定位原文与完整书目规范核验分别检查。`);
 }
 for(const material of materials.filter(item=>item.role==='format')){
  const detail=`已提供格式规范《${material.name}》，全文可在工作台查看；当前导出只执行本次格式要求中可识别的参数，尚未逐条核对该文件的全部条款，不能据此认定符合目标期刊。`;
  format.items.push({requirement:`格式规范：${material.name}`,status:'unresolved',detail});
  format.warnings.push(detail);limitations.push(detail);
 }
 assertDeliveryFormat(format);
 return {format,limitations:[...new Set(limitations)]};
}
