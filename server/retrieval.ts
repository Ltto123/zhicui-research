import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Evidence, RetrievalDiagnostic } from '../shared/types.ts';
import { extractEpmcBody } from './full-text.ts';
import { searchArxiv } from './literature/arxiv.ts';
import { searchPubmed } from './literature/pubmed.ts';
import { searchEric } from './literature/eric.ts';
import { searchDoaj } from './literature/doaj.ts';
import { searchOpenAire } from './literature/openaire.ts';
import { selectLiteratureSources } from './literature/query.ts';
import { readLiteratureResponse } from './literature/network.ts';

/** Includes separate abstract discovery and selected-only body acquisition. */
export const RETRIEVAL_VERSION = 5;

const additionalSearch = { arXiv: searchArxiv, PubMed: searchPubmed, ERIC: searchEric, DOAJ: searchDoaj, OpenAIRE: searchOpenAire };
type AdditionalSource = keyof typeof additionalSearch;
type RetrievalSource = 'OpenAlex' | 'Europe PMC' | 'Crossref' | AdditionalSource;
const additionalSource = (name: RetrievalSource): name is AdditionalSource => Object.hasOwn(additionalSearch, name);

const DESCRIPTION_ONLY_TYPES = new Set(['dataset', 'paratext', 'software', 'withdrawn-preprint']);
const PUBLISHED_TYPES = new Set(['article', 'review', 'journal-article']);
const titleKey = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const isFigshareCollection = (doi?: string): boolean => /^10\.6084\/m9\.figshare\.c\.\d+(?:\.v\d+)?$/i.test(doi ?? '');
function explicitVersionPair(a: Evidence, b: Evidence): boolean {
  if (titleKey(a.title) !== titleKey(b.title) || !a.authors || a.authors.normalize('NFKC').toLowerCase() !== b.authors?.normalize('NFKC').toLowerCase()) return false;
  const published = (entry: Evidence) => PUBLISHED_TYPES.has(entry.publicationType ?? '');
  const related = (entry: Evidence) => entry.publicationType === 'preprint' || isFigshareCollection(entry.doi);
  return (published(a) && related(b)) || (published(b) && related(a));
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const normalizeText = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const plain = (value: string): string => normalizeText(value.replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*?)?\s*\/?>/g, ' '));
const stableId = (identity: string): string => `E-${createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 12)}`;
function doiOf(value: unknown): string | undefined {
  const doi = text(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : undefined;
}

async function readPublic(url: URL, signal: AbortSignal, diagnostics: RetrievalDiagnostic[] = [], source = '', query = '', validate?: (value: string) => void): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await readLiteratureResponse(url, signal, {
        headers: { Accept: 'application/json, application/xml;q=0.9', 'User-Agent': 'ZhicuiResearch/0.1 (evidence retrieval)' },
        onFallback: message => { diagnostics.push({ source, query, url: url.href, status: 'error', returned: 0, error: message, retrievedAt: new Date().toISOString() }); console.warn(message); },
      });
      let returned = 1;
      if (!url.pathname.endsWith('/fullTextXML')) {
        let parsed: Record<string, unknown>;
        try { parsed = record(JSON.parse(result)); } catch { throw new Error('接口未返回有效 JSON'); }
        const rows = source === 'OpenAlex' ? parsed.results : source === 'Europe PMC' ? record(parsed.resultList).result : record(parsed.message).items;
        if (!Array.isArray(rows)) throw new Error('接口响应缺少预期文献列表');
        returned = rows.length;
      }
      validate?.(result);
      diagnostics.push({ source, query, url: url.href, status: 'ok', returned, retrievedAt: new Date().toISOString() });
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message + (error.cause instanceof Error ? `（${error.cause.message}）` : '') : '接口错误';
      diagnostics.push({ source, query, url: url.href, status: /timeout|timed out/i.test(message) ? 'timeout' : 'error', returned: 0, error: message, retrievedAt: new Date().toISOString() });
      if (attempt || /HTTP 4(?!29)\d\d|长度限制|正文校验|拒绝/.test(message)) throw new Error(message);
      await delay(200, undefined, { signal });
    }
  }
  throw new Error('文献接口重试结束');
}

interface FullTextState {
  cache: Map<string, Promise<string>>;
  maximum: number;
  targetReached: () => boolean;
  onProgress?: (message: string) => void;
}
interface EuropeOptions {
  requireFullText?: boolean;
  abstractOnly?: boolean;
  fullTexts?: FullTextState;
  expectedDoi?: string;
  onEntry?: (entry: Evidence) => void;
  cursorMark?: string;
  onPage?: (nextCursor: string | undefined) => void;
}

