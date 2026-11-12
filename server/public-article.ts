import { lookup } from 'node:dns/promises';
import { connect as connectTcp, isIP, type Socket } from 'node:net';
import * as tls from 'node:tls';
import * as http from 'node:http';
import * as https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 200_000;
const IDLE_MS = 8_000;
const PDF_RESOURCES = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const BODY_SECTION = /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(introduction|background|methods?|materials?(?: and methods?)?|experimental(?: methods?| details?)?|results?(?: and discussion)?|discussion|conclusions?|theory|引言|绪论|研究方法|材料与方法|实验方法|研究结果|结果|讨论|结论)(?=[\s:：]|$)/gim;

function aborted(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error('公开论文读取已取消。'); }
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted(signal));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
async function cleanup(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  // Start cleanup even after cancellation, but a stuck socket/parser shutdown
  // must not outlive the caller's deadline or create an unhandled rejection.
  const observed = promise.catch(() => {});
  try { await bounded(observed, signal); } catch { /* Keep the original failure. */ }
}
function publicAddress(value: string): boolean {
  if (!isIP(value)) return false;
  const address = ipaddr.parse(value);
  // Reject mapped/transition ranges as well as private, reserved, link-local,
  // documentation, multicast and unspecified addresses. No fallback DNS lookup.
  return address.range() === 'unicast' && !(address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress());
}
function destination(raw: string,allowHttp=false): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new Error('论文来源 URL 无效。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!(url.protocol==='https:'||(allowHttp&&url.protocol==='http:')) || url.username || url.password || url.port) throw new Error('公开来源只允许无凭据的 HTTP(S) 默认端口；论文正文只允许 HTTPS。');
  if (!host || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/.test(host) || (!isIP(host) && !host.includes('.')) || (isIP(host) && !publicAddress(host))) throw new Error('论文来源必须是公网地址，不能读取本机、内网或保留地址。');
  url.hash = ''; return url;
}
export function publicDocumentUrl(raw:string,allowHttp=false):URL{return destination(raw,allowHttp);}
type VerifiedTarget = { address: string } | { proxyHostname: true };
const CLASH_HOSTS = new Set(['arxiv.org', 'export.arxiv.org']);
function loopbackProxy(): boolean {
  const configured = configuredProxy(); if (!configured) return false;
  try { const proxy = new URL(configured); return ['http:', 'https:'].includes(proxy.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(proxy.hostname.toLowerCase()) && proxy.pathname === '/' && !proxy.search && !proxy.hash; } catch { return false; }
}
function clashFakeIP(address: string): boolean { return isIP(address) === 4 && address.startsWith('198.18.'); }
async function resolvePublic(url: URL, signal: AbortSignal, allowTrustedProxy = true): Promise<VerifiedTarget> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await bounded(lookup(host, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length) throw new Error('论文来源 DNS 没有可验证的公网地址。');
  if (addresses.every(entry => publicAddress(entry.address))) return { address: addresses.find(entry => isIP(entry.address) === 4)?.address ?? addresses[0].address };
  // Clash Fake-IP is a routing token, never a public destination IP. Only
  // these exact, independently trusted platforms may delegate DNS to the
  // explicitly configured local proxy. Arbitrary metadata URLs cannot opt in.
  if (allowTrustedProxy && CLASH_HOSTS.has(host.toLowerCase()) && loopbackProxy() && addresses.some(entry => clashFakeIP(entry.address)) && addresses.every(entry => publicAddress(entry.address) || clashFakeIP(entry.address))) return { proxyHostname: true };
  throw new Error('论文来源 DNS 含非公网地址，已拒绝读取。');
}

/** Use only trusted process proxy settings. The candidate URL cannot set proxy
 * credentials. Ordinary sources pin CONNECT to a verified public IP. The narrow
 * arXiv + loopback Clash Fake-IP case delegates resolution to that trusted proxy
 * so its domain routing works; TLS always verifies the original hostname. */
function configuredProxy(): string | undefined { return process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim() || process.env.http_proxy?.trim() || process.env.HTTP_PROXY?.trim() || undefined; }
function networkError(message: string): Error { return Object.assign(new Error(message), { code: 'PUBLIC_ARTICLE_TRANSPORT' }); }
function retryableNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; cause?: unknown };
  return Boolean(value.code && /^(?:PUBLIC_ARTICLE_TRANSPORT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/.test(value.code)) || Boolean(value.cause && value.cause !== error && retryableNetworkError(value.cause));
}
function dispatcherFor(url: URL, target: VerifiedTarget, signal: AbortSignal, useProxy = true): Agent {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port=url.protocol==='http:'?80:443;
  const configured = useProxy ? configuredProxy() : undefined;
  let proxy: URL | undefined;
  if (configured) {
    try { proxy = new URL(configured); } catch { throw new Error('已配置的代理地址无效。'); }
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('公开论文读取不支持此代理配置。');
  }
  if ('proxyHostname' in target && (!proxy || !loopbackProxy() || !CLASH_HOSTS.has(hostname.toLowerCase()))) throw new Error('Clash 映射只能通过受信的本机代理读取，不能作为公网地址直连。');
  return new Agent({ maxResponseSize: MAX_BYTES, headersTimeout: IDLE_MS, bodyTimeout: IDLE_MS, connect: (_options, callback) => {
    let done = false; let connection: Socket | undefined; let tunnel: http.ClientRequest | undefined;
    const finish = (error: Error | null, socket?: Socket) => {
      if (done) return; done = true;
      if (error) signal.removeEventListener('abort', stop);
      if (error) callback(error, null); else callback(null, socket!);
    };
    const stop = () => { const error = aborted(signal); connection?.destroy(error); tunnel?.destroy(error); finish(error); };
    signal.addEventListener('abort', stop, { once: true });
    const secure = (socket?: Socket) => {
      if (signal.aborted) { socket?.destroy(); stop(); return; }
      if (!socket && !('address' in target)) { finish(new Error('Clash 映射没有可安全直连的公网地址。')); return; }
      if(url.protocol==='http:'){
        const plain=socket??connectTcp({host:(target as {address:string}).address,port});connection=plain;
        plain.setTimeout(IDLE_MS,()=>plain.destroy(networkError('公开来源连接连续 8 秒无进展。')));
        plain.once('error',error=>finish(error));plain.once('close',()=>signal.removeEventListener('abort',stop));
        if(socket)finish(null,plain);else plain.once('connect',()=>finish(null,plain));return;
      }
      const encrypted = tls.connect({ ...(socket ? { socket } : { host: (target as {address:string}).address, port: 443 }), servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(hostname, cert), ALPNProtocols: ['http/1.1'] });
      connection = encrypted;
      encrypted.setTimeout(IDLE_MS, () => encrypted.destroy(networkError('论文连接连续 8 秒无进展。')));
      encrypted.once('secureConnect', () => finish(null, encrypted));
      encrypted.once('error', error => finish(error));
      encrypted.once('close', () => signal.removeEventListener('abort', stop));
    };
    if (signal.aborted) { stop(); return; }
    if (!proxy) { secure(); return; }
    const authority = 'proxyHostname' in target ? `${hostname}:${port}` : `${isIP(target.address) === 6 ? `[${target.address}]` : target.address}:${port}`;
    const headers: Record<string, string> = { Host: `${url.hostname}:${port}` };
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    tunnel = (proxy.protocol === 'https:' ? https : http).request(proxy, { method: 'CONNECT', path: authority, headers, signal });
    tunnel.setTimeout(IDLE_MS, () => tunnel?.destroy(networkError('论文代理连接连续 8 秒无进展。')));
    tunnel.once('connect', (response, socket, head) => {
      connection = socket;
      if (response.statusCode !== 200 || head.length) { socket.destroy(); finish(new Error('代理未建立有效论文连接。')); return; }
      secure(socket);
    });
    tunnel.once('error', error => { signal.removeEventListener('abort', stop); finish(error); });
    tunnel.end();
  } });
}

