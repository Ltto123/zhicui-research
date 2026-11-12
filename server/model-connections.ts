import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {atomicJson} from './upstream/atomic-json';
import {createProvider} from './providers';
import type {ModelConfig,ModelProvider,PublicSettings,ModelConnectionsState,PublicModelConnection} from '../shared/types';

const cleanText=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'不允许控制字符');
const modelName=cleanText(150),protocol=z.enum(['openai','anthropic']);
const apiKey=z.string().max(2000).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'密钥不允许控制字符');
function normalizedUrl(value:string):string {
  let url:URL;try{url=new URL(value);}catch{throw new Error('API 地址必须是有效的 URL');}
  if(url.username||url.password||url.hash||url.search)throw new Error('API 地址不能包含凭据、参数或片段');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('远程 API 必须使用 HTTPS，本地接口可使用 HTTP');
  return url.href.replace(/\/+$/,'');
}
const baseUrl=z.string().trim().min(1).max(1000).transform((value,ctx)=>{try{return normalizedUrl(value);}catch{ctx.addIssue({code:'custom',message:'API 地址无效'});return z.NEVER;}});
export const connectionInputSchema=z.object({name:cleanText(120),baseUrl,protocol,models:z.array(modelName).min(1).max(100).transform(value=>[...new Set(value)]),apiKey:apiKey.optional(),clearApiKey:z.boolean().optional()}).strict();
export const connectionSelectionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('api'),connectionId:cleanText(100),model:modelName}).strict(),
  z.object({kind:z.enum(['codex','claude']),model:z.string().trim().max(150).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)).default('')}).strict(),
]);
export type ConnectionInput=z.input<typeof connectionInputSchema>;
export type ConnectionSelection=z.output<typeof connectionSelectionSchema>;
const verificationSchema=z.object({model:modelName,status:z.enum(['verified','failed']),checkedAt:z.string().datetime(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),detail:z.enum(['连接测试成功。','真实模型调用成功。','连接测试失败，请检查地址、协议、密钥权限和模型名称。','连接测试超时或已取消；未确认接入。'])}).strict();
const savedConnectionSchema=z.object({id:cleanText(100),name:cleanText(120),baseUrl,protocol,models:z.array(modelName).min(1).max(100),apiKey:apiKey.default(''),revision:z.string().uuid(),verification:z.array(verificationSchema).max(100)}).strict();
const savedStateSchema=z.object({version:z.literal(1),connections:z.array(savedConnectionSchema).max(50),active:connectionSelectionSchema.nullable()}).strict();
type SavedConnection=z.output<typeof savedConnectionSchema>;
type SavedState=z.output<typeof savedStateSchema>;
type Snapshot={id:string;revision:string;model:string;fingerprint:string};
type ProviderFactory=(config:ModelConfig)=>ModelProvider;
export interface ConnectionTestResult {ok:boolean;stale:boolean;detail:string;model:string;checkedAt:string;connectionId?:string;}
const success='连接测试成功。',callSuccess='真实模型调用成功。',failure='连接测试失败，请检查地址、协议、密钥权限和模型名称。',cancelled='连接测试超时或已取消；未确认接入。';
function fingerprint(connection:SavedConnection,model:string):string{return createHash('sha256').update(JSON.stringify([connection.baseUrl,connection.protocol,connection.apiKey,model])).digest('hex');}

/** A legacy endpoint override must never silently inherit another endpoint's env key. */
export function legacyModelConfig(environment:ModelConfig,saved:Partial<ModelConfig>):ModelConfig {
  const merged={...environment,...saved};
  if(saved.apiKey===undefined&&(saved.baseUrl!==undefined||saved.protocol!==undefined)){
    let same=false;try{same=normalizedUrl(merged.baseUrl)===normalizedUrl(environment.baseUrl)&&merged.protocol===environment.protocol;}catch{/* Invalid legacy config remains unconfigured. */}
    if(!same)merged.apiKey='';
  }
  return merged;
}

