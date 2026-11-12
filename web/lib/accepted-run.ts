import type {Conversation,Run} from '../../shared/types';

/** The successful POST is authoritative even if the following read fails.
 * This local message is replaced by the next full conversation response. */
export function withAcceptedRun(conversation:Conversation,run:Run,text:string):Conversation{
  if(conversation.id!==run.conversationId)return conversation;
  const localId=`accepted-message-${run.id}`;
  return {...conversation,updatedAt:run.updatedAt,
    runs:conversation.runs.some(item=>item.id===run.id)?conversation.runs.map(item=>item.id===run.id?run:item):[...conversation.runs,run],
    messages:conversation.messages.some(item=>item.runId===run.id&&item.role==='user'&&item.content===text)?conversation.messages:[...conversation.messages.filter(item=>item.id!==localId),{id:localId,role:'user',content:text,runId:run.id,createdAt:run.createdAt}],
  };
}
