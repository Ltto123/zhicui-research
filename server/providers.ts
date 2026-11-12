/** Pi session pattern adapted from K-Dense BYOK 6a55f5c, MIT; see upstream/LICENSE. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { GenerateOptions, ModelConfig, ModelProvider, ProviderStatus, ModelUsage } from '../shared/types.ts';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FIELDS = new Set(['LLM_BACKEND', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_PROTOCOL', 'ZHICUI_PROVIDER']);
const CODEX_LIMITATION = 'Codex CLI 已安装，但当前版本尚未验证可禁用全部工具；暂不启用此通道。';
const MODEL_TIMEOUT_MS = 180_000;
// Provider token counters are observations, not a price or billing estimate.
// An all-zero SDK placeholder does not establish that a request cost nothing.
export function safeModelUsage(value:unknown):ModelUsage|undefined {
  if(!value||typeof value!=='object')return;
  const raw=value as Record<string,unknown>,usage:ModelUsage={};
  for(const key of ['input','output','cacheRead','cacheWrite','total'] as const){
    const count=raw[key];if(typeof count==='number'&&Number.isSafeInteger(count)&&count>=0)usage[key]=count;
  }
  return Object.values(usage).some(count=>count>0)?usage:undefined;
}
function modelTimeout(options: GenerateOptions): number {
  return typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.min(600_000, Math.max(1000, Math.floor(options.timeoutMs)))
    : MODEL_TIMEOUT_MS;
}

export function parseEnvironment(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !ENV_FIELDS.has(match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    output[match[1]] = value;
  }
  return output;
}

export function loadEnvironmentConfig(): ModelConfig {
  const values: Record<string, string> = {};
  for (const file of [path.join(APP_ROOT, '.env')]) {
    if (fs.existsSync(file)) Object.assign(values, parseEnvironment(fs.readFileSync(file, 'utf8')));
  }
  for (const key of ENV_FIELDS) if (process.env[key] !== undefined) values[key] = process.env[key]!;
  const provider = values.ZHICUI_PROVIDER ?? values.LLM_BACKEND;
  const kind = provider === 'codex' || provider === 'claude' ? provider : 'api';
  const protocol = values.LLM_PROTOCOL === 'anthropic' || values.LLM_BACKEND === 'anthropic' ? 'anthropic' : 'openai';
  return { kind, protocol, baseUrl: values.LLM_BASE_URL || (protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'), model: values.LLM_MODEL || '', ...(values.LLM_API_KEY ? { apiKey: values.LLM_API_KEY } : {}) };
}

export function validateModelConfig(config: ModelConfig): void {
  if (!['api', 'claude', 'codex'].includes(config.kind)) throw new Error('不支持的模型接入方式。');
  if (config.kind !== 'api') return;
  if (!config.model.trim() || config.model.length > 200 || /[\r\n\0]/.test(config.model)) throw new Error('请填写有效的模型名称。');
  if (!['openai', 'anthropic'].includes(config.protocol)) throw new Error('不支持的 API 协议。');
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new Error('模型地址必须是有效的 HTTP 或 HTTPS URL。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型地址必须使用 HTTP 或 HTTPS。');
  if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不可包含凭据、查询参数或片段；密钥请放在密钥字段。');
  if (config.apiKey && /[\r\n\0]/.test(config.apiKey)) throw new Error('API 密钥不可含换行或空字符。');
}

function cancellation(signal: AbortSignal): void { if (signal.aborted) throw new Error('任务已取消。'); }
function publicFailure(error: unknown, key?: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  if (key) message = message.split(key).join('[密钥已隐藏]');
  return new Error(message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 800));
}

async function generateApi(config: ModelConfig, options: GenerateOptions): Promise<string> {
  cancellation(options.signal);
  const sdk = await import('@earendil-works/pi-coding-agent');
  fs.mkdirSync(options.sessionDir, { recursive: true });
  const agentDir = path.join(options.sessionDir, '.pi-runtime');
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: path.join(agentDir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false, signal: options.signal });
  const providerId = 'zhicui-explicit-api';
  const hostname = new URL(config.baseUrl).hostname.toLowerCase();
  const deepseek = config.protocol === 'openai' && (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com') || /(?:^|\/)deepseek(?:[-_/]|$)/i.test(config.model));
  runtime.registerProvider(providerId, {
    name: '智萃科研自选 API', baseUrl: config.baseUrl.replace(/\/$/, ''), api: config.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    // Pi emits DeepSeek's explicit disabled switch only for reasoning-capable
    // models. Capability=true does not enable it: the session remains off.
    models: [{ id: config.model, name: config.model, input: ['text'], reasoning: deepseek, contextWindow: 131_072, maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(config.protocol === 'openai' ? { compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' as const, ...(deepseek ? {thinkingFormat:'deepseek' as const} : {}) } } : {}),
    }],
  });
  // Runtime values are literal: no models.json !command or $variable expansion.
  await runtime.setRuntimeApiKey(providerId, config.apiKey || 'local-keyless');
  const model = runtime.getModel(providerId, config.model);
  if (!model) throw new Error('模型注册失败。');
  const resources: import('@earendil-works/pi-coding-agent').ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.system, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session } = await sdk.createAgentSession({ cwd: options.sessionDir, agentDir, model, modelRuntime: runtime,
    tools: [], customTools: [], resourceLoader: resources, thinkingLevel: 'off',
    sessionManager: sdk.SessionManager.create(options.sessionDir, path.join(options.sessionDir, 'sessions')),
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } }),
  });
  let text = ''; let failure: Error | undefined; let timedOut = false;
  const startedAt = Date.now(); const onAbort = () => { void session.abort(); };
  const timeoutMs = modelTimeout(options);
  const timeout = setTimeout(() => { timedOut = true; void session.abort(); }, timeoutMs);
  const reportProgress = () => options.onProgress?.(text.length
    ? `已收到模型输出 ${text.length} 字符，累计 ${Math.floor((Date.now() - startedAt) / 1000)} 秒。`
    : `正在等待模型输出，已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒。`);
  const heartbeat = setInterval(reportProgress, 30_000);
  options.signal.addEventListener('abort', onAbort, { once: true });
  const unsubscribe = session.subscribe(event => {
    if(event.type==='message_end'&&event.message.role==='assistant'){
      const usage=safeModelUsage({...event.message.usage,total:event.message.usage?.totalTokens});
      if(usage)options.onUsage?.(usage);
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const firstText = !text.length; text += event.assistantMessageEvent.delta;
      if (firstText && text.length) reportProgress();
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') failure = new Error(event.message.errorMessage || '模型请求失败。');
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'length') failure = new Error('模型返回因输出长度限制被截断，未将残缺正文视为完整成果。');
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'toolUse') failure = new Error('模型请求了未启用的工具，当前文本通道无法执行。');
  });
  try {
    cancellation(options.signal); await session.prompt(options.prompt, { expandPromptTemplates: false }); cancellation(options.signal);
    if (timedOut) throw new Error(`模型请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止；未把残缺正文视为完成结果。`);
    if (failure) throw failure;
    if (!text.trim()) throw new Error('模型没有返回正文，未生成成果。');
    return text.trim();
  } catch (error) {
    cancellation(options.signal);
    if (timedOut) throw new Error(`模型请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止；未把残缺正文视为完成结果。`);
    throw publicFailure(error, config.apiKey);
  }
  finally { clearTimeout(timeout); clearInterval(heartbeat); unsubscribe(); options.signal.removeEventListener('abort', onAbort); session.dispose(); }
}

interface Command { executable: string; prefix: string[]; }
function findCli(kind: 'codex' | 'claude'): Command | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of dirs) {
    if (process.platform === 'win32') {
      const binary = path.join(directory, `${kind}.exe`);
      if (fs.existsSync(binary)) return { executable: binary, prefix: [] };
      const relative = kind === 'claude' ? ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] : ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];
      const candidate = path.join(directory, ...relative);
      if (fs.existsSync(candidate)) return kind === 'codex' ? { executable: process.execPath, prefix: [candidate] } : { executable: candidate, prefix: [] };
    } else {
      const binary = path.join(directory, kind);
      try { fs.accessSync(binary, fs.constants.X_OK); return { executable: binary, prefix: [] }; } catch { /* next PATH entry */ }
    }
  }
  return undefined;
}

