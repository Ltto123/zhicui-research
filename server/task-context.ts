import type { Run, RunOptions, TaskContext } from '../shared/types';

const MAX_TASK_CHARACTERS=120_000;
const SUPPLEMENT_SEPARATOR='\n用户接续要求：';
type HistoryRun=Pick<Run,'id'|'prompt'|'taskContext'>;

export function effectiveTaskPrompt(context:TaskContext):string{
  const prompt=context.rootPrompt+context.supplements.map(value=>SUPPLEMENT_SEPARATOR+value).join('');
  if(prompt.length>MAX_TASK_CHARACTERS)throw new Error('原始任务与累积补充要求超过120000字符（12万字符），未截断或创建任务；请开启新对话并明确整理后的完整要求。');
  return prompt;
}

/** Only an explicit opening switch resets a conversation's goal. Negations,
 * quotations later in a message and ordinary refinement verbs do not. */
export function isExplicitNewTask(prompt:string):boolean{
  const text=prompt.trimStart();
  return /^(?:(?:请|现在|这次|我们|先)[，,：:\s]*)*(?:换(?:一个|个|一项)?(?:话题|主题|任务|课题|问题)|(?:另起|新开|开始)(?:一个|一项)?新(?:任务|课题|话题|主题)|新(?:任务|课题|话题|主题))(?=[:：，,。！？!?\s]|$)/.test(text)
    ||/^(?:请)?(?:不再|不要|不用)继续(?:之前|原来|前面|当前)(?:的)?(?:任务|综述|研究)[了，,。；;\s]*(?:现在)?(?:换(?:一个|个)?(?:任务|话题|主题|课题|问题)|另起新任务)/.test(text)
    // A bare English label needs a delimiter: "new topic modeling" and
    // "new task-specific constraints" are refinements, not switch commands.
    ||/^(?:please\s+)?new\s+(?:task|topic)(?=\s*(?:[:：,，.!?。！？;；—–]|$))/i.test(text)
    ||/^(?:please\s+)?(?:start\s+(?:a\s+)?new\s+(?:task|topic)|switch\s+(?:to\s+)?(?:(?:a\s+)?new\s+|another\s+|a\s+)?(?:task|topic))(?=[\s:：,，.!?。！？;；—–]|$)/i.test(text);
}

function copy(context:TaskContext):TaskContext{return {...context,supplements:[...context.supplements]};}

/** Rebuild old task lineage from user-authored run prompts, never model plans.
 * Legacy resume instructions used the same separator and must not disappear. */
function priorContext(runs:readonly HistoryRun[]):TaskContext|undefined{
  let current:TaskContext|undefined;
  for(const run of runs){
    if(run.taskContext){current=copy(run.taskContext);continue;}
    for(const part of run.prompt.split(SUPPLEMENT_SEPARATOR)){
      if(!current||isExplicitNewTask(part))current={rootRunId:run.id,rootPrompt:part,supplements:[]};
      else current={...current,supplements:[...current.supplements,part]};
    }
  }
  return current;
}

export function buildTaskContext(runs:readonly HistoryRun[],prompt:string,intent:RunOptions['taskIntent'],newRunId:string):TaskContext{
  const previous=intent==='new'||isExplicitNewTask(prompt)?undefined:priorContext(runs);
  const context:TaskContext=previous?{...previous,supplements:[...previous.supplements,prompt],parentRunId:runs.at(-1)!.id}:{rootRunId:newRunId,rootPrompt:prompt,supplements:[]};
  effectiveTaskPrompt(context);
  return context;
}
