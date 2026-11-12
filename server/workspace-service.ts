import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {Store} from './store';
import {LibraryStore} from './library';
import type {Conversation,Project} from '../shared/types';
import type {ConversationPatch,DeletionPreview,DeletionResult,ProjectPatch,SavedWorkspace,WorkspaceEntityKind} from '../shared/workspace';
import {atomicJson} from './upstream/atomic-json';
import {recycleDirectory,validateManagedTree} from './windows-recycle';
import {registeredArtifactOutputs} from './run-files';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fail=(message:string):never=>{throw Object.assign(new Error(message),{statusCode:409});};
interface FileRecord {relative:string;size:number;sha256:string;}
interface Journal {version:1;id:string;kind:WorkspaceEntityKind;targetId:string;token:string;phase:'prepared'|'recycled'|'committed'|'complete';manifestHash:string;recycledPath?:string;files:FileRecord[];directories:string[];result:DeletionResult;}
export interface WorkspaceDependencies {recycle?:(directory:string,allowedRoot:string)=>Promise<{recycledPath:string}>;openFolder?:(directory:string)=>Promise<void>;}
interface EngineControl {cancelAndWait(ids:string[],timeoutMs?:number):Promise<void>;}

/** Management is separate from research. All file identities are derived from
 * persisted objects, never accepted as paths in an HTTP request. */
