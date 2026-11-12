'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,LoaderCircle,Plus,PlugZap,Trash2} from 'lucide-react';
import type {ModelConnectionsState,ProviderStatus,PublicModelConnection} from '../../shared/types';
import {api,errorText} from '../lib/api';
import {cliNames,connectionStatus,modelConnectionActions,modelSelectionLabel,parseModelIds} from '../lib/model-connections';

const actions=modelConnectionActions();
const blank={name:'',baseUrl:'',protocol:'openai' as 'openai'|'anthropic',modelsText:''};
const draftFor=(connection?:PublicModelConnection)=>connection?{name:connection.name,baseUrl:connection.baseUrl,protocol:connection.protocol,modelsText:connection.models.join('\n')}:{...blank};
const checkedTime=(value:string)=>new Date(value).toLocaleString('zh-CN');

export function ModelConnectionManager({onChanged,onBusyChange}:{onChanged:(state:ModelConnectionsState)=>void;onBusyChange:(busy:boolean)=>void}){
  const [state,setState]=useState<ModelConnectionsState>(),[providers,setProviders]=useState<ProviderStatus[]>([]),[selectedId,setSelectedId]=useState(''),[draft,setDraft]=useState({...blank});
  const [key,setKey]=useState(''),[clearKey,setClearKey]=useState(false),[testModel,setTestModel]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[failed,setFailed]=useState(false),[deleteConfirm,setDeleteConfirm]=useState(false);
  const [cliKind,setCliKind]=useState<'codex'|'claude'>('codex'),[cliModel,setCliModel]=useState('');
  const controller=useRef<AbortController|null>(null),mounted=useRef(true),busyRef=useRef(false);
  const selected=state?.connections.find(connection=>connection.id===selectedId),dirty=JSON.stringify(draft)!==JSON.stringify(draftFor(selected))||Boolean(key)||clearKey;
  const status=connectionStatus(selected,testModel,dirty),endpointChanged=Boolean(selected&&(draft.baseUrl.trim()!==selected.baseUrl||draft.protocol!==selected.protocol));
  function edit(connection?:PublicModelConnection,preferredModel?:string){setSelectedId(connection?.id??'');setDraft(draftFor(connection));const preferred=preferredModel??(state?.active?.kind==='api'&&state.active.connectionId===connection?.id?state.active.model:undefined);setTestModel(preferred&&connection?.models.includes(preferred)?preferred:connection?.models[0]??'');setKey('');setClearKey(false);setDeleteConfirm(false);setNotice('');}
  function adopt(next:ModelConnectionsState){setState(next);onChanged(next);}
  useEffect(()=>{
    mounted.current=true;const abort=new AbortController();
    actions.load(abort.signal).then(next=>{if(abort.signal.aborted)return;adopt(next);edit(next.connections.find(connection=>next.active?.kind==='api'&&connection.id===next.active.connectionId)??next.connections[0],next.active?.kind==='api'?next.active.model:undefined);if(next.active&&next.active.kind!=='api'){setCliKind(next.active.kind);setCliModel(next.active.model);}}).catch(error=>{if(!abort.signal.aborted){setFailed(true);setNotice(errorText(error));}}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    api<ProviderStatus[]>('/providers',{signal:abort.signal}).then(list=>{if(!abort.signal.aborted)setProviders(list);}).catch(()=>{});
    return()=>{mounted.current=false;abort.abort();controller.current?.abort();};
  },[]);
  async function perform(action:(signal:AbortSignal)=>Promise<void>){
    if(busyRef.current)return;busyRef.current=true;const abort=new AbortController();controller.current=abort;setBusy(true);onBusyChange(true);setNotice('');setFailed(false);
    try{await action(AbortSignal.any([abort.signal,AbortSignal.timeout(180_000)]));}catch(error){if(mounted.current){setFailed(true);setNotice(errorText(error));}}finally{busyRef.current=false;controller.current=null;if(mounted.current){setBusy(false);onBusyChange(false);}}
  }
  function save(){void perform(async signal=>{
    const models=parseModelIds(draft.modelsText);if(!draft.name.trim()||!draft.baseUrl.trim()||!models.length)throw new Error('请填写连接名称、API地址和至少一个模型ID。');
    const oldIds=new Set(state?.connections.map(connection=>connection.id));
    const next=await actions.save(selectedId||undefined,{name:draft.name.trim(),baseUrl:draft.baseUrl.trim(),protocol:draft.protocol,models,...(key.trim()?{apiKey:key.trim()}:{}),...(clearKey?{clearApiKey:true}:{})},signal);
    if(!mounted.current)return;adopt(next);edit(next.connections.find(connection=>selectedId?connection.id===selectedId:!oldIds.has(connection.id)));setNotice('连接和模型已保存，未发出测试请求。可在输入框旁选择下次使用的模型。');
  });}
  function test(){if(!selected||dirty||!testModel)return;void perform(async signal=>{
    const result=await actions.test(selected.id,testModel,signal);if(!mounted.current)return;adopt(result.state);const current=result.state.connections.find(connection=>connection.id===selected.id);setDraft(draftFor(current));setSelectedId(current?.id??'');setFailed(!result.ok);setNotice(result.stale?'测试期间配置发生变化，本次结果不代表当前配置已接入。请核对后重新测试。':result.ok?'所选连接的此模型最近验证成功；其他模型仍按各自记录显示。':result.detail);
  });}
  function remove(){if(!selected)return;void perform(async signal=>{const next=await actions.remove(selected.id,signal);if(!mounted.current)return;adopt(next);edit(next.connections[0]);setNotice('连接已删除。已启动任务继续使用其启动时的配置。');});}
  function useCli(){void perform(async signal=>{const next=await actions.select({kind:cliKind,model:cliModel.trim()},signal);if(mounted.current){adopt(next);setNotice('已保存下次执行的CLI选择，未启动研究，也未发出模型测试。');}});}
  const cliSelected=state?.active?.kind===cliKind&&state.active.model===cliModel.trim(),cliAvailable=providers.find(provider=>provider.kind===cliKind)?.available===true;
  function testCli(){if(!cliSelected)return;void perform(async signal=>{const result=await api<{ok:boolean;detail:string}>('/providers/test',{method:'POST',body:JSON.stringify({kind:cliKind,model:cliModel.trim()}),signal});if(mounted.current){setFailed(!result.ok);setNotice(result.ok?'本次CLI连接测试成功。此结果不代表其他CLI模型或API连接已接入。':result.detail);}});}
  if(loading)return <div className="loading-row"><LoaderCircle size={17} className="spin"/>读取已保存连接…</div>;
  return <div className="model-connections-manager">
    <p className="next-model-note">下次执行 / 接续：<strong>{modelSelectionLabel(state)}</strong>。保存或选择模型不会启动研究，也不改变当前正在执行的模型。</p>
    <div className="saved-connections-heading"><h3>已保存 API 连接</h3><button type="button" className="text-button" onClick={()=>edit()} disabled={busy}><Plus size={15}/>添加连接</button></div>
    <div className="saved-connections" role="group" aria-label="选择要编辑的API连接">{state?.connections.map(connection=><button type="button" key={connection.id} aria-pressed={selectedId===connection.id} onClick={()=>edit(connection)} disabled={busy}><span>{connection.name}<small>{connection.models.length} 个模型</small></span>{selectedId===connection.id&&<Check size={14}/>}</button>)}</div>
    <section className="connection-editor" aria-label={selected?'编辑已保存连接':'添加API连接'}><h3>{selected?'编辑连接':'添加连接'}</h3><div className="settings-fields">
      <label>连接名称<input value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})} placeholder="例如：我的研究接口" disabled={busy}/></label>
      <label>接口协议<select aria-label="接口协议" value={draft.protocol} onChange={event=>setDraft({...draft,protocol:event.target.value as 'openai'|'anthropic'})} disabled={busy}><option value="openai">OpenAI 兼容接口</option><option value="anthropic">Anthropic 接口</option></select></label>
      <label>API 地址<input type="url" value={draft.baseUrl} onChange={event=>setDraft({...draft,baseUrl:event.target.value})} placeholder="https://api.example.com/v1" autoComplete="off" disabled={busy}/></label>
      <label>模型 ID 列表<span className="field-hint">每行一个，按提供方实际名称填写</span><textarea aria-label="模型ID列表" value={draft.modelsText} onChange={event=>setDraft({...draft,modelsText:event.target.value})} rows={4} placeholder={'model-id-1\nmodel-id-2'} disabled={busy}/></label>
      <label>API Key<span className="field-hint">{selected?.hasApiKey?'此连接已有密钥；地址与协议不变时留空保留':'未保存密钥'}</span><input type="password" value={key} onChange={event=>{setKey(event.target.value);setClearKey(false);}} placeholder={selected?.hasApiKey?'输入新密钥以替换':'输入此接口的密钥（如需要）'} autoComplete="new-password" disabled={busy}/></label>
      {endpointChanged&&<p className="retrieval-warning">地址或协议已改变，旧密钥不会自动沿用；需要鉴权的新接口请填写新密钥。</p>}
      {selected?.hasApiKey&&<label className="connection-clear-key"><input type="checkbox" checked={clearKey} onChange={event=>{setClearKey(event.target.checked);if(event.target.checked)setKey('');}} disabled={busy}/>清除此连接保存的密钥</label>}
    </div><div className="connection-editor-actions"><button type="button" className="primary-button" disabled={busy||!dirty} onClick={save}>{busy?<LoaderCircle size={14} className="spin"/>:null}保存连接与模型</button>{selected&&<button type="button" className="text-button" disabled={busy} onClick={()=>setDeleteConfirm(value=>!value)}><Trash2 size={14}/>删除连接</button>}</div>{deleteConfirm&&<div className="delete-connection-confirm"><p>删除“{selected?.name}”及其保存的密钥和模型列表？已保存的研究成果保留。</p><button type="button" className="text-button" onClick={remove} disabled={busy}>确认删除此连接</button><button type="button" className="text-button" onClick={()=>setDeleteConfirm(false)} disabled={busy}>保留连接</button></div>}</section>
    {selected&&<section className="connection-test" aria-label="测试所选连接与模型"><h3>连接验证</h3><label>本次测试的模型<select value={testModel} onChange={event=>setTestModel(event.target.value)} disabled={busy}>{selected.models.map(model=><option value={model} key={model}>{model}</option>)}</select></label><p className={`model-status ${status.status}`}><span className={`status-dot ${status.status==='verified'?'green':'muted-dot'}`}/>{status.label}</p>{status.checkedAt&&<p>记录时间：{checkedTime(status.checkedAt)}</p>}<p>{status.detail}</p><p>仅测试“{selected.name} / {testModel}”，会发出一次真实模型请求，可能产生少量费用。保存、切换模型和打开设置不会自动测试。</p>{dirty&&<p>请先保存更改，再测试已保存的配置。</p>}<button type="button" className="text-button" disabled={busy||dirty||!testModel} onClick={test}><PlugZap size={15}/>测试此连接与模型（可能计费）</button></section>}
    <details className="cli-settings"><summary>本机 CLI 通道</summary><p>CLI是否安装与模型是否验证分别判断；本机工具可用不等于已接入模型。</p><label>CLI通道<select value={cliKind} onChange={event=>{setCliKind(event.target.value as 'codex'|'claude');setCliModel('');}} disabled={busy}><option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option></select></label><p>{providers.find(provider=>provider.kind===cliKind)?.detail??'尚未确认本机工具可用性'}</p><label>CLI 模型（可选）<input value={cliModel} onChange={event=>setCliModel(event.target.value)} placeholder="留空使用CLI默认模型" disabled={busy}/></label><button type="button" className="text-button" disabled={busy||!cliAvailable} onClick={useCli}>将 {cliNames[cliKind]} 用于下次执行</button><button type="button" className="text-button" disabled={busy||!cliAvailable||!cliSelected} onClick={testCli}>测试已选 CLI（可能计费）</button></details>
    {notice&&<div className={`notice ${failed?'error':'success'}`} role={failed?'alert':'status'}>{notice}</div>}
  </div>;
}
