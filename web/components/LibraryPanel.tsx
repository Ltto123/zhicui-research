'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Bookmark, Check, LoaderCircle, Search } from 'lucide-react';
import type { LibraryItem, LibraryReadingStatus } from '../../shared/library';
import { api, body, errorText } from '../lib/api';
import { evidenceSourceHref } from '../lib/source-links';
import {SourceLink,SourceReturnContext} from './SourceLink';
import {readWorkspaceReturn,workspaceReturnHref} from '../lib/workspace-return';
import styles from './LibraryPanel.module.css';

export interface LibraryDraft {
  revision: number;
  tags: string;
  note: string;
  readingStatus: LibraryReadingStatus;
  dirty: boolean;
}

const readingLabels: Record<LibraryReadingStatus, string> = { unread: '未读', reading: '在读', read: '已读' };
const scopeLabels = { metadata: '已存书目信息', abstract: '已存摘要', full_text: '已存全文' };
const scopeRank = { metadata: 0, abstract: 1, full_text: 2 };
const draftKey = (projectId: string, itemId: string) => `${projectId}:${itemId}`;
const fromItem = (item: LibraryItem): LibraryDraft => ({ revision: item.revision, tags: item.tags.join('，'), note: item.note, readingStatus: item.readingStatus, dirty: false });
const parseTags = (value: string) => [...new Set(value.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))];

