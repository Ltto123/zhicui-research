'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowUpRight, BookOpen, Bookmark, Check, ChevronDown, ChevronLeft,
  ChevronRight, FileText, FolderOpen, Globe, Library, Link2, RefreshCw, Search, X,
} from 'lucide-react';
import type { PaperLibraryItem, PaperLibraryPage } from '../../shared/paper-library';
import { api, body, errorText } from '../lib/api';
import { evidenceSourceHref } from '../lib/source-links';
import {SourceLink,SourceReturnContext} from './SourceLink';
import {readWorkspaceReturn,workspaceReturnHref} from '../lib/workspace-return';
import styles from './PaperLibrary.module.css';

interface PaperLibraryProps {
  projectId: string;
  projectName: string;
  conversationId?: string;
  conversationTitle?: string;
  onClose: () => void;
  onCollected?: () => void;
}

type PaperScope = 'metadata' | 'abstract' | 'full_text';
type ResourceFilter = '' | 'cached_pdf' | 'reader' | 'external';
type ListState =
  | { key: string; data: PaperLibraryPage }
  | { key: string; error: string };

const pageSize = 25;
const scopeLabels: Record<PaperScope, string> = {
  metadata: '仅题录',
  abstract: '已获摘要',
  full_text: '已获全文',
};

function externalHref(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return url.href;
    }
  } catch { /* A malformed saved link is not offered as a resource. */ }
}

