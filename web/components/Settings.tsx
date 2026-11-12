'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, LoaderCircle, PlugZap, X } from 'lucide-react';
import type { ModelConnectionsState } from '../../shared/types';
import { ModelConnectionManager } from './ModelConnectionManager';
import type { researchCapabilities } from '../../server/research-skills';
import { api, body, errorText } from '../lib/api';

interface RetrievalConnectionStatus {
  network: { mode: 'proxy' | 'direct'; proxy?: string; message: string; checkedAt: string };
  sources: { name: string; scope: string; status: 'not_checked' | 'available' | 'failed'; detail: string; checkedAt?: string }[];
}
const connectionLabels = { not_checked: '未检查', available: '可连接', failed: '连接失败' };
const checkedTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Settings({ onClose, onConnectionsChanged }: { onClose: () => void; onConnectionsChanged: (state: ModelConnectionsState) => void }) {
  const [busy, setBusy] = useState(false);
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalConnectionStatus>();
  const [retrievalBusy, setRetrievalBusy] = useState(false);
  const [retrievalError, setRetrievalError] = useState('');
  const [capabilities, setCapabilities] = useState<ReturnType<typeof researchCapabilities>>();
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const retrievalRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    api<RetrievalConnectionStatus>('/retrieval/status', { signal: abort.signal })
      .then(setRetrievalStatus)
      .catch(error => { if (!abort.signal.aborted) setRetrievalError(errorText(error)); });
    api<ReturnType<typeof researchCapabilities>>('/research-capabilities', { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setCapabilities(result); })
      .catch(error => { if (!abort.signal.aborted) setCapabilitiesError(errorText(error)); });
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { abort.abort(); retrievalRequest.current?.abort(); before?.focus(); };
  }, []);

  async function checkRetrieval() {
    if (retrievalRequest.current) return;
    const abort = new AbortController();
    retrievalRequest.current = abort;
    setRetrievalBusy(true); setRetrievalError('');
    try {
      const result = await api<RetrievalConnectionStatus>('/retrieval/test', {
        method: 'POST', body: '{}', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
      });
      if (!abort.signal.aborted) setRetrievalStatus(result);
    } catch (error) { if (!abort.signal.aborted) setRetrievalError(errorText(error)); }
    finally { retrievalRequest.current = null; if (!abort.signal.aborted) setRetrievalBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={panel} tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) onClose();
        if (event.key === 'Tab') {
          const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]') ?? []);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header><div><span className="eyebrow">你的研究工具</span><h2 id="settings-title">模型与检索接入</h2></div>
        <button className="icon-button" aria-label="关闭模型设置" onClick={onClose} disabled={busy}><X size={19} /></button></header>
      <p className="muted">保存多个接口与模型，为下次执行或接续选择。材料只会在实际执行时发送给该轮使用的提供方。</p>
      <ModelConnectionManager onChanged={onConnectionsChanged} onBusyChange={setBusy} />
      <section className="retrieval-settings" aria-labelledby="research-skills-title">
        <h3 id="research-skills-title">工作台已经融入哪些技能</h3>
        {capabilities ? <>
          <ul className="retrieval-source-status">{capabilities.skills.map(skill => <li key={skill.id}>
            <strong>{skill.name}</strong><p>{skill.description}</p><small>{skill.boundary}</small>
          </li>)}</ul>
          <p>{capabilities.execution}</p>
          <details><summary>还没有接入的来源</summary><ul>{capabilities.notConnected.map(source => <li key={source.name}><strong>{source.name}</strong>：{source.reason}</li>)}</ul></details>
          <small>{capabilities.note}</small>
        </> : <p>{capabilitiesError ? `技能清单暂时无法读取：${capabilitiesError}` : '正在读取技能清单…'}</p>}
      </section>
      <section className="retrieval-settings" aria-labelledby="retrieval-settings-title">
        <div className="retrieval-settings-heading"><h3 id="retrieval-settings-title">文献检索与网络</h3><button className="text-button" onClick={() => void checkRetrieval()} disabled={retrievalBusy}>
          {retrievalBusy ? <LoaderCircle size={15} className="spin" /> : <PlugZap size={15} />}{retrievalBusy ? '正在检查…' : '检查数据库连接'}</button></div>
        <p>模型连接与数据库连接分别检查。点击检查会向下列来源发出请求；打开设置只读取已记录的状态。</p>
        {retrievalStatus && <>
          <div className="retrieval-network"><strong>{retrievalStatus.network.mode === 'proxy' ? '工作台服务器通过代理访问' : '工作台服务器直接访问网络'}</strong>
            {retrievalStatus.network.proxy && <span>{retrievalStatus.network.proxy}</span>}<p>{retrievalStatus.network.message}</p>
            <small>{retrievalStatus.network.checkedAt ? `状态记录于 ${checkedTime(retrievalStatus.network.checkedAt)}` : '尚未检查网络连接'}</small></div>
          <ul className="retrieval-source-status">{retrievalStatus.sources.map(source => <li key={source.name}>
            <div><strong>{source.name}</strong><span className={`connection-state ${source.status}`}>{connectionLabels[source.status]}</span></div>
            <p>{source.scope}</p><p>{source.detail}</p>{source.checkedAt && <small>检查于 {checkedTime(source.checkedAt)}</small>}
          </li>)}</ul>
          <small>连接可用表示来源能够响应；具体任务的召回数量与阅读范围，请查看该任务的检索记录。</small>
          <p className="muted"><small>部分书目信息来自 <a href="https://graph.openaire.eu/" target="_blank" rel="noopener noreferrer">OpenAIRE Graph</a>，按 <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> 使用；工作台会整理和合并重复记录。</small></p>
        </>}
        {!retrievalStatus && !retrievalError && <p>正在读取检索接入信息…</p>}
        {retrievalError && <div className="notice error" role="alert">检索连接检查未完成：{retrievalError}</div>}
      </section>
    </div>
  </div>;
}
