import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import type { Evidence, Material } from '../shared/types.ts';

interface Summary { count:number; missing:number; sum:number; mean:number; min:number; max:number; sampleStandardDeviation:number|null; standardError:number|null; }
const idHeader = /^(?:id|index|trial|row|row_?id|no\.?|序号|编号|样本编号|记录编号)$/i;
const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const missing = /^(?:|na|n\/a|null|nan|缺失|无)$/i;

function summary(values: number[], missingCount: number): Summary {
  let sum = 0; let correction = 0;
  for (const value of values) { const adjusted=value-correction; const next=sum+adjusted; correction=(next-sum)-adjusted; sum=next; }
  const mean = sum / values.length;
  const variance = values.length > 1 ? values.reduce((acc,value) => acc+(value-mean)**2,0)/(values.length-1) : null;
  if (!Number.isFinite(sum) || !Number.isFinite(mean) || (variance !== null && !Number.isFinite(variance))) throw new Error('数值过大，超出可靠浮点计算范围。');
  return {count:values.length,missing:missingCount,sum,mean,min:Math.min(...values),max:Math.max(...values),sampleStandardDeviation:variance === null ? null : Math.sqrt(variance),standardError:variance === null ? null : Math.sqrt(variance/values.length)};
}

export async function calculateMaterials(materials: Material[], signal?: AbortSignal): Promise<Evidence[]> {
  const results: Evidence[] = [];
  for (const material of materials) {
    signal?.throwIfAborted();
    if (material.role !== 'evidence' || !/\.(?:csv|tsv)$/i.test(material.name)) continue;
    const rows = parse(material.text,{bom:true,skip_empty_lines:true,delimiter:/\.tsv$/i.test(material.name)?'\t':',',max_record_size:20000,relax_column_count:false}) as string[][];
    if (rows.length < 2 || rows.length > 20001) throw new Error(`“${material.name}”需要表头和 1 至 20000 行数据。`);
    const headers=rows[0].map(header=>header.trim());
    if (headers.length>100 || headers.some(header=>!header) || new Set(headers).size!==headers.length) throw new Error(`“${material.name}”需要唯一、非空的列名（最多 100 列）。`);
    const columns:Record<string,Summary>=Object.create(null);
    const excludedColumns:{column:string;reason:string}[]=[];
    const numericColumns:Record<string,(number|null)[]>=Object.create(null);
    for (let col=0;col<headers.length;col++) {
      signal?.throwIfAborted();
      const header=headers[col];
      if(idHeader.test(header)) { excludedColumns.push({column:header,reason:'标识符或序号列，不作为实测变量统计'}); continue; }
      const tokens=rows.slice(1).map(row=>row[col].trim());
      if(tokens.some(token=>!missing.test(token)&&(!numeric.test(token)||!Number.isFinite(Number(token))))) { excludedColumns.push({column:header,reason:'含非数值观测；未默默删除这些记录进行计算'}); continue; }
      const data=tokens.map(token=>missing.test(token)?null:Number(token));
      const valid=data.filter((value):value is number=>value!==null);
      if(!valid.length) { excludedColumns.push({column:header,reason:'无有效数值'}); continue; }
      columns[header]=summary(valid,data.length-valid.length); numericColumns[header]=data;
    }
    const xName=headers.find(header=>/^x(?:[_(\/]|$)/i.test(header));
    const yName=headers.find(header=>/^y(?:[_(\/]|$)/i.test(header));
    let linearFit:Record<string,number|string|null>|undefined;
    if(xName&&yName&&numericColumns[xName]&&numericColumns[yName]) {
      const pairs=numericColumns[xName].flatMap((x,i)=>x!==null&&numericColumns[yName][i]!==null?[[x,numericColumns[yName][i] as number]]:[]);
      if(pairs.length>=3) {
        const mx=pairs.reduce((s,p)=>s+p[0],0)/pairs.length,my=pairs.reduce((s,p)=>s+p[1],0)/pairs.length;
        const ssx=pairs.reduce((s,p)=>s+(p[0]-mx)**2,0),ssy=pairs.reduce((s,p)=>s+(p[1]-my)**2,0);
        if(ssx>0) {
          const slope=pairs.reduce((s,p)=>s+(p[0]-mx)*(p[1]-my),0)/ssx,intercept=my-slope*mx;
          const residualSumSquares=pairs.reduce((s,p)=>s+(p[1]-intercept-slope*p[0])**2,0);
          linearFit={x:xName,y:yName,n:pairs.length,slope,intercept,residualSumSquares,rSquared:ssy>0?1-residualSumSquares/ssy:null,...ssy===0?{rSquaredNote:'响应变量为常数，总平方和为0，R²未定义，不能解读为解释力为0。'}:{}};
          if(Object.values(linearFit).some(value=>typeof value==='number'&&!Number.isFinite(value))) throw new Error('拟合数值超出可靠浮点计算范围。');
        }
      }
    }
    const payload={source:{materialId:material.id,name:material.name,sha256:material.sha256},rows:rows.length-1,columns,excludedColumns,...(linearFit?{linearFit}:{}),formulas:{mean:'sum(x_i)/n',sampleStandardDeviation:'sqrt(sum((x_i-mean)^2)/(n-1))',standardError:'sampleStandardDeviation/sqrt(n)',linearFit:'普通最小二乘 y = intercept + slope*x，仅显式 x/y 列且至少3个完整配对'},limitations:['保留列名中的单位，未推断缺失的单位或仪器精度。','标准误仅描述重复测量在独立同分布假设下的均值精度；未包含仪器、校准等系统不确定度。','描述统计和最小二乘拟合不验证因果、独立性、正态性或原始记录真实性。','只有一项观测时，样本标准差与标准误为 null，不表示零误差。']};
    results.push({id:`calc-${createHash('sha256').update(material.id+material.sha256).digest('hex').slice(0,16)}`,title:`${material.name}：确定性复算`,text:JSON.stringify(payload,null,2),location:`原材料 ${material.id}，SHA-256 ${material.sha256}；全部 ${rows.length-1} 行`,readScope:'computed',materialId:material.id,retrievedAt:new Date().toISOString()});
  }
  return results;
}