async function europe(query: string, signal: AbortSignal, warnings: string[], diagnostics: RetrievalDiagnostic[] = [], size = 6, options: EuropeOptions = {}): Promise<Evidence[]> {
  const search = options.requireFullText ? `(${query}) AND OPEN_ACCESS:Y` : query;
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  url.search = new URLSearchParams({ query: search, format: 'json', resultType: 'core', pageSize: String(size) }).toString();
  if (options.cursorMark !== undefined) url.searchParams.set('cursorMark', options.cursorMark);
  const result = record(JSON.parse(await readPublic(url, signal, diagnostics, 'Europe PMC', search)));
  const nextCursor = text(result.nextCursorMark);
  options.onPage?.(array(record(result.resultList).result).length && nextCursor && nextCursor.length <= 8192 && nextCursor !== options.cursorMark ? nextCursor : undefined);
  const evidence: Evidence[] = [];
  for (const value of array(record(result.resultList).result)) {
    signal.throwIfAborted();
    const row = record(value); const title = plain(text(row.title));
    if (!title) continue;
    const doi = doiOf(row.doi); const id = text(row.id); const source = text(row.source);
    if (options.expectedDoi && doi !== options.expectedDoi) continue;
    const pmcid = /^PMC\d+$/.test(text(row.pmcid)) ? text(row.pmcid) : undefined;
    const abstract = plain(text(row.abstractText));
    const entry: Evidence = {
      id: stableId(doi || `epmc:${source}:${id}`), title,
      url: doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${encodeURIComponent(source || 'MED')}/${encodeURIComponent(id)}`,
      ...(doi ? { doi } : {}), authors: text(row.authorString), year: text(row.pubYear),
      journal: plain(text(record(record(row.journalInfo).journal).title)) || undefined,
      ...(abstract ? { abstract } : {}),
      ...(pmcid && row.isOpenAccess === 'Y' ? { fullTextUrls: [`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`] } : {}),
      text: abstract || `文献元数据：${title}。尚未取得摘要或正文，不用于支持内容性主张。`,
      location: `${abstract ? 'Europe PMC 返回的摘要全文' : 'Europe PMC 文献元数据'}；检索接口 ${url.href}`,
      readScope: abstract ? 'abstract' : 'metadata', retrievedAt: new Date().toISOString(),
    };
    const state = options.fullTexts;
    const mayDownload = !options.abstractOnly && (options.requireFullText ? Boolean(state && (state.cache.has(pmcid || '') || (!state.targetReached() && state.cache.size < state.maximum))) : evidence.length < 2);
    if (pmcid && row.isOpenAccess === 'Y' && mayDownload) {
      try {
        const load = async () => {
          state?.onProgress?.(`正在读取 ${pmcid} 的开放正文，并校验正文结构。`);
          let full = '';
          await readPublic(new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`), signal, diagnostics, 'Europe PMC', search, xml => { full = extractEpmcBody(xml); });
          return full;
        };
        if (state && !state.cache.has(pmcid)) state.cache.set(pmcid, load());
        entry.text = await (state?.cache.get(pmcid) ?? load()); entry.readScope = 'full_text';
        entry.location = `${pmcid}；https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML；已读取并校验 JATS 主文 body 文本；排除前置摘要、参考文献与附加文件，图像视觉内容未核验`;
      } catch (error) {
        signal.throwIfAborted();
        warnings.push(`${title.slice(0, 70)}：全文读取未完成（${error instanceof Error ? error.message : '读取失败'}），按${abstract ? '摘要' : '元数据'}使用。`);
      }
    }
    evidence.push(entry);
    options.onEntry?.(entry);
  }
  return evidence;
}

async function crossref(query: string, signal: AbortSignal, diagnostics: RetrievalDiagnostic[] = [], size = 6): Promise<Evidence[]> {
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({ query: query.replace(/\b(?:AND|OR|NOT)\b/g, ' ').replace(/["()]/g, ' '), rows: String(size), select: 'DOI,title,author,issued,abstract,URL,container-title,type' }).toString();
  const result = record(JSON.parse(await readPublic(url, signal, diagnostics, 'Crossref', query)));
  return array(record(result.message).items).flatMap(value => {
    const row = record(value); const title = plain(text(array(row.title)[0])); const doi = doiOf(row.DOI);
    if (!title || !doi) return [];
    const abstract = plain(text(row.abstract)); const year = array(array(record(row.issued)['date-parts'])[0])[0];
    const publicationType = text(row.type) || undefined; const descriptionOnly = DESCRIPTION_ONLY_TYPES.has(publicationType ?? '') || isFigshareCollection(doi);
    const resourceType = isFigshareCollection(doi) ? 'Figshare collection' : publicationType;
    return [{ id: stableId(doi), title, doi, url: `https://doi.org/${doi}`,
      authors: array(row.author).slice(0, 6).map(author => { const name = record(author); return [text(name.given), text(name.family)].filter(Boolean).join(' '); }).filter(Boolean).join(', '),
      year: typeof year === 'number' ? String(year) : undefined,
      journal: plain(text(array(row['container-title'])[0])) || undefined,
      publicationType,
      ...(abstract && !descriptionOnly ? { abstract } : {}),
      text: descriptionOnly ? `资源元数据（${resourceType}，非论文摘要，不能计入论文引用最低篇数）：${abstract || title}` : abstract || `文献元数据：${title}。尚未取得摘要或正文，不用于支持内容性主张。`,
      location: `${descriptionOnly ? `Crossref ${resourceType} 资源说明（非论文摘要）` : abstract ? 'Crossref 登记摘要（来源提交的摘要）' : 'Crossref DOI 及书目信息'}；检索接口 ${url.href}`,
      readScope: abstract && !descriptionOnly ? 'abstract' as const : 'metadata' as const, retrievedAt: new Date().toISOString() }];
  });
}

const rank = { metadata: 0, abstract: 1, full_text: 2, user_material: 2, computed: 2 };
const limit = (value: number | undefined, fallback: number, maximum: number) => Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
export interface SearchEvidenceOptions { targetCount?: number; maxResults?: number; maxQueries?: number; requireFullText?: boolean; abstractOnly?: boolean; preferFullTextSources?: boolean; excludeEvidence?: Evidence[]; topic?: string; }

function openAccessUrls(row: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const value of [row.best_oa_location, ...array(row.locations), row.primary_location]) {
    const location = record(value);
    if (location.is_oa !== true) continue;
    for (const candidate of [location.pdf_url, location.landing_page_url]) {
      try {
        const url = new URL(text(candidate));
        if (url.protocol !== 'https:' || url.username || url.password || urls.includes(url.href)) continue;
        urls.push(url.href);
        if (urls.length === 3) return urls;
      } catch { /* An absent or invalid source URL is not an article address. */ }
    }
  }
  return urls;
}

function invertedAbstract(value: unknown): string {
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(record(value))) {
    if (!word || !Array.isArray(positions)) return '';
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position > 20_000 || words.has(position)) return '';
      words.set(position, word);
    }
  }
  if (!words.size || Math.max(...words.keys()) !== words.size - 1) return '';
  // The inverted index contains text tokens, not an HTML/XML document. Literal
  // comparisons such as x<y and y>z must not be mistaken for markup.
  return normalizeText(Array.from({ length: words.size }, (_, i) => words.get(i)!).join(' '));
}

