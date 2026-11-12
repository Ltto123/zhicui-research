import {createHash} from 'node:crypto';
import type {Conversation,Run} from '../shared/types';

export interface ConfirmationExpectation {expectedConfirmationToken?:string;}

/** Bind approval to the task and writing state actually shown to the user.
 * Progress events and timestamps do not change the content being approved. */
export function outlineConfirmationToken(run:Run):string {
 return createHash('sha256').update(JSON.stringify([run.id,run.status,run.prompt,run.outline??null,run.outlineConfirmed??false,run.draft??null])).digest('hex');
}

export function assertOutlineConfirmation(run:Run,expectation:ConfirmationExpectation):void {
 if(!expectation.expectedConfirmationToken||expectation.expectedConfirmationToken!==outlineConfirmationToken(run)){
  throw Object.assign(new Error('提纲或任务状态已更新，不能按旧版本确认；请刷新并审校当前提纲后继续。'),{statusCode:409});
 }
}

export function publicRun(run:Run):Run {return {...run,confirmationToken:outlineConfirmationToken(run)};}

export function publicConversation(conversation:Conversation):Conversation {return {...conversation,runs:conversation.runs.map(publicRun)};}