function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.on('error', () => child.kill());
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

function execute(command: Command, args: string[], input: string, options: { cwd?: string; signal: AbortSignal; timeoutMs: number }): Promise<string> {
  cancellation(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.prefix, ...args], { cwd: options.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let stdout = ''; let stderr = ''; let aborted = false; let timedOut = false; let overflow = false;
    const timer = setTimeout(() => { timedOut = true; stopProcessTree(child); }, options.timeoutMs);
    const abort = () => { aborted = true; stopProcessTree(child); };
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) { overflow = true; stopProcessTree(child); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort);
      if (aborted || options.signal.aborted) reject(new Error('任务已取消。'));
      else if (timedOut) reject(new Error('CLI 请求超时，进程已停止。'));
      else if (overflow) reject(new Error('CLI 返回内容超过安全长度限制。'));
      else if (code !== 0) reject(new Error(`CLI 退出码 ${code}：${stderr.slice(-1200) || '未返回错误详情'}`));
      else resolve(stdout);
    });
    child.stdin.end(input); if (options.signal.aborted) abort();
  });
}

let claudeProbe: { time: number; result: ProviderStatus } | undefined;
async function statusClaude(): Promise<ProviderStatus> {
  if (claudeProbe && Date.now() - claudeProbe.time < 60_000) return claudeProbe.result;
  const command = findCli('claude'); let result: ProviderStatus = { kind: 'claude', available: false, detail: '未找到 Claude Code CLI。' };
  if (command) {
    try {
      const help = await execute(command, ['--help'], '', { signal: new AbortController().signal, timeoutMs: 8000 });
      const safe = ['--safe-mode', '--tools', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'].every(flag => help.includes(flag));
      result = safe ? { kind: 'claude', available: true, detail: '已检测到支持无工具文本模式的 Claude Code CLI；登录与模型额度将在实际调用时验证。' } : { kind: 'claude', available: false, detail: '已找到 Claude Code CLI，但版本缺少必要的无工具隔离选项。' };
    } catch { result = { kind: 'claude', available: false, detail: 'Claude Code CLI 未能在 8 秒内完成版本能力检查。' }; }
  }
  claudeProbe = { time: Date.now(), result }; return result;
}

async function generateClaude(config: ModelConfig, options: GenerateOptions): Promise<string> {
  cancellation(options.signal);
  const status = await statusClaude(); if (!status.available) throw new Error(status.detail);
  fs.mkdirSync(options.sessionDir, { recursive: true });
  const args = ['--print', '--safe-mode', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'];
  if (config.model.trim()) args.push('--model', config.model.trim());
  const startedAt = Date.now(); const heartbeat = setInterval(() => options.onProgress?.(`Claude Code 正在处理文本，已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒。`), 30_000);
  try {
    const output = await execute(findCli('claude')!, args, `${options.system}\n\n<task>\n${options.prompt}\n</task>`, { cwd: options.sessionDir, signal: options.signal, timeoutMs: modelTimeout(options) });
    const result = JSON.parse(output) as { is_error?: boolean; result?: string; errors?: string[] };
    if (result.is_error) throw new Error(result.result || result.errors?.join('; ') || 'Claude Code 未能完成请求。');
    if (!result.result?.trim()) throw new Error('Claude Code 未返回文本结果。');
    return result.result.trim();
  } catch (error) { throw publicFailure(error, config.apiKey); }
  finally { clearInterval(heartbeat); }
}

export function createProvider(config: ModelConfig): ModelProvider {
  validateModelConfig(config); const immutable = { ...config };
  return { generate: async options => {
    if (immutable.kind === 'codex') return Promise.reject(new Error(findCli('codex') ? CODEX_LIMITATION : '未找到 Codex CLI。'));
    if(immutable.kind==='claude')return generateClaude(immutable,options);
    try{return await generateApi(immutable,options);}catch(error){
      if(options.disableTransientRetries||options.signal.aborted||!/(Connection error|fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket hang up|\b50[234]\b)/i.test((error as Error).message))throw error;
      options.onProgress?.('模型连接暂时中断；本阶段尚未发布结果，正在有界重连一次。');
      await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('任务已取消。'));};const timer=setTimeout(()=>{options.signal.removeEventListener('abort',abort);resolve();},1000);options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();});
      return generateApi(immutable,{...options,sessionDir:options.sessionDir+'-retry'});
    }
  } };
}

export async function providerStatus(config:ModelConfig=loadEnvironmentConfig()): Promise<ProviderStatus[]> {
  let api: ProviderStatus;
  try { validateModelConfig({ ...config, kind: 'api' }); api = { kind: 'api', available: true, detail: '已读取 API 配置；网络、密钥权限与模型兼容性以实际调用结果为准。' }; }
  catch { api = { kind: 'api', available: false, detail: '请设置 API 地址、模型及所需密钥。' }; }
  return [api, { kind: 'codex', available: false, detail: findCli('codex') ? CODEX_LIMITATION : '未找到 Codex CLI。' }, await statusClaude()];
}