async function openalex(query: string, signal: AbortSignal, diagnostics: RetrievalDiagnostic[], size: number, page: number): Promise<{ evidence: Evidence[]; more: boolean }> {
  const url = new URL('https://api.openalex.org/works');
  // OpenAlex supports uppercase Boolean operators and quoted phrases. Preserve
  // them: deleting NOT would turn an exclusion into a positive search term.
  const search = query.trim();
  url.search = new URLSearchParams({ search, 'per-page': String(size), page: String(page), select: 'id,doi,title,type,publication_year,authorships,abstract_inverted_index,primary_location,best_oa_location,locations' }).toString();
  const result = record(JSON.parse(await readPublic(url, signal, diagnostics, 'OpenAlex', query))); const rows = array(result.results);
  const evidence = rows.flatMap(value => {
    const row = record(value); const title = plain(text(row.title)); const doi = doiOf(row.doi); const identity = text(row.id);
    if (!title || !/^https:\/\/openalex\.org\/W\d+$/.test(identity)) return [];
    const abstract = invertedAbstract(row.abstract_inverted_index); const landing = text(record(row.primary_location).landing_page_url);
    const publicationType = text(row.type) || undefined; const descriptionOnly = DESCRIPTION_ONLY_TYPES.has(publicationType ?? '') || isFigshareCollection(doi);
    const resourceType = isFigshareCollection(doi) ? 'Figshare collection' : publicationType;
    return [{ id: stableId(doi || identity), title, ...(doi ? { doi } : {}), url: doi ? `https://doi.org/${doi}` : /^https:\/\//.test(landing) ? landing : identity,
      authors: array(row.authorships).slice(0, 12).map(author => text(record(record(author).author).display_name)).filter(Boolean).join(', '), year: typeof row.publication_year === 'number' ? String(row.publication_year) : undefined,
      journal: plain(text(record(record(row.primary_location).source).display_name)) || undefined,
      publicationType,
      ...(abstract && !descriptionOnly ? { abstract } : {}),
      ...(!descriptionOnly && openAccessUrls(row).length ? { fullTextUrls: openAccessUrls(row) } : {}),
      text: descriptionOnly ? `资源元数据（${resourceType}，非论文摘要，不能计入论文引用最低篇数）：${abstract || title}` : abstract || `文献元数据：${title}。尚未取得摘要或正文，不用于支持内容性主张。`, readScope: abstract && !descriptionOnly ? 'abstract' as const : 'metadata' as const,
      location: `${identity}；OpenAlex ${descriptionOnly ? `${resourceType} 资源说明（非论文摘要）` : abstract ? '完整摘要倒排索引重建' : '书目元数据'}；检索接口 ${url.href}`, retrievedAt: new Date().toISOString() }];
  });
  return { evidence, more: rows.length === size && (typeof record(result.meta).count !== 'number' || page * size < Number(record(result.meta).count)) };
}

