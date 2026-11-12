import { Socket } from 'node:net';
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { configureHttpProxy, redactProxyUrl, withLoopbackNoProxy } from './upstream/http-proxy';
import { readLiteratureResponse } from './literature/network';
import { probeArxiv } from './literature/arxiv';
import { searchEric } from './literature/eric';
import { searchDoaj } from './literature/doaj';
import { searchOpenAire } from './literature/openaire';

export interface NetworkStatus { mode: 'proxy' | 'direct'; proxy?: string; message: string; checkedAt: string; }
export interface SourceStatus { name: string; scope: string; status: 'not_checked' | 'available' | 'failed'; detail: string; checkedAt?: string; }
const PROXY_VARIABLES = ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy'];
const SOURCES = [
  { name: 'OpenAlex', scope: '跨学科论文与可用摘要，覆盖教育研究', url: 'https://api.openalex.org/works?search=ChatGPT%20teacher%20lesson%20planning&per-page=1' },
  { name: 'Crossref', scope: 'DOI书目与出版方登记的摘要', url: 'https://api.crossref.org/works?query=teacher%20lesson%20planning&rows=1&select=DOI,title' },
  { name: 'Europe PMC', scope: '生命科学及医学教育摘要与开放全文', url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=ChatGPT%20teacher&format=json&pageSize=1' },
  { name: 'arXiv', scope: '物理、数学、计算机等领域预印本与开放原文入口', url: 'https://export.arxiv.org/api/query?search_query=all:electron&start=0&max_results=1' },
  { name: 'PubMed', scope: '生物医学与生命科学书目、摘要及可用原文入口', url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=machine%20learning&retmode=json&retmax=1&tool=ZhicuiResearch' },
  { name: 'ERIC', scope: '教育研究题录、摘要及可用全文入口', url: 'https://api.ies.ed.gov/eric/' },
  { name: 'DOAJ', scope: '开放获取期刊文章题录、摘要及出版方全文入口', url: 'https://doaj.org/api/search/articles/education' },
  { name: 'OpenAIRE', scope: '跨学科论文与机构仓储记录，保留公开全文入口', url: 'https://api.openaire.eu/graph/v3/research-products' },
];
let network: NetworkStatus = { mode:'direct', message:'网络尚未初始化；尚未验证数据库连接。', checkedAt:'' };
let sources: SourceStatus[] = SOURCES.map(s => ({ name:s.name, scope:s.scope, status:'not_checked', detail:'尚未检查；连接可用不代表检索覆盖完整。' }));

export function probeProxy(address: string): Promise<boolean> {
  return new Promise(resolve => {
    let url: URL;
    try { url = new URL(address); if (!['http:', 'https:'].includes(url.protocol)) return resolve(false); }
    catch { return resolve(false); }
    const socket = new Socket(); let finished = false;
    const done = (ok: boolean) => { if (finished) return; finished=true; clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer=setTimeout(() => done(false), 2000);
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    socket.connect(Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url.hostname);
  });
}

/** Same-process setup also covers `npm run server`, which bypasses the desktop launcher. */
export async function prepareNetwork(env: NodeJS.ProcessEnv = process.env, probe = probeProxy, report: (message:string)=>void = console.warn): Promise<NetworkStatus> {
  const mode=env.ZHICUI_NETWORK_MODE?.trim().toLowerCase()||'auto';
  if(!['auto','direct'].includes(mode))throw new Error('ZHICUI_NETWORK_MODE 仅支持 auto 或 direct。');
  const https = env.https_proxy?.trim() || env.HTTPS_PROXY?.trim() || env.http_proxy?.trim() || env.HTTP_PROXY?.trim();
  const http = env.http_proxy?.trim() || env.HTTP_PROXY?.trim() || https;
  // Only this backend process is configured. Never assume a developer's
  // loopback proxy exists on a deployment server or on a customer's computer.
  // Match the dispatcher's lowercase precedence and retain host exceptions.
  // A blanket inherited wildcard must not silently disable a configured proxy;
  // callers that want all requests direct can select the explicit direct mode.
  const noProxy=(env.no_proxy?.trim()||env.NO_PROXY?.trim()||'').split(/[\s,]+/).filter(entry=>entry&&entry!=='*').join(',');
  env.NO_PROXY = withLoopbackNoProxy(noProxy); env.no_proxy = env.NO_PROXY;
  if(mode==='direct'||!https){
    const ignoredAllProxy=Boolean(env.ALL_PROXY?.trim()||env.all_proxy?.trim());
    const message=mode==='direct'
      ?'ZHICUI_NETWORK_MODE=direct：本次服务按显式设置使用有超时的直连，忽略继承的代理；数据库访问需逐库检查。'
      :`未配置 HTTP(S)_PROXY，本次服务使用有超时的直连；${ignoredAllProxy?'未采用 ALL_PROXY，':' '}数据库访问需逐库检查。`;
    for(const name of PROXY_VARIABLES)delete env[name];
    if(mode==='direct'||ignoredAllProxy)report(message);
    return {mode:'direct',message,checkedAt:new Date().toISOString()};
  }
  const configured = [...new Set([https,http!])];
  const available = (await Promise.all(configured.map(url => probe(url).catch(() => false)))).every(Boolean);
  if (available) {
    env.HTTP_PROXY=http; env.http_proxy=http; env.HTTPS_PROXY=https; env.https_proxy=https;
    return { mode:'proxy', proxy:redactProxyUrl(https), message:'已检测到代理端口，境外文献请求通过该代理；数据库是否可访问需逐库检查。', checkedAt:new Date().toISOString() };
  }
  const message='代理端口不可用，本次服务将尝试有超时的直连；数据库访问结果以逐库检查为准。';
  report(message);
  for (const name of PROXY_VARIABLES) delete env[name];
  return { mode:'direct', message, checkedAt:new Date().toISOString() };
}

export async function initializeNetwork(): Promise<NetworkStatus> {
  network=await prepareNetwork();
  if(network.mode==='direct'){
    // Clearing env alone does not remove an already installed Node/proxy
    // dispatcher. Direct mode is an explicit startup choice for this process.
    setGlobalDispatcher(new Agent({connect:{timeout:12_000}}));
    globalThis.fetch=undiciFetch as unknown as typeof globalThis.fetch;
  }else configureHttpProxy();
  return network;
}
export function retrievalStatus() { return { network, sources }; }

function validSourceResponse(name:string,text:string):boolean{
  const body=JSON.parse(text);
  if(name==='PubMed')return !body.error&&!body.ERROR&&Array.isArray(body.esearchresult?.idlist)&&!('errorlist' in body.esearchresult)&&!body.esearchresult.ERROR;
  return name==='OpenAlex'?Array.isArray(body.results):name==='Crossref'?Array.isArray(body.message?.items):Array.isArray(body.resultList?.result);
}
export async function checkLiteratureSources(signal: AbortSignal): Promise<SourceStatus[]> {
  signal.throwIfAborted();
  const results = await Promise.all(SOURCES.map(async source => {
    const checkedAt=new Date().toISOString();
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(new Error('连接检查超过 12 秒，已停止等待；其他来源分别记录结果。')),12_000);
    const timeout=AbortSignal.any([signal,deadline.signal]);
    const networkWarnings:string[]=[];
    const onFallback=(message:string)=>{networkWarnings.push(message);console.warn(message);};
    try {
      if(source.name==='arXiv'){
        // Reuse the adapter's one-connection/3-second scheduler. A health check
        // never queues ahead of an active research retrieval.
        const result=await probeArxiv(timeout,onFallback);
        if(!result)return {name:source.name,scope:source.scope,status:'not_checked' as const,detail:'arXiv 检索正在进行，本次未额外发送连接检查；可在检索结束后再检查。',checkedAt};
      }else if(source.name==='ERIC'||source.name==='DOAJ'||source.name==='OpenAIRE'){
        // Share parsing, request spacing and quotas with actual searches.
        // The health action must never bypass a source's request budget.
        const adapter=source.name==='ERIC'?searchEric:source.name==='DOAJ'?searchDoaj:searchOpenAire;
        await adapter('education',timeout,{size:1,onProgress:onFallback});
      }else{
        const text=await readLiteratureResponse(new URL(source.url),timeout,{maximumBytes:250_000,configuredTimeoutMs:4000,directTimeoutMs:6000,headers:{Accept:'application/json'},onFallback});
        if(!validSourceResponse(source.name,text))throw new Error('接口返回结构无效');
      }
      const usedDirectFallback=networkWarnings.some(message=>/当前配置网络连接失败.*仅尝试一次.*直连/.test(message));
      return {name:source.name,scope:source.scope,status:'available' as const,detail:`${usedDirectFallback?'配置网络失败后已通过一次限时直连':'已按当前服务网络配置实际连通'}并收到有效响应；搜索命中与正文可得性由具体检索决定。${networkWarnings.join(' ')}`,checkedAt};
    } catch(error) {
      signal.throwIfAborted();
      const detail=error instanceof Error?error.message:'连接失败';
      return {name:source.name,scope:source.scope,status:'failed' as const,detail:[...networkWarnings,detail].join(' ').slice(0,500),checkedAt};
    }finally{clearTimeout(timer);}
  }));
  sources=results; return results;
}
