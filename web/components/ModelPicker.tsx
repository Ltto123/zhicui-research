'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,ChevronDown,LoaderCircle,Settings2} from 'lucide-react';
import type {ActiveModelSelection,ModelConnectionsState,ProviderStatus,Run} from '../../shared/types';
import {cliNames,connectionStatus,modelSelectionLabel} from '../lib/model-connections';

export function ModelPicker({state,providers,run,disabled,onSelect,onManage}:{state?:ModelConnectionsState;providers:ProviderStatus[];run?:Run;disabled?:boolean;onSelect:(selection:ActiveModelSelection)=>Promise<void>;onManage:()=>void}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null),mounted=useRef(true),busyRef=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!open)return;const close=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close);},[open]);
  async function choose(selection:ActiveModelSelection){if(busyRef.current||disabled)return;busyRef.current=true;setBusy(true);setError('');try{await onSelect(selection);if(mounted.current)setOpen(false);}catch(error){if(mounted.current)setError(error instanceof Error?error.message:'模型选择未保存，请重试。');}finally{busyRef.current=false;if(mounted.current)setBusy(false);}}
  const active=state?.active,lastUse=run?.modelHistory?.at(-1);
  return <div className="model-picker" ref={root} onKeyDown={event=>{if(event.key==='Escape')setOpen(false);}}>
    <button type="button" className="model-chip" aria-label="选择下次执行模型" aria-expanded={open} aria-haspopup="menu" title={`下次执行 / 接续：${modelSelectionLabel(state)}`} onClick={()=>setOpen(value=>!value)} disabled={disabled||busy}>{busy?<LoaderCircle size={14} className="spin"/>:null}<span>{modelSelectionLabel(state)}</span><ChevronDown size={12}/></button>
    {open&&<div className="model-picker-menu" role="menu" aria-label="已保存模型"><header><strong>下次执行 / 接续模型</strong><p>切换只保存选择，不会启动研究或中断当前任务。</p></header>
      {run&&<div className="model-run-identity"><p>本轮选择：{run.connectionName|| (run.provider==='api'?'API':cliNames[run.provider])} · {run.model||'默认模型'}</p><p>{lastUse?`最近实际调用：${lastUse.connectionName||(lastUse.provider==='api'?'API':cliNames[lastUse.provider])} · ${lastUse.model||'默认模型'}`:'本轮尚无已记录的模型调用；选择不代表已使用。'}</p></div>}
      {state?.connections.map(connection=><section key={connection.id}><h4>{connection.name}</h4>{connection.models.map(model=>{const selected=active?.kind==='api'&&active.connectionId===connection.id&&active.model===model,status=connectionStatus(connection,model);return <button key={model} type="button" role="menuitemradio" aria-checked={selected} disabled={busy||disabled} onClick={()=>void choose({kind:'api',connectionId:connection.id,model})}><span><strong>{model}</strong><small className={status.status==='verified'?'model-verified':''}>{status.status==='verified'?'已接入 · 最近验证成功':status.status==='failed'?'最近验证失败':'已保存未测试'}</small></span>{selected&&<Check size={14}/>}</button>;})}</section>)}
      {!state?.connections.length&&<p className="model-menu-empty">尚未保存 API 连接。添加接口后，在这里选择其模型。</p>}
      <section><h4>本机命令行</h4>{(['codex','claude'] as const).map(kind=>{const provider=providers.find(item=>item.kind===kind),selected=active?.kind===kind,model=selected?active.model:'';return <button type="button" key={kind} role="menuitemradio" aria-checked={selected} disabled={busy||disabled||!provider?.available} onClick={()=>void choose({kind,model})}><span><strong>{cliNames[kind]}</strong><small>{provider?.available?'本机工具可用 · 模型连接未验证':'本机工具未确认可用'}</small></span>{selected&&<Check size={14}/>}</button>;})}</section>
      {error&&<p role="alert" className="retrieval-warning">{error}</p>}<button type="button" className="manage-models" role="menuitem" onClick={()=>{setOpen(false);onManage();}} disabled={busy||disabled}><Settings2 size={14}/>管理连接与模型</button>
    </div>}
  </div>;
}
