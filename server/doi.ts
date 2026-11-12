import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

export interface ResolvedDoi { doi: string; url: string; via: 'configured-network' | 'direct'; warning?: string; }
const MAX_DOI = 500;
const MAX_HEADERS = 16_384;
const MAX_RESPONSE = 65_536;
const DIRECT_WARNING = '当前网络的 DOI 解析失败；现在尝试一次有超时的直连。';
class InvalidRedirect extends Error {}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason instanceof Error ? signal.reason : new Error('DOI 解析已取消。'));
    signal.addEventListener('abort', stop, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
function normalizeDoi(value: string): string {
  // A DOI is an identifier, never a caller-provided URL or query string. Keep
  // suffix punctuation as data and encode it when constructing the fixed URL.
  if (typeof value !== 'string' || value.length > MAX_DOI || !/^10\.\d{4,9}\/[^\s\p{C}\\?#%]+$/u.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('DOI 格式无效：请提供不超过 500 字符的裸 DOI，不含空白、控制字符、网址参数或点路径段。');
  return value.toLowerCase();
}
function publicAddress(value: string): boolean {
  if (!isIP(value)) return false;
  const address = ipaddr.parse(value);
  return address.range() === 'unicast' && !(address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress());
}
async function publisherUrl(location: string | null, signal: AbortSignal): Promise<string> {
  if (!location || location.length > 4096 || /[\u0000-\u001f\u007f]/.test(location)) throw new InvalidRedirect('DOI 未提供有效的出版页面跳转地址。');
  let url: URL;
  try { url = new URL(location, 'https://doi.org'); } catch { throw new InvalidRedirect('DOI 返回的出版页面地址无效。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/.test(host)) throw new InvalidRedirect('DOI 出版页面跳转地址必须是无凭据的公网 HTTPS 域名，不能是本机、内网或 IP 地址。');
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
  let addresses: Awaited<ReturnType<typeof lookup>>[] | { address: string }[];
  try { addresses = await bounded(lookup(host, { all: true, verbatim: true }), dnsSignal); }
  catch { signal.throwIfAborted(); throw new InvalidRedirect('DOI 出版页面域名无法完成公网 DNS 校验，未返回未经验证的跳转地址。'); }
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new InvalidRedirect('DOI 出版页面 DNS 包含非公网地址，已拒绝跳转。');
  return url.href;
}

/** Resolve one DOI without following or downloading its publisher redirect.
 * The application owns the configured dispatcher; only the fallback Agent is
 * local to this call, and it is always destroyed before the call finishes. */
export async function resolveDoi(value: string, signal: AbortSignal): Promise<ResolvedDoi> {
  signal.throwIfAborted();
  const doi = normalizeDoi(value);
  const encoded = doi.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  const requestUrl = new URL(`https://doi.org/${encoded}`);
  const overall = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const attempt = async (milliseconds: number, dispatcher?: Agent): Promise<string> => {
    const requestSignal = AbortSignal.any([overall, AbortSignal.timeout(milliseconds)]);
    const response = await bounded(fetch(requestUrl, { method: 'HEAD', redirect: 'manual', signal: requestSignal, ...(dispatcher ? { dispatcher } : {}), headers: { Accept: 'text/html', 'User-Agent': 'ZhicuiResearch/0.1 (DOI resolution)' } }), requestSignal);
    try {
      const headerCharacters = [...response.headers].reduce((length, [key, header]) => length + key.length + header.length, 0);
      if (headerCharacters > MAX_HEADERS || Number(response.headers.get('content-length') || 0) > MAX_RESPONSE) throw new InvalidRedirect('DOI 响应超过允许的头部或内容长度，未接受该跳转。');
      if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error(`DOI 未返回出版页面跳转（HTTP ${response.status}）。`);
      return await publisherUrl(response.headers.get('location'), overall);
    } finally { await bounded(response.body?.cancel() ?? Promise.resolve(), overall); }
  };
  try {
    return { doi, url: await attempt(8_000), via: 'configured-network' };
  } catch (error) {
    signal.throwIfAborted(); overall.throwIfAborted();
    if (error instanceof InvalidRedirect) throw error;
    // Do not disclose arbitrary transport errors: they can contain proxy URLs
    // or credentials. This message is emitted before the direct attempt.
    console.warn(DIRECT_WARNING);
  }
  const direct = new Agent({ maxHeaderSize: MAX_HEADERS, maxResponseSize: MAX_RESPONSE, headersTimeout: 6_000, bodyTimeout: 6_000, connect: { timeout: 6_000 } });
  try {
    return { doi, url: await attempt(6_000, direct), via: 'direct', warning: DIRECT_WARNING };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof InvalidRedirect) throw error;
    throw new Error('DOI 在当前网络和直连下均解析失败；没有返回虚构的出版页面，请稍后重试。');
  } finally {
    // Destroy is initiated even when the caller or total deadline has already
    // aborted. Cleanup cannot extend the overall limit or mask that error.
    await bounded(direct.destroy(), AbortSignal.any([overall, AbortSignal.timeout(2_000)])).catch(() => {});
  }
}
