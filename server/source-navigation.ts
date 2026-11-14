import type {Store} from './store';

/** Legacy source links know the source run, not the view that opened it.
 * Resolve a surviving location using metadata only; never fetch source content. */
export function sourceNavigation(store:Store,runId:string,evidenceId:string):{returnTo:string}{
 const source=store.getSourceRun(runId);
 if(source.evidence.filter(entry=>entry.id===evidenceId).length!==1){
  throw Object.assign(new Error('原文来源不存在或不能唯一确定'),{statusCode:404});
 }
 const conversation=store.allConversations().find(entry=>entry.id===source.conversationId);
 if(conversation&&store.listProjects().some(project=>project.id===conversation.projectId)){
  return {returnTo:'/?'+new URLSearchParams({conversation:conversation.id,project:conversation.projectId}).toString()};
 }
 // A retained source can outlive its conversation and project. Never link to
 // their deleted IDs or recreate the conversation just to open the source.
 return {returnTo:'/?saved=1'};
}
