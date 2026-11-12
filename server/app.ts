import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, revisionInputSchema } from './store';
import { ResearchEngine } from './engine';
import {publicRun,publicConversation} from './outline-confirmation';
import { loadEnvironmentConfig,providerStatus,createProvider } from './providers';
import { extractMaterial } from './materials';
import { listMethods } from './methods';
import { researchCapabilities } from './research-skills';
import { retrievalStatus, checkLiteratureSources } from './network';
import { resolveDoi } from './doi';
import { getEvidenceSource } from './sources';
import { registerLibraryRoutes } from './library-routes';
import {registerPaperLibraryRoutes} from './paper-library-routes';
import {WorkspaceService,type WorkspaceDependencies} from './workspace-service';
import {registerWorkspaceRoutes} from './workspace-routes';
import {validateManagedTree} from './windows-recycle';
import {ModelConnectionManager,connectionInputSchema,connectionSelectionSchema,legacyModelConfig} from './model-connections';

const uuid=z.string().uuid();
const optionsSchema=z.object({materialIds:z.array(uuid).max(30).optional(),methodMode:z.enum(['auto','supplement','replace']).optional(),methodInstructions:z.string().max(15000).optional(),formatInstructions:z.string().max(10000).optional(),waitForConfirmation:z.boolean().optional(),taskIntent:z.enum(['continue','new']).optional()});
const settingsSchema=z.object({kind:z.enum(['api','codex','claude']),baseUrl:z.string().max(1000),model:z.string().max(150),protocol:z.enum(['openai','anthropic']),apiKey:z.string().max(2000).optional()});
export async function buildApp(dataRoot:string,workspaceDependencies:WorkspaceDependencies={}) {
  const app=Fastify({logger:false,bodyLimit:1024*1024});const store=new Store(dataRoot);
  const connections=new ModelConnectionManager(store.root,()=>legacyModelConfig(loadEnvironmentConfig(),store.readSettings()));
  const config=()=>connections.getConfig();
  const engine=new ResearchEngine(store,config,{autonomous:true,provider:snapshot=>{
    const provider=createProvider(snapshot);
    return {generate:async options=>{
      const output=await provider.generate(options);
      if(!options.signal.aborted&&output.trim()){
        try{connections.recordCallSuccess(snapshot);}catch{options.onProgress?.('模型调用成功，但连接验证状态未能保存；本次研究输出仍保留。');}
      }
      return output;
    }};
  }});
  const origins=new Set(['http://localhost:3000','http://127.0.0.1:3000','http://localhost:4310','http://127.0.0.1:4310']);
  const hosts=new Set(['localhost','127.0.0.1','localhost:3000','127.0.0.1:3000','localhost:4310','127.0.0.1:4310']);
  app.addHook('onRequest',async(req,reply)=>{
    if(!hosts.has(req.headers.host??'') || (req.headers.origin && !origins.has(req.headers.origin)))return reply.code(403).send({error:'请求来源不受信任'});
    if(req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:'拒绝跨站请求'});
    if(!req.headers.origin && req.headers.referer){try{if(!origins.has(new URL(req.headers.referer).origin))return reply.code(403).send({error:'请求来源不受信任'});}catch{return reply.code(403).send({error:'请求来源无效'});}}
  });
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store').header('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");return payload;});
  app.setErrorHandler((err,req,reply)=>{
    if(err instanceof z.ZodError)return reply.code(400).send({error:'请求字段不完整或超出限制：'+err.issues.map(i=>i.path.join('.')).join(', ')});
    const error=err as Error & {statusCode?:number;code?:string};
    const code=error.statusCode&&error.statusCode>=400?error.statusCode:/不存在/.test(error.message)?404:/尚未结束|已有其他|不能接续/.test(error.message)?409:400;
    reply.code(code).send({error:error.message.replace(/(Bearer\s+)[\w.-]+/gi,'$1[redacted]')});
  });
  await app.register(multipart,{limits:{fileSize:5*1024*1024,files:1,fields:3,parts:4}});
  app.get('/api/health',async()=>({ok:true,product:'智萃科研',version:'0.1.0',runtime:'BYOK / Pi 1.3.0'}));
  app.get('/api/doi/resolve',async(req)=>{
    const {doi}=z.object({doi:z.string().min(1).max(500)}).parse(req.query);
    return resolveDoi(doi,AbortSignal.timeout(20_000));
  });
  app.get<{Params:{id:string;evidenceId:string}}>('/api/runs/:id/evidence/:evidenceId/source',async(req,reply)=>{
    const id=uuid.parse(req.params.id),evidenceId=z.string().min(1).max(200).parse(req.params.evidenceId);
    const controller=new AbortController();const disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.once('close',disconnect);
    try{return await getEvidenceSource(store,id,evidenceId,AbortSignal.any([controller.signal,AbortSignal.timeout(85_000)]));}
    finally{reply.raw.removeListener('close',disconnect);}
  });
  app.get<{Params:{id:string;evidenceId:string}}>('/api/runs/:id/evidence/:evidenceId/document',async(req,reply)=>{
    const id=uuid.parse(req.params.id),evidenceId=z.string().min(1).max(200).parse(req.params.evidenceId);
    const controller=new AbortController();const disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.once('close',disconnect);
    let evidence;
    try{({evidence}=await getEvidenceSource(store,id,evidenceId,AbortSignal.any([controller.signal,AbortSignal.timeout(85_000)])));}
    finally{reply.raw.removeListener('close',disconnect);}
    const document=evidence.sourceDocument;
    if(!document||document.mimeType!=='application/pdf'||!/^[a-f0-9]{64}\.pdf$/.test(document.fileName)||document.fileName!==document.sha256+'.pdf')return reply.code(404).send({error:'这条证据当前保存的是正文文本，没有可打开的原始PDF文件'});
    const file=path.join(store.root,'source-documents',document.fileName);
    if(!fs.existsSync(file))return reply.code(404).send({error:'原始PDF缓存缺失，请重新获取这条证据'});
    const bytes=fs.readFileSync(file);
    if(createHash('sha256').update(bytes).digest('hex')!==document.sha256)throw new Error('原始PDF校验失败，未返回损坏内容');
    reply.header('Content-Disposition',`inline; filename="source-${document.sha256.slice(0,12)}.pdf"`);
    return reply.type('application/pdf').send(bytes);
  });
  app.get('/api/retrieval/status',async()=>retrievalStatus());
  let sourceCheck: Promise<ReturnType<typeof retrievalStatus>> | undefined;
  app.post('/api/retrieval/test',async()=>{
    sourceCheck ??= checkLiteratureSources(AbortSignal.timeout(15_000)).then(()=>retrievalStatus()).finally(()=>{sourceCheck=undefined;});
    return sourceCheck;
  });
  app.get('/api/projects',async()=>store.listProjects());
  app.post('/api/projects',async(req)=>store.createProject(z.object({name:z.string().trim().min(1).max(120)}).parse(req.body).name));
  const workspace=new WorkspaceService(store,engine,workspaceDependencies);
  for(const warning of workspace.recoverPending())console.warn(warning);
  registerWorkspaceRoutes(app,store,workspace);
  registerLibraryRoutes(app,store);
  registerPaperLibraryRoutes(app,store);
  app.get<{Params:{id:string}}>('/api/projects/:id/conversations',async(req)=>store.listConversations(uuid.parse(req.params.id)).map(publicConversation));
  app.post<{Params:{id:string}}>('/api/projects/:id/conversations',async(req)=>publicConversation(store.createConversation(uuid.parse(req.params.id),z.object({title:z.string().max(120).optional()}).parse(req.body??{}).title)));
  app.get<{Params:{id:string}}>('/api/conversations/:id',async(req)=>publicConversation(store.getConversation(uuid.parse(req.params.id))));
  app.get<{Params:{id:string}}>('/api/projects/:id/materials',async(req)=>store.getMaterials(uuid.parse(req.params.id)));
  app.put<{Params:{id:string}}>('/api/conversations/:id/materials',async(req)=>publicConversation(store.selectMaterials(uuid.parse(req.params.id),z.object({materialIds:z.array(uuid).max(30)}).parse(req.body).materialIds)));
  app.post<{Params:{id:string}}>('/api/conversations/:id/materials',async(req)=>{
    const conversationId=uuid.parse(req.params.id);store.assertConversationWritable(conversationId);let buffer:Buffer|undefined;let name='';let role:'evidence'|'method'|'format'='evidence';
    for await(const part of req.parts()){if(part.type==='file'){buffer=await part.toBuffer();name=path.basename(part.filename.replaceAll('\\','/')).slice(0,180);}else if(part.fieldname==='role')role=z.enum(['evidence','method','format']).parse(part.value);}
    if(!buffer||!name)throw new Error('请附上一份材料');
    const extracted=await extractMaterial(buffer,name);
    const c=store.assertConversationWritable(conversationId);
    if(c.materialIds.length>=30)throw new Error('单次对话最多选择30份材料，请先取消选择部分材料');
    const m=store.addMaterial(c.projectId,{name,role,size:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),...extracted});
    const uploadDir=path.join(store.root,'uploads');if(fs.existsSync(uploadDir))validateManagedTree(uploadDir,store.root);fs.mkdirSync(uploadDir,{recursive:true});fs.writeFileSync(path.join(uploadDir,m.id),buffer,{mode:0o600,flag:'wx'});
    store.selectMaterials(c.id,[...c.materialIds,m.id]);return m;
  });
  app.post<{Params:{id:string}}>('/api/conversations/:id/messages',async(req,reply)=>{
    const body=optionsSchema.extend({content:z.string().trim().min(1).max(30000),expectedConfirmationToken:z.string().regex(/^[a-f0-9]{64}$/).optional()}).parse(req.body);const {content,expectedConfirmationToken,...options}=body;
    const run=engine.submit(uuid.parse(req.params.id),content,options,{expectedConfirmationToken});void engine.execute(run.id);return reply.code(202).send(publicRun(run));
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/cancel',async(req)=>engine.cancel(uuid.parse(req.params.id)));
  app.post<{Params:{id:string}}>('/api/runs/:id/revisions',async(req,reply)=>{
    const run=engine.revise(uuid.parse(req.params.id),revisionInputSchema.parse(req.body));
    void engine.execute(run.id);return reply.code(202).send(publicRun(run));
  });
  app.post<{Params:{id:string}}>('/api/runs/:id/resume',async(req,reply)=>{
    const id=uuid.parse(req.params.id),body=z.object({instruction:z.string().max(30000).optional(),expectedConfirmationToken:z.string().regex(/^[a-f0-9]{64}$/).optional()}).parse(req.body??{});
    const run=engine.validateResume(id,body.instruction,body);
    void engine.resume(id,body.instruction,body).catch(()=>{});return reply.code(202).send(publicRun(run));
  });
  app.get('/api/methods',async()=>listMethods());
  app.get('/api/research-capabilities',async()=>researchCapabilities());
  app.get('/api/model-connections',async()=>connections.publicState());
  app.post('/api/model-connections',async(req)=>{connections.create(connectionInputSchema.parse(req.body));return connections.publicState();});
  app.put('/api/model-connections/active',async(req)=>connections.select(connectionSelectionSchema.parse(req.body)));
  app.put<{Params:{id:string}}>('/api/model-connections/:id',async(req)=>{connections.update(z.string().min(1).max(100).parse(req.params.id),connectionInputSchema.parse(req.body));return connections.publicState();});
  app.delete<{Params:{id:string}}>('/api/model-connections/:id',async(req)=>{connections.remove(z.string().min(1).max(100).parse(req.params.id));return connections.publicState();});
  app.post<{Params:{id:string}}>('/api/model-connections/:id/test',async(req)=>{
    const {model}=z.object({model:z.string().trim().min(1).max(150)}).strict().parse(req.body);
    return connections.test(z.string().min(1).max(100).parse(req.params.id),model);
  });
  app.get('/api/settings',async()=>connections.publicSettings());
  app.put('/api/settings',async(req)=>{
    return connections.saveLegacy(settingsSchema.parse(req.body));
  });
  app.get('/api/providers',async()=>providerStatus(config()));
  app.post('/api/providers/test',async(req)=>{
    const target=z.union([z.object({}).strict(),z.object({kind:z.enum(['codex','claude']),model:z.string().trim().max(150).refine(value=>!/[\u0000-\u001f\u007f]/.test(value))}).strict()]).parse(req.body??{});
    return connections.testActive(createProvider,undefined,target.kind?{kind:target.kind,model:target.model}:undefined);
  });
  app.get<{Params:{id:string;format:string}}>('/api/artifacts/:id/:format',async(req,reply)=>{
    const id=uuid.parse(req.params.id),format=z.enum(['md','html','docx','pdf']).parse(req.params.format),artifact=store.getArtifact(id);
    if(!artifact.formats.includes(format))return reply.code(404).send({error:'该文件格式尚未生成成功'});
    const file=path.join(store.root,'artifacts',`${id}.${format}`);if(!fs.existsSync(file))return reply.code(404).send({error:'成果文件缺失，正文仍保存在对话中'});
    validateManagedTree(file,store.root);
    const mime={md:'text/markdown; charset=utf-8',html:'text/html; charset=utf-8',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf'}[format];
    reply.header('Content-Disposition',`attachment; filename="zhicui-${id}.${format}"; filename*=UTF-8''${encodeURIComponent(artifact.title+'.'+format)}`);return reply.type(mime).send(fs.createReadStream(file));
  });
  app.addHook('onClose',async()=>{connections.stopTests();engine.stopAll();});
  return app;
}
