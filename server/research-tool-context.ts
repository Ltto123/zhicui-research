import type {ActionContext} from './research-tool-writing';
import type {searchEvidence,fetchFullTextEvidence} from './retrieval';
import type {screenEvidence} from './screening';
export interface ResearchToolContext extends ActionContext {search?:typeof searchEvidence;fullText?:typeof fetchFullTextEvidence;screen?:typeof screenEvidence;guidelineReader?:typeof import('./format-guidelines').readFormatGuideline;persist?:<T>(write:()=>T)=>T;}
export function prepared(ctx:ResearchToolContext){ctx.signal.throwIfAborted();const run=ctx.store.getRun(ctx.runId);if(!run.agent?.turnIntent)throw new Error('先根据用户消息和已保存状态调用 prepare_task 判断本轮意图；不要先丢弃原稿或重新检索。');return run;}