/** The owning workspace keeps this cache across panel and project switches. */
export function LibraryPanel({ projectId, refreshKey, drafts, onChanged }: { projectId: string; refreshKey: number; drafts: Map<string, LibraryDraft>; onChanged: () => void }) {
  const parentReturnTo=useContext(SourceReturnContext);
  const returnLocation=readWorkspaceReturn(parentReturnTo??'/');
  const initialSelection=useRef({projectId,id:returnLocation?.libraryItemId});
  if(initialSelection.current.projectId!==projectId)initialSelection.current={projectId,id:returnLocation?.libraryItemId};
  const [collection, setCollection] = useState<{ projectId: string; items: LibraryItem[] }>();
  const [selected, setSelected] = useState<{ projectId: string; id: string }>();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [, renderDraft] = useState(0);
  const activeProject = useRef(projectId);
  const requestVersion = useRef(0);
  const mutationBusy = useRef(new Set<string>());
  activeProject.current = projectId;

  useEffect(() => {
    setSearch(''); setTag(''); setStatus(''); setMessage(''); setError(''); setPending('');
  }, [projectId]);

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setLoading(true);
    if (!projectId) { setCollection(undefined); setLoading(false); return; }
    void api<LibraryItem[]>(`/projects/${encodeURIComponent(projectId)}/library`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) }).then(items => {
      if (controller.signal.aborted || activeProject.current !== projectId || requestVersion.current !== version) return;
      for (const item of items) {
        const key = draftKey(projectId, item.id);
        if (!drafts.get(key)?.dirty) drafts.set(key, fromItem(item));
      }
      setCollection({ projectId, items });
      // Consume the requested item only after this project's list loads. Later
      // refreshes retain the user's current selection instead of restoring again.
      const requestedId=initialSelection.current.id;
      initialSelection.current.id=undefined;
      setSelected(previous => {
        if(previous?.projectId===projectId&&items.some(item=>item.id===previous.id))return previous;
        const next=items.find(item=>item.id===requestedId)??items[0];
        return next?{projectId,id:next.id}:undefined;
      });
    }).catch(cause => {
      if (!controller.signal.aborted && activeProject.current === projectId && requestVersion.current === version) setError(errorText(cause));
    }).finally(() => {
      if (!controller.signal.aborted && activeProject.current === projectId && requestVersion.current === version) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, refreshKey, reload, drafts]);

  const items = collection?.projectId === projectId ? collection.items : [];
  const tags = [...new Set(items.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const query = search.trim().toLocaleLowerCase();
  const filtered = items.filter(item => (!query || [item.title, item.authors, item.doi, ...item.tags].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)) && (!tag || item.tags.includes(tag)) && (!status || item.readingStatus === status));
  const item = selected?.projectId === projectId ? filtered.find(value => value.id === selected.id) : undefined;
  const key = item ? draftKey(projectId, item.id) : '';
  const draft = item ? drafts.get(key) ?? fromItem(item) : undefined;
  const conflicted = Boolean(item && draft?.dirty && draft.revision !== item.revision);
  const busy = Boolean(item && (pending === key || mutationBusy.current.has(key)));
  const origin = item ? [...item.origins].sort((a, b) => scopeRank[b.readScope] - scopeRank[a.readScope])[0] : undefined;
  const orphanDrafts = !loading && collection?.projectId === projectId ? [...drafts.entries()].filter(([cachedKey, value]) => cachedKey.startsWith(`${projectId}:`) && value.dirty && !items.some(value => draftKey(projectId, value.id) === cachedKey)) : [];

  function edit(update: Partial<LibraryDraft>) {
    if (!item || !draft || busy) return;
    const next = { ...draft, ...update };
    next.dirty = next.note !== item.note || next.readingStatus !== item.readingStatus || JSON.stringify(parseTags(next.tags)) !== JSON.stringify(item.tags);
    drafts.set(key, next); setMessage(''); renderDraft(value => value + 1);
  }

  async function save() {
    if (!item || !draft || !draft.dirty || conflicted || busy || loading) return;
    const submitted = draft;
    const targetProject = projectId, targetKey = key;
    const nextTags = parseTags(draft.tags);
    if (nextTags.length > 12 || nextTags.some(value => value.length > 40)) { setError('最多 12 个标签，每个标签最多 40 字。'); return; }
    mutationBusy.current.add(targetKey); setPending(targetKey); setError(''); setMessage('');
    ++requestVersion.current;
    try {
      const saved = await api<LibraryItem>(`/projects/${encodeURIComponent(targetProject)}/library/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: body({ revision: submitted.revision, tags: nextTags, note: submitted.note, readingStatus: submitted.readingStatus }) });
      if (drafts.get(targetKey) === submitted) drafts.set(targetKey, fromItem(saved));
      onChanged();
      if (activeProject.current === targetProject) {
        ++requestVersion.current;
        setCollection(previous => previous?.projectId === targetProject ? { ...previous, items: previous.items.map(value => value.id === saved.id && value.revision <= saved.revision ? saved : value) } : previous);
        setMessage('整理信息已保存。'); setReload(value => value + 1);
      }
    } catch (cause) {
      if (activeProject.current === targetProject) { setError(`${errorText(cause)} 你的未保存修改已保留。`); setReload(value => value + 1); }
    } finally {
      mutationBusy.current.delete(targetKey);
      if (activeProject.current === targetProject) { setPending(''); renderDraft(value => value + 1); }
    }
  }

  async function remove() {
    if (!item || !draft || draft.dirty || busy || loading) return;
    const targetProject = projectId, targetKey = key, targetId = item.id;
    const submitted = draft;
    mutationBusy.current.add(targetKey); setPending(targetKey); setError(''); setMessage('');
    ++requestVersion.current;
    try {
      await api<void>(`/projects/${encodeURIComponent(targetProject)}/library/${encodeURIComponent(targetId)}`, { method: 'DELETE', body: body({ revision: item.revision }) });
      // Another mounted panel may have started a new draft while this request ran.
      if (drafts.get(targetKey) === submitted && !submitted.dirty) drafts.delete(targetKey);
      onChanged();
      if (activeProject.current === targetProject) {
        ++requestVersion.current;
        setCollection(previous => previous?.projectId === targetProject ? { ...previous, items: previous.items.filter(value => value.id !== targetId) } : previous);
        setMessage('已取消收藏，原始资料与任务记录仍保留。'); setReload(value => value + 1);
      }
    } catch (cause) {
      if (activeProject.current === targetProject) { setError(errorText(cause)); setReload(value => value + 1); }
    } finally {
      mutationBusy.current.delete(targetKey);
      if (activeProject.current === targetProject) setPending('');
    }
  }

  const returnTo=workspaceReturnHref({...returnLocation,libraryItemId:item?.id});
  return <SourceReturnContext.Provider value={returnTo}><section className={styles.panel} aria-label="当前课题文献夹">
    <header className={styles.intro}><div><h2>我的文献夹</h2><p>收藏当前课题值得继续阅读的文献。</p></div><Bookmark size={20} strokeWidth={1.5} /></header>
    <p className={styles.boundary}>个人笔记不会自动发送给 AI。阅读状态由你标记，不代表 AI 已阅读；这里的整理不会调用模型或联网检索。</p>
    <div className={styles.toolbar}><span>{items.length} 篇收藏</span>{projectId && items.length > 0 ? <a href={`/api/projects/${encodeURIComponent(projectId)}/library/export.bib`} download="zhicui-library.bib"><ArrowDown size={13} />导出全部 BibTeX</a> : <button disabled><ArrowDown size={13} />导出 BibTeX</button>}</div>
    <p className={styles.draftHint}>导出不含个人笔记。作者原始文本保留在备注字段，导入后请核对作者信息。</p>
    <label className={styles.search}><Search size={15} /><input aria-label="搜索收藏文献" placeholder="标题、作者、DOI 或标签" value={search} onChange={event => setSearch(event.target.value)} disabled={!projectId} /></label>
    <div className={styles.filters}><select aria-label="按标签筛选" value={tag} onChange={event => setTag(event.target.value)} disabled={!projectId}><option value="">全部标签</option>{tags.map(value => <option key={value}>{value}</option>)}</select><select aria-label="按我的阅读状态筛选" value={status} onChange={event => setStatus(event.target.value)} disabled={!projectId}><option value="">全部阅读状态</option>{Object.entries(readingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => { setError(''); setReload(value => value + 1); }} disabled={loading}>刷新列表</button></div>}
    {message && <p className={styles.success} role="status"><Check size={14} />{message}</p>}
    {loading && <p className={styles.loading} role="status"><LoaderCircle size={15} className="spin" />正在读取收藏…</p>}
    {!loading && !items.length && <div className={styles.empty}><Bookmark size={28} strokeWidth={1.2} /><h3>{projectId ? '把值得读的文献留在这里' : '先选择一个课题'}</h3><p>在「材料」的已保存资料中，点击「收藏到文献夹」。</p></div>}
    {!loading && Boolean(items.length) && !filtered.length && <p className={styles.empty}>没有符合筛选条件的收藏。</p>}
    <div className={styles.list}>{filtered.map(value => <button key={value.id} className={`${styles.card} ${value.id === item?.id ? styles.selected : ''}`} aria-pressed={value.id === item?.id} onClick={() => { setSelected({ projectId, id: value.id }); setMessage(''); setError(''); }}>
      <strong>{value.title}</strong><span>{[value.authors, value.year].filter(Boolean).join(' · ') || '作者与年份待补全'}</span><div><small>{readingLabels[value.readingStatus]}</small>{value.tags.map(value => <small key={value}>#{value}</small>)}{drafts.get(draftKey(projectId, value.id))?.dirty && <small className={styles.unsaved}>有未保存修改</small>}</div>
    </button>)}</div>
    {item && draft && <section className={styles.editor} aria-label={`整理文献：${item.title}`}>
      <h3>{item.title}</h3><p className={styles.metadata}>{[item.journal, item.year].filter(Boolean).join(' · ')}{item.doi && <span>DOI：{item.doi}</span>}</p>
      <div className={styles.source}><span>{scopeLabels[item.readScope]}</span>{origin && <SourceLink href={evidenceSourceHref(origin.runId, origin.evidenceId)} target="_blank" rel="noopener noreferrer">打开原文<ArrowUpRight size={12} /></SourceLink>}</div>
      {item.abstract && <details className={styles.abstract}><summary>查看已保存摘要</summary><p>{item.abstract}</p></details>}
      <label>我的阅读状态<select aria-label="我的阅读状态" value={draft.readingStatus} onChange={event => edit({ readingStatus: event.target.value as LibraryReadingStatus })} disabled={busy}><option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option></select></label>
      <label>标签<input aria-label="文献标签" value={draft.tags} placeholder="如：方法参考，待精读" maxLength={520} onChange={event => edit({ tags: event.target.value })} disabled={busy} /><small>用逗号分隔，最多 12 个标签。</small></label>
      <label>个人笔记<textarea aria-label="个人笔记" rows={7} maxLength={10000} value={draft.note} placeholder="写下你的想法、疑问或准备引用的位置…" onChange={event => edit({ note: event.target.value })} disabled={busy} /><small>原文保持只读。笔记仅作个人整理，不自动用作研究证据。</small></label>
      {conflicted && <div className={styles.conflict} role="alert"><strong>这条收藏已有新版本</strong><p>你的草稿已保留。先核对最新内容，再决定是否将自己的修改用于新版。</p><details><summary>查看最新整理信息</summary><p>阅读状态：{readingLabels[item.readingStatus]}<br />标签：{item.tags.join('，') || '无'}</p><pre>{item.note || '尚无笔记'}</pre></details><button onClick={() => { drafts.set(key, { ...draft, revision: item.revision }); renderDraft(value => value + 1); setError(''); }} disabled={busy}>保留我的草稿，基于新版继续编辑</button></div>}
      <div className={styles.actions}><span>{draft.dirty ? '未保存 · 切换条目仍会保留' : '已保存'}</span><button className={styles.save} onClick={() => void save()} disabled={!draft.dirty || conflicted || busy || loading}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存整理</button></div>
      <p className={styles.draftHint}>未保存的草稿仅保留在当前页面；刷新或关闭页面前请保存。</p>
      <div className={styles.remove}><button onClick={() => void remove()} disabled={draft.dirty || busy || loading}>取消收藏</button><small>{draft.dirty ? '请先保存修改，再取消收藏。' : '只移出文献夹，原始资料和任务记录仍保留。'}</small></div>
    </section>}
    {orphanDrafts.map(([orphanKey, value]) => <section className={styles.conflict} key={orphanKey}><strong>该收藏已被移除，未保存内容仍保留</strong><p>请复制需要保留的内容，再到材料中重新收藏。</p><p>标签：{value.tags || '无'} · 阅读状态：{readingLabels[value.readingStatus]}</p><textarea aria-label="已移除文献的未保存笔记" rows={5} value={value.note} readOnly /></section>)}
  </section></SourceReturnContext.Provider>;
}