function normalized(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function titleMatches(expected: string, actual: string): boolean {
  const wanted = normalized(expected), observed = normalized(actual);
  if (!wanted || !observed) return false;
  if (observed.includes(wanted)) return true;
  const tokens = (value: string) => [...new Set(value.normalize('NFKC').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
  const expectedTokens = tokens(expected), actualTokens = tokens(actual);
  if (expectedTokens.length < 4 || actualTokens.length < 4) return false;
  const common = expectedTokens.filter(token => actualTokens.includes(token)).length;
  return common / expectedTokens.length >= .85 && (2 * common / (expectedTokens.length + actualTokens.length)) >= .8;
}
function checkText(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (clean.length > MAX_TEXT) throw new Error('论文正文超过 200000 字符，未截断或标记为已读全文。');
  if (clean.length < 2000) throw new Error('未取得足够正文文本，可能是摘要页、登录页或扫描件。');
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(clean)) throw new Error('论文正文包含不可读的控制字符。');
  const sections = [...clean.matchAll(BODY_SECTION)];
  const substantial = sections.filter((section, index) => clean.slice(section.index! + section[0].length, sections[index + 1]?.index ?? clean.length).replace(/\s/g, '').length >= 200);
  if (new Set(substantial.map(match => match[1].toLowerCase())).size < 2) throw new Error('未确认文章正文结构，可能仅为摘要或目录壳页。');
  return clean;
}
function decodeHtml(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] || 'utf-8';
  try { return new TextDecoder(charset, { fatal: true }).decode(buffer); } catch { throw new Error('论文 HTML 编码无法可靠读取。'); }
}
function staticRedirect(buffer: Buffer, url: URL, contentType: string,allowHttp=false): URL | undefined {
  const { document } = parseHTML(decodeHtml(buffer, contentType));
  const attribute = (node: Element, name: string) => Array.from(node.attributes).find(value => value.name.toLowerCase() === name)?.value;
  const metas = Array.from(document.querySelectorAll('meta')).filter(node => attribute(node, 'http-equiv')?.trim().toLowerCase() === 'refresh');
  if (!metas.length) return undefined;
  if (metas.length !== 1) throw new Error('论文静态跳转目标不唯一，未继续读取。');
  const content = attribute(metas[0], 'content') ?? '';
  if (content.length > 4096 || /[\u0000-\u001f\u007f]/.test(content)) throw new Error('论文静态跳转字段无效。');
  const match = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i.exec(content);
  if (!match) throw new Error('论文静态跳转缺少可确认的目标。');
  let target = match[1];
  if (target.startsWith('"') || target.startsWith("'")) {
    if (target.length < 3 || target.at(-1) !== target[0]) throw new Error('论文静态跳转目标引号不完整。');
    target = target.slice(1, -1);
  }
  return destination(new URL(target, url).href,allowHttp);
}
function extractHtml(buffer: Buffer, url: URL, contentType: string, expectedTitle?: string): string {
  const { document } = parseHTML(decodeHtml(buffer, contentType));
  if (document.querySelectorAll('*').length > 50_000) throw new Error('论文 HTML 节点过多，未尝试不完整抽取。');
  Object.defineProperty(document, 'documentURI', { value: url.href, configurable: true });
  Object.defineProperty(document, 'URL', { value: url.href, configurable: true });
  const titles = [document.title, document.querySelector('h1')?.textContent, ...Array.from(document.querySelectorAll('meta[name="citation_title"],meta[property="og:title"],meta[name="dc.title"]')).map(node => node.getAttribute('content'))].filter((value): value is string => Boolean(value));
  if (titles.some(value => /^(?:sign in|log in|login|access denied|just a moment|checking your browser|verify you are human|登录|访问受限)/i.test(value.trim()))) throw new Error('来源返回登录、验证或访问限制页，未取得正文。');
  if (expectedTitle && !titles.some(value => titleMatches(expectedTitle, value))) throw new Error('网页标题与预期论文身份不匹配，拒绝将其他页面当作全文。');
  for (const node of Array.from(document.querySelectorAll('script,style,iframe,object,embed,nav,aside,footer,form,noscript,template,[hidden],[aria-hidden="true"],.toc,#toc,.table-of-contents,[role="navigation"]'))) node.remove();
  for (const node of Array.from(document.querySelectorAll('[style]'))) if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '')) node.remove();
  // A structured abstract has its own Methods/Results headings. It cannot be
  // the structural evidence for a full article. Keep it aside and restore it
  // only after substantial body sections outside the abstract are verified.
  const abstracts: string[] = [];
  for (const node of Array.from(document.querySelectorAll('.abstract,.ltx_abstract,[id="abstract" i],[id="Abs1"],[data-title="Abstract" i]'))) {
    if (!document.documentElement.contains(node) || /^H[1-6]$/.test(node.tagName)) continue;
    abstracts.push((node as HTMLElement).innerText || node.textContent || ''); node.remove();
  }
  for (const heading of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    if (!/^(?:abstract|摘要)\s*[:：]?$/i.test(heading.textContent?.trim() || '') || !document.documentElement.contains(heading)) continue;
    const level = Number(heading.tagName.slice(1)); const parts: string[] = []; let start: Element = heading;
    // Publishers sometimes wrap just the heading in <header> or <div>, with
    // the abstract content beside that wrapper. Walk that interval as well.
    while (start.parentElement && !/^(?:BODY|HTML|ARTICLE|MAIN|SECTION)$/.test(start.parentElement.tagName) && start.parentElement.textContent?.trim() === heading.textContent?.trim()) start = start.parentElement;
    let node: ChildNode | null = start;
    while (node) {
      const next: ChildNode | null = node.nextSibling;
      if (node !== start && node.nodeType === 1) {
        const element = node as Element;
        const headings = /^H[1-6]$/.test(element.tagName) ? [element] : Array.from(element.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        if (headings.some(value => Number(value.tagName.slice(1)) <= level)) break;
      }
      parts.push((node as HTMLElement).innerText || node.textContent || ''); node.parentNode?.removeChild(node); node = next;
    }
    abstracts.push(parts.join('\n'));
  }
  const article = new Readability(document as unknown as Document, { charThreshold: 1500, maxElemsToParse: 50_000, disableJSONLD: true }).parse();
  if (!article?.content) throw new Error('页面没有可确认的论文正文，可能只有摘要或付费入口。');
  const extracted = parseHTML(`<html><body>${article.content}</body></html>`).document.body.innerText;
  const body = checkText(extracted);
  return checkText([...abstracts.filter(value => value.trim()), body].join('\n\n'));
}
async function extractPdf(buffer: Buffer, signal: AbortSignal, expectedTitle?: string, deadline = Infinity): Promise<{ text: string; pages: number }> {
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('论文 PDF 文件头无效。');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'); signal.throwIfAborted();
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
    standardFontDataUrl: path.join(PDF_RESOURCES, 'standard_fonts').replaceAll('\\', '/') + '/', cMapUrl: path.join(PDF_RESOURCES, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
    useWasm: false, maxImageSize: 1, stopAtErrors: true });
  const stop = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const pdf = await bounded(task.promise, signal);
    if (pdf.numPages > 200) throw new Error('论文 PDF 超过 200 页，未截取部分冒充全文。');
    const pages: string[] = []; let total = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      if (Date.now() >= deadline) throw new Error('公开论文读取总计超过 30 秒。');
      signal.throwIfAborted(); const page = await bounded(pdf.getPage(index), signal);
      const content = await bounded(page.getTextContent(), signal);
      const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      page.cleanup(); total += text.length;
      // A text-free page may be a scanned body page. Refuse full-text status
      // instead of silently inserting a placeholder and claiming completeness.
      if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 100) throw new Error('PDF 有缺失或过少文本层的页面，可能是扫描页或仅有页码水印；未执行 OCR，不能确认正文完整。');
      if (total > MAX_TEXT) throw new Error('论文正文超过 200000 字符，未截断。');
      pages.push(`[第 ${index} 页]\n${text}`);
    }
    const text = checkText(pages.join('\n\n'));
    if (expectedTitle && !normalized(pages.slice(0, 2).join('\n').slice(0, 12000)).includes(normalized(expectedTitle))) throw new Error('PDF 正文与预期论文标题不匹配。');
    return { text, pages: pdf.numPages };
  } finally { signal.removeEventListener('abort', stop); await cleanup(task.destroy(), signal); }
}

