import type {ActiveModelSelection,ModelConnectionsState,PublicModelConnection} from '../../shared/types';
import {api,body} from './api';

export const cliNames={codex:'Codex CLI',claude:'Claude Code CLI'};
export interface ConnectionDraft {name:string;baseUrl:string;protocol:'openai'|'anthropic';models:string[];apiKey?:string;clearApiKey?:boolean;}
export function parseModelIds(value:string):string[]{return [...new Set(value.split(/\r?\n/).map(model=>model.trim()).filter(Boolean))];}
export function connectionStatus(connection:PublicModelConnection|undefined,model:string,dirty=false){
  const record=connection?.verification.filter(item=>item.model===model).sort((a,b)=>(Date.parse(b.checkedAt)||Infinity)-(Date.parse(a.checkedAt)||Infinity))[0];
  if(dirty||!record||!Number.isFinite(Date.parse(record.checkedAt)))return {status:'unverified' as const,label:dirty?'有未保存更改 · 保存后需重新核对状态':'已保存 · 此模型未测试',detail:'保存配置不代表连接成功。',checkedAt:undefined};
  return {status:record.status,label:record.status==='verified'?'已接入 · 最近验证成功':'最近连接验证失败',detail:record.detail,checkedAt:record.checkedAt};
}
export function modelSelectionLabel(state:ModelConnectionsState|undefined):string{
  const active=state?.active;if(!active)return '选择模型';
  if(active.kind!=='api')return `${cliNames[active.kind]} · ${active.model||'默认模型'}`;
  return `${state!.connections.find(connection=>connection.id===active.connectionId)?.name??'未找到已保存连接'} · ${active.model}`;
}
export function selectedModelVerified(state:ModelConnectionsState|undefined):boolean{
  const active=state?.active;return active?.kind==='api'&&connectionStatus(state!.connections.find(connection=>connection.id===active.connectionId),active.model).status==='verified';
}
export function modelConnectionUpdates(publish:(state:ModelConnectionsState)=>void){
  let revision=0;
  return {
    adopt(state:ModelConnectionsState){revision++;publish(state);},
    async read(load:()=>Promise<ModelConnectionsState>,signal?:AbortSignal){const before=revision;const state=await load();if(!signal?.aborted&&before===revision)publish(state);},
  };
}
interface TestResult {ok:boolean;stale:boolean;model:string;checkedAt:string;connectionId:string;detail:string;}
/** Constructing this client never requests anything. Test is a separate explicit action. */
export function modelConnectionActions(request:typeof api=api){
  return {
    load:(signal?:AbortSignal)=>request<ModelConnectionsState>('/model-connections',{signal}),
    save:(id:string|undefined,input:ConnectionDraft,signal?:AbortSignal)=>request<ModelConnectionsState>(id?`/model-connections/${encodeURIComponent(id)}`:'/model-connections',{method:id?'PUT':'POST',body:body(input),signal}),
    remove:(id:string,signal?:AbortSignal)=>request<ModelConnectionsState>(`/model-connections/${encodeURIComponent(id)}`,{method:'DELETE',signal}),
    select:(active:ActiveModelSelection,signal?:AbortSignal)=>request<ModelConnectionsState>('/model-connections/active',{method:'PUT',body:body(active),signal}),
    test:async(id:string,model:string,signal?:AbortSignal)=>{
      const result=await request<TestResult>(`/model-connections/${encodeURIComponent(id)}/test`,{method:'POST',body:body({model}),signal:signal??AbortSignal.timeout(180_000)});
      const state=await request<ModelConnectionsState>('/model-connections',{signal});
      return {...result,ok:result.ok&&!result.stale,state};
    },
  };
}
