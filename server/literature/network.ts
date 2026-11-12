import { Agent, fetch as undiciFetch } from 'undici';

const ENDPOINTS: Record<string, RegExp> = {
  'export.arxiv.org': /^\/api\/query$/,
  'eutils.ncbi.nlm.nih.gov': /^\/entrez\/eutils\/(?:esearch|efetch)\.fcgi$/,
  'api.openalex.org': /^\/works(?:\/[^/]+)?$/,
  'api.crossref.org': /^\/works$/,
  'www.ebi.ac.uk': /^\/europepmc\/webservices\/rest\/(?:search|PMC\d+\/fullTextXML)$/,
  'api.ies.ed.gov': /^\/eric\/$/,
  'doaj.org': /^\/api\/search\/articles\/[^/]+$/,
  'api.openaire.eu': /^\/graph\/v3\/research-products$/,
};
export interface LiteratureNetworkOptions {
  method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; maximumBytes?: number;
  configuredTimeoutMs?: number; directTimeoutMs?: number;
  beforeRequest?: () => Promise<void>; onFallback?: (message: string) => void;
}
export class LiteratureNetworkError extends Error {
  constructor(message: string, readonly category: string) { super(message); this.name = 'LiteratureNetworkError'; }
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function classification(error: unknown): string {
  if (error instanceof LiteratureNetworkError) return error.category;
  let value: unknown = error;
  for (let depth = 0; depth < 5 && value && typeof value === 'object'; depth++) {
    const entry = value as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof entry.code === 'string' && /^(?:[A-Z][A-Z_0-9]{2,60})$/.test(entry.code)) return entry.code;
    if (entry.name === 'TimeoutError') return 'TIMEOUT';
    value = entry.cause;
  }
  return error instanceof TypeError ? 'NETWORK_ERROR' : 'REQUEST_ERROR';
}
const retryable = (category: string) => /^(?:NETWORK_ERROR|TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(category);
const limit = (value: number | undefined, fallback: number, maximum: number) => Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;

/** Fixed public metadata interfaces only. Never resolves/fetches redirects or
 * arbitrary publisher URLs. Deployment proxy settings stay process-local. */
export async function readLiteratureResponse(url: URL, signal: AbortSignal, options: LiteratureNetworkOptions = {}): Promise<string> {
  signal.throwIfAborted();
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !ENDPOINTS[url.hostname]?.test(url.pathname)) throw new LiteratureNetworkError('拒绝非授权文献接口地址。', 'INVALID_ENDPOINT');
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const maxBytes = limit(options.maximumBytes, 4_000_000, 4_194_304);
  const configuredMs = limit(options.configuredTimeoutMs, 8000, 15_000), directMs = limit(options.directTimeoutMs, 6000, 10_000);
  const configuredProxy = process.env.ZHICUI_NETWORK_MODE !== 'direct' && Boolean(process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim() || process.env.http_proxy?.trim() || process.env.HTTP_PROXY?.trim());
  let direct: Agent | undefined;
  const attempt = async (useDirect: boolean): Promise<string> => {
    if (options.beforeRequest) await bounded(options.beforeRequest(), combined); combined.throwIfAborted();
    const deadline = AbortSignal.any([combined, AbortSignal.timeout(useDirect ? directMs : configuredMs)]);
    if (useDirect) direct = new Agent({ connect: { timeout: directMs, rejectUnauthorized: true } });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Application dependencies (notably Playwright) can replace global fetch
      // with a different undici copy. An explicit Agent must be paired with
      // this package's fetch or its response-handler protocol can mismatch.
      const transport = useDirect ? undiciFetch as unknown as typeof fetch : fetch;
      const response = await bounded(transport(url, { method: options.method ?? 'GET', ...(options.body === undefined ? {} : { body: options.body }), headers: options.headers, redirect: 'error', signal: deadline, ...(direct ? { dispatcher: direct } : {}) } as RequestInit), deadline);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new LiteratureNetworkError(`文献接口 HTTP ${response.status}`, `HTTP_${response.status}`); }
      if (Number(response.headers.get('content-length')) > maxBytes) { void response.body?.cancel().catch(() => {}); throw new LiteratureNetworkError('文献接口返回内容超过长度限制。', 'RESPONSE_TOO_LARGE'); }
      if (!response.body) throw new LiteratureNetworkError('文献接口返回空内容。', 'EMPTY_RESPONSE');
      reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let count = 0, output = '';
      while (true) { const part = await bounded(reader.read(), deadline); deadline.throwIfAborted(); if (part.done) break; count += part.value.byteLength; if (count > maxBytes) throw new LiteratureNetworkError('文献接口返回内容超过长度限制。', 'RESPONSE_TOO_LARGE'); output += decoder.decode(part.value, { stream: true }); }
      return output + decoder.decode();
    } catch (error) {
      signal.throwIfAborted(); const category = deadline.aborted ? 'TIMEOUT' : classification(error);
      if (error instanceof LiteratureNetworkError) throw error;
      throw new LiteratureNetworkError(`文献接口连接或读取失败（${category}）。`, category);
    } finally {
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* pending read already cancelled */ } }
    }
  };
  try {
    try { return await attempt(false); }
    catch (error) {
      signal.throwIfAborted(); if (combined.aborted || !configuredProxy || !retryable(classification(error))) throw error;
      const message = `${url.hostname} 当前配置网络连接失败（${classification(error)}）；现在仅尝试一次有时限的直连，未改变系统或服务代理设置。`;
      if (options.onFallback) options.onFallback(message); else console.warn(message);
      return await attempt(true);
    }
  } finally { if (direct) void direct.destroy().catch(() => {}); }
}
