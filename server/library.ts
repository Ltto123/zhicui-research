import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from './store';
import type {Evidence} from '../shared/types';
import type {LibraryItem,LibraryOrigin,LibraryReadScope,LibraryUpdate} from '../shared/library';
import {atomicJson} from './upstream/atomic-json';

const MAX_BYTES=32*1024*1024;
const MAX_ITEMS_PER_PROJECT=1000;
const MAX_ORIGINS=50;
const scopeSchema=z.enum(['metadata','abstract','full_text']);
const noControls=(text:string)=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
const identifier=z.string().min(1).max(200).refine(noControls);
const tagSchema=z.string().max(200).transform(value=>value.normalize('NFKC').replace(/\s+/gu,' ').trim()).pipe(z.string().min(1).max(40)).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const revisionSchema=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1);
const updateSchema=z.object({revision:revisionSchema,tags:z.array(tagSchema).max(12).optional(),note:z.string().max(10000).refine(noControls).optional(),readingStatus:z.enum(['unread','reading','read']).optional()}).strict();
const originSchema=z.object({runId:identifier,conversationId:identifier,evidenceId:identifier,readScope:scopeSchema}).strict();
const itemSchema=z.object({
 id:identifier,projectId:identifier,title:z.string().min(1).max(2000).refine(noControls),authors:z.string().max(4000).optional(),year:z.string().max(64).optional(),journal:z.string().max(1000).optional(),
 doi:z.string().max(1000).optional(),url:z.string().max(4000).optional(),abstract:z.string().max(50000).optional(),readScope:scopeSchema,origins:z.array(originSchema).min(1).max(MAX_ORIGINS),
 tags:z.array(tagSchema).max(12),note:z.string().max(10000).refine(noControls),readingStatus:z.enum(['unread','reading','read']),revision:revisionSchema,createdAt:z.string().datetime(),updatedAt:z.string().datetime(),
}).strict();
const stateSchema=z.object({version:z.literal(1),items:z.array(itemSchema)}).strict();
interface LibraryState {version:1;items:LibraryItem[];}
const scopeRank:Record<LibraryReadScope,number>={metadata:0,abstract:1,full_text:2};
const now=()=>new Date().toISOString();
function fail(message:string,statusCode=400):never {throw Object.assign(new Error(message),{statusCode});}
function parse<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);if(!result.success)fail('文献夹请求字段无效或超出长度限制');return result.data;}
function field(value:unknown):string|undefined {return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()||undefined:undefined;}
export function normalizeDoi(input:unknown):string|undefined {
 let value=field(input);if(!value)return;
 value=value.replace(/^doi\s*:\s*/i,'');
 if(/^https?:\/\//i.test(value)){
  try{const url=new URL(value);if(!['doi.org','dx.doi.org'].includes(url.hostname.toLowerCase())||url.username||url.password||url.search||url.hash)return;value=decodeURIComponent(url.pathname.slice(1));}catch{return;}
 }
 return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(value)&&value.length<=1000?value.toLowerCase():undefined;
}
function normalizeUrl(input:unknown):string|undefined {
 const value=field(input);if(!value||value.length>4000)return;
 try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;url.hash='';return url.href;}catch{return;}
}
function sameOrigin(a:LibraryOrigin,b:LibraryOrigin):boolean {return a.runId===b.runId&&a.conversationId===b.conversationId&&a.evidenceId===b.evidenceId;}
function stronger(a:LibraryReadScope,b:LibraryReadScope):LibraryReadScope {return scopeRank[a]>=scopeRank[b]?a:b;}
export function sourceContent(source:Evidence,notes:readonly string[]):Pick<LibraryItem,'abstract'|'readScope'> {
 const declared=parse(scopeSchema,source.readScope),text=typeof source.text==='string'?source.text.trim():'';
 const derivedNotes=new Set(notes.filter(note=>typeof note==='string').map(note=>note.trim()).filter(Boolean));
 // Legacy runs sometimes replaced the original body with generated notes but
 // retained full_text. Mirror sources.ts's original-text exclusions locally;
 // importing that module would unnecessarily load its retrieval dependencies.
 const derived=(value:string)=>/^全文文字研读笔记[:：]/.test(value)||derivedNotes.has(value)
  ||Boolean(text&&value===text&&source.location?.includes('全文文字已分块研读'));
 const validAbstract=(value:unknown):string|undefined=>{const candidate=typeof value==='string'?value.trim():'';return candidate&&!derived(candidate)?candidate:undefined;};
 const abstract=validAbstract(source.abstract)??(declared==='abstract'?validAbstract(text):undefined);
 const readScope=declared==='metadata'?'metadata':declared==='full_text'&&text&&!derived(text)?'full_text':abstract?'abstract':'metadata';
 return {abstract,readScope};
}
function sourceFields(source:Evidence,notes:readonly string[]):Pick<LibraryItem,'title'|'authors'|'year'|'journal'|'doi'|'url'|'abstract'|'readScope'> {
 const title=field(source.title);
 if(!title)fail('论文题名缺失，不能收藏');
 return {title,authors:field(source.authors),year:field(source.year),journal:field(source.journal),doi:normalizeDoi(source.doi),url:normalizeUrl(source.url),...sourceContent(source,notes)};
}

