import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import type { Evidence, RetrievalDiagnostic } from '../../shared/types.ts';
import { arxivQuery } from './query.ts';
import { readLiteratureResponse } from './network.ts';

const ATOM = 'http://www.w3.org/2005/Atom', ARXIV = 'http://arxiv.org/schemas/atom', SEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
let queue: Promise<void> = Promise.resolve();
let lastStarted = -Infinity;
let pendingRequests = 0;

function aborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
}
/** One live arXiv connection at a time, and >=3s between starts, across runs. */
function scheduled<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  pendingRequests++;
  const pending = queue.then(async () => {
    signal.throwIfAborted(); return await work();
  }).finally(() => { pendingRequests--; });
  queue = pending.then(() => undefined, () => undefined);
  return aborted(pending, signal);
}
const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();
const children = (node: Element, name: string, namespace = ATOM): Element[] => Array.from(node.childNodes).filter(child => child.nodeType === 1 && (child as Element).localName === name && (child as Element).namespaceURI === namespace) as Element[];
const field = (node: Element, name: string, namespace = ATOM) => tidy(children(node, name, namespace)[0]?.textContent || '');
const identifier = (url: string): string | undefined => /^https?:\/\/(?:export\.)?arxiv\.org\/abs\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?)$/i.exec(url)?.[1];
const doiOf = (value: string) => { const doi = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase(); return /^10\.\d{4,9}\/[^\s\x00-\x1f]+$/.test(doi) ? doi : undefined; };

export class ArxivSearchError extends Error {
  constructor(message: string, public diagnostics: RetrievalDiagnostic[]) { super(message); this.name = 'ArxivSearchError'; }
}

/** Health probes must observe the API's processwide single-connection rule.
 * Never queue a probe behind research work or use a parallel network path. */
export async function probeArxiv(signal: AbortSignal, onProgress?: (message: string) => void): Promise<Awaited<ReturnType<typeof searchArxiv>> | undefined> {
  signal.throwIfAborted();
  if (pendingRequests > 0) return undefined;
  return searchArxiv('electron', signal, { size: 1, onProgress });
}

export async function searchArxiv(query: string, signal: AbortSignal, options: { start?: number; size?: number; onProgress?: (message: string) => void } = {}): Promise<{ evidence: Evidence[]; diagnostics: RetrievalDiagnostic[]; more: boolean; warnings: string[] }> {
  signal.throwIfAborted();
  const diagnostics: RetrievalDiagnostic[] = [], warnings: string[] = [];
  const url = new URL('https://export.arxiv.org/api/query');
  let translated = query;
  const start = Number.isFinite(options.start) ? Math.max(0, Math.min(29_999, Math.floor(options.start!))) : 0;
  const size = Number.isFinite(options.size) ? Math.max(1, Math.min(50, Math.floor(options.size!))) : 50;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    translated = arxivQuery(query);
    url.search = new URLSearchParams({ search_query: translated, start: String(start), max_results: String(size), sortBy: 'relevance', sortOrder: 'descending' }).toString();
    const xml = await scheduled(() => readLiteratureResponse(url, combined, {
      headers: { Accept: 'application/atom+xml', 'User-Agent': 'ZhicuiResearch/0.1 (metadata search)' },
      beforeRequest: async () => { const pause = Math.max(0, lastStarted + 3000 - Date.now()); if (pause) await wait(pause, combined); combined.throwIfAborted(); lastStarted = Date.now(); },
      onFallback: message => { warnings.push(message); diagnostics.push({ source: 'arXiv', query: translated, url: url.href, status: 'error', returned: 0, error: message, retrievedAt: new Date().toISOString() }); if (options.onProgress) options.onProgress(message); else console.warn(message); },
    }), combined);
    const fail = (): never => { throw new Error('arXiv 未返回有效 Atom 文献列表'); };
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail();
    const document = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(xml, 'application/xml');
    const root = document.documentElement; if (!root || root.localName !== 'feed' || root.namespaceURI !== ATOM) fail();
    const entries = children(root, 'entry'); const evidence: Evidence[] = []; const retrievedAt = new Date().toISOString();
    for (const item of entries) {
      const rawId = field(item, 'id'); if (/\/api\/errors(?:#|$)/.test(rawId) || field(item, 'title') === 'Error') throw new Error('arXiv Atom 返回查询错误，未当作文献');
      const versioned = identifier(rawId); const title = field(item, 'title'); if (!versioned || !title) fail();
      const baseId = versioned!.replace(/v\d+$/i, ''), abstract = field(item, 'summary'), comment = field(item, 'comment', ARXIV);
      const withdrawn = /\b(?:this (?:paper|article|submission|preprint) (?:has been |is |was )?withdrawn|withdrawn (?:by|due|because|at))\b/i.test(`${title} ${comment} ${abstract}`) || /^\s*(?:\[withdrawn\]|withdrawn\b)/i.test(comment || title);
      const doi = doiOf(field(item, 'doi', ARXIV)); const published = field(item, 'published'), updated = field(item, 'updated');
      if (withdrawn) warnings.push(`arXiv ${versioned} 标记已撤回，仅保留元数据，不计为可用论文。`);
      evidence.push({ id: `E-${createHash('sha256').update(doi || `arxiv:${baseId.toLowerCase()}`).digest('hex').slice(0, 12)}`,
        title, url: `https://arxiv.org/abs/${versioned}`, ...(doi ? { doi } : {}),
        authors: children(item, 'author').map(author => field(author, 'name')).filter(Boolean).join(', '),
        year: /^\d{4}-\d{2}-\d{2}T/.test(published) ? published.slice(0, 4) : undefined,
        journal: field(item, 'journal_ref', ARXIV) || 'arXiv', publicationType: withdrawn ? 'withdrawn-preprint' : 'preprint',
        ...(abstract && !withdrawn ? { abstract, fullTextUrls: [`https://arxiv.org/pdf/${versioned}`] } : {}),
        text: withdrawn ? `已撤回文献元数据：${title}。不用于内容性主张。${comment}` : abstract || `文献元数据：${title}。尚未取得摘要。`,
        readScope: abstract && !withdrawn ? 'abstract' : 'metadata', retrievedAt,
        location: `arXiv ${versioned}；${withdrawn ? '已撤回（withdrawn），非有效内容证据' : abstract ? '完整原始摘要，未读取正文' : '书目元数据'}；首次提交 ${published || '未提供'}；版本更新 ${updated || '未提供'}；检索接口 ${url.href}` });
    }
    const total = Number(field(root, 'totalResults', SEARCH));
    diagnostics.push({ source: 'arXiv', query: translated, url: url.href, status: 'ok', returned: entries.length, retrievedAt });
    return { evidence, diagnostics, warnings, more: entries.length > 0 && (Number.isFinite(total) && total > 0 ? start + entries.length < total : entries.length === size) && start + entries.length < 30_000 };
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : 'arXiv 检索失败';
    diagnostics.push({ source: 'arXiv', query: translated, url: url.href, status: combined.aborted || /timeout|timed out/i.test(message) ? 'timeout' : 'error', returned: 0, error: message, retrievedAt: new Date().toISOString() });
    throw new ArxivSearchError(message, diagnostics);
  }
}
