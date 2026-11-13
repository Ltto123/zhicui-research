import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { atomicJson } from './upstream/atomic-json';
import {resolveArtifactTitle} from './artifact-title';
import { buildTaskContext, effectiveTaskPrompt } from './task-context';
import { applyReferenceRequirement, classifyResearchContinuation, isPureContinuationInstruction } from './research-continuity';
import type { Project, Conversation, Material, Run, RunOptions, ModelConfig, Message, Artifact, RunEvent, RevisionInput } from '../shared/types';
import type { ConversationPatch, ProjectPatch, SavedArtifact, WorkspaceEntityKind, WorkspaceIndex, WorkspaceSection } from '../shared/workspace';

export const revisionInputSchema=z.object({
  issues:z.array(z.object({severity:z.enum(['error','warning']),location:z.string().trim().min(1).max(300),issue:z.string().trim().min(1).max(1200),suggestion:z.string().trim().min(1).max(1200)}).strict()).min(1).max(12),
  proofs:z.array(z.object({evidenceId:z.string().min(1).max(200),start:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),end:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),quote:z.string().min(1).max(3000)}).strict()).max(20).optional(),
}).strict().refine(value=>(value.proofs??[]).reduce((sum,proof)=>sum+proof.quote.length,0)<=24000,{message:'原文片段总长度超过24000字符',path:['proofs']});

