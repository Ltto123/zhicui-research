'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, FileText, Download, LoaderCircle } from 'lucide-react';
import type { Evidence } from '../../../shared/types';
import { api, errorText } from '../../lib/api';
import styles from './source.module.css';

type SourceResponse = { evidence: Evidence; cached: boolean };
type ResolvedDoi = { doi: string; url: string; via: string; warning?: string };
const resolutionLabel = (via: string) => via === 'direct' ? '直连解析' : via === 'configured-network' ? '工作台网络解析' : '文献登记服务';

function publisherURL(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) ||
    /(^|\.)(localhost|local|internal|home|lan)$/.test(host)) throw new Error('出版商地址无效，暂时无法安全打开。');
  return url.href;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className={styles.page}><header className={styles.topbar}><a href="/" className={styles.back}><ArrowLeft size={16} />返回智萃工作台</a><span>文献原文</span></header>{children}</main>;
}

function SourceReader() {
  const query = useSearchParams();
  const runId = query.get('runId') ?? '';
  const evidenceId = query.get('evidenceId') ?? '';
  const doi = query.get('doi') ?? '';
  const hasSource = Boolean(runId || evidenceId);
  const sourceValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) && /^[a-z0-9_-]{1,200}$/i.test(evidenceId);
  const valid = hasSource ? sourceValid : doi.length <= 1000 && /^10\.\d{4,9}\/\S+$/i.test(doi);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<SourceResponse | null>(null);
  const [publisher, setPublisher] = useState<ResolvedDoi | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState(false);
  const [publisherError, setPublisherError] = useState('');
  const [view, setView] = useState<'pdf' | 'text'>('text');
  const controller = useRef<AbortController | null>(null);
  const publisherController = useRef<AbortController | null>(null);

  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    setResult(null); setPublisher(null); setError(''); setPublisherError(''); setResolving(false);
    publisherController.current?.abort();
    if (!valid) { setLoading(false); return () => current.abort(); }
    setLoading(true);
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(90_000)]);
    void (async () => {
      try {
        if (hasSource) {
          const value = await api<SourceResponse>(`/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}/source`, { signal });
          if (!value?.evidence || value.evidence.id !== evidenceId || typeof value.evidence.text !== 'string' || typeof value.evidence.title !== 'string') throw new Error('原文响应不完整，请重新读取。');
          if (!current.signal.aborted) { setResult(value); setView(value.evidence.sourceDocument?.mimeType === 'application/pdf' ? 'pdf' : 'text'); }
        } else {
          const value = await api<ResolvedDoi>(`/doi/resolve?doi=${encodeURIComponent(doi)}`, { signal });
          const url = publisherURL(value.url);
          if (!current.signal.aborted) setPublisher({ ...value, url });
        }
      } catch (cause) {
        if (!current.signal.aborted) setError(signal.aborted ? '读取超时，请稍后重新尝试。' : errorText(cause));
      } finally { if (!current.signal.aborted) setLoading(false); }
    })();
    return () => { current.abort(); publisherController.current?.abort(); };
  }, [runId, evidenceId, doi, hasSource, valid, attempt]);

  async function resolvePublisher() {
    if (!result?.evidence.doi || resolving) return;
    const current = new AbortController(); publisherController.current?.abort(); publisherController.current = current;
    setResolving(true); setPublisherError('');
    const signal = AbortSignal.any([current.signal, AbortSignal.timeout(45_000)]);
    try {
      const value = await api<ResolvedDoi>(`/doi/resolve?doi=${encodeURIComponent(result.evidence.doi)}`, { signal });
      const url = publisherURL(value.url);
      if (!current.signal.aborted) setPublisher({ ...value, url });
    } catch (cause) { if (!current.signal.aborted) setPublisherError(signal.aborted ? '出版商地址解析超时，可重试。' : errorText(cause)); }
    finally { if (!current.signal.aborted) setResolving(false); }
  }

  const evidence = result?.evidence;
  const documentURL = sourceValid ? `/api/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}/document` : '';
  const pdf = evidence?.sourceDocument?.mimeType === 'application/pdf';
  const scope = evidence?.readScope === 'full_text' ? '已获取正文' : evidence?.readScope === 'abstract' ? '摘要 · 尚未取得正文' : evidence?.readScope === 'metadata' ? '仅有书目信息 · 尚未取得正文' : '来源材料';

  return <Shell>
    {!valid ? <section className={styles.notice}><h1>无法读取原文</h1><p>原文链接参数不完整或无效。</p></section> : <>
      {loading && <section className={styles.notice} role="status"><LoaderCircle className={styles.spinner} size={26} /><h1>{hasSource ? '正在读取文献原文' : '正在定位出版商页面'}</h1><p>通过工作台的网络连接读取，最长等待 90 秒。</p><button className={styles.button} onClick={() => { controller.current?.abort(); setLoading(false); setError('读取已停止，可重新尝试。'); }}>停止读取</button></section>}
      {error && <section className={styles.notice} role="alert"><h1>原文暂未读取完成</h1><p>{error}</p><button className={styles.primary} onClick={() => setAttempt(value => value + 1)}>重新读取</button></section>}
      {!loading && !error && !hasSource && publisher && <section className={styles.identity}><span className={styles.eyebrow}>DOI 来源定位</span><h1>{publisher.doi}</h1><p>仅定位出版商页面，尚未取得全文。</p><a className={styles.primary} href={publisher.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开出版商页面<ExternalLink size={15} /></a><p className={styles.muted}>解析来源：{resolutionLabel(publisher.via)}</p>{publisher.warning && <p className={styles.muted}>{publisher.warning}</p>}</section>}
      {evidence && <>
        <section className={styles.identity}>
          <span className={styles.eyebrow}><FileText size={15} />{scope}</span>
          <h1>{evidence.title}</h1>
          <div className={styles.metadata}>{evidence.authors && <span>{evidence.authors}</span>}{evidence.year && <span>{evidence.year}</span>}{evidence.journal && <span>{evidence.journal}</span>}</div>
          {evidence.doi && <p className={styles.doi}>DOI: {evidence.doi}</p>}
          <p className={styles.muted}>{evidence.location}</p>
          <div className={styles.actions}>
            {pdf && <a className={styles.primary} href={documentURL} download><Download size={15} />下载原始 PDF</a>}
            {publisher ? <a className={styles.button} href={publisher.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">出版商原页面<ExternalLink size={15} /></a> : evidence.doi && <button className={styles.button} onClick={() => void resolvePublisher()} disabled={resolving}>{resolving ? '正在定位出版商…' : '定位出版商原页面'}</button>}
            <span className={styles.muted}>{result.cached ? '已保存的来源内容' : '本次读取的来源内容'} · {evidence.text.length.toLocaleString('zh-CN')} 字符</span>
          </div>
          {publisherError && <p role="alert" className={styles.warning}>{publisherError}</p>}
          {publisher?.warning && <p className={styles.muted}>{publisher.warning}</p>}
        </section>
        <section className={styles.reader} aria-label="来源内容">
          <div className={styles.readerbar}><div className={styles.tabs}>{pdf && <button className={view === 'pdf' ? styles.active : ''} aria-pressed={view === 'pdf'} onClick={() => setView('pdf')}>原始 PDF</button>}<button className={view === 'text' ? styles.active : ''} aria-pressed={view === 'text'} onClick={() => setView('text')}>{evidence.readScope === 'abstract' ? '摘要文本' : '正文文本'}</button></div><span>来源原文，非 AI 研读笔记</span></div>
          {pdf && view === 'pdf' ? <><iframe className={styles.pdf} title="原始 PDF" src={documentURL} referrerPolicy="no-referrer" /><p className={styles.pdfHelp}>若浏览器无法预览，可使用上方“下载原始 PDF”。</p></> : <pre className={styles.text} data-testid="source-text">{evidence.text}</pre>}
        </section>
        {evidence.abstract && evidence.abstract !== evidence.text && <details className={styles.abstract}><summary>查看原摘要</summary><p>{evidence.abstract}</p></details>}
      </>}
    </>}
  </Shell>;
}

export default function SourcePage() {
  return <Suspense fallback={<Shell><section className={styles.notice}>正在打开原文页…</section></Shell>}><SourceReader /></Suspense>;
}
