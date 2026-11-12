import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type {Store} from './store';
import type {WorkspaceService} from './workspace-service';
import {validateManagedTree} from './windows-recycle';
import {publicConversation} from './outline-confirmation';

const uuid=z.string().uuid();
const name=z.string().trim().min(1).max(120).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const projectPatch=z.object({name:name.optional(),description:z.string().max(2000).optional(),pinned:z.boolean().optional(),archived:z.boolean().optional(),sectionId:uuid.nullable().optional()}).strict();
const conversationPatch=z.object({title:name.optional(),pinned:z.boolean().optional(),archived:z.boolean().optional(),unread:z.boolean().optional(),sectionId:uuid.nullable().optional()}).strict();
const target=z.object({kind:z.enum(['project','conversation']),id:uuid}).strict();
const idOf=(params:unknown)=>z.object({id:uuid}).parse(params).id;
const escape=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));

/** Navigation and explicit file management. No endpoint invokes a model. */
export function registerWorkspaceRoutes(app:FastifyInstance,store:Store,workspace:WorkspaceService):void {
 app.get('/api/workspace',async()=>store.workspaceIndex());
 app.post('/api/workspace/default-project',async()=>store.defaultProject());
 app.get('/api/workspace/saved',async()=>workspace.saved());
 app.patch('/api/projects/:id',async req=>workspace.editProject(idOf(req.params),projectPatch.parse(req.body)));
 app.patch('/api/conversations/:id',async req=>publicConversation(await workspace.editConversation(idOf(req.params),conversationPatch.parse(req.body))));
 app.post('/api/workspace/sections',async req=>{const body=z.object({name:name.max(80),projectId:uuid.optional()}).strict().parse(req.body);return store.createSection(body.name,body.projectId);});
 app.patch('/api/workspace/sections/:id',async req=>store.updateSection(idOf(req.params),z.object({name:name.max(80)}).strict().parse(req.body)));
 app.delete('/api/workspace/sections/:id',async(req,reply)=>{store.removeSection(idOf(req.params));return reply.code(204).send();});
 app.post('/api/conversations/:id/move',async req=>publicConversation(await workspace.move(idOf(req.params),z.object({projectId:uuid}).strict().parse(req.body).projectId)));
 app.post('/api/conversations/:id/fork',async req=>({conversation:publicConversation(store.forkConversation(idOf(req.params)))}));
 app.post('/api/projects/:id/open-folder',async req=>workspace.openProjectFolder(idOf(req.params)));
 app.post('/api/artifacts/:id/save',async req=>store.saveArtifact(idOf(req.params)));
 app.post('/api/workspace/deletion-preview',async req=>{const {kind,id}=target.parse(req.body);return workspace.preview(kind,id);});
 app.post('/api/workspace/delete',async req=>{const {kind,id,token}=target.extend({token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);return workspace.remove(kind,id,token);});
 app.get('/api/conversations/:id/export',async(req,reply)=>{
  const conversation=store.getConversation(idOf(req.params)),{format}=z.object({format:z.enum(['md','html']).default('md')}).strict().parse(req.query);
  const sections=[conversation.title,...conversation.messages.map(message=>`${message.role==='user'?'我':'智萃科研'}\n\n${message.content}`),...conversation.artifacts.map(artifact=>`成果：${artifact.title}\n\n${artifact.markdown}`)];
  const body=format==='md'?sections.join('\n\n---\n\n')+'\n':`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(conversation.title)}</title><style>body{max-width:850px;margin:40px auto;padding:0 24px;font:16px/1.8 "Times New Roman",SimSun,serif}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}section+section{border-top:1px solid #ddd;margin-top:24px}</style>${sections.map(section=>`<section><pre>${escape(section)}</pre></section>`).join('')}</html>`;
  reply.header('Content-Disposition',`attachment; filename="zhicui-chat.${format}"; filename*=UTF-8''${encodeURIComponent(conversation.title+'.'+format)}`);
  return reply.type(format==='md'?'text/markdown; charset=utf-8':'text/html; charset=utf-8').send(body);
 });
 app.get('/api/materials/:id/download',async(req,reply)=>{
  const id=idOf(req.params),material=store.allProjects().flatMap(project=>store.getMaterials(project.id)).find(material=>material.id===id);
  if(!material)return reply.code(404).send({error:'材料不存在'});
  const file=path.join(store.root,'uploads',id);
  if(!fs.existsSync(file))return reply.code(404).send({error:'原始文件缺失，已提取的文本仍保留'});
  validateManagedTree(file,store.root);
  reply.header('Content-Disposition',`attachment; filename="zhicui-material"; filename*=UTF-8''${encodeURIComponent(material.name)}`);
  return reply.type('application/octet-stream').send(fs.createReadStream(file));
 });
}
