import type {Conversation,Run} from '../../shared/types';
import type {ConversationSummary} from '../../shared/workspace';

/** An executing task takes precedence; otherwise only the newest task is current. */
export function currentRun(runs:readonly Run[]):Run|undefined{
  return [...runs].reverse().find(run=>run.status==='running'||run.status==='queued')??runs.at(-1);
}

/** A stale click never grants approval to another task or a changed outline. */
export function sameRunAction(expected:Run,current:Run|undefined):boolean{
  return Boolean(current&&expected.id===current.id&&expected.status===current.status&&
    (expected.status!=='awaiting_confirmation'||
      (JSON.stringify(expected.outline)===JSON.stringify(current.outline)&&expected.outlineConfirmed===current.outlineConfirmed&&expected.draft===current.draft)));
}

export function conversationSummaryChanged(value:Conversation,summary:ConversationSummary):boolean{
  return value.updatedAt!==summary.updatedAt||value.runs.at(-1)?.status!==summary.latestStatus||
    value.messages.length!==summary.messageCount||value.artifacts.length!==summary.artifactCount;
}