export interface PublicDocumentDownload {bytes:Uint8Array;contentType:string;finalUrl:string;networkWarnings?:string[];}
/** Bounded bytes only. Every redirect is independently DNS/IP validated and
 * pinned by the transport; callers must separately validate document meaning. */
export async function downloadPublicDocument(raw: string, signal: AbortSignal, options: {allowHttp?:boolean;onProgress?: (message: string) => void} = {}):Promise<PublicDocumentDownload> {
  signal.throwIfAborted();
  const deadline = Date.now() + 30_000;
  const total = new AbortController(); const totalTimer = setTimeout(() => total.abort(new Error('公开论文读取总计超过 30 秒。')), 30_000);
  const overall = AbortSignal.any([signal, total.signal]);
  try {
    let url = destination(raw,options.allowHttp); let useProxy = Boolean(configuredProxy()); const networkWarnings: string[] = [];
    for (let hop = 0; hop <= 3; hop++) {
      overall.throwIfAborted(); let target = await resolvePublic(url, overall, useProxy);
      async function downloadOne(): Promise<{ data: Buffer; type: string } | { redirect: string }> {
      const download = new AbortController(); const downloadTimer = setTimeout(() => download.abort(networkError('论文单次下载超过 20 秒。')), 20_000);
      const downloadSignal = AbortSignal.any([overall, download.signal]); let dispatcher: Agent | undefined;
      let data: Buffer; let type: string;
      try {
        dispatcher = dispatcherFor(url, target, downloadSignal, useProxy);
        const response = await bounded(fetch(url, { dispatcher, signal: downloadSignal, redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/pdf,text/html;q=0.9,application/xhtml+xml;q=0.8', 'User-Agent': 'ZhicuiResearch/0.1 (public article text retrieval)' } }), downloadSignal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); await cleanup(response.body?.cancel() ?? Promise.resolve(), downloadSignal); downloadSignal.throwIfAborted();
          if (hop === 3 || !location) throw new Error('论文来源跳转超过 3 次或缺少目标地址。');
          return { redirect: new URL(location, url).href };
        }
        if (!response.ok) { await cleanup(response.body?.cancel() ?? Promise.resolve(), downloadSignal); throw Object.assign(new Error(`公开论文下载失败（HTTP ${response.status}）。`), { proxyExitRejected: useProxy && response.status === 403 }); }
        if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await cleanup(response.body?.cancel() ?? Promise.resolve(), downloadSignal); throw new Error('论文响应超过 8 MB，未读取。'); }
        if (!response.body) throw new Error('论文响应没有正文。');
        type = response.headers.get('content-type') || '';
        const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
        try { while (true) { const item = await bounded(reader.read(), downloadSignal); if (item.done) break; bytes += item.value.byteLength; if (bytes > MAX_BYTES) { await cleanup(reader.cancel(), downloadSignal); throw new Error('论文响应超过 8 MB，未截断。'); } parts.push(item.value); } }
        finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        data = Buffer.concat(parts); return { data, type };
      } finally { clearTimeout(downloadTimer); await cleanup(dispatcher?.destroy() ?? Promise.resolve(), overall); }
      }
      let response: Awaited<ReturnType<typeof downloadOne>>;
      try { response = await downloadOne(); }
      catch (cause) {
        const proxyExitRejected = cause instanceof Error && 'proxyExitRejected' in cause && cause.proxyExitRejected === true;
        if (!useProxy || networkWarnings.length || overall.aborted || !(proxyExitRejected || retryableNetworkError(cause))) throw cause;
        const warning = proxyExitRejected
          ? `读取 ${url.hostname} 时代理出口被站点拒绝（HTTP 403），将在剩余的 30 秒总时限内尝试本机直连一次。`
          : `读取 ${url.hostname} 时代理网络连接失败，将在剩余的 30 秒总时限内临时直连一次。`;
        networkWarnings.push(warning); if (options.onProgress) options.onProgress(warning); else console.warn(warning); overall.throwIfAborted(); useProxy = false;
        // Never turn a proxy Fake-IP token into a direct socket. Re-resolve
        // under strict public-address rules before the one direct attempt.
        target = await resolvePublic(url, overall, false);
        response = await downloadOne();
      }
      overall.throwIfAborted();
      if ('redirect' in response) { url = destination(response.redirect,options.allowHttp); continue; }
      const { data, type } = response;
      const pdf=/application\/pdf/i.test(type)||data.subarray(0,1024).includes(Buffer.from('%PDF-'));
      const refresh = !pdf&&/text\/html|application\/xhtml\+xml/i.test(type)?staticRedirect(data, url, type,options.allowHttp):undefined;
      if (refresh) {
        if (hop === 3) throw new Error('论文来源跳转超过 3 次。');
        url = refresh; continue;
      }
      if (Date.now() >= deadline) throw new Error('公开论文读取总计超过 30 秒。');
      return {bytes:data,contentType:type,finalUrl:url.href,...(networkWarnings.length?{networkWarnings}:{})};
    }
    throw new Error('论文跳转未完成。');
  } finally { clearTimeout(totalTimer); }
}

/** Only independently identified, public HTTPS article bodies succeed. Caller
 * metadata supplies a candidate, not permission to execute scripts or tools. */
export async function readPublicArticle(raw: string, signal: AbortSignal, options: { expectedTitle?: string; onProgress?: (message: string) => void } = {}): Promise<{ text: string; location: string; document?: { mimeType: 'application/pdf'; bytes: Uint8Array }; networkWarnings?: string[] }> {
 signal.throwIfAborted();const deadline=Date.now()+30_000,total=new AbortController(),timer=setTimeout(()=>total.abort(new Error('公开论文读取总计超过 30 秒。')),30_000),overall=AbortSignal.any([signal,total.signal]);
 try{
  const downloaded=await downloadPublicDocument(raw,overall,{onProgress:options.onProgress}),data=Buffer.from(downloaded.bytes),type=downloaded.contentType,url=new URL(downloaded.finalUrl),source=`${url.origin}${url.pathname}`;
  overall.throwIfAborted();const warnings=downloaded.networkWarnings?.length?{networkWarnings:downloaded.networkWarnings}:{};
  if(/application\/pdf/i.test(type)||data.subarray(0,1024).includes(Buffer.from('%PDF-'))){
   const result=await extractPdf(data,overall,options.expectedTitle,deadline);overall.throwIfAborted();
   if(Date.now()>=deadline)throw new Error('公开论文读取总计超过 30 秒。');
   return {text:result.text,location:`公开 PDF 文本层 ${result.pages} 页，全部页面已提取；按页定位；图像与公式视觉内容未核验，未执行 OCR；来源 ${source}`,document:{mimeType:'application/pdf',bytes:data},...warnings};
  }
  if(!/text\/html|application\/xhtml\+xml/i.test(type))throw new Error('公开论文响应不是可识别的 HTML 正文或 PDF。');
  const text=extractHtml(data,url,type,options.expectedTitle);overall.throwIfAborted();if(Date.now()>=deadline)throw new Error('公开论文读取总计超过 30 秒。');
  return {text,location:`公开 HTML 正文文字抽取；已排除页面导航与脚本；数学公式与图片内容未核验；来源 ${source}`,...warnings};
 }finally{clearTimeout(timer);}
}