/** Small, explicit user collections. Every operation reads the latest complete
 * file; failed writes cannot leak into an in-memory cache or overwrite notes
 * based on another LibraryStore instance's stale revision. */
export class LibraryStore {
 private readonly file:string;
 constructor(private readonly store:Store){this.file=path.join(store.root,'library.json');}
 private project(projectId:string):void {
  if(typeof projectId!=='string'||!projectId||projectId.length>200)fail('课题标识无效');
  try{this.store.getProject(projectId);}catch{fail('课题不存在',404);}
 }
 private read():LibraryState {
  let raw:string;
  try{
   const stat=fs.lstatSync(this.file);
   if(!stat.isFile()||stat.isSymbolicLink())fail('文献夹文件不是普通资料文件；已保留原文件',500);
   if(stat.size>MAX_BYTES)fail('文献夹超过 32 MB 上限，请先备份检查',413);
   raw=fs.readFileSync(this.file,'utf8');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,items:[]};throw error;}
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{fail('文献夹文件损坏，已保留原文件；请先备份检查',500);}
  const result=stateSchema.safeParse(parsed);if(!result.success)fail('文献夹版本不支持或资料损坏，已保留原文件',500);
  const ids=new Set<string>(),counts=new Map<string,number>();
  for(const item of result.data.items){
   if(ids.has(item.id))fail('文献夹包含重复标识，资料损坏；已保留原文件',500);ids.add(item.id);
   counts.set(item.projectId,(counts.get(item.projectId)??0)+1);
   if(counts.get(item.projectId)!>MAX_ITEMS_PER_PROJECT)fail('课题文献夹超过 1000 条上限，请先备份检查',413);
   if(item.doi&&normalizeDoi(item.doi)!==item.doi||item.url&&normalizeUrl(item.url)!==item.url)fail('文献夹来源标识损坏，已保留原文件',500);
   if(new Set(item.origins.map(origin=>JSON.stringify([origin.runId,origin.conversationId,origin.evidenceId]))).size!==item.origins.length)fail('文献夹来源重复，资料损坏；已保留原文件',500);
  }
  return result.data;
 }
 private write(state:LibraryState):void {
  if(Buffer.byteLength(JSON.stringify(state,null,2)+'\n','utf8')>MAX_BYTES)fail('文献夹超过 32 MB 上限，本次修改未保存',413);
  try{atomicJson(this.file,state);}catch{fail('文献夹保存失败，原有完整文件仍保留；请检查本机文件权限或磁盘空间',500);}
 }
 list(projectId:string):LibraryItem[]{this.project(projectId);return this.read().items.filter(item=>item.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 collect(projectId:string,input:{runId:string;evidenceId:string}):{item:LibraryItem;created:boolean}{
  this.project(projectId);this.store.assertProjectUnlocked(projectId);const request=parse(z.object({runId:identifier,evidenceId:identifier}).strict(),input);
  // Scan identities only, so a duplicated run ID cannot point a collection at
  // the first matching run from another project.
  const matches=this.store.listProjects().flatMap(project=>this.store.listConversations(project.id).flatMap(conversation=>conversation.runs.filter(run=>run.id===request.runId).map(run=>({conversation,run}))));
  if(!matches.length)fail('当前课题中找不到该任务',404);if(matches.length!==1)fail('任务标识存在歧义，不能收藏',409);
  const {conversation,run}=matches[0];
  if(conversation.projectId!==projectId)fail('当前课题中找不到该任务',404);
  if(run.conversationId!==conversation.id)fail('任务与对话关联不一致，不能收藏',409);
  const sources=run.evidence.filter(source=>source.id===request.evidenceId);
  if(!sources.length)fail('该任务中找不到这条文献',404);if(sources.length!==1)fail('任务中存在重复证据标识，不能确定要收藏的文献',409);
  const source=sources[0];if(!['metadata','abstract','full_text'].includes(source.readScope))fail('只能收藏任务中已有的外部论文，计算结果和上传材料不属于文献夹');
  const notes=run.reading?.entries.filter(entry=>entry.evidenceId===source.id).map(entry=>entry.notes)??[];
  const metadata=sourceFields(source,notes),origin:LibraryOrigin={runId:run.id,conversationId:conversation.id,evidenceId:source.id,readScope:metadata.readScope};
  const state=this.read(),items=state.items.filter(item=>item.projectId===projectId);
  const originMatches=items.filter(item=>item.origins.some(saved=>sameOrigin(saved,origin)));
  if(originMatches.length>1)fail('同一来源关联了多条文献，请先核对收藏记录',409);
  const byOrigin=originMatches[0];
  if(byOrigin?.doi&&metadata.doi&&byOrigin.doi!==metadata.doi)fail('同一来源的 DOI 发生冲突，原收藏未被覆盖',409);
  let candidates=metadata.doi?items.filter(item=>item.doi===metadata.doi):[];
  if(!candidates.length&&metadata.url)candidates=items.filter(item=>item.url===metadata.url&&!(item.doi&&metadata.doi&&item.doi!==metadata.doi));
  if(candidates.length>1)fail('同一地址对应多条不同文献，无法自动合并，请先核对 DOI',409);
  if(candidates[0]&&byOrigin&&candidates[0].id!==byOrigin.id)fail('文献身份与既有来源关联冲突，未自动合并',409);
  const existing=candidates[0]??byOrigin;
  if(existing){
   const before=JSON.stringify(existing);
   for(const key of ['authors','year','journal','doi','url','abstract'] as const)if(!existing[key]&&metadata[key])existing[key]=metadata[key];
   existing.readScope=stronger(existing.readScope,metadata.readScope);
   const previous=existing.origins.find(saved=>sameOrigin(saved,origin));
   if(previous)previous.readScope=stronger(previous.readScope,origin.readScope);
   else{if(existing.origins.length>=MAX_ORIGINS)fail('该文献已保存 50 条来源，未新增来源或修改个人整理信息',409);existing.origins.push(origin);}
   this.store.retainCollectedSource(run.id,source.id);
   if(JSON.stringify(existing)!==before){existing.revision++;existing.updatedAt=now();parse(itemSchema,existing);this.write(state);}
   return {item:structuredClone(existing),created:false};
  }
  if(items.length>=MAX_ITEMS_PER_PROJECT)fail('本课题文献夹已达 1000 条上限，未新增收藏',409);
  const timestamp=now(),item:LibraryItem={id:randomUUID(),projectId,...metadata,origins:[origin],tags:[],note:'',readingStatus:'unread',revision:1,createdAt:timestamp,updatedAt:timestamp};
  parse(itemSchema,item);this.store.retainCollectedSource(run.id,source.id);state.items.push(item);this.write(state);return {item:structuredClone(item),created:true};
 }
 update(projectId:string,id:string,patch:LibraryUpdate):LibraryItem{
  this.project(projectId);this.store.assertProjectUnlocked(projectId);parse(identifier,id);const changes=parse(updateSchema,patch),state=this.read(),item=state.items.find(item=>item.projectId===projectId&&item.id===id);
  if(!item)fail('当前课题中找不到该收藏',404);if(item.revision!==changes.revision)fail('这条收藏已被更新，请刷新后再保存，避免覆盖较新的笔记',409);
  const before=JSON.stringify(item);
  if(changes.tags!==undefined){const seen=new Set<string>();item.tags=changes.tags.filter(tag=>{const key=tag.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});}
  if(changes.note!==undefined)item.note=changes.note;
  if(changes.readingStatus!==undefined)item.readingStatus=changes.readingStatus;
  if(JSON.stringify(item)!==before){item.revision++;item.updatedAt=now();parse(itemSchema,item);this.write(state);}
  return structuredClone(item);
 }
 remove(projectId:string,id:string,revision:number):void{
  this.project(projectId);this.store.assertProjectUnlocked(projectId);parse(identifier,id);parse(revisionSchema,revision);const state=this.read(),index=state.items.findIndex(item=>item.projectId===projectId&&item.id===id);
  if(index<0)fail('当前课题中找不到该收藏',404);if(state.items[index].revision!==revision)fail('这条收藏已被更新，请刷新后再移除，避免删除较新的笔记',409);
  state.items.splice(index,1);this.write(state);
 }
}