/** Owns configuration only. Construction, saving and selecting never call a model. */
export class ModelConnectionManager {
  private readonly file:string;
  private state:SavedState;
  private readonly snapshots=new WeakMap<ModelConfig,Snapshot>();
  private readonly pending=new Map<string,Promise<ConnectionTestResult>>();
  private readonly controllers=new Set<AbortController>();
  constructor(private readonly root:string,legacyConfig:()=>ModelConfig){
    this.file=path.join(root,'model-connections.json');
    if(fs.existsSync(this.file)){
      try{
        if(fs.statSync(this.file).size>2*1024*1024)throw new Error();
        this.state=savedStateSchema.parse(JSON.parse(fs.readFileSync(this.file,'utf8')));
        if(new Set(this.state.connections.map(c=>c.id)).size!==this.state.connections.length)throw new Error();
        if(this.state.active?.kind==='api')this.connection(this.state.active.connectionId,this.state.active.model);
      }catch{throw new Error('模型连接配置无法读取；请检查配置文件，未回退到其他接口或密钥。');}
    }else{
      this.state={version:1,connections:[],active:null};
      const legacy=legacyConfig();
      const parsed=connectionInputSchema.safeParse({name:'原有 API 连接',baseUrl:legacy.baseUrl,protocol:legacy.protocol,models:[legacy.model],apiKey:legacy.apiKey});
      if(parsed.success){
        const connection:SavedConnection={id:'legacy-api',...parsed.data,apiKey:parsed.data.apiKey??'',revision:randomUUID(),verification:[]};delete (connection as SavedConnection&{clearApiKey?:boolean}).clearApiKey;
        this.state.connections.push(connection);
        if(legacy.kind==='api')this.state.active={kind:'api',connectionId:connection.id,model:legacy.model.trim()};
      }
      if(legacy.kind==='codex'||legacy.kind==='claude')this.state.active={kind:legacy.kind,model:/[\u0000-\u001f\u007f]/.test(legacy.model)?'':legacy.model.slice(0,150)};
    }
  }
  private connection(id:string,model?:string):SavedConnection {
    const connection=this.state.connections.find(c=>c.id===id);
    if(!connection)throw new Error('模型连接不存在');
    if(model!==undefined&&!connection.models.includes(model))throw new Error('该模型不在此连接的模型列表中');
    return connection;
  }
  private save(next:SavedState):void {atomicJson(this.file,next);this.state=next;}
  private publicConnection(connection:SavedConnection):PublicModelConnection {
    return {id:connection.id,name:connection.name,baseUrl:connection.baseUrl,protocol:connection.protocol,models:[...connection.models],hasApiKey:Boolean(connection.apiKey),verification:connection.verification.filter(v=>connection.models.includes(v.model)&&v.fingerprint===fingerprint(connection,v.model)).map(v=>({model:v.model,status:v.status,checkedAt:v.checkedAt,detail:v.detail}))};
  }
  publicState():ModelConnectionsState{return {connections:this.state.connections.map(c=>this.publicConnection(c)),active:this.state.active?{...this.state.active}:null};}
  private configFor(connection:SavedConnection,model:string):ModelConfig {
    const config:ModelConfig={kind:'api',connectionId:connection.id,connectionName:connection.name,baseUrl:connection.baseUrl,model,protocol:connection.protocol,apiKey:connection.apiKey};
    this.snapshots.set(config,{id:connection.id,revision:connection.revision,model,fingerprint:fingerprint(connection,model)});return config;
  }
  getConfig():ModelConfig {
    const active=this.state.active;
    if(active?.kind==='api')return this.configFor(this.connection(active.connectionId,active.model),active.model);
    return {kind:active?.kind??'api',model:active?.model??'',baseUrl:'',protocol:'openai',apiKey:''};
  }
  publicSettings():PublicSettings {
    const config=this.getConfig(),connection=config.connectionId?this.connection(config.connectionId):undefined;
    return {kind:config.kind,baseUrl:config.baseUrl,model:config.model,protocol:config.protocol,hasApiKey:Boolean(config.apiKey),...(connection?{connectionId:connection.id,connectionName:connection.name,verification:this.publicConnection(connection).verification.find(v=>v.model===config.model)}:{})};
  }
  create(value:ConnectionInput){
    const input=connectionInputSchema.parse(value);if(this.state.connections.length>=50)throw new Error('最多保存 50 个模型连接');
    const connection:SavedConnection={id:randomUUID(),name:input.name,baseUrl:input.baseUrl,protocol:input.protocol,models:input.models,apiKey:input.clearApiKey?'':input.apiKey??'',revision:randomUUID(),verification:[]};
    this.save({...this.state,connections:[...this.state.connections,connection]});return this.publicConnection(connection);
  }
  update(id:string,value:ConnectionInput){
    const input=connectionInputSchema.parse(value),previous=this.connection(id);
    const sameEndpoint=input.baseUrl===previous.baseUrl&&input.protocol===previous.protocol;
    const connection:SavedConnection={id,name:input.name,baseUrl:input.baseUrl,protocol:input.protocol,models:input.models,apiKey:input.clearApiKey?'':input.apiKey||(sameEndpoint?previous.apiKey:''),revision:randomUUID(),verification:[]};
    connection.verification=previous.verification.filter(v=>connection.models.includes(v.model)&&v.fingerprint===fingerprint(connection,v.model));
    let active=this.state.active;
    if(active?.kind==='api'&&active.connectionId===id&&!connection.models.includes(active.model))active=null;
    this.save({...this.state,active,connections:this.state.connections.map(c=>c.id===id?connection:c)});return this.publicConnection(connection);
  }
  remove(id:string):void {
    this.connection(id);const active=this.state.active?.kind==='api'&&this.state.active.connectionId===id?null:this.state.active;
    this.save({...this.state,active,connections:this.state.connections.filter(c=>c.id!==id)});
  }
  select(value:ConnectionSelection){
    const active=connectionSelectionSchema.parse(value);if(active.kind==='api')this.connection(active.connectionId,active.model);
    this.save({...this.state,active});return this.publicState();
  }
  saveLegacy(value:ModelConfig):PublicSettings {
    if(value.kind!=='api'){this.select({kind:value.kind,model:value.model});return this.publicSettings();}
    const active=this.state.active;
    const current=active?.kind==='api'?this.connection(active.connectionId):undefined;
    const input={name:current?.name??'API 连接',baseUrl:value.baseUrl,protocol:value.protocol,models:[...new Set([...(current?.models??[]),value.model])],apiKey:value.apiKey};
    const connection=current?this.update(current.id,input):this.create(input);
    this.select({kind:'api',connectionId:connection.id,model:value.model.trim()});return this.publicSettings();
  }
  private record(config:ModelConfig,status:'verified'|'failed',detail:z.infer<typeof verificationSchema>['detail'],checkedAt=new Date().toISOString()):boolean {
    const snapshot=this.snapshots.get(config);if(!snapshot)return false;
    const connection=this.state.connections.find(c=>c.id===snapshot.id);
    if(!connection||connection.revision!==snapshot.revision||fingerprint(connection,snapshot.model)!==snapshot.fingerprint)return false;
    // A caller cannot mutate the captured public config and verify a different request.
    if(config.kind!=='api'||config.connectionId!==connection.id||config.model!==snapshot.model||config.baseUrl!==connection.baseUrl||config.protocol!==connection.protocol||config.apiKey!==connection.apiKey)return false;
    const verification={model:snapshot.model,status,detail,checkedAt,fingerprint:snapshot.fingerprint};
    const next={...connection,verification:[...connection.verification.filter(v=>v.model!==snapshot.model),verification]};
    this.save({...this.state,connections:this.state.connections.map(c=>c.id===connection.id?next:c)});return true;
  }
  recordCallSuccess(config:ModelConfig):boolean{return this.record(config,'verified',callSuccess);}
  test(id:string,model:string,factory:ProviderFactory=createProvider,signal?:AbortSignal):Promise<ConnectionTestResult>{return this.testConfig(this.configFor(this.connection(id,model),model),factory,signal);}
  testActive(factory:ProviderFactory=createProvider,signal?:AbortSignal,expected?:{kind:'codex'|'claude';model:string}):Promise<ConnectionTestResult>{
    const config=this.getConfig();
    if(expected&&(config.kind!==expected.kind||config.model!==expected.model))throw Object.assign(new Error('已选模型发生变化；本次未发出测试请求，请重新确认测试目标。'),{statusCode:409});
    // Compare and test one captured config, without an await or a second read.
    return this.testConfig(config,factory,signal);
  }
  private testConfig(config:ModelConfig,factory:ProviderFactory,signal?:AbortSignal):Promise<ConnectionTestResult>{
    const snapshot=this.snapshots.get(config),key=snapshot?JSON.stringify(snapshot):JSON.stringify([config.kind,config.model]);
    const existing=this.pending.get(key);if(existing)return existing;
    const promise=this.performTest(config,factory,signal).finally(()=>{this.pending.delete(key);});this.pending.set(key,promise);return promise;
  }
  private async performTest(config:ModelConfig,factory:ProviderFactory,signal?:AbortSignal):Promise<ConnectionTestResult>{
    const controller=new AbortController();this.controllers.add(controller);
    const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(),60_000);let abort:(()=>void)|undefined;
    let ok=false,detail:z.infer<typeof verificationSchema>['detail']=failure;
    try{
      if(combined.aborted)throw new Error('cancelled');
      const cancelledPromise=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('cancelled'));combined.addEventListener('abort',abort,{once:true});});
      const output=await Promise.race([Promise.resolve().then(()=>factory(config).generate({system:'你是连接测试助手，请仅回复：智萃科研连接成功。',prompt:'测试模型连接，只回复一句话。',signal:combined,sessionDir:path.join(this.root,'connection-tests',randomUUID()),timeoutMs:60_000,disableTransientRetries:true})),cancelledPromise]);
      if(combined.aborted)throw new Error('cancelled');
      ok=typeof output==='string'&&Boolean(output.trim());if(ok)detail=success;
    }catch{detail=combined.aborted?cancelled:failure;}
    finally{clearTimeout(timer);if(abort)combined.removeEventListener('abort',abort);this.controllers.delete(controller);}
    const checkedAt=new Date().toISOString(),recorded=this.record(config,ok?'verified':'failed',detail,checkedAt);
    return {ok,stale:config.kind==='api'&&!recorded,detail,model:config.model,checkedAt,...(config.connectionId?{connectionId:config.connectionId}:{})};
  }
  stopTests(){for(const controller of this.controllers)controller.abort();}
}