function deduplicate(entries: Evidence[], preferFullText = false): Evidence[] {
  const output: Evidence[] = []; const ids = new Map<string, number>(); const dois = new Map<string, number>(); const titles = new Map<string, Set<number>>(); const abstracts = new Map<string, number>(); const contentOnlyGroups = new Set<number>(); const auditNotes = new Map<number, Set<string>>();
  for (const entry of entries) {
    const title = titleKey(entry.title);
    // Long, byte-equivalent content after whitespace normalization is not two
    // independent pieces of evidence merely because bibliographic fields differ.
    // Keep punctuation and numbers, and ignore short boilerplate descriptions.
    const abstract = entry.readScope === 'abstract' ? entry.text.normalize('NFKC').replace(/\s+/gu, '') : '';
    const substantialAbstract = abstract.length >= 600 ? abstract : undefined;
    let index = ids.get(entry.id) ?? (entry.doi ? dois.get(entry.doi) : undefined);
    const duplicateContent = index === undefined && substantialAbstract !== undefined ? abstracts.get(substantialAbstract) : undefined;
    if (duplicateContent !== undefined) { index = duplicateContent; contentOnlyGroups.add(index); }
    if (index === undefined) {
      const matches: number[] = [];
      for (const byTitle of titles.get(title) ?? []) {
        const previous = output[byTitle];
        const sameAuthors = !!previous.authors && previous.authors.normalize('NFKC').toLowerCase() === entry.authors?.normalize('NFKC').toLowerCase();
        const a = previous.text.replace(/\s+/g, ' ').trim(); const b = entry.text.replace(/\s+/g, ' ').trim();
        const sharedAbstract = previous.readScope === 'abstract' && entry.readScope === 'abstract' && Math.min(a.length, b.length) > 300 && (a === b || (Math.min(a.length, b.length) / Math.max(a.length, b.length) > 0.85 && (a.startsWith(b) || b.startsWith(a))));
        const compatibleAuthors = !previous.authors || !entry.authors || sameAuthors;
        const sameIdentity = compatibleAuthors && (!previous.doi || !entry.doi || previous.doi === entry.doi) && (!previous.year || !entry.year || previous.year === entry.year);
        if (sameIdentity || (sameAuthors && sharedAbstract) || explicitVersionPair(previous, entry)) matches.push(byTitle);
      }
      // A common title can belong to several distinct studies. Keep all title
      // candidates, and merge only when the metadata identifies one of them.
      if (matches.length === 1) index = matches[0];
    }
    if (index === undefined) { index = output.length; output.push(entry); }
    else {
      const previous = output[index]; const versionPair = explicitVersionPair(previous, entry);
      if (versionPair) contentOnlyGroups.add(index);
      const publishedContent = versionPair ? [previous, entry].find(value => PUBLISHED_TYPES.has(value.publicationType ?? '') && rank[value.readScope] > 0) : undefined;
      const requiredFullText = preferFullText ? [previous, entry].find(value => value.readScope === 'full_text') : undefined;
      const best = requiredFullText ?? publishedContent ?? (rank[entry.readScope] > rank[previous.readScope] ? entry : previous); const other = best === entry ? previous : entry;
      // Equal content does not prove equal bibliographic identity. Once records
      // were joined only on content, aliases must not later enrich the chosen
      // title/authors with another record's DOI, journal, URL or year.
      const contentOnly = contentOnlyGroups.has(index);
      const doi = contentOnly ? best.doi : best.doi || other.doi;
      // Classification follows bibliographic identity, not the shared content
      // group: a supplement's dataset type must not contaminate its article.
      // A genuine same-DOI conflict still keeps the conservative resource scope.
      const sameBibliographicIdentity = best.id === other.id || Boolean(best.doi && other.doi && best.doi === other.doi);
      const classifications = !contentOnly || sameBibliographicIdentity ? [best.publicationType, other.publicationType] : [best.publicationType];
      const descriptionType = classifications.find(type => DESCRIPTION_ONLY_TYPES.has(type ?? ''));
      const publicationType = descriptionType || best.publicationType || (contentOnly ? undefined : other.publicationType);
      output[index] = { ...(contentOnly ? best : { ...other, ...best }), ...(publicationType ? { publicationType } : {}), ...(doi ? { doi, id: stableId(doi), url: `https://doi.org/${doi}` } : {}),
        ...(descriptionType ? { readScope: 'metadata' as const, text: best.text.startsWith('资源元数据') ? best.text : `资源元数据（${descriptionType}，非论文摘要，不能计入论文引用最低篇数）：${best.text}`, location: `${best.location}；来源类型为 ${descriptionType}，未将资源说明视为论文摘要` } : {}) };
      const openAireAttribution = '；元数据来源包含 OpenAIRE（CC-BY 4.0，https://graph.openaire.eu/）';
      if (contentOnly && !sameBibliographicIdentity && best === entry) auditNotes.get(index)?.delete(openAireAttribution);
      if (sameBibliographicIdentity && [previous.location, entry.location].some(value => /元数据来源(?:包含)? OpenAIRE/.test(value))) {
        if (!auditNotes.has(index)) auditNotes.set(index, new Set());
        auditNotes.get(index)!.add(openAireAttribution);
      }
      if (duplicateContent !== undefined || versionPair) {
        const explanation = versionPair ? '同题名同作者的明确预印本或补充集合，按同一作品计数，优先保留已取得内容的正式论文' : '与另一记录的完整摘要一致，按一份内容证据计数，书目身份差异仍待核验';
        const note = `；${explanation}（另条记录：${other.title}；${other.authors || '作者未提供'}；类型 ${other.publicationType || '未提供'}；${other.url || (other.doi ? `https://doi.org/${other.doi}` : other.id)}）`;
        if (!auditNotes.has(index)) auditNotes.set(index, new Set());
        auditNotes.get(index)!.add(note);
      }
      for (const note of auditNotes.get(index) ?? []) {
        const location = output[index].location;
        if (!location.includes(note)) output[index].location = location.includes('；检索接口 ') ? location.replace('；检索接口 ', note + '；检索接口 ') : location + note;
      }
    }
    ids.set(entry.id, index); if (entry.doi) dois.set(entry.doi, index);
    if (!titles.has(title)) titles.set(title, new Set());
    titles.get(title)!.add(index);
    if (substantialAbstract) abstracts.set(substantialAbstract, index);
  }
  return output;
}

function newWorkFilter(existing: Evidence[], preferFullText = false): (entry: Evidence) => boolean {
  const identityView = (entry: Evidence): Evidence => ({ ...entry, ...(doiOf(entry.doi) ? { doi: doiOf(entry.doi) } : {}),
    ...(entry.readScope === 'full_text' && entry.abstract?.trim() ? { text: entry.abstract, readScope: 'abstract' as const } : {}) });
  const excluded = existing.map(identityView);
  const excludedCount = excluded.length ? deduplicate(excluded, preferFullText).length : 0;
  const cache = new WeakMap<Evidence, boolean>();
  return entry => {
    if (!excluded.length) return true;
    let fresh = cache.get(entry);
    // Use the entire known corpus so ambiguous common titles are not matched
    // against one arbitrary record. Original abstracts remain identity evidence
    // after a paper gains a body; never compare its full body as an abstract.
    if (fresh === undefined) { fresh = deduplicate([...excluded, identityView(entry)], preferFullText).length > excludedCount; cache.set(entry, fresh); }
    return fresh;
  };
}

/** Shared by incremental retrieval and the engine's final admission check. */
export function newIndependentEvidence(existing: Evidence[], found: Evidence[]): Evidence[] {
  return deduplicate(found).filter(newWorkFilter(existing));
}