export class WorkspaceService {
 private lockedProjects=new Set<string>();
 private journalDirectory:string;
 constructor(readonly store:Store,private engine:EngineControl,private dependencies:WorkspaceDependencies={}){
  this.journalDirectory=path.join(store.root,'management-journal');
 }
 guardProject(id:string):void {if(this.lockedProjects.has(id))fail('项目正在整理，请等待当前操作完成');}
 private target(kind:WorkspaceEntityKind,id:string){
  if(!uuid.test(id))fail('项目或对话标识无效');
  const conversation=kind==='conversation'?this.store.getConversation(id):undefined;
  const project=this.store.getProject(conversation?.projectId??id);
  if(project.removedAt)fail('项目已移除');
  const conversations=conversation?[conversation]:this.store.allConversations().filter(c=>c.projectId===id);
  return {project,conversations,name:conversation?.title??project.name};
 }
 private collections(){const library=new LibraryStore(this.store);return this.store.allProjects().flatMap(project=>library.list(project.id));}
 private confirmation(kind:WorkspaceEntityKind,id:string):string{
  const target=this.target(kind,id),runIds=new Set(target.conversations.flatMap(c=>c.runs.map(r=>r.id)));
  return hash(JSON.stringify({kind,id,name:target.name,projects:target.project.id,
   conversations:target.conversations.map(c=>({id:c.id,projectId:c.projectId,title:c.title,materialIds:c.materialIds,runs:c.runs.map(r=>r.id)})),
   saved:this.store.listSavedArtifacts().filter(s=>runIds.has(s.artifact.runId)).map(s=>({id:s.artifact.id,savedAt:s.savedAt})),
   collections:this.collections().filter(item=>item.origins.some(origin=>runIds.has(origin.runId))).map(item=>({id:item.id,revision:item.revision})),
  }));
 }
 private managedPath(relative:string):string{
  if(typeof relative!=='string'||relative.includes('\\')||relative.includes(':')||relative.split('/').some(part=>!part||part==='.'||part==='..'))fail('过程文件路径无效，未清理');
  if(!/^(?:artifacts\/[0-9a-f-]{36}\.(?:md|html|docx|pdf)|run-files\/[0-9a-f-]{36}\.json|(?:sessions|agent-sessions)\/[0-9a-f-]{36}(?:\/[^\0]*)?)$/i.test(relative))fail('文件不在任务所属目录中，未清理');
  const file=path.resolve(this.store.root,...relative.split('/'));
  if(path.relative(this.store.root,file).startsWith('..'))fail('文件超出资料库，未清理');
  return file;
 }
 private statIfPresent(file:string){try{return fs.lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
 private samePath(a:string,b:string){return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
 /** Check before mkdir/copy/atomicJson; validating after a recursive mkdir can
  * already have written through a junction into another directory. */
 private checkDirectory(directory:string):void{
  const relative=path.relative(this.store.root,directory);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('写入目录超出资料库');
  for(let current=directory;;current=path.dirname(current)){
   const stat=fs.lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!this.samePath(fs.realpathSync.native(current),path.resolve(current)))fail('写入目录含链接或不可信路径');
   if(current===path.dirname(current))break;
  }
 }
 private ensureDirectory(directory:string):void{
  const relative=path.relative(this.store.root,directory);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('写入目录超出资料库');
  this.checkDirectory(this.store.root);let current=this.store.root;
  for(const part of relative.split(path.sep).filter(Boolean)){
   if(part==='.'||part==='..'||/[\x00-\x1f:]/.test(part))fail('写入目录名称无效');
   this.checkDirectory(current);current=path.join(current,part);
   if(!this.statIfPresent(current))fs.mkdirSync(current);
   this.checkDirectory(current);
  }
 }
 private writeNew(file:string,bytes:string|Buffer):void{
  this.ensureDirectory(path.dirname(file));const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
 private copyToView(source:string,destination:string):void{
  validateManagedTree(source,this.store.root);this.ensureDirectory(path.dirname(destination));
  const old=this.statIfPresent(destination);if(old&&(!old.isFile()||old.isSymbolicLink()))fail('保存目录的目标文件不是普通文件');
  // Replace the directory entry, rather than overwriting an existing inode.
  // This also prevents a hard link in the view from modifying its other names.
  const temporary=destination+'.'+randomUUID()+'.tmp';
  try{this.writeNew(temporary,fs.readFileSync(source));this.checkDirectory(path.dirname(destination));fs.renameSync(temporary,destination);}
  catch(error){if(this.statIfPresent(temporary)){validateManagedTree(temporary,this.store.root);fs.unlinkSync(temporary);}throw error;}
 }
 private fileRecords(kind:WorkspaceEntityKind,id:string){
  const {project,conversations}=this.target(kind,id),ids=new Set(conversations.map(c=>c.id));
  const runs=conversations.flatMap(c=>c.runs),otherRuns=this.store.allConversations().filter(c=>!ids.has(c.id)).flatMap(c=>c.runs);
  const saved=new Set(this.store.listSavedArtifacts().map(item=>item.artifact.id));
  const otherArtifacts=new Set(this.store.allConversations().filter(c=>!ids.has(c.id)).flatMap(c=>c.artifacts.map(a=>a.id)));
  const registered=(runId:string)=>{const record=this.managedPath(`run-files/${runId}.json`);if(this.statIfPresent(record))validateManagedTree(record,this.store.root);return registeredArtifactOutputs(this.store.root,runId);};
  for(const run of otherRuns)for(const id of registered(run.id))otherArtifacts.add(id);
  const roots=new Set<string>(),kept=new Set<string>();
  const artifacts=new Set([...conversations.flatMap(c=>c.artifacts.map(a=>a.id)),...runs.flatMap(run=>registered(run.id))]);
  for(const id of artifacts){if(!uuid.test(id))fail('成果文件标识异常，未清理');for(const ext of ['md','html','docx','pdf']){
   const relative=`artifacts/${id}.${ext}`;if(fs.existsSync(this.managedPath(relative)))(saved.has(id)||otherArtifacts.has(id)?kept:roots).add(relative);
  }}
  const otherRoots=new Set(otherRuns.map(run=>run.taskContext?.rootRunId??run.id));
  const otherRunIds=new Set(otherRuns.map(run=>run.id));
  const sharedSession=(relative:string)=>{const directory=this.managedPath(relative);return otherRuns.some(run=>{const file=run.agent?.sessionFile;if(!file)return false;const absolute=path.isAbsolute(file)?path.resolve(file):path.resolve(this.store.root,file),child=path.relative(directory,absolute);return !child||child!=='..'&&!child.startsWith('..'+path.sep)&&!path.isAbsolute(child);});};
  for(const run of runs){
   if(!uuid.test(run.id))fail('任务标识异常，未清理');
   for(const relative of [`sessions/${run.id}`,`run-files/${run.id}.json`])if(fs.existsSync(this.managedPath(relative)))(otherRunIds.has(run.id)||relative.startsWith('sessions/')&&sharedSession(relative)?kept:roots).add(relative);
   const rootId=run.taskContext?.rootRunId??run.id;if(!uuid.test(rootId))fail('研究会话标识异常，未清理');
   const relative=`agent-sessions/${rootId}`;if(fs.existsSync(this.managedPath(relative)))(otherRoots.has(rootId)||sharedSession(relative)?kept:roots).add(relative);
  }
  const materials=kind==='project'?this.store.getMaterials(project.id):this.store.getMaterials(project.id).filter(m=>conversations.some(c=>c.materialIds.includes(m.id)||c.runs.some(r=>r.materialIds.includes(m.id))));
  for(const material of materials)if(uuid.test(material.id)&&fs.existsSync(path.join(this.store.root,'uploads',material.id)))kept.add(`uploads/${material.id}`);
  const files:FileRecord[]=[],directories:string[]=[];
  const walk=(relative:string)=>{
   const file=this.managedPath(relative),stat=fs.lstatSync(file);
   if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))fail('任务目录含链接或特殊文件，未清理');
   if(stat.isDirectory()){directories.push(relative);for(const child of fs.readdirSync(file).sort())walk(relative+'/'+child);}
   else files.push({relative,size:stat.size,sha256:hash(fs.readFileSync(file))});
  };
  for(const root of roots){validateManagedTree(this.managedPath(root),this.store.root);walk(root);}
  return {files:files.sort((a,b)=>a.relative.localeCompare(b.relative)),directories:directories.sort((a,b)=>b.length-a.length||a.localeCompare(b)),keptFiles:kept.size};
 }
 preview(kind:WorkspaceEntityKind,id:string):DeletionPreview{
  const target=this.target(kind,id),inventory=this.fileRecords(kind,id),activeRuns=target.conversations.flatMap(c=>c.runs).filter(r=>['running','queued','awaiting_confirmation'].includes(r.status)).length;
  return {kind,id,name:target.name,token:this.confirmation(kind,id),conversations:target.conversations.length,files:inventory.files.length,bytes:inventory.files.reduce((n,f)=>n+f.size,0),keptFiles:inventory.keptFiles,activeRuns,
   warnings:[...(activeRuns?['会先停止当前任务，文件数量按停止后的保存状态确认。']:[]),'已保存成果、项目上传材料、收藏和共享原文缓存保留；外部下载文件不受影响。']};
 }
 private async locked<T>(projects:string[],conversations:string[],operation:()=>Promise<T>):Promise<T>{
  for(const id of projects)this.guardProject(id);
  const unlock=this.store.acquireWorkspaceLock(conversations,projects);for(const id of projects)this.lockedProjects.add(id);
  try{return await operation();}finally{for(const id of projects)this.lockedProjects.delete(id);unlock();}
 }
 async editProject(id:string,patch:ProjectPatch):Promise<Project>{
  this.guardProject(id);if(patch.archived!==true)return this.store.updateProject(id,patch);
  const target=this.target('project',id);return this.locked([id],target.conversations.map(c=>c.id),async()=>{await this.engine.cancelAndWait(target.conversations.flatMap(c=>c.runs.map(r=>r.id)));return this.store.commitProjectUpdate(id,patch);});
 }
 async editConversation(id:string,patch:ConversationPatch):Promise<Conversation>{
  const c=this.store.getConversation(id);this.guardProject(c.projectId);if(patch.archived!==true)return this.store.updateConversation(id,patch);
  return this.locked([c.projectId],[id],async()=>{await this.engine.cancelAndWait(c.runs.map(r=>r.id));return this.store.commitConversationUpdate(id,patch);});
 }
 async move(id:string,projectId:string):Promise<Conversation>{
  const c=this.store.getConversation(id);return this.locked([...new Set([c.projectId,projectId])],[id],async()=>{await this.engine.cancelAndWait(c.runs.map(r=>r.id));return this.store.commitConversationMove(id,projectId);});
 }
 saved():SavedWorkspace{
  const all=this.store.allProjects(),artifacts=this.store.listSavedArtifacts(),materials=all.flatMap(p=>this.store.getMaterials(p.id)),libraryCounts=all.map(p=>({projectId:p.id,count:new LibraryStore(this.store).list(p.id).length}));
  const projects=all.filter(p=>!p.removedAt||artifacts.some(item=>item.projectId===p.id)||materials.some(item=>item.projectId===p.id)||libraryCounts.some(item=>item.projectId===p.id&&item.count>0));
  return {projects,artifacts,materials,libraryCounts:libraryCounts.filter(item=>projects.some(project=>project.id===item.projectId))};
 }
 private journalPath(id:string){if(!uuid.test(id))fail('回收操作标识无效');return path.join(this.journalDirectory,id+'.json');}
 private writeJournal(journal:Journal){this.ensureDirectory(this.journalDirectory);const file=this.journalPath(journal.id);if(this.statIfPresent(file))validateManagedTree(file,this.store.root);atomicJson(file,journal);}
 private journals():Journal[]{
  if(!fs.existsSync(this.journalDirectory))return [];
  validateManagedTree(this.journalDirectory,this.store.root);
  return fs.readdirSync(this.journalDirectory).filter(name=>uuid.test(name.replace(/\.json$/,''))&&name.endsWith('.json')).map(name=>{
   const file=path.join(this.journalDirectory,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>32*1024*1024)fail('回收记录异常，保留现有文件');
   const journal=JSON.parse(fs.readFileSync(file,'utf8')) as Journal;
   if(!journal||journal.version!==1||journal.id+'.json'!==name||!['project','conversation'].includes(journal.kind)||!uuid.test(journal.targetId)||!/^[a-f0-9]{64}$/.test(journal.token)||!/^[a-f0-9]{64}$/.test(journal.manifestHash)||!Array.isArray(journal.files)||!Array.isArray(journal.directories)||!['prepared','recycled','committed','complete'].includes(journal.phase))fail('回收记录无效，保留现有文件');
   for(const file of journal.files){this.managedPath(file.relative);if(!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0)fail('回收文件记录无效');}for(const dir of journal.directories)this.managedPath(dir);
   if(new Set(journal.files.map(file=>file.relative)).size!==journal.files.length||new Set(journal.directories).size!==journal.directories.length||journal.directories.some(dir=>journal.files.some(file=>file.relative===dir))||!journal.result||journal.result.deleted!==true||journal.result.operationId!==journal.id||journal.result.recycledFiles!==journal.files.length||!Number.isSafeInteger(journal.result.retainedFiles)||journal.result.retainedFiles<0)fail('回收记录的文件数量或结果无效');
   return journal;
  });
 }
 private verifyPackage(journal:Journal):{snapshotHash:string}{
  if(!journal.recycledPath||!path.isAbsolute(journal.recycledPath)||!fs.existsSync(journal.recycledPath))fail('未取得可验证的回收站副本，原应用文件保留');
  const root=journal.recycledPath!;
  if(!this.dependencies.recycle){const volume=path.parse(this.store.root).root;if(!this.samePath(path.parse(root).root,volume)||!/^\$Recycle\.Bin[\\/]S-\d+(?:-\d+)+[\\/]\$R[^\\/]+$/i.test(path.relative(volume,root)))fail('回收记录未指向本卷系统回收站');}
  validateManagedTree(root,path.dirname(root));validateManagedTree(path.join(root,'manifest.json'),root);
  if(hash(fs.readFileSync(path.join(root,'manifest.json')))!==journal.manifestHash)fail('回收站副本清单校验失败，原应用文件保留');
  for(const record of journal.files){const file=path.join(root,'files',...record.relative.split('/'));validateManagedTree(file,root);if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).size!==record.size||hash(fs.readFileSync(file))!==record.sha256)fail('回收站副本内容校验失败，原应用文件保留');}
  for(const relative of journal.directories){const directory=path.join(root,'files',...relative.split('/'));validateManagedTree(directory,root);if(!fs.lstatSync(directory).isDirectory())fail('回收站副本目录不完整');}
  validateManagedTree(path.join(root,'conversation.json'),root);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.version!==1||manifest.operationId!==journal.id||manifest.kind!==journal.kind||manifest.id!==journal.targetId||JSON.stringify(manifest.files)!==JSON.stringify(journal.files)||JSON.stringify(manifest.directories)!==JSON.stringify(journal.directories)||typeof manifest.snapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(manifest.snapshotHash))fail('回收站清单与待清理记录不一致');
  if(hash(fs.readFileSync(path.join(root,'conversation.json')))!==manifest.snapshotHash)fail('对话恢复记录校验失败，原应用文件保留');
  return {snapshotHash:manifest.snapshotHash};
 }
 private unchangedOriginals(journal:Journal):void{
  const inventory=this.fileRecords(journal.kind,journal.targetId);
  if(JSON.stringify(inventory.files)!==JSON.stringify(journal.files)||JSON.stringify(inventory.directories)!==JSON.stringify(journal.directories))fail('过程文件或保存范围在回收期间发生变化，已保留原内容，请重新确认');
  for(const record of journal.files){const file=this.managedPath(record.relative);validateManagedTree(file,this.store.root);if(hash(fs.readFileSync(file))!==record.sha256)fail('过程文件在回收期间发生变化，已保留原内容，请重新确认');}
 }
 private cleanup(journal:Journal):void{
  this.verifyPackage(journal);
  // The verified full recovery copy is already in the system Recycle Bin.
  // Remove only identical application copies; never delete changed/new files.
  for(const record of journal.files){const file=this.managedPath(record.relative);if(!fs.existsSync(file))continue;validateManagedTree(file,this.store.root);if(hash(fs.readFileSync(file))!==record.sha256)fail('对话已移除，但发生变化的过程文件仍保留，未清理');fs.unlinkSync(file);}
  for(const relative of journal.directories){const directory=this.managedPath(relative);if(!fs.existsSync(directory))continue;validateManagedTree(directory,this.store.root);fs.rmdirSync(directory);}
  journal.phase='complete';this.writeJournal(journal);
 }
 private exists(kind:WorkspaceEntityKind,id:string){try{this.target(kind,id);return true;}catch{return false;}}
 recoverPending():string[]{
  const warnings:string[]=[];
  let journals:Journal[];try{journals=this.journals();}catch(error){return [error instanceof Error?error.message:'回收记录不可读取，现有文件保留'];}
  for(const journal of journals)if(journal.phase==='committed'||journal.phase==='recycled'&&!this.exists(journal.kind,journal.targetId)){
   if(this.exists(journal.kind,journal.targetId)){warnings.push('对话或项目已恢复，未继续旧的文件清理');continue;}
   if(journals.some(other=>other.id!==journal.id&&other.kind===journal.kind&&other.targetId===journal.targetId&&other.phase==='complete'))continue;
   try{this.cleanup(journal);}catch(error){warnings.push(error instanceof Error?error.message:'回收清理未完成，已保留文件');}
  }
  return warnings;
 }
 async remove(kind:WorkspaceEntityKind,id:string,token:string):Promise<DeletionResult>{
  const matching=this.journals().filter(j=>j.kind===kind&&j.targetId===id&&j.token===token),prior=matching.find(j=>j.phase==='complete')??matching.find(j=>j.phase==='committed')??matching.find(j=>j.phase==='recycled');
  if(prior&&!this.exists(kind,id)){if(prior.phase!=='complete')this.cleanup(prior);return prior.result;}
  const target=this.target(kind,id);this.guardProject(target.project.id);
  if(token!==this.confirmation(kind,id))fail('内容或保存范围已有变化，请重新查看删除范围');
  return this.locked([target.project.id],target.conversations.map(c=>c.id),async()=>{
   await this.engine.cancelAndWait(target.conversations.flatMap(c=>c.runs.map(r=>r.id)));
   if(token!==this.confirmation(kind,id))fail('内容或保存范围已有变化，请重新查看删除范围');
   const inventory=this.fileRecords(kind,id),snapshot=this.store.workspaceDeletionSnapshot(kind,id),snapshotText=JSON.stringify(snapshot,null,2)+'\n';
   let journal:Journal|undefined;
   if(prior?.phase==='recycled'){
    // A failed metadata commit can retry without recycling duplicate packages.
    // A changed or missing backup is never reused; originals are still present.
    try{const proof=this.verifyPackage(prior);if(proof.snapshotHash===hash(snapshotText)&&JSON.stringify(prior.files)===JSON.stringify(inventory.files)&&JSON.stringify(prior.directories)===JSON.stringify(inventory.directories))journal=prior;}catch{/* Rebuild only from the still-present original snapshot. */}
   }
   if(!journal){
    const operationId=randomUUID(),packageDirectory=path.join(this.store.root,'recycle-packages',operationId);
    this.ensureDirectory(this.journalDirectory);this.ensureDirectory(packageDirectory);
    this.writeNew(path.join(packageDirectory,'conversation.json'),snapshotText);this.ensureDirectory(path.join(packageDirectory,'files'));
    for(const relative of inventory.directories)this.ensureDirectory(path.join(packageDirectory,'files',...relative.split('/')));
    for(const record of inventory.files){const source=this.managedPath(record.relative),output=path.join(packageDirectory,'files',...record.relative.split('/'));validateManagedTree(source,this.store.root);this.writeNew(output,fs.readFileSync(source));if(hash(fs.readFileSync(output))!==record.sha256)fail('恢复副本复制校验失败，未删除对话');}
    const manifest=JSON.stringify({version:1,operationId,kind,id,files:inventory.files,directories:inventory.directories,snapshotHash:hash(snapshotText)},null,2)+'\n';this.writeNew(path.join(packageDirectory,'manifest.json'),manifest);
    journal={version:1,id:operationId,kind,targetId:id,token,phase:'prepared',manifestHash:hash(manifest),files:inventory.files,directories:inventory.directories,result:{deleted:true,operationId,recycledFiles:inventory.files.length,retainedFiles:inventory.keptFiles}};
    this.writeJournal(journal);
    const receipt=await(this.dependencies.recycle??recycleDirectory)(packageDirectory,path.join(this.store.root,'recycle-packages'));
    journal.recycledPath=receipt.recycledPath;journal.phase='recycled';this.verifyPackage(journal);this.writeJournal(journal);
   }
   this.unchangedOriginals(journal);
   if(token!==this.confirmation(kind,id)||hash(JSON.stringify(this.store.workspaceDeletionSnapshot(kind,id),null,2)+'\n')!==hash(snapshotText))fail('对话内容或保存范围在回收期间发生变化，原数据保留，请重新确认');
   // Re-read saved origins after the asynchronous native operation. Route locks
   // reject new collection writes, and this also protects direct Store clients.
   const runIds=new Set(snapshot.conversations.flatMap(c=>c.runs.map(r=>r.id))),retain=new Map<string,Set<string>>();
   const retainSource=(runId:string,evidenceId:string)=>{if(!runIds.has(runId))return;const ids=retain.get(runId)??new Set<string>();ids.add(evidenceId);retain.set(runId,ids);};
   for(const item of this.collections())for(const origin of item.origins)retainSource(origin.runId,origin.evidenceId);
   for(const saved of this.store.listSavedArtifacts())if(runIds.has(saved.artifact.runId))for(const source of this.store.getSourceRun(saved.artifact.runId).evidence)retainSource(saved.artifact.runId,source.id);
   this.store.commitWorkspaceDeletion(kind,id,[...retain].map(([runId,evidenceIds])=>({runId,evidenceIds:[...evidenceIds]})));
   journal.phase='committed';this.writeJournal(journal);this.cleanup(journal);return journal.result;
  });
 }
 async openProjectFolder(id:string):Promise<{opened:true}>{
  this.store.getProject(id);this.guardProject(id);if(!uuid.test(id))fail('项目标识无效');
  const directory=path.join(this.store.root,'saved-projects',id);this.ensureDirectory(directory);
  // Give Explorer a project-specific view of explicitly saved files, not the
  // global private datastore or model settings.
  const safeName=(value:string)=>value.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100).replace(/[. ]+$/g,'')||'文件';
  for(const item of this.store.listSavedArtifacts().filter(item=>item.projectId===id))for(const format of item.artifact.formats){if(!uuid.test(item.artifact.id)||!['md','html','docx','pdf'].includes(format))fail('保存成果标识无效');const source=path.join(this.store.root,'artifacts',item.artifact.id+'.'+format);if(fs.existsSync(source))this.copyToView(source,path.join(directory,safeName(item.artifact.title)+'-'+item.artifact.id+'.'+format));}
  for(const material of this.store.getMaterials(id)){const source=path.join(this.store.root,'uploads',material.id);if(uuid.test(material.id)&&fs.existsSync(source))this.copyToView(source,path.join(directory,material.id+'-'+safeName(material.name)));}
  if(this.dependencies.openFolder)await this.dependencies.openFolder(directory);
  else{if(process.platform!=='win32')fail('当前系统暂不支持在资源管理器打开');await new Promise<void>((resolve,reject)=>{const executable=path.join(process.env.SystemRoot??'C:\\Windows','explorer.exe');const child=spawn(executable,[directory],{shell:false,windowsHide:true,stdio:'ignore',detached:true});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});}
  return {opened:true};
 }
}
