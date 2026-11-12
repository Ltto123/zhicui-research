import type {Run,TaskPlan} from '../shared/types';

export function confirmationRequired(request:string,inherited=false):boolean{
  let required=inherited;
  for(const clause of request.split(/[。；;\n]/)){
    if(/(?:不再|无需|不用|不必|不要)(?:再)?(?:等|等待)(?:我)?(?:确认|批准)|(?:无需|不用|不必)(?:我)?(?:确认|批准)/.test(clause)){required=false;continue;}
    if(/等我确认|先.{0,20}清单.{0,20}确认|(?:不要|暂不|先不).{0,8}继续(?:成文|写作)|wait for my confirmation/i.test(clause))required=true;
  }
  return required;
}

/** Only affirmative user instructions can relax a saved reading requirement. */
function readingScopePolicy(request:string):{required:boolean;abstractsAllowed:boolean} {
  let required=false,abstractsAllowed=false;
  const unquoted=request.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"/g,value=>' '.repeat(value.length));
  // A change of acquisition method and a reading requirement may share a
  // sentence. Process adversative clauses in order so declining a download
  // cannot swallow an explicit request to read online, or vice versa.
  for(const sentence of unquoted.split(/[。；;\n]/)){
   const userSentence=sentence.replace(/^\s*用户接续要求[：:]\s*/,'').trim();
   // A comma after an example/interpretation lead-in does not turn its quoted
   // subject into a new instruction (e.g. “例如，允许只用摘要”).
   if(/[？?]/.test(sentence)||/^(?:请|先|现在|帮我)*(?:例如|比如|举例|示例|假如|如果|假设|解释|是否)/.test(userSentence))continue;
   // Permission must be a complete direct instruction. An unknown lead-in
   // keeps its context across commas: reported or denied speech cannot become
   // authorization merely because the next fragment says “允许只用摘要”.
   let directContext=true;
   for(const fragment of userSentence.split(/[，,]|但是?|而是|不过/)){
    const clause=fragment.trim();if(!clause)continue;
    const directScope=/^(?:请|现在|本次|这次|直接|在线|也|仍|仔细)*(?:必须|务必|需要|要求|应当|仍须|仍需|不允许|不再允许|禁止|不要|不能|不可|拒绝|避免|别|不需要|不必|不用|无需|不获取|不下载|不阅读|不研读|不读|研究|研读|阅读|读取|获取|下载|读到|可读|能读|必须读|需要读)/.test(clause);
    if(/例如|比如|示例|假如|如果|假设|解释|是否/.test(clause)){directContext=false;continue;}
    if(/(?:不允许|不再允许|禁止)(?:只|仅).{0,5}摘要|(?:不要|不能|不可|拒绝|避免|别)(?:再)?(?:允许)?(?:只|仅).{0,5}摘要/.test(clause)){directContext&&=directScope;required=true;abstractsAllowed=false;continue;}
    const permission=/^(?:请|现在|本次|这次|明确|我)*(?:(?:只|仅)(?:读|用|依据|根据)?摘要(?:即可|就行|也可以)|允许(?:只|仅)(?:读|用|依据|根据)?摘要)(?:吧|了)?$/.test(clause);
    if(permission&&directContext){required=false;abstractsAllowed=true;continue;}
    if(/(?:不(?:需要|必|用)?|无需|不要).{0,8}(?:读|阅读|读取|研究|研读).{0,5}(?:全文|正文)/i.test(clause)){directContext&&=directScope;required=false;continue;}
    // Declining a download changes the acquisition method, not a previously
    // requested reading scope. A following online-reading clause still applies.
    if(/(?:不(?:需要|必|用)?|无需|不要).{0,8}(?:获取|下载).{0,5}(?:全文|正文)/.test(clause)){directContext&&=directScope;continue;}
    if(/(?:必须|务必|需要|要求|应当|仍须|仍需).{0,6}(?:研究|研读|阅读|读取|读)(?!笔记|记录).{0,24}(?:正文|全文)(?!结构|格式|排版)|(?:研究|研读|阅读|读取|获取|下载|读到|可读|能读|必须读|需要读)(?!笔记|记录).{0,4}(?:论文)?(?:正文|全文)(?!结构|格式|排版)|(?:论文|文献).{0,12}(?:全文|正文).{0,8}(?:研读|阅读|读取)(?!笔记|记录)|\b(?:read|require|retrieve|study)\b.{0,24}\bfull[ -]?text\b/i.test(clause)){directContext&&=directScope;required=true;abstractsAllowed=false;continue;}
    // Reusing a named existing corpus is a direct task instruction, not a
    // claim that any source was newly read or a report of someone else's words.
    if(/^(?:请|现在|本次|这次)*(?:沿用|复用|保留)(?:已|现|原).*(?:文献|资料|笔记|筛选|全文)/.test(clause))continue;
    directContext=false;
   }
  }
  return {required,abstractsAllowed};
}