export async function searchEvidence(queries: string[], signal: AbortSignal, onProgress?: (message: string) => void, options: SearchEvidenceOptions = {}): Promise<{ evidence: Evidence[]; warnings: string[]; diagnostics?: RetrievalDiagnostic[]; pendingEvidence?:Evidence[]; discoveredCount?:number; rawReturnedCount?:number }> {
  signal.throwIfAborted();
  // Explicit abstract discovery wins over the legacy full-text search mode.
  const requireFullText = options.requireFullText === true && options.abstractOnly !== true;
  const preferFullTextSources = options.abstractOnly === true && options.preferFullTextSources === true;
  const maxResults = limit(options.maxResults, 12, 300); const target = Math.min(maxResults, limit(options.targetCount, maxResults, 300));
  const normalized = [...new Set(queries.map(query => query.trim()).filter(Boolean))].slice(0, limit(options.maxQueries, options.targetCount ? 24 : 3, 24));
  const warnings: string[] = []; const diagnostics: RetrievalDiagnostic[] = []; const groups = normalized.map(() => [] as Evidence[]);
  const specialistSources = options.abstractOnly === true ? selectLiteratureSources({ queries: normalized, topic: options.topic }).filter((entry): entry is { name: 'arXiv' | 'PubMed' | 'ERIC'; reason: string } => entry.name !== 'OpenAlex') : [];
  const supplementalSources: AdditionalSource[] = options.abstractOnly === true ? ['DOAJ', 'OpenAIRE'] : [];
  const specialistGroups = new Map<string, Evidence[]>(), specialistMore = new Set<string>();
  for (const { name, reason } of specialistSources) { onProgress?.(`按主题加入 ${name}：${reason}；本阶段只读取摘要。`); for (let index = 0; index < normalized.length; index++) specialistGroups.set(`${name}:${index}`, []); }
  for (const name of supplementalSources) for (let index = 0; index < normalized.length; index++) specialistGroups.set(`${name}:${index}`, []);
  const duration = options.targetCount || requireFullText ? 180_000 : 70_000; const size = options.targetCount || requireFullText ? 50 : 6;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(duration)]); const failed = new Set<string>(); const more = new Set<number>();
  const excluded = options.excludeEvidence ?? [];
  const isNewWork = newWorkFilter(excluded, requireFullText);
  const pagePublicAbstracts = preferFullTextSources && excluded.length > 0;
  const pmcCursors = new Map<number, string>(), seenPmcCursors = normalized.map(() => new Set<string>());
  const collected = () => {
    const allGroups = [...groups, ...specialistGroups.values()];
    return deduplicate(Array.from({ length: Math.max(0, ...allGroups.map(group => group.length)) }, (_, i) => allGroups.flatMap(group => group[i] ? [group[i]] : [])).flat(), requireFullText).filter(isNewWork);
  };
  const meetsScope = (entry: Evidence) => requireFullText ? entry.readScope === 'full_text' : entry.readScope !== 'metadata';
  const usable = () => collected().filter(meetsScope).length;
  const fullTexts: FullTextState = { cache: new Map(), maximum: Math.min(300, Math.max(20, target * 3)), targetReached: () => usable() >= target, onProgress };
  const retrieve = async (source: RetrievalSource, index: number, page = 1) => {
    signal.throwIfAborted(); if (combined.aborted || failed.has(source)) return;
    const query = normalized[index]; onProgress?.(`正在检索 ${source}（第 ${page} 页）：${query.slice(0, 100)}`);
    if (source === 'Crossref' && /\b(?:OR|NOT)\b/.test(query)) {
      warnings.push(`Crossref 不直接支持本查询的布尔分支或排除语义，已跳过该库此查询并保留 OpenAlex / Europe PMC 的原始检索式：${query}`);
      return;
    }
    try {
      let evidence: Evidence[];
      if (source === 'OpenAlex') { const found = await openalex(query, combined, diagnostics, size, page); evidence = found.evidence; if (found.more) more.add(index); else more.delete(index); }
      else if (additionalSource(source)) {
        const found = await additionalSearch[source](query, combined, { start: (page - 1) * size, size, onProgress });
        evidence = found.evidence; diagnostics.push(...found.diagnostics); warnings.push(...(found.warnings ?? []));
        const key = `${source}:${index}`; specialistGroups.get(key)!.push(...evidence); if (found.more) specialistMore.add(key); else specialistMore.delete(key);
      }
      else evidence = source === 'Europe PMC' ? await europe(query, combined, warnings, diagnostics, size, {
        requireFullText: requireFullText || preferFullTextSources, abstractOnly: options.abstractOnly, fullTexts, onEntry: entry => groups[index].push(entry),
        ...(pagePublicAbstracts ? { cursorMark: page === 1 ? '*' : pmcCursors.get(index), onPage: (next: string | undefined) => {
          if (next && next !== '*' && !seenPmcCursors[index].has(next)) { pmcCursors.set(index, next); seenPmcCursors[index].add(next); }
          else pmcCursors.delete(index);
        } } : {}),
      }) : await crossref(query, combined, diagnostics, size);
      if (source === 'OpenAlex' || source === 'Crossref') groups[index].push(...evidence);
      onProgress?.(`${source} 返回 ${evidence.length} 条；${excluded.length ? '排除已有作品后新增' : '累计去重'} ${collected().length} 篇，其中 ${usable()} 篇${requireFullText ? '已取得并校验正文' : '有摘要或全文'}。`);
    } catch (error) {
      signal.throwIfAborted();
      if (additionalSource(source) && error && typeof error === 'object' && Array.isArray((error as { diagnostics?: unknown }).diagnostics)) diagnostics.push(...(error as { diagnostics: RetrievalDiagnostic[] }).diagnostics);
      // A malformed query is local to that request; network/provider failures
      // can stop repeated requests to the same unavailable source.
      if (!(error instanceof Error && /HTTP 400\b|查询语法|返回查询错误/.test(error.message))) failed.add(source);
      else if (source === 'OpenAlex') more.delete(index);
      else specialistMore.delete(`${source}:${index}`);
      const message = `${source} 检索未成功：${error instanceof Error ? error.message : '接口错误'}。保留已取得记录，继续其他可用来源。`; warnings.push(message); onProgress?.(message);
    }
  };
  const batch = async (jobs: (() => Promise<void>)[]) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => { while (cursor < jobs.length && !combined.aborted) { const job = jobs[cursor++]; await job(); } })); signal.throwIfAborted();
  };
  if (requireFullText) {
    // Full-text acquisition is its own stage. A large abstract count cannot
    // bypass the only supported public full-text provider.
    await batch(normalized.map((_, index) => () => retrieve('Europe PMC', index)));
    const triedDois = new Set<string>(); const maximumDoiQueries = Math.min(120, Math.max(12, target * 2));
    const enrichDois = async () => {
      if (failed.has('Europe PMC') || combined.aborted || usable() >= target || fullTexts.cache.size >= fullTexts.maximum) return;
      const candidates = collected().filter(entry => entry.doi && entry.readScope !== 'full_text' && !DESCRIPTION_ONLY_TYPES.has(entry.publicationType ?? '') && !isFigshareCollection(entry.doi) && !triedDois.has(entry.doi)).slice(0, maximumDoiQueries - triedDois.size);
      await batch(candidates.map(entry => async () => {
        if (usable() >= target || fullTexts.cache.size >= fullTexts.maximum || failed.has('Europe PMC')) return;
        const doi = entry.doi!; triedDois.add(doi);
        const query = `DOI:"${doi.replace(/["\\]/g, '\\$&')}"`;
        onProgress?.(`按已取得的 DOI 查找开放正文：${doi}`);
        try {
          await europe(query, combined, warnings, diagnostics, 5, { requireFullText: true, fullTexts, expectedDoi: doi, onEntry: found => groups[0].push(found) });
        } catch (error) {
          signal.throwIfAborted();
          warnings.push(`Europe PMC DOI 全文查找未完成：${error instanceof Error ? error.message : '接口错误'}；保留已有内容。`);
          if (!(error instanceof Error && /HTTP 400\b/.test(error.message))) failed.add('Europe PMC');
        }
      }));
    };
    if (usable() < target && !combined.aborted) {
      await batch(normalized.map((_, index) => () => retrieve('OpenAlex', index)));
      await enrichDois();
    }
    for (let page = 2; page <= 6 && usable() < target && !combined.aborted && !failed.has('OpenAlex') && !failed.has('Europe PMC') && triedDois.size < maximumDoiQueries && fullTexts.cache.size < fullTexts.maximum; page++) {
      const jobs = [...more].map(index => () => retrieve('OpenAlex', index, page)); if (!jobs.length) break;
      await batch(jobs); await enrichDois();
    }
    if (fullTexts.cache.size >= fullTexts.maximum && usable() < target) warnings.push(`已达到本轮 ${fullTexts.maximum} 篇不同 PMCID 的正文尝试上限；未取得的正文仍不计入全文数量。`);
    if (triedDois.size >= maximumDoiQueries && usable() < target) warnings.push(`已达到本轮 ${maximumDoiQueries} 个 DOI 的定向全文查找上限。`);
  } else {
    if (preferFullTextSources) {
      onProgress?.('优先检索有公开正文入口的 Europe PMC 候选：此阶段只读取摘要及 PMCID 位置，随后覆盖全部 OpenAlex 子主题；不下载正文。');
      await batch(normalized.map((_, index) => () => retrieve('Europe PMC', index)));
    }
    // Search every planned subtopic before paging a broad query, and interleave
    // results so early queries cannot consume the entire candidate budget.
    await batch(normalized.flatMap((_, index) => [() => retrieve('OpenAlex', index), ...specialistSources.map(({ name }) => () => retrieve(name, index))]));
    // Open repositories supplement a sparse corpus. They retain separate groups
    // so pagination and the candidate budget cannot erase their provenance.
    if (!options.targetCount || usable() < target) await batch(supplementalSources.flatMap(source => normalized.map((_, index) => () => retrieve(source, index))));
    const fallbackSources: ('Europe PMC' | 'Crossref')[] = preferFullTextSources ? ['Crossref'] : ['Europe PMC', 'Crossref'];
    if (!pagePublicAbstracts && (!options.targetCount || usable() < target)) await batch(fallbackSources.flatMap(source => normalized.map((_, index) => () => retrieve(source, index))));
    for (let page = 2; page <= 6 && usable() < target && !combined.aborted; page++) {
      const jobs = [
        ...(pagePublicAbstracts && !failed.has('Europe PMC') ? [...pmcCursors.keys()].map(index => () => retrieve('Europe PMC', index, page)) : []),
        ...(!failed.has('OpenAlex') ? [...more].map(index => () => retrieve('OpenAlex', index, page)) : []),
        ...[...specialistMore].flatMap(key => { const [source, index] = key.split(':') as [AdditionalSource, string]; return failed.has(source) ? [] : [() => retrieve(source, Number(index), page)]; }),
      ];
      if (!jobs.length) break; await batch(jobs);
    }
    if (pagePublicAbstracts && usable() < target) await batch(fallbackSources.flatMap(source => normalized.map((_, index) => () => retrieve(source, index))));
  }
  if (combined.aborted) warnings.push(`文献检索达到 ${duration / 1000} 秒总时限，保留已实际获取的材料。`);
  for (const item of diagnostics) if (item.error?.includes('仅尝试一次有时限的直连') && !warnings.includes(item.error)) warnings.push(item.error);
  const discovered = collected().sort((a, b) => rank[b.readScope] - rank[a.readScope]);
  const selected = discovered.slice(0, maxResults), pendingEvidence=discovered.slice(maxResults);
  if(pendingEvidence.length)onProgress?.(`已发现 ${discovered.length} 篇去重候选；本批处理 ${selected.length} 篇，另 ${pendingEvidence.length} 篇已保留待筛选，未判为不相关。`);
  if (selected.some(entry => entry.readScope === 'metadata')) warnings.push('部分检索结果只有元数据，仅可用于书目定位，不能据此宣称原文支持结论。');
  if (!selected.length && normalized.length) warnings.push(excluded.length ? '本轮排除已有作品后没有新增独立文献；既有记录保留，不能将此写成领域没有证据。' : '本轮未获得可用文献，不能将检索失败写成领域没有证据。');
  if ((options.targetCount || requireFullText) && selected.filter(meetsScope).length < target) warnings.push(`本轮取得 ${selected.filter(meetsScope).length} 篇${requireFullText ? '已校验全文' : '有摘要或全文的候选文献'}，未达到 ${target} 篇${requireFullText ? '全文' : '检索'}目标；${requireFullText ? '摘要只作为候选，不能冒充已读正文。' : '候选仍须按研究问题筛选。'}`);
  return { evidence: selected, warnings: [...new Set(warnings)], diagnostics, pendingEvidence, discoveredCount:discovered.length, rawReturnedCount:diagnostics.filter(item=>item.status==='ok'&&!/\/fullTextXML(?:[?#]|$)/.test(item.url)&&!(item.source==='PubMed'&&/\/esearch\.fcgi(?:[?#]|$)/.test(item.url))).reduce((sum,item)=>sum+item.returned,0) };
}

function pmcidFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (url.hostname === 'www.ebi.ac.uk') return /^\/europepmc\/webservices\/rest\/(PMC\d+)\/fullTextXML\/?$/.exec(url.pathname)?.[1];
    if (url.hostname === 'europepmc.org' || url.hostname === 'www.europepmc.org') return /^\/(?:article\/PMC|articles)\/(PMC\d+)\/?$/i.exec(url.pathname)?.[1]?.toUpperCase();
    if (url.hostname === 'pmc.ncbi.nlm.nih.gov') return /^\/articles\/(PMC\d+)\/?$/.exec(url.pathname)?.[1];
  } catch { /* The public article reader separately validates all other URLs. */ }
}

/** Acquire only identities already selected by abstract screening. The returned
 * array keeps every selected record and its bibliography, even on failure. */
export interface FullTextEvidenceOptions { maxResults?: number; cacheDirectory?:string; onResult?: (evidence: Evidence) => void; }
export async function fetchFullTextEvidence(candidates: Evidence[], signal: AbortSignal, onProgress?: (message: string) => void, options: FullTextEvidenceOptions = {}): Promise<{ evidence: Evidence[]; warnings: string[]; diagnostics?: RetrievalDiagnostic[] }> {
  signal.throwIfAborted();
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new Error('已选文献包含重复 ID，不能混用不同正文或覆盖书目身份。');
  const evidence = candidates.map(candidate => ({ ...candidate }));
  const warnings: string[] = []; const diagnostics: RetrievalDiagnostic[] = [];
  const maximum = limit(options.maxResults, Math.min(candidates.length, 300), 300);
  let publicReader: Promise<typeof import('./public-article.ts')> | undefined;
  const bodyCache = new Map<string, Promise<{ text: string; location: string }>>();
  const pending = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidate.readScope !== 'full_text' && candidate.readScope !== 'user_material' && candidate.readScope !== 'computed');
  const selected = pending.slice(0, maximum);
  const articleBudget = 45_000;
  const duration = Math.max(180_000, Math.ceil(selected.length / 3) * articleBudget + 15_000);
  const failed = new AbortController();
  const combined = AbortSignal.any([signal, failed.signal, AbortSignal.timeout(duration)]);
  const attempted = new Set<string>();
  if (pending.length > maximum) warnings.push(`本轮最多为 ${maximum} 篇已选文献获取正文；其余已选记录保留原内容，未计为已读全文。`);
  if (selected.length) onProgress?.(`将为 ${selected.length} 篇已选文献获取正文；最多 3 篇并行，单篇最多 ${articleBudget / 1000} 秒，整批最多 ${duration / 1000} 秒；逐篇保存已取得正文。`);
  const xmlBody = (pmcid: string, query: string, articleSignal: AbortSignal) => {
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`;
    if (!bodyCache.has(url)) bodyCache.set(url, (async () => {
      let body = '';
      await readPublic(new URL(url), articleSignal, diagnostics, 'Europe PMC', query, xml => { body = extractEpmcBody(xml); });
      return { text: body, location: `${pmcid}；${url}；已读取并校验 JATS 主文 body 文本；排除前置摘要、参考文献与附加文件，图像视觉内容未核验` };
    })());
    return bodyCache.get(url)!;
  };
  const acquire = async (candidate: Evidence, index: number, articleSignal: AbortSignal) => {
    articleSignal.throwIfAborted();
    if (DESCRIPTION_ONLY_TYPES.has(candidate.publicationType ?? '') || isFigshareCollection(candidate.doi)) {
      warnings.push(`《${candidate.title.slice(0, 70)}》是资源说明而非研究论文，未将其升级为论文全文。`); return;
    }
    onProgress?.(`正在获取已选论文正文（${attempted.size}/${selected.length}）：《${candidate.title.slice(0, 100)}》；单篇最多 ${articleBudget / 1000} 秒。`);
    const originalAbstract = candidate.abstract || (candidate.readScope === 'abstract' ? candidate.text : undefined);
    const urls = [...new Set(candidate.fullTextUrls ?? [])].slice(0, 3);
    const knownPmcids = [...new Set([...urls, candidate.url ?? ''].map(pmcidFromUrl).filter((id): id is string => !!id))];
    let pmcids = knownPmcids;
    const doi = doiOf(candidate.doi);
    let full: { text: string; location: string } | undefined;
    let sourceDocument:Evidence['sourceDocument'];
    // These URLs were selected from this paper's public locations. Validate the
    // article title/body before spending time on a different index's DOI lookup.
    // PMC routes are excluded here and keep their exact DOI identity check below.
    {
      for (const url of urls) {
        articleSignal.throwIfAborted();
        // Known PMC addresses were handled by the validated XML route. Do not
        // bypass an unsuccessful DOI match through the generic HTML fallback.
        if (pmcidFromUrl(url)) continue;
        try {
          const { readPublicArticle } = await (publicReader ??= import('./public-article.ts'));
          const networkWarnings:string[]=[];
          const reportNetwork=(message:string)=>{if(networkWarnings.includes(message))return;networkWarnings.push(message);warnings.push(message);if(onProgress)onProgress(message);else console.warn(message);};
          const received = await readPublicArticle(url, articleSignal, { expectedTitle: candidate.title,onProgress:reportNetwork });
          for(const warning of received.networkWarnings??[])reportNetwork(warning);
          articleSignal.throwIfAborted();
          if (!received.text.trim()) throw new Error('公开文章未返回有效正文');
          if(received.document&&options.cacheDirectory){
            const data=Buffer.from(received.document.bytes);const sha256=createHash('sha256').update(data).digest('hex');const fileName=sha256+'.pdf';
            fs.mkdirSync(options.cacheDirectory,{recursive:true});const file=path.join(options.cacheDirectory,fileName);
            if(fs.existsSync(file)){if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==sha256)throw new Error('已缓存的原始PDF校验失败，未覆盖已有文件');}
            else fs.writeFileSync(file,data,{flag:'wx'});
            sourceDocument={fileName,mimeType:'application/pdf',sha256};
          }
          full = {...received,location:[received.location,...networkWarnings].join('；')};
          diagnostics.push({ source: 'Open-access article', query: candidate.id, url, status: 'ok', returned: 1, retrievedAt: new Date().toISOString() });
          break;
        } catch (error) {
          full = undefined; articleSignal.throwIfAborted();
          const message = error instanceof Error ? error.message : '公开正文读取失败';
          diagnostics.push({ source: 'Open-access article', query: candidate.id, url, status: /timeout|timed out/i.test(message) ? 'timeout' : 'error', returned: 0, error: message, retrievedAt: new Date().toISOString() });
          warnings.push(`《${candidate.title.slice(0, 70)}》的公开正文链接读取失败：${message}。`);
        }
      }
    }
    if (!full && doi) {
      // A DOI search is only an identity lookup. Never import its bibliography
      // or fetch a neighbouring result whose DOI differs from the selected one.
      pmcids = [];
      const query = `DOI:"${doi.replace(/["\\]/g, '\\$&')}"`;
      try {
        const matched = await europe(query, articleSignal, warnings, diagnostics, 5, { abstractOnly: true, requireFullText: true, expectedDoi: doi });
        const matchedPmcids = [...new Set(matched.flatMap(entry => (entry.fullTextUrls ?? []).map(pmcidFromUrl)).filter((id): id is string => !!id))];
        pmcids = [...knownPmcids.filter(id => matchedPmcids.includes(id)), ...matchedPmcids.filter(id => !knownPmcids.includes(id))].slice(0, 3);
      } catch (error) {
        articleSignal.throwIfAborted();
        warnings.push(`《${candidate.title.slice(0, 70)}》的 DOI 正文定位未完成：${error instanceof Error ? error.message : '接口错误'}。`);
      }
    }
    if (!full) for (const pmcid of pmcids) {
      articleSignal.throwIfAborted();
      try { full = await xmlBody(pmcid, doi || candidate.id, articleSignal); break; }
      catch (error) { articleSignal.throwIfAborted(); warnings.push(`${pmcid} 正文未取得：${error instanceof Error ? error.message : '读取失败'}。`); }
    }
    articleSignal.throwIfAborted();
    if (full) {
      evidence[index] = { ...candidate, ...(originalAbstract ? { abstract: originalAbstract } : {}),...(sourceDocument?{sourceDocument}:{}), text: full.text, readScope: 'full_text', location: full.location, retrievedAt: new Date().toISOString() };
      // Persistence failures must abort this batch, not be classified as a
      // publisher failure and hidden behind an abstract-only return value.
      options.onResult?.(evidence[index]);
      onProgress?.(`已取得并校验《${candidate.title.slice(0, 100)}》正文，保留原摘要和书目身份。`);
    } else warnings.push(`《${candidate.title.slice(0, 70)}》未取得可验证正文，保留原${candidate.readScope === 'abstract' ? '摘要' : '元数据'}，不计为已读全文。`);
  };
  let cursor = 0, completed = 0;
  const workers = Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (cursor < selected.length && !combined.aborted) {
      const { candidate, index } = selected[cursor++];
      attempted.add(candidate.id);
      const articleSignal = AbortSignal.any([combined, AbortSignal.timeout(articleBudget)]);
      try { await acquire(candidate, index, articleSignal); }
      catch (error) {
        signal.throwIfAborted();
        if (!articleSignal.aborted) throw error;
        const message = combined.aborted ? '整批正文获取已停止' : `单篇正文获取达到 ${articleBudget / 1000} 秒时限`;
        warnings.push(`《${candidate.title.slice(0, 70)}》${message}，保留原摘要，继续其余已选论文。`);
        diagnostics.push({ source: 'Selected full text', query: candidate.id, url: candidate.fullTextUrls?.[0] ?? candidate.url ?? '', status: 'timeout', returned: 0, error: message, retrievedAt: new Date().toISOString() });
      }
      completed++;
      onProgress?.(`已处理 ${completed}/${selected.length} 篇选中论文；《${candidate.title.slice(0, 70)}》${evidence[index].readScope === 'full_text' ? '已取得并保存正文' : '未取得正文，保留原内容'}。`);
    }
  });
  try { await Promise.all(workers); }
  catch (error) { failed.abort(error); await Promise.allSettled(workers); throw error; }
  signal.throwIfAborted();
  if (combined.aborted) warnings.push(`已选文献正文获取达到 ${duration / 1000} 秒总时限；保留已取得正文和其余原摘要，未伪造全文完成。`);
  const unattempted = pending.filter(({ candidate }) => !attempted.has(candidate.id));
  if (unattempted.length) {
    warnings.push(`有 ${unattempted.length} 篇已选论文因数量上限或整批时限未尝试获取正文，仍保留原内容；不能记为获取失败或已读全文。`);
    for (const { candidate } of unattempted) diagnostics.push({ source: 'Selected full text', query: candidate.id, url: candidate.fullTextUrls?.[0] ?? candidate.url ?? '', status: 'not_attempted', returned: 0, error: '数量上限或整批时限内未启动', retrievedAt: new Date().toISOString() });
  }
  return { evidence, warnings: [...new Set(warnings)], diagnostics };
}
