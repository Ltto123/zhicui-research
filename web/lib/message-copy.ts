import type {Message,Run} from '../../shared/types';

const support:Record<string,string>={supported:'支持',partial:'部分支持',unsupported:'不支持',contradicted:'存在反证',unclear:'无法判断'};
export function messageCopyText(message:Message,run?:Run):string{
  if(message.kind!=='outline'||!run?.outline)return message.content;
  const outline=run.outline;
  return ['论证清单',outline.question,`交付目标：${outline.deliverable}`,...outline.rows.map((row,index)=>[
    `${index+1}. ${row.section}`,row.purpose,row.claim,`支持情况：${support[row.support]??'无法判断'}`,
    `依据：${row.evidenceIds.map(id=>run.evidence.find(source=>source.id===id)?.title??'未关联来源').join('；')||'当前没有可直接支持的证据'}`,
    row.locations.length?`位置：${row.locations.join('；')}`:'',`论证方法：${row.reasoning}`,`范围与缺口：${row.limits||'详见证据范围与审查记录'}`,
  ].filter(Boolean).join('\n')),outline.gaps.length?'仍需保留的边界：\n'+outline.gaps.map(gap=>`• ${gap}`).join('\n'):''].filter(Boolean).join('\n\n');
}
export async function copyMessageText(text:string,writeText:((text:string)=>Promise<void>)|undefined):Promise<void>{
  if(!writeText)throw new Error('当前浏览器无法访问剪贴板，请手动选择正文复制。');
  await writeText(text);
}