/** This requirement comes from user instructions, never from retrieved papers. */
export function fullTextRequired(request:string):boolean {
  return readingScopePolicy(request).required;
}

/** A later explicit abstract permission changes writing scope, not screening
 * provenance. A stale plan and saved fullTextIds must not silently veto it. */
export function fullTextRequiredForRun(run:Pick<Run,'prompt'|'plan'|'screening'>,evidenceId?:string):boolean {
  const policy=readingScopePolicy(run.prompt);
  return !policy.abstractsAllowed&&(policy.required||run.plan?.evidenceRequirement==='full_text'||Boolean(evidenceId&&run.screening?.fullTextIds?.includes(evidenceId)));
}

/** Availability of every cited original is separate from the model's reading
 * scope. Fetching an original for the viewer does not mean the model read it. */
export function originalSourceAccessRequired(request:string):boolean {
  let required=false;
  for(const sentence of request.split(/[。；;\n]/)){
   let everyInSentence=false,negatedQuantifier=false;
   for(const clause of sentence.split(/[，,]|但是?|而是|不过/)){
    const every=/(?:每(?:一)?(?:条|篇|项|个)|所有|全部).{0,20}(?:证据|文献|引用|参考|论文)|(?:最终引用|最终采用).{0,12}(?:每|所有|全部)/.test(clause);
    if(every){
      everyInSentence=true;
      negatedQuantifier=/(?:不(?:再)?要求|不要(?:再)?(?:强制|要求|强求)|无需(?:保证|要求)|不是|并非)/.test(clause);
    }
    if(!/(?:原文|全文|正文)/.test(clause))continue;
    const opens=/(?:点开|点击|打开|访问|查看)/.test(clause);
    const cancels=/(?:不(?:再)?(?:需要|要求|必|用)|不要(?:再)?(?:强制|要求|强求)|无需|取消|撤销|不是|并非).{0,35}(?:点开|打开|访问|查看|可读|读到)|(?:取消|撤销).{0,35}(?:原文|全文|正文).{0,20}(?:要求|约束)|(?:原文|全文|正文).{0,10}(?:不必|无需|不用|不需要).{0,20}(?:打开|访问|查看|可读|读到)/.test(clause);
    if(cancels||(negatedQuantifier&&(opens||/可读|读到/.test(clause)))){required=false;continue;}
    // Declining a file download alone does not revoke a prior request to open
    // originals online. It also cannot create a new accessibility requirement.
    if(!opens&&/(?:无需|不用|不必|不要求|不需要).{0,20}(?:获取|下载)/.test(clause))continue;
    if(everyInSentence&&(opens||/(?:获取|下载|可读|可访问|可打开)/.test(clause)))required=true;
   }
  }
  return required;
}

export function continuationTaskType(run:Run,rootPlan?:TaskPlan):TaskPlan['taskType']|undefined {
  if(!run.taskContext?.supplements.length)return;
  let type=rootPlan&&!['local','format'].includes(rootPlan.taskType)?rootPlan.taskType:undefined;
  if(!type&&/(?:主题|文献|系统|范围)?综述|literature review/i.test(run.taskContext.rootPrompt))type='review';
  const changes:Record<string,TaskPlan['taskType']>={研究方案:'proposal',开题报告:'proposal',报告:'report',论文:'paper',综述:'review',短回答:'local'};
  for(const instruction of run.taskContext.supplements){
    if(/(?:只|仅)(?:改|调整|整理|修改).{0,5}(?:格式|版式|排版)/.test(instruction)){type='format';continue;}
    const change=/(?:把|将)?(?:综述|成果|文章|论文|报告|任务).{0,8}(?:改为|改成|调整为|换成).{0,6}(研究方案|开题报告|报告|论文|综述|短回答)/.exec(instruction);
    if(change)type=changes[change[1]];
  }
  return type;
}