export type SourceRun=Pick<Run,'id'|'conversationId'|'evidence'|'reading'>;
interface RetainedSourceAlias {artifactId:string;runId:string;evidenceIds:string[];}
interface State { version: 1; projects: Project[]; conversations: Conversation[]; materials: Material[]; options: Record<string, RunOptions>; optionOverrides?: Record<string, RunOptions>; sections?:WorkspaceSection[]; savedArtifacts?:SavedArtifact[]; retainedSources?:SourceRun[]; retainedSourceAliases?:RetainedSourceAlias[]; }
const active = new Set(['queued','running','awaiting_confirmation']);
const now = () => new Date().toISOString();
function sourceReferences(markdown:string):{runId:string;evidenceId:string}[] {
  const references=new Map<string,{runId:string;evidenceId:string}>(),add=(runId:string,evidenceId:string)=>{if(runId&&evidenceId)references.set(JSON.stringify([runId,evidenceId]),{runId,evidenceId});};
  for(const match of markdown.matchAll(/\/api\/runs\/([^\s/<>"'#?)]+)\/evidence\/([^\s/<>"'#?)]+)\/(?:source|document)/g))try{add(decodeURIComponent(match[1]),decodeURIComponent(match[2]));}catch{/* Malformed percent escapes are not a source identity. */}
  for(const match of markdown.matchAll(/\/source\?[^\s<>"')\]]+/g))try{const url=new URL(match[0].replaceAll('&amp;','&'),'http://localhost');if(url.searchParams.getAll('runId').length===1&&url.searchParams.getAll('evidenceId').length===1)add(url.searchParams.get('runId')!,url.searchParams.get('evidenceId')!);}catch{/* Non-URL prose is not a source reference. */}
  return [...references.values()];
}
function sourceScopeRank(run:SourceRun,source:Run['evidence'][number]):number {
  const text=source.text.trim(),notes=run.reading?.entries.find(entry=>entry.evidenceId===source.id)?.notes;
  if(source.readScope==='abstract')return text?1:0;
  if(source.readScope!=='full_text')return 0;
  const derived=!text||text===notes||/^\s*全文文字研读笔记[:：]/.test(text)||source.location.includes('全文文字已分块研读');
  return derived?(source.abstract?.trim()?1:0):2;
}
export class Store {
  private state: State;
  private readonly conversationLocks=new Set<string>();
  private readonly projectLocks=new Set<string>();
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root); fs.mkdirSync(this.root, {recursive:true});
    const file = path.join(this.root, 'state.json');
    // A corrupt store is never silently replaced with an empty project.
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {version:1,projects:[],conversations:[],materials:[],options:{}};
    if (this.state.version !== 1 || !Array.isArray(this.state.conversations)) throw new Error('不支持或损坏的资料库，请保留原文件检查');
    // Older deliveries inherited a planning title even after the manuscript
    // changed genre. Repair metadata only, including independent saved copies.
    for(const c of this.state.conversations)for(const artifact of c.artifacts)artifact.title=resolveArtifactTitle(artifact.markdown,artifact.title);
    for(const {artifact} of this.state.savedArtifacts??[])artifact.title=resolveArtifactTitle(artifact.markdown,artifact.title);
    for (const c of this.state.conversations) for (const r of c.runs) {
      if (r.status === 'running' || r.status === 'queued') {
        r.status='interrupted'; r.stage='服务重启，等待接续'; r.updatedAt=now();
        r.events.push({seq:r.events.length+1,type:'status',message:'服务重启，本次执行已中断；已保存的材料、证据和成果保留。',createdAt:now()});
      }
    }
    this.save();
  }
  private save() { atomicJson(path.join(this.root,'state.json'),this.state); }
  // Management writes never publish a half-written mutation to live readers.
  private commit(next:State) {
    atomicJson(path.join(this.root,'state.json'),next);
    // Publish only after durability, preserving live engine object references.
    // Metadata-only edits must not strand an executor on an obsolete run object.
    const reuse=<T extends {id:string}>(before:T[],after:T[])=>{const originals=new Map(before.map(item=>[item.id,item]));return after.map(item=>{const old=originals.get(item.id);if(!old)return item;const live=old as Record<string,unknown>;for(const key of Object.keys(old))if(!(key in item))delete live[key];for(const [key,value] of Object.entries(item))if(!isDeepStrictEqual(live[key],value))live[key]=value;return old;});};
    for(const conversation of next.conversations){const old=this.state.conversations.find(c=>c.id===conversation.id);if(old){conversation.runs=reuse(old.runs,conversation.runs);conversation.messages=reuse(old.messages,conversation.messages);conversation.artifacts=reuse(old.artifacts,conversation.artifacts);}}
    next.conversations=reuse(this.state.conversations,next.conversations);next.projects=reuse(this.state.projects,next.projects);next.materials=reuse(this.state.materials,next.materials);this.state=next;
  }
  listProjects() { return this.state.projects.filter(p=>!p.removedAt); }
  allProjects() { return this.state.projects; }
  allConversations() { return this.state.conversations; }
  getProject(id:string) { const p=this.state.projects.find(p=>p.id===id); if(!p) throw new Error('课题不存在'); return p; }
  createProject(name:string) { const p:Project={id:randomUUID(),name:name.trim().slice(0,120)||'未命名课题',createdAt:now()}; const next=structuredClone(this.state);next.projects.push(p);this.commit(next); return p; }
  listConversations(projectId:string) { this.getProject(projectId); return this.state.conversations.filter(c=>c.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)); }
  createConversation(projectId:string,title='新对话') { this.assertProjectWritable(projectId); const c:Conversation={id:randomUUID(),projectId,title,createdAt:now(),updatedAt:now(),materialIds:[],messages:[],runs:[],artifacts:[]}; this.state.conversations.push(c); this.save(); return c; }
  getConversation(id:string) { const c=this.state.conversations.find(c=>c.id===id); if(!c) throw new Error('对话不存在'); return c; }
  getMaterials(projectId:string) { this.getProject(projectId); return this.state.materials.filter(m=>m.projectId===projectId); }
  selectedMaterials(conversationId:string, ids?:string[]) { const c=this.getConversation(conversationId); const selected=ids ?? c.materialIds; const materials=selected.map(id=>this.state.materials.find(m=>m.id===id && m.projectId===c.projectId)); if(materials.some(m=>!m)) throw new Error('只能选择同一课题的已有材料'); return materials as Material[]; }
  selectMaterials(conversationId:string,ids:string[]) { const c=this.assertConversationWritable(conversationId); this.selectedMaterials(c.id,ids); c.materialIds=[...new Set(ids)]; c.updatedAt=now(); this.save(); return c; }
  addMaterial(projectId:string,input:Omit<Material,'id'|'projectId'|'createdAt'>) { this.assertProjectWritable(projectId); const m:Material={...input,id:randomUUID(),projectId,createdAt:now()}; this.state.materials.push(m); this.save(); return m; }
  message(conversationId:string,role:Message['role'],content:string,kind?:Message['kind'],runId?:string) { const c=this.getConversation(conversationId); const m:Message={id:randomUUID(),role,content,kind,runId,createdAt:now()}; c.messages.push(m); c.updatedAt=now(); this.save(); return m; }
  createRun(conversationId:string,prompt:string,config:ModelConfig,options:RunOptions={},restoreLegacyCheckpoint=true) {
    const c=this.assertConversationWritable(conversationId); if(c.runs.some(r=>active.has(r.status))) throw new Error('本对话的任务尚未结束，请先停止或接续');
    const id=randomUUID(),taskContext=buildTaskContext(c.runs,prompt,options.taskIntent,id),effectivePrompt=effectiveTaskPrompt(taskContext);
    const effectiveOptions:RunOptions={};
    if(taskContext.parentRunId){
      const rootIndex=c.runs.findIndex(run=>run.id===taskContext.rootRunId);
      const lineage=rootIndex>=0?c.runs.slice(rootIndex):c.runs.filter(run=>run.id===taskContext.parentRunId);
      // Legacy runs did not inherit omitted options. Fold only durable method
      // and format preferences across this goal's lineage, never taskIntent or
      // a stale selected-material snapshot.
      for(const previous of lineage){const saved=this.state.options[previous.id]??{};
        if(saved.methodMode!==undefined)effectiveOptions.methodMode=saved.methodMode;
        if(saved.methodInstructions!==undefined)effectiveOptions.methodInstructions=saved.methodInstructions;
        if(saved.formatInstructions!==undefined)effectiveOptions.formatInstructions=saved.formatInstructions;
        if(saved.waitForConfirmation!==undefined)effectiveOptions.waitForConfirmation=saved.waitForConfirmation;
      }
    }
    for(const [key,value] of Object.entries(options))if(value!==undefined)Object.assign(effectiveOptions,{[key]:value});
    const materials=this.selectedMaterials(c.id,options.materialIds);
    const r:Run={id,conversationId,prompt:effectivePrompt,taskContext,status:'queued',stage:'准备开始',createdAt:now(),updatedAt:now(),model:config.model,provider:config.kind,connectionId:config.connectionId,connectionName:config.connectionName,materialIds:materials.map(m=>m.id),events:[],evidence:[]};
    r.requirementOptions={...(options.methodInstructions!==undefined?{methodInstructions:options.methodInstructions}:{}),...(options.formatInstructions!==undefined?{formatInstructions:options.formatInstructions}:{})};
    c.runs.push(r); c.materialIds=r.materialIds; this.state.options[r.id]=effectiveOptions;
    (this.state.optionOverrides??={})[r.id]={...options};
    if(restoreLegacyCheckpoint)this.restoreResearchCheckpoint(r.id);
    if(c.messages.length===0) c.title=prompt.slice(0,36);
    this.message(c.id,'user',prompt,undefined,r.id); return r;
  }
  /** Restore a pure control continuation without changing its execution status.
   * Scientific/quantity/format changes use research-only restoration below. */
  private restoreControlCheckpoint(run:Run,c:Conversation):boolean {
    if(run.revision||run.draft||run.outline||!run.taskContext?.parentRunId)return false;
    const targetIndex=c.runs.indexOf(run),seen=new Set([run.id]);let parentId:string|undefined=run.taskContext.parentRunId;
    while(parentId&&!seen.has(parentId)){
      seen.add(parentId);const index=c.runs.findIndex(candidate=>candidate.id===parentId);
      if(index<0||index>=targetIndex)return false;
      const source=c.runs[index];
      if(classifyResearchContinuation(source,run)!=='same_research')return false;
      const added=run.taskContext.supplements.slice(source.taskContext?.supplements.length??0);
      if(!added.length||!added.every(isPureContinuationInstruction))return false;
      const sourceOptions=this.runOptions(source.id),nextOptions=this.runOptions(run.id);
      if(['methodMode','methodInstructions','formatInstructions'].some(key=>sourceOptions[key as keyof RunOptions]!==nextOptions[key as keyof RunOptions]))return false;
      if((['formatGuidelines','formatResolution','formatReview'] as const).some(key=>run[key]!==undefined&&!isDeepStrictEqual(run[key],source[key])))return false;
      // Do not silently revive an earlier failed version past a delivered one.
      if(['completed','limited'].includes(source.status))return false;
      if(source.plan&&(source.draft||source.outline||source.reading)){
        const empty=run.evidence.length===0;
        const unchangedSources=run.evidence.every(entry=>source.evidence.some(original=>isDeepStrictEqual(entry,original)));
        const noNewResearch=(['screening','fullTextRetrieval','retrievalExpansion','retrievalExpansionHistory'] as const).every(key=>run[key]===undefined||isDeepStrictEqual(run[key],source[key]))
          &&(!run.retrieval?.completedAt||isDeepStrictEqual(run.retrieval,source.retrieval));
        const oldSourceOnly=run.researchCheckpoint?.kind==='evidence_only'&&!run.reading?.entries.length&&unchangedSources&&noNewResearch;
        const researchOnly=run.researchCheckpoint?.kind==='same_research'&&(['evidence','retrieval','screening','fullTextRetrieval','reading'] as const).every(key=>isDeepStrictEqual(run[key],source[key]));
        if(!empty&&!oldSourceOnly&&!researchOnly)return false;
        const plan=structuredClone(source.plan);if(nextOptions.waitForConfirmation!==undefined)plan.waitForConfirmation=nextOptions.waitForConfirmation;
        const outlineConfirmed=nextOptions.waitForConfirmation===true&&!source.plan.waitForConfirmation?false:source.outlineConfirmed;
        this.updateRun(run.id,{plan,methodText:source.methodText,evidence:structuredClone(source.evidence),retrieval:structuredClone(source.retrieval),screening:structuredClone(source.screening),fullTextRetrieval:structuredClone(source.fullTextRetrieval),retrievalExpansion:structuredClone(source.retrievalExpansion),retrievalExpansionHistory:structuredClone(source.retrievalExpansionHistory),reading:structuredClone(source.reading),outline:structuredClone(source.outline),outlineConfirmed,draft:source.draft,review:structuredClone(source.review),progress:structuredClone(source.progress),
          pendingWritingTarget:structuredClone(source.pendingWritingTarget),formatGuidelines:structuredClone(source.formatGuidelines),formatResolution:structuredClone(source.formatResolution),formatReview:structuredClone(source.formatReview),
          researchCheckpoint:{kind:'same_research',sourceRunId:source.id,sourcePrompt:source.researchCheckpoint?.kind==='same_research'?source.researchCheckpoint.sourcePrompt:source.prompt}});
        this.event(run.id,'status','已识别为继续原任务：保留已有稿件、论证清单、审查问题与研读记录，从已保存阶段接续；未放宽引用数量或跳过复查。');
        return true;
      }
      parentId=source.taskContext?.parentRunId;
    }
    return false;
  }
  /** Explicit invocation restores a checkpoint only; it never starts a task.
   * A new scientific instruction never inherits an old draft or review. */
  restoreResearchCheckpoint(id:string):Run {
    const run=this.getRun(id),c=this.getConversation(run.conversationId),targetIndex=c.runs.indexOf(run);
    const external=(entry:Run['evidence'][number])=>['abstract','full_text','metadata'].includes(entry.readScope)&&Boolean(entry.text.trim());
    if(run.revision||!['queued','failed','interrupted','cancelled'].includes(run.status)||!run.taskContext?.parentRunId)return run;
    if(this.restoreControlCheckpoint(run,c))return run;
    if(run.evidence.some(external))return run;
    const rootId=run.taskContext.rootRunId,seen=new Set([run.id]);let parentId:string|undefined=run.taskContext.parentRunId;
    while(parentId&&!seen.has(parentId)){
      seen.add(parentId);const sourceIndex=c.runs.findIndex(candidate=>candidate.id===parentId);
      if(sourceIndex<0||sourceIndex>=targetIndex)break;
      const source=c.runs[sourceIndex];
      if((source.taskContext?.rootRunId??source.id)!==rootId)break;
      let kind=classifyResearchContinuation(source,run);
      if(kind==='none')return run;
      // A guideline may have been fetched before any literature or draft was
      // saved. Keep that closest source even when no scientific checkpoint exists.
      if(run.formatGuidelines===undefined&&source.formatGuidelines!==undefined)this.updateRun(id,{formatGuidelines:structuredClone(source.formatGuidelines),formatResolution:undefined,formatReview:undefined});
      if(source.plan&&source.evidence.some(external)&&!['format','local'].includes(source.plan.taskType)){
        const sourceOptions=this.runOptions(source.id),nextOptions=this.runOptions(run.id);
        // Scientific method or format changes require planning to honor the
        // new instruction; unchanged source bodies remain reusable evidence.
        if(['methodMode','methodInstructions','formatInstructions'].some(key=>sourceOptions[key as keyof RunOptions]!==nextOptions[key as keyof RunOptions]))kind='evidence_only';
        const same=kind==='same_research';
        const plan=same?applyReferenceRequirement(source.plan,run.prompt):undefined;
        if(plan&&nextOptions.waitForConfirmation!==undefined)plan.waitForConfirmation=nextOptions.waitForConfirmation;
        const patch:Partial<Run>={evidence:structuredClone(same?source.evidence:source.evidence.filter(external)),
          plan,methodText:same?source.methodText:undefined,retrieval:same?structuredClone(source.retrieval):undefined,
          screening:same?structuredClone(source.screening):undefined,fullTextRetrieval:same?structuredClone(source.fullTextRetrieval):undefined,
          retrievalExpansion:same?structuredClone(source.retrievalExpansion):undefined,retrievalExpansionHistory:same?structuredClone(source.retrievalExpansionHistory):undefined,reading:same?structuredClone(source.reading):undefined,
          formatGuidelines:structuredClone(run.formatGuidelines??source.formatGuidelines),formatResolution:undefined,formatReview:undefined,
          outline:undefined,outlineConfirmed:undefined,draft:undefined,review:undefined,revision:undefined,modelExecution:undefined,progress:undefined,failure:undefined,error:undefined,
          researchCheckpoint:{sourceRunId:source.id,sourcePrompt:same&&source.researchCheckpoint?.kind==='same_research'?source.researchCheckpoint.sourcePrompt:source.prompt,kind}};
        this.updateRun(id,patch);
        this.event(id,'status',same?'已接续同一研究任务保存的文献与研究进度；将按最新要求重新生成论证清单和成果。':'已保留同一研究任务的原始来源；研究约束发生变化，将重新规划与筛选，不沿用旧稿或科学判断。');
        return run;
      }
      parentId=source.taskContext?.parentRunId;
    }
    return run;
  }
  createRevisionRun(baseRunId:string,input:RevisionInput,config:ModelConfig):Run {
    const request=revisionInputSchema.parse(input),base=this.getRun(baseRunId),c=this.assertConversationWritable(base.conversationId);
    if(c.runs.some(run=>active.has(run.status)))throw new Error('本对话的任务尚未结束，不能同时创建修订版本');
    if(!['completed','limited'].includes(base.status)||!c.artifacts.some(artifact=>artifact.runId===base.id)||!base.plan||!base.outline||!base.draft?.trim()||base.plan.taskType==='format')throw new Error('只有已交付且保留原始草稿的研究任务可以定向修订');
    this.selectedMaterials(c.id,base.materialIds);
    for(const proof of request.proofs??[]){
      const matches=base.evidence.filter(source=>source.id===proof.evidenceId),source=matches[0];
      if(matches.length!==1||source.readScope!=='full_text'||!source.text.trim()||source.text===base.reading?.entries.find(entry=>entry.evidenceId===source.id)?.notes||/^\s*全文文字研读笔记[:：]/.test(source.text)||source.location.includes('全文文字已分块研读'))throw new Error(`原文片段 ${proof.evidenceId} 必须对应本任务唯一保存的真实正文`);
      if(proof.end<=proof.start||proof.end>source.text.length||proof.end-proof.start!==proof.quote.length||!proof.quote.trim()||source.text.slice(proof.start,proof.end)!==proof.quote)throw new Error(`原文片段 ${proof.evidenceId} 的字符位置或逐字内容不匹配`);
    }
    // Clone the server-owned snapshot only after all admission checks. The
    // request is a correction audit, never a new research prompt or evidence.
    const id=randomUUID(),createdAt=now(),context=base.taskContext??{rootRunId:base.id,rootPrompt:base.prompt,supplements:[]};
    const run:Run={...structuredClone(base),id,prompt:base.prompt,taskContext:{...structuredClone(context),parentRunId:base.id},status:'queued',stage:'准备定向修订已有成果',createdAt,updatedAt:createdAt,model:config.model,provider:config.kind,connectionId:config.connectionId,connectionName:config.connectionName,modelHistory:undefined,events:[],error:undefined,modelExecution:undefined,
      revision:{baseRunId:base.id,issues:structuredClone(request.issues),proofs:structuredClone(request.proofs??[]),phase:'pending',createdAt},requirementOptions:{},pendingWritingTarget:undefined,formatReview:undefined,review:{issues:structuredClone(request.issues),checks:[],limitations:[]}};
    c.runs.push(run);this.state.options[id]=structuredClone(this.runOptions(base.id));(this.state.optionOverrides??={})[id]=structuredClone(this.runExplicitOptions(base.id));c.updatedAt=createdAt;
    c.messages.push({id:randomUUID(),role:'user',content:'基于已交付成果定向修订，保留原研究目标与已取得资料：\n'+request.issues.map((issue,index)=>`${index+1}. ${issue.location}：${issue.issue}\n修订要求：${issue.suggestion}`).join('\n'),runId:id,createdAt});
    this.save();return run;
  }
  getRun(id:string) { for(const c of this.state.conversations) {const r=c.runs.find(r=>r.id===id);if(r)return r;} throw new Error('任务不存在'); }
  runOptions(id:string) {return this.state.options[id]??{};}
  runExplicitOptions(id:string) {return this.state.optionOverrides?.[id]??this.runOptions(id);}
  runRequirementOptions(id:string):Pick<RunOptions,'methodInstructions'|'formatInstructions'> {
    const run=this.getRun(id);if(run.requirementOptions)return run.requirementOptions;
    if(run.revision)return {};
    // Legacy resumes may already have cleared the override. Durable effective
    // options still identify changes from the previous run in the same task.
    const conversation=this.getConversation(run.conversationId),index=conversation.runs.indexOf(run),root=run.taskContext?.rootRunId??run.id;
    const parent=conversation.runs.slice(0,index).findLast(item=>item.id===run.taskContext?.parentRunId)
      ??conversation.runs.slice(0,index).findLast(item=>(item.taskContext?.rootRunId??item.id)===root);
    const effective=this.runOptions(id),previous=parent?this.runOptions(parent.id):{},explicit=this.state.optionOverrides?.[id]??{};
    const result:Pick<RunOptions,'methodInstructions'|'formatInstructions'>={};
    for(const key of ['methodInstructions','formatInstructions'] as const){
      if(explicit[key]!==undefined)result[key]=explicit[key];
      else if(effective[key]!==undefined&&effective[key]!==previous[key])result[key]=effective[key];
    }
    return result;
  }
  inheritRunOptions(id:string) {const run=this.getRun(id);this.assertConversationWritable(run.conversationId);run.requirementOptions??=structuredClone(this.runRequirementOptions(id));(this.state.optionOverrides??={})[id]={};this.save();}
  updateRun(id:string,patch:Partial<Run>,resume=false) { const r=this.getRun(id); if(resume||patch.status==='queued'||patch.status==='running'&&r.status!=='running')this.assertConversationWritable(r.conversationId); if(r.status==='cancelled' && patch.status && patch.status!=='cancelled' && !resume) throw new Error('已终止的任务不能重新完成'); Object.assign(r,patch,{id:r.id,conversationId:r.conversationId,updatedAt:now()}); this.getConversation(r.conversationId).updatedAt=now();this.save();return r; }
  event(id:string,type:RunEvent['type'],message:string) {const r=this.getRun(id); const event={seq:r.events.length+1,type,message:message.slice(0,5000),createdAt:now()};r.events.push(event);r.updatedAt=now();this.save();return event;}
  addArtifact(conversationId:string,artifact:Artifact) {const c=this.getConversation(conversationId); const old=c.artifacts.find(a=>a.runId===artifact.runId);if(old)return old; artifact.title=resolveArtifactTitle(artifact.markdown,artifact.title);c.artifacts.push(artifact);this.save();return artifact;}
  getArtifact(id:string) {for(const c of this.state.conversations){const a=c.artifacts.find(a=>a.id===id);if(a)return a;}const saved=this.state.savedArtifacts?.find(entry=>entry.artifact.id===id);if(saved)return saved.artifact;throw new Error('成果不存在');}
  workspaceIndex():WorkspaceIndex {
    const projects=this.listProjects(),ids=new Set(projects.map(p=>p.id));
    return structuredClone({projects,sections:(this.state.sections??[]).filter(s=>!s.projectId||ids.has(s.projectId)),conversations:this.state.conversations.filter(c=>ids.has(c.projectId)).map(c=>({id:c.id,projectId:c.projectId,title:c.title,createdAt:c.createdAt,updatedAt:c.updatedAt,pinned:c.pinned,archivedAt:c.archivedAt,unread:c.unread,sectionId:c.sectionId,latestStatus:c.runs.at(-1)?.status,messageCount:c.messages.length,artifactCount:c.artifacts.length}))});
  }
  defaultProject():Project {
    const existing=this.state.projects.find(p=>p.isDefault&&!p.removedAt&&!p.archivedAt);if(existing){this.assertProjectWritable(existing.id);return existing;}
    const next=structuredClone(this.state),p:Project={id:randomUUID(),name:'默认课题',createdAt:now(),isDefault:true};
    // Only one usable project owns the default role; historical folders remain.
    for(const old of next.projects)if(old.isDefault)old.isDefault=false;
    next.projects.push(p);this.commit(next);return this.getProject(p.id);
  }
  private assertProjectPresent(id:string):Project {const p=this.getProject(id);if(p.removedAt)throw new Error('课题已移除，保存的资料仍可读取');return p;}
  assertProjectUnlocked(id:string):void {if(this.projectLocks.has(id))throw new Error('课题正在执行管理操作，请稍后重试');}
  private assertConversationUnlocked(id:string) {const c=this.getConversation(id);this.assertProjectUnlocked(c.projectId);if(this.conversationLocks.has(id))throw new Error('对话正在执行管理操作，请稍后重试');}
  assertProjectWritable(id:string):Project {const p=this.assertProjectPresent(id);this.assertProjectUnlocked(id);if(p.archivedAt)throw new Error('课题已归档，请先恢复');return p;}
  assertConversationWritable(id:string):Conversation {const c=this.getConversation(id);this.assertProjectWritable(c.projectId);this.assertConversationUnlocked(id);if(c.archivedAt)throw new Error('对话已归档，请先恢复');return c;}
  acquireWorkspaceLock(conversationIds:string[],projectIds:string[]):()=>void {
    const cIds=new Set(conversationIds),pIds=new Set(projectIds);
    for(const id of cIds){const c=this.getConversation(id);this.assertConversationUnlocked(id);this.assertProjectPresent(c.projectId);}
    for(const id of pIds){this.assertProjectPresent(id);this.assertProjectUnlocked(id);if(this.state.conversations.some(c=>c.projectId===id&&this.conversationLocks.has(c.id)))throw new Error('课题中的对话正在执行管理操作，请稍后重试');}
    for(const id of cIds)this.conversationLocks.add(id);for(const id of pIds)this.projectLocks.add(id);
    let released=false;return ()=>{if(released)return;released=true;for(const id of cIds)this.conversationLocks.delete(id);for(const id of pIds)this.projectLocks.delete(id);};
  }
  private sectionFor(id:string|null|undefined,projectId?:string):string|undefined {
    if(!id)return undefined;const section=this.state.sections?.find(s=>s.id===id);if(!section||section.projectId!==projectId)throw new Error('分区不存在或不属于此范围');return section.id;
  }
  updateProject(id:string,patch:ProjectPatch):Project {this.assertProjectUnlocked(id);return this.commitProjectUpdate(id,patch);}
  commitProjectUpdate(id:string,patch:ProjectPatch):Project {
    this.assertProjectPresent(id);if(patch.archived===true&&this.state.conversations.some(c=>c.projectId===id&&c.runs.some(r=>active.has(r.status))))throw new Error('课题仍有活动任务，请先停止并等待结束');
    const sectionId=patch.sectionId!==undefined?this.sectionFor(patch.sectionId):undefined,next=structuredClone(this.state),p=next.projects.find(p=>p.id===id)!;
    if(patch.name!==undefined){if(!patch.name.trim())throw new Error('课题名称不能为空');p.name=patch.name.trim().slice(0,120);}
    if(patch.description!==undefined)p.description=patch.description.slice(0,2000);if(patch.pinned!==undefined)p.pinned=patch.pinned;if(patch.archived!==undefined)p.archivedAt=patch.archived?(p.archivedAt??now()):undefined;if(patch.sectionId!==undefined)p.sectionId=sectionId;p.updatedAt=now();this.commit(next);return this.getProject(id);
  }
  updateConversation(id:string,patch:ConversationPatch):Conversation {this.assertConversationUnlocked(id);return this.commitConversationUpdate(id,patch);}
  commitConversationUpdate(id:string,patch:ConversationPatch):Conversation {
    const original=this.getConversation(id);this.assertProjectPresent(original.projectId);if(patch.archived===true&&original.runs.some(r=>active.has(r.status)))throw new Error('对话仍有活动任务，请先停止并等待结束');
    const sectionId=patch.sectionId!==undefined?this.sectionFor(patch.sectionId,original.projectId):undefined,next=structuredClone(this.state),c=next.conversations.find(c=>c.id===id)!;
    if(patch.title!==undefined){if(!patch.title.trim())throw new Error('对话名称不能为空');c.title=patch.title.trim().slice(0,200);}
    if(patch.pinned!==undefined)c.pinned=patch.pinned;if(patch.unread!==undefined)c.unread=patch.unread;if(patch.archived!==undefined)c.archivedAt=patch.archived?(c.archivedAt??now()):undefined;if(patch.sectionId!==undefined)c.sectionId=sectionId;c.updatedAt=now();this.commit(next);return this.getConversation(id);
  }
  createSection(name:string,projectId?:string):WorkspaceSection {
    if(projectId)this.assertProjectWritable(projectId);if(!name.trim())throw new Error('分区名称不能为空');const next=structuredClone(this.state),section:WorkspaceSection={id:randomUUID(),name:name.trim().slice(0,80),projectId,createdAt:now()};(next.sections??=[]).push(section);this.commit(next);return section;
  }
  updateSection(id:string,patch:{name:string}):WorkspaceSection {
    const original=this.state.sections?.find(s=>s.id===id);if(!original)throw new Error('分区不存在');if(original.projectId)this.assertProjectWritable(original.projectId);if(!patch.name.trim())throw new Error('分区名称不能为空');const next=structuredClone(this.state),section=next.sections!.find(s=>s.id===id)!;section.name=patch.name.trim().slice(0,80);this.commit(next);return section;
  }
  removeSection(id:string):void {
    const original=this.state.sections?.find(s=>s.id===id);if(!original)throw new Error('分区不存在');if(original.projectId)this.assertProjectWritable(original.projectId);
    for(const c of this.state.conversations)if(c.sectionId===id)this.assertConversationUnlocked(c.id);for(const p of this.state.projects)if(p.sectionId===id)this.assertProjectUnlocked(p.id);
    const next=structuredClone(this.state);next.sections=next.sections?.filter(s=>s.id!==id);for(const p of next.projects)if(p.sectionId===id)delete p.sectionId;for(const c of next.conversations)if(c.sectionId===id)delete c.sectionId;this.commit(next);
  }
  // Every copied path is server-derived, a direct child of a known data
  // directory, and checked against symlinks before file bytes are accessed.
  private managedFile(directory:'uploads'|'artifacts',name:string):string {
    if(!/^[a-zA-Z0-9_-]+(?:\.(?:md|html|docx|pdf))?$/.test(name))throw new Error('资料文件标识无效');
    const base=path.join(this.root,directory);if(fs.existsSync(base)){const stat=fs.lstatSync(base);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('资料目录不能是链接或其他文件');if(path.resolve(fs.realpathSync(base))!==path.resolve(base))throw new Error('资料目录不在可信数据路径');}
    const file=path.join(base,name);if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('资料文件不能是链接或其他对象');}return file;
  }
  private copyManagedFiles(copies:{directory:'uploads'|'artifacts';from:string;to:string;transform?:(text:string)=>string}[],commit:()=>void):void {
    const created:string[]=[];
    try{for(const copy of copies){const source=this.managedFile(copy.directory,copy.from),target=this.managedFile(copy.directory,copy.to);if(!fs.existsSync(source))continue;fs.mkdirSync(path.dirname(target),{recursive:true});if(copy.transform)fs.writeFileSync(target,copy.transform(fs.readFileSync(source,'utf8')),{flag:'wx',mode:0o600});else fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);created.push(target);}commit();}
    catch(error){for(const file of created)try{fs.unlinkSync(file);}catch{/* Only newly created copies are disposable. */}throw error;}
  }
  private rewriteSnapshot<T>(value:T,ids:Map<string,string>):T {
    // ID fields and references may occur in lineage, options, evidence, prompts
    // and local source URLs. UUID replacements are exact, never substring IDs.
    const rewrite=(input:unknown):unknown=>{if(typeof input==='string'){if(ids.has(input))return ids.get(input)!;return input.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>ids.get(id)??id);}if(Array.isArray(input))return input.map(rewrite);if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).map(([key,entry])=>[ids.get(key)??key,rewrite(entry)]));return input;};return rewrite(value) as T;
  }
  moveConversation(id:string,targetProjectId:string):Conversation {this.assertConversationWritable(id);this.assertProjectWritable(targetProjectId);return this.commitConversationMove(id,targetProjectId);}
  commitConversationMove(id:string,targetProjectId:string):Conversation {
    const original=this.getConversation(id),sourceProject=this.assertProjectPresent(original.projectId),target=this.assertProjectPresent(targetProjectId);if(sourceProject.archivedAt||original.archivedAt||target.archivedAt)throw new Error('归档项目或对话必须先恢复再移动');if(original.runs.some(r=>active.has(r.status)))throw new Error('对话仍有活动任务，请先停止并等待结束');if(original.projectId===targetProjectId)return original;
    const next=structuredClone(this.state),ids=new Map<string,string>(),used=new Set(original.materialIds),runIds=new Set(original.runs.map(r=>r.id));
    const collect=(input:unknown,key?:string):void=>{if(Array.isArray(input)){for(const entry of input)collect(entry,key);return;}if(input&&typeof input==='object'){for(const [name,value] of Object.entries(input))collect(value,name);return;}if(typeof input==='string'&&(key==='materialId'||key==='materialIds'))used.add(input);};collect(original);for(const runId of runIds){collect(this.state.options[runId]);collect(this.state.optionOverrides?.[runId]);}
    const copies:{directory:'uploads';from:string;to:string}[]=[];
    for(const materialId of used){const source=this.state.materials.find(m=>m.id===materialId&&m.projectId===original.projectId);if(!source)throw new Error('对话引用的材料缺失，不能安全移动');const cloned={...structuredClone(source),id:randomUUID(),projectId:targetProjectId};ids.set(source.id,cloned.id);next.materials.push(cloned);copies.push({directory:'uploads',from:source.id,to:cloned.id});}
    const moved=this.rewriteSnapshot(original,ids);moved.projectId=targetProjectId;delete moved.sectionId;moved.updatedAt=now();next.conversations[next.conversations.findIndex(c=>c.id===id)]=moved;for(const runId of runIds){if(next.options[runId])next.options[runId]=this.rewriteSnapshot(next.options[runId],ids);if(next.optionOverrides?.[runId])next.optionOverrides[runId]=this.rewriteSnapshot(next.optionOverrides[runId],ids);}
    this.copyManagedFiles(copies,()=>this.commit(next));return this.getConversation(id);
  }
  forkConversation(id:string):Conversation {
    const original=this.assertConversationWritable(id),next=structuredClone(this.state),ids=new Map<string,string>([[id,randomUUID()]]);
    for(const r of original.runs)ids.set(r.id,randomUUID());for(const m of original.messages)ids.set(m.id,randomUUID());for(const a of original.artifacts)ids.set(a.id,randomUUID());
    const fork=this.rewriteSnapshot(original,ids);fork.forkedFrom=id;fork.title=(original.title+'（分叉）').slice(0,200);fork.createdAt=now();fork.updatedAt=now();delete fork.pinned;delete fork.unread;delete fork.archivedAt;
    for(const run of fork.runs){delete run.agent;delete run.modelExecution;delete run.modelHistory;delete run.connectionId;delete run.connectionName;delete run.writingReview;delete run.writingReviewCheckpoint;delete run.writingOutline;delete run.writingPatch;delete run.outlineConfirmed;if(active.has(run.status)){run.status='interrupted';run.stage='已分叉保存快照，等待手动接续';}run.updatedAt=now();}
    for(const run of original.runs){const newId=ids.get(run.id)!;if(this.state.options[run.id])next.options[newId]=this.rewriteSnapshot(this.state.options[run.id],ids);if(this.state.optionOverrides?.[run.id])(next.optionOverrides??={})[newId]=this.rewriteSnapshot(this.state.optionOverrides[run.id],ids);}
    // Older binary exports can contain reader URLs which cannot be rewritten
    // without re-rendering. Preserve a read-only source alias for those links;
    // no execution, session, draft or writable artifact path is retained here.
    const binary=original.artifacts.filter(a=>a.formats.some(format=>format==='docx'||format==='pdf'));
    for(const artifact of binary){
      const artifactId=ids.get(artifact.id)!,inherited=this.state.retainedSourceAliases?.filter(alias=>alias.artifactId===artifact.id)??[];
      // Binary copies preserve their actual old hyperlinks across every fork,
      // even though the visible Markdown now links to the new run identities.
      if(inherited.length){for(const alias of inherited)(next.retainedSourceAliases??=[]).push({...structuredClone(alias),artifactId});continue;}
      const record=(run:SourceRun,evidenceIds:string[])=>this.retainArtifactSource(next,artifactId,run,evidenceIds);
      const own=original.runs.find(run=>run.id===artifact.runId);if(own)record(own,own.evidence.map(e=>e.id));
      for(const {runId,evidenceId} of sourceReferences(artifact.markdown)){const linked=this.state.conversations.flatMap(c=>c.runs).find(run=>run.id===runId)??this.state.retainedSources?.find(run=>run.id===runId);if(linked)record(linked,[evidenceId]);}
    }
    next.conversations.push(fork);const copies:{directory:'artifacts';from:string;to:string;transform?:(text:string)=>string}[]=[];for(const a of original.artifacts)for(const format of ['md','html','docx','pdf'] as const)copies.push({directory:'artifacts',from:a.id+'.'+format,to:ids.get(a.id)!+'.'+format,...(['md','html'].includes(format)?{transform:(text:string)=>this.rewriteSnapshot(text,ids)}:{})});
    this.copyManagedFiles(copies,()=>this.commit(next));return this.getConversation(fork.id);
  }
  saveArtifact(id:string):SavedArtifact {
    const existing=this.state.savedArtifacts?.find(entry=>entry.artifact.id===id);
    const c=this.state.conversations.find(c=>c.artifacts.some(a=>a.id===id));if(!c){if(existing)return structuredClone(existing);throw new Error('成果不存在');}this.assertConversationUnlocked(c.id);const p=this.assertProjectPresent(c.projectId),entry:SavedArtifact=existing??{artifact:structuredClone(this.getArtifact(id)),projectId:p.id,projectName:p.name,savedAt:now()},next=structuredClone(this.state);if(!existing)(next.savedArtifacts??=[]).push(entry);
    const run=c.runs.find(r=>r.id===entry.artifact.runId);if(run)this.retainArtifactSource(next,id,run,run.evidence.map(e=>e.id));
    for(const {runId,evidenceId} of sourceReferences(entry.artifact.markdown)){const linked=this.state.conversations.flatMap(chat=>chat.runs).find(candidate=>candidate.id===runId)??this.state.retainedSources?.find(candidate=>candidate.id===runId);if(linked)this.retainArtifactSource(next,id,linked,[evidenceId]);}
    if(!isDeepStrictEqual(this.state,next))this.commit(next);return structuredClone(entry);
  }
  listSavedArtifacts():SavedArtifact[] {return structuredClone(this.state.savedArtifacts??[]);}
  retainCollectedSource(runId:string,evidenceId:string):void {
    const run=this.getRun(runId),conversation=this.getConversation(run.conversationId);this.assertConversationUnlocked(conversation.id);this.assertProjectPresent(conversation.projectId);
    if(run.evidence.filter(source=>source.id===evidenceId).length!==1)throw new Error('该任务中不存在唯一对应的证据');
    const next=structuredClone(this.state);this.retainSource(next,run,new Set([evidenceId]));if(!isDeepStrictEqual(this.state,next))this.commit(next);
  }
  getSourceRun(id:string):SourceRun {for(const c of this.state.conversations){const run=c.runs.find(r=>r.id===id);if(run)return run;}const retained=this.state.retainedSources?.find(r=>r.id===id);if(retained)return retained;throw new Error('原文来源不存在');}
  private retainArtifactSource(next:State,artifactId:string,run:SourceRun,evidenceIds:string[]):void {
    this.retainSource(next,run,new Set(evidenceIds));const existing=next.retainedSourceAliases?.find(alias=>alias.artifactId===artifactId&&alias.runId===run.id);
    if(existing)existing.evidenceIds=[...new Set([...existing.evidenceIds,...evidenceIds])];else(next.retainedSourceAliases??=[]).push({artifactId,runId:run.id,evidenceIds:[...evidenceIds]});
  }
  private retainSource(next:State,run:SourceRun,wanted:Set<string>):void {
    const evidence=run.evidence.filter(e=>wanted.has(e.id));if(!evidence.length)return;
    const previous=next.retainedSources?.find(entry=>entry.id===run.id),retained:SourceRun=previous??{id:run.id,conversationId:run.conversationId,evidence:[]};
    const fresh=new Set(evidence.filter(entry=>{const old=retained.evidence.find(old=>old.id===entry.id);return !old||sourceScopeRank(run,entry)>sourceScopeRank(retained,old);}).map(entry=>entry.id));
    for(const entry of evidence)if(fresh.has(entry.id)){const index=retained.evidence.findIndex(old=>old.id===entry.id);if(index<0)retained.evidence.push(structuredClone(entry));else retained.evidence[index]=structuredClone(entry);}
    if(retained.reading&&fresh.size){retained.reading.entries=retained.reading.entries.filter(entry=>!fresh.has(entry.evidenceId));if(retained.reading.partialEntries)retained.reading.partialEntries=retained.reading.partialEntries.filter(entry=>!fresh.has(entry.evidenceId));}
    if(run.reading&&fresh.size){retained.reading??={version:run.reading.version,entries:[]};for(const entry of run.reading.entries.filter(entry=>fresh.has(entry.evidenceId)))retained.reading.entries.push(structuredClone(entry));for(const entry of run.reading.partialEntries??[])if(fresh.has(entry.evidenceId))(retained.reading.partialEntries??=[]).push(structuredClone(entry));}
    if(!previous)(next.retainedSources??=[]).push(retained);
  }
  workspaceDeletionSnapshot(kind:WorkspaceEntityKind,id:string):{projects:Project[];conversations:Conversation[];options:Record<string,RunOptions>;optionOverrides:Record<string,RunOptions>} {
    const conversations=kind==='project'?(this.assertProjectPresent(id),this.state.conversations.filter(c=>c.projectId===id)):[this.getConversation(id)],runIds=new Set(conversations.flatMap(c=>c.runs.map(r=>r.id)));
    return structuredClone({projects:kind==='project'?[this.getProject(id)]:[],conversations,options:Object.fromEntries(Object.entries(this.state.options).filter(([runId])=>runIds.has(runId))),optionOverrides:Object.fromEntries(Object.entries(this.state.optionOverrides??{}).filter(([runId])=>runIds.has(runId)))});
  }
  commitWorkspaceDeletion(kind:WorkspaceEntityKind,id:string,retainedRequests:{runId:string;evidenceIds:string[]}[]):void {
    const snapshot=this.workspaceDeletionSnapshot(kind,id);if(snapshot.conversations.some(c=>c.runs.some(r=>active.has(r.status))))throw new Error('仍有活动任务，请先停止并等待结束');
    const next=structuredClone(this.state),removedIds=new Set(snapshot.conversations.map(c=>c.id)),runs=snapshot.conversations.flatMap(c=>c.runs),runIds=new Set(runs.map(r=>r.id)),requests=new Map<string,Set<string>>();
    for(const request of retainedRequests){if(!runIds.has(request.runId))continue;const wanted=requests.get(request.runId)??new Set<string>();for(const evidenceId of request.evidenceIds)wanted.add(evidenceId);requests.set(request.runId,wanted);}
    for(const saved of this.state.savedArtifacts??[]){const run=runs.find(r=>r.id===saved.artifact.runId);if(run)requests.set(run.id,new Set(run.evidence.map(e=>e.id)));for(const {runId,evidenceId} of sourceReferences(saved.artifact.markdown)){if(!runIds.has(runId))continue;const wanted=requests.get(runId)??new Set<string>();wanted.add(evidenceId);requests.set(runId,wanted);}}
    const survivingArtifacts=new Set([...next.conversations.filter(c=>!removedIds.has(c.id)).flatMap(c=>c.artifacts.map(a=>a.id)),...(next.savedArtifacts??[]).map(saved=>saved.artifact.id)]);
    next.retainedSourceAliases=next.retainedSourceAliases?.filter(alias=>survivingArtifacts.has(alias.artifactId));
    for(const alias of next.retainedSourceAliases??[])if(runIds.has(alias.runId)){const wanted=requests.get(alias.runId)??new Set<string>();for(const evidenceId of alias.evidenceIds)wanted.add(evidenceId);requests.set(alias.runId,wanted);}
    // Early workspace snapshots did not record binary-alias ownership. Retain
    // an existing source snapshot conservatively while its binary fork lives.
    if(this.state.retainedSourceAliases===undefined)for(const source of next.retainedSources??[]){if(!runIds.has(source.id))continue;const referenced=next.conversations.some(c=>!removedIds.has(c.id)&&c.forkedFrom===source.conversationId&&c.artifacts.some(a=>a.formats.some(format=>format==='pdf'||format==='docx')));if(referenced){const wanted=requests.get(source.id)??new Set<string>();for(const evidence of source.evidence)wanted.add(evidence.id);requests.set(source.id,wanted);}}
    // A failed library write may have left an unreferenced staged snapshot.
    // Only references confirmed by this deletion transaction justify retaining
    // sources belonging to the runs being removed.
    next.retainedSources=next.retainedSources?.flatMap(source=>{
      if(!runIds.has(source.id))return [source];const wanted=requests.get(source.id),evidence=source.evidence.filter(entry=>wanted?.has(entry.id));if(!evidence.length)return [];
      const retained:SourceRun={...source,evidence};
      if(source.reading){retained.reading={...source.reading,entries:source.reading.entries.filter(entry=>wanted?.has(entry.evidenceId))};if(source.reading.partialEntries)retained.reading.partialEntries=source.reading.partialEntries.filter(entry=>wanted?.has(entry.evidenceId));}
      return [retained];
    });
    for(const run of runs){const wanted=requests.get(run.id);if(wanted?.size)this.retainSource(next,run,wanted);delete next.options[run.id];if(next.optionOverrides)delete next.optionOverrides[run.id];}
    next.conversations=next.conversations.filter(c=>!removedIds.has(c.id));if(kind==='project'){const project=next.projects.find(p=>p.id===id)!;project.removedAt=now();project.updatedAt=now();next.sections=next.sections?.filter(section=>section.projectId!==id);}this.commit(next);
  }
  readSettings():Partial<ModelConfig> {const file=path.join(this.root,'settings.json'); return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};}
  writeSettings(config:ModelConfig) {atomicJson(path.join(this.root,'settings.json'),config);}
}