function doiHref(doi?: string): string | undefined {
  if (!doi || !/^10\.\d{4,9}\/\S+$/i.test(doi)) return undefined;
  try { return 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/'); } catch { return undefined; }
}

function readerHref(paper: PaperLibraryItem): string | undefined {
  if (!paper.readerUrl?.startsWith('/source?')) return undefined;
  const query = new URLSearchParams(paper.readerUrl.slice('/source?'.length));
  const origin = paper.origins.find(item => item.kind === 'evidence'
    && item.runId === query.get('runId') && item.evidenceId === query.get('evidenceId'));
  return origin ? evidenceSourceHref(origin.runId, origin.evidenceId) : undefined;
}

function PaperRow({ paper, projectId, onCollected }: {
  paper: PaperLibraryItem; projectId: string; onCollected?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const posting = useRef(false);
  const doi = doiHref(paper.doi);
  const website = externalHref(paper.url);
  const externalResources = [...new Set(paper.resourceUrls.map(externalHref))]
    .filter((value): value is string => !!value && value !== doi && value !== website);
  const conversations = [...new Map(paper.origins.map(origin => [origin.conversationId, origin])).values()];
  const candidateOnly = paper.origins.length > 0 && paper.origins.every(origin => origin.kind === 'candidate');
  // Internal resources must point back to a projected evidence origin.
  const evidenceOrigins = paper.origins.filter(origin => origin.kind === 'evidence');
  const reader = readerHref(paper);
  const cachedPdf = evidenceOrigins.some(origin =>
    `/api/runs/${encodeURIComponent(origin.runId)}/evidence/${encodeURIComponent(origin.evidenceId)}/document` === paper.cachedPdfUrl)
    ? paper.cachedPdfUrl : undefined;
  const alreadySaved = saveState === 'saved' || (paper.isCollected && !paper.canUpgradeCollection);
  const collectLabel = alreadySaved ? '已收藏到文献夹' : paper.canUpgradeCollection ? '更新收藏' : '收藏到文献夹';

  async function collect() {
    const origin = paper.collectOrigin;
    if (!origin || origin.kind !== 'evidence' || posting.current || alreadySaved) return;
    posting.current = true;
    setSaveState('saving');
    setSaveError('');
    try {
      const result = await api<{ created: boolean }>(`/projects/${encodeURIComponent(projectId)}/library`, {
        method: 'POST', body: body({ runId: origin.runId, evidenceId: origin.evidenceId }),
      });
      setSaveState('saved');
      setMessage(paper.canUpgradeCollection ? '收藏已更新' : result.created ? '已收藏' : '已在文献夹');
      onCollected?.();
    } catch (error) {
      setSaveState('idle');
      setSaveError(errorText(error));
    } finally {
      posting.current = false;
    }
  }

  return <article className={styles.row} aria-label={paper.title}>
    <div className={styles.rowTop}>
      <h2><button className={styles.paperTitle} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {paper.title}<ChevronDown size={15} aria-hidden className={open ? styles.flipped : undefined} />
      </button></h2>
      {(paper.collectOrigin || paper.isCollected) && <button
        className={styles.bookmark} disabled={saveState === 'saving' || alreadySaved || !paper.collectOrigin}
        aria-label={collectLabel}
        title={collectLabel}
        onClick={() => void collect()}
      >{alreadySaved ? <Check size={17} /> : paper.canUpgradeCollection ? <RefreshCw size={16} /> : <Bookmark size={17} />}</button>}
    </div>
    {paper.authors && <p className={styles.authors}>{paper.authors}</p>}
    <div className={styles.metadata}>
      {(paper.journal || paper.year) && <span className={styles.publication}><BookOpen size={13} aria-hidden />
        {[paper.journal, paper.year].filter(Boolean).join(' · ')}</span>}
      <span className={`${styles.scopeBadge} ${paper.readScope === 'full_text' ? styles.fullText : ''}`}>
        {scopeLabels[paper.readScope]}
      </span>
      {candidateOnly && <span>检索候选</span>}
    </div>
    <div className={styles.links}>
      {doi && <a href={doi} title={paper.doi} target="_blank" rel="noopener noreferrer"><Link2 size={13} />DOI</a>}
      {website && website !== doi && <a href={website} target="_blank" rel="noopener noreferrer"><Globe size={13} />来源网页</a>}
      {cachedPdf && <a href={cachedPdf} target="_blank" rel="noopener noreferrer"><FileText size={13} />已存 PDF</a>}
      {reader && <SourceLink href={reader} target="_blank" rel="noopener noreferrer"><BookOpen size={13} />工作台阅读</SourceLink>}
      {externalResources.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">
        <ArrowUpRight size={13} />全文线索{externalResources.length > 1 ? ` ${index + 1}` : ''}</a>)}
    </div>
    {open && <div className={styles.details}>
      {paper.abstract && <div><h3>摘要</h3><p>{paper.abstract}</p></div>}
      {conversations.length > 0 && <div><h3>来自对话</h3><div className={styles.origins}>
        {conversations.map(origin => <a key={origin.conversationId}
          href={`/?conversation=${encodeURIComponent(origin.conversationId)}`} target="_blank" rel="noopener noreferrer">
          {origin.conversationTitle}<ArrowUpRight size={13} /></a>)}
      </div></div>}
    </div>}
    {message && <p className={styles.saved} role="status">{message}</p>}
    {saveError && <p className={styles.errorMessage} role="alert">{saveError}</p>}
  </article>;
}

export function PaperLibrary(props: PaperLibraryProps) {
  // A new navigation target owns its own filters, page and in-flight requests.
  return <PaperLibraryView key={`${props.projectId}/${props.conversationId ?? ''}`} {...props} />;
}

function PaperLibraryView({ projectId, projectName, conversationId, conversationTitle, onClose, onCollected }: PaperLibraryProps) {
  const parentReturnTo=useContext(SourceReturnContext);
  const [range, setRange] = useState<'conversation' | 'project'>(conversationId ? 'conversation' : 'project');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PaperScope | ''>('');
  const [resource, setResource] = useState<ResourceFilter>('');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<ListState>();
  const listTop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (text.trim() === query) return;
    const timer = window.setTimeout(() => { setQuery(text.trim()); setOffset(0); }, 180);
    return () => window.clearTimeout(timer);
  }, [text, query]);

  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (range === 'conversation' && conversationId) params.set('conversationId', conversationId);
  if (scope) params.set('scope', scope);
  if (resource) params.set('resource', resource);
  if (query) params.set('q', query);
  const path = `/projects/${encodeURIComponent(projectId)}/papers?${params.toString()}`;
  const requestKey = `${path}/${reload}`;
  useEffect(() => {
    const controller = new AbortController();
    void api<PaperLibraryPage>(path, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
    }).then(data => {
      if (controller.signal.aborted) return;
      if (offset > 0 && offset >= data.matched) {
        setOffset(Math.max(0, Math.ceil(data.matched / pageSize) - 1) * pageSize);
        return;
      }
      setResult({ key: requestKey, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key: requestKey, error: errorText(error) });
    });
    return () => controller.abort();
  }, [path, requestKey, offset]);

  const current = result?.key === requestKey ? result : undefined;
  const data = current && 'data' in current ? current.data : undefined;
  const error = current && 'error' in current ? current.error : undefined;
  const filtered = Boolean(scope || resource || query);
  const chooseRange = (next: 'conversation' | 'project') => { setRange(next); setOffset(0); };
  const clearFilters = () => { setText(''); setQuery(''); setScope(''); setResource(''); setOffset(0); };
  const changePage = (next: number) => {
    setOffset(next);
    listTop.current?.scrollTo({ top: 0 });
  };

  const returnTo=workspaceReturnHref({...readWorkspaceReturn(parentReturnTo??'/'),paperHash:`#papers/${projectId}${range==='conversation'&&conversationId?'/'+conversationId:''}`});
  return <SourceReturnContext.Provider value={returnTo}><section className={styles.screen} aria-label="论文库">
    <header className={styles.topbar}>
      <button className={styles.back} onClick={onClose}><ArrowLeft size={16} />返回工作台</button>
      <span className={styles.breadcrumb}><FolderOpen size={14} aria-hidden />{projectName}</span>
    </header>
    <div className={styles.scroll} ref={listTop}>
      <div className={styles.sheet}>
        <div className={styles.heading}>
          <span className={styles.mark}><Library size={23} strokeWidth={1.65} aria-hidden /></span>
          <div><h1>论文库</h1><p>{range === 'conversation' ? conversationTitle ?? '本对话' : projectName}</p></div>
        </div>
        <div className={styles.toolbar}>
          <div className={styles.range} aria-label="论文范围" role="group">
            {conversationId && <button aria-pressed={range === 'conversation'} onClick={() => chooseRange('conversation')}>本对话</button>}
            <button aria-pressed={range === 'project'} onClick={() => chooseRange('project')}>整个项目</button>
          </div>
          <div className={styles.controls}>
            <label className={styles.search}><Search size={16} aria-hidden />
              <input aria-label="搜索论文" type="search" placeholder="搜索题名、作者、DOI…" maxLength={200} value={text}
                onChange={event => setText(event.target.value)} />
            </label>
            <select aria-label="获取情况" value={scope} onChange={event => { setScope(event.target.value as PaperScope | ''); setOffset(0); }}>
              <option value="">全部获取情况</option>
              {Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select aria-label="可用资源" value={resource} onChange={event => { setResource(event.target.value as ResourceFilter); setOffset(0); }}>
              <option value="">全部资源</option><option value="cached_pdf">已存 PDF</option><option value="reader">工作台阅读</option><option value="external">外部链接</option>
            </select>
          </div>
        </div>
        <div className={styles.resultsBar}>
          <strong>{data ? filtered ? `匹配 ${data.matched} 篇 · 共 ${data.total} 篇` : `共 ${data.total} 篇论文` : '论文列表'}</strong>
          {(filtered || text) && <button onClick={clearFilters}><X size={13} />清除筛选</button>}
        </div>
        {!current && <p className={styles.feedback} role="status">正在读取论文…</p>}
        {error && <div className={styles.feedback} role="alert"><p>{error}</p><button onClick={() => setReload(value => value + 1)}>重新加载</button></div>}
        {data?.items.length === 0 && <div className={styles.empty}><BookOpen size={28} strokeWidth={1.4} aria-hidden />
          <h2>{filtered ? '没有匹配的论文' : range === 'conversation' ? '本对话暂无论文' : '这个项目暂无论文'}</h2>
          <p>{filtered ? '可以更换关键词或清除筛选。' : '研究中检索到的论文会自动出现在这里。'}</p>
        </div>}
        {data && data.items.map(paper => <PaperRow key={paper.id} paper={paper} projectId={projectId} onCollected={onCollected} />)}
        {data && data.matched > pageSize && <nav className={styles.pagination} aria-label="论文分页">
          <span>第 {Math.floor(offset / pageSize) + 1} / {Math.ceil(data.matched / pageSize)} 页</span>
          <button disabled={!offset} onClick={() => changePage(offset - pageSize)}><ChevronLeft size={15} />上一页</button>
          <button disabled={offset + pageSize >= data.matched} onClick={() => changePage(offset + pageSize)}>下一页<ChevronRight size={15} /></button>
        </nav>}
      </div>
    </div>
  </section></SourceReturnContext.Provider>;
}
