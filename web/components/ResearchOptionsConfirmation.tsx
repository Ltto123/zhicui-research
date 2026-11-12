'use client';

import type {ResearchOptionsConfirmationStatus} from '../lib/research-options-confirmation';

export interface ResearchOptionsConfirmationProps {
  status:ResearchOptionsConfirmationStatus;
  onConfirm:()=>void;
  disabled?:boolean;
  materialCount?:number;
  appliedRunId?:string;
}

/** Presentation only: confirming never sends a message or starts research. */
export function ResearchOptionsConfirmation({status,onConfirm,disabled=false,materialCount=0}:ResearchOptionsConfirmationProps){
  const label=status==='applied'?'已应用到本轮':status==='confirmed'?'已确认，待发送':'待确认';
  const detail=status==='applied'?'服务端已接受本轮设置。再次修改后需重新确认。':status==='confirmed'?'下一次发送时使用；尚未发送消息或启动研究。':'确认方法、格式、等待确认选项和所选材料。确认本身不会启动研究。';
  return <div className="research-options-confirmation" data-status={status}>
    <div role="status" aria-live="polite"><strong>{label}</strong><span> · {materialCount} 份材料</span><p>{detail}</p></div>
    <button type="button" onClick={onConfirm} disabled={disabled||status!=='pending'}>{status==='pending'?'确认下次使用':status==='confirmed'?'已确认':'已应用'}</button>
  </div>;
}
