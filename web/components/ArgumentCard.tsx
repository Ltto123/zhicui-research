import { BookOpen, ChevronDown, ListChecks } from 'lucide-react';
import type { Run } from '../../shared/types';
import {awaitingWritingOutline} from '../lib/run-progress';

export const scopeLabels: Record<string, string> = { full_text: '全文', abstract: '摘要', metadata: '书目记录', user_material: '已提供材料', computed: '计算结果' };
const supportLabels: Record<string, string> = { supported: '支持', partial: '部分支持', unsupported: '不支持', contradicted: '存在反证', unclear: '无法判断' };

export function ArgumentCard({ run }: { run: Run }) {
  if (!run.outline) return null;
  const waiting=awaitingWritingOutline(run),hasDraft=Boolean(run.draft?.trim()),running=run.status==='running'||run.status==='queued';
  const title=hasDraft?'写作结构与证据核对':'写作提纲';
  const card=<section className="argument-card" aria-label={title}>
    <div className="argument-heading"><ListChecks size={18} /><h3>{waiting?'请审校写作提纲':title}</h3><span>{waiting?'等待你的审校':hasDraft?'内部核对记录':'章节与主要论点'}</span></div>
    <p className="argument-question">{run.outline.question}</p>
    <div className="argument-delivery">交付目标 · {run.outline.deliverable}</div>
    {run.outline.rows.map((row, index) => <details key={index} className="argument-row" open={waiting}>
      <summary><span className="argument-number">{String(index + 1).padStart(2, '0')}</span><span>{row.section}</span><ChevronDown size={14} /></summary>
      <div className="argument-body"><p className="argument-purpose">{row.purpose}</p><p>{row.claim}</p>
        <details className="argument-evidence"><summary>查看证据核对详情<ChevronDown size={12}/></summary><div className={`support-label ${row.support}`}>{supportLabels[row.support] || row.support}</div>
        <dl><dt>依据与位置</dt><dd>{row.evidenceIds.length ? row.evidenceIds.map(id => {
          const source = run.evidence.find(item => item.id === id);
          return <div className="argument-source" key={id}><BookOpen size={12} /><span>{source?.title || id}{source && <small> · {scopeLabels[source.readScope]}</small>}</span></div>;
        }) : '当前没有可直接支持的证据'}{row.locations.length > 0 && <small>{row.locations.join('；')}</small>}</dd>
          <dt>论证方法</dt><dd>{row.reasoning}</dd><dt>范围与缺口</dt><dd>{row.limits || '详见证据范围与审查记录'}</dd></dl></details>
      </div>
    </details>)}
    {run.outline.gaps.length > 0 && <div className="argument-gaps"><strong>{hasDraft?'提纲阶段记录的边界':'提纲中的研究边界'}</strong>{hasDraft&&<p>这是提纲形成时的记录；当前结论与仍适用的限制，以最新稿件和审查为准。</p>}<ul>{run.outline.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div>}
    <div className="argument-footer">{waiting?'请审校章节安排和主要论点，可发送调整意见。提纲通过后，成稿、内部修订和复查由系统自动完成。':hasDraft?`${running?'系统自动同步写作结构与证据':'已保存的内部结构核对记录'}，无需再次确认。${running?'':'当前是否运行以任务状态为准。'}`:running?'系统正在处理写作提纲；是否等待审校以本次设置和任务状态为准。':'本次执行已停止。这份提纲保留了当时的结构、证据与缺口，不表示任务仍在后台运行。'}</div>
  </section>;
  return waiting?card:<details className="review-details"><summary>查看写作提纲<ChevronDown size={12}/></summary>{card}</details>;
}
