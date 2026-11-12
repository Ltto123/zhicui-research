import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RecycleRequest {
  executable: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}
export type RecycleRunner = (request: RecycleRequest) => Promise<{ exitCode: number | null; stdout: string; stderr?: string }>;

function samePath(left: string, right: string) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function checkedPath(value: string): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value)) throw new Error('回收路径必须是普通的绝对路径');
  if (/^[\\/]{2}/.test(value) || value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('不允许网络、设备或含路径跳转的回收路径');
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')) throw new Error('不允许设备路径或备用数据流');
    for (const part of value.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (/[<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('不允许特殊 Windows 文件名');
    }
  }
  return path.resolve(value);
}

function checkOrdinaryEntry(target: string) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('回收目录不能包含符号链接、junction 或特殊文件');
  if (!samePath(realpathSync.native(target), path.resolve(target))) throw new Error('回收目录不能经过重解析路径');
  return stat;
}

/** Reject links and path escapes synchronously. The native helper additionally checks
 * every Windows reparse attribute immediately before submitting the disposable copy.
 * These checks are fail-closed validation, not a filesystem locking mechanism. */
export function validateManagedTree(directory: string, allowedRoot: string): void {
  const root = checkedPath(allowedRoot), target = checkedPath(directory);
  if (samePath(root, path.parse(root).root)) throw new Error('回收范围不能是整个卷');
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('回收目录必须严格位于指定范围内');
  // Windows can opt individual directories into case-sensitive lookup. Verify
  // the actual ancestor identity, not just path.relative's case-folded prefix.
  let boundary = target;
  for (const _ of relative.split(path.sep)) boundary = path.dirname(boundary);
  const rootIdentity = lstatSync(root, { bigint: true }), boundaryIdentity = lstatSync(boundary, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || rootIdentity.dev !== boundaryIdentity.dev || rootIdentity.ino !== boundaryIdentity.ino) throw new Error('回收目录的实际父目录与指定范围不一致');
  const targetStat = checkOrdinaryEntry(target);
  for (let ancestor = path.dirname(target); ; ancestor = path.dirname(ancestor)) {
    if (!checkOrdinaryEntry(ancestor).isDirectory()) throw new Error('回收路径必须是目录');
    if (ancestor === path.dirname(ancestor)) break;
  }
  const pending = targetStat.isDirectory() ? [target] : [];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current)) {
      const child = checkedPath(path.join(current, entry));
      if (checkOrdinaryEntry(child).isDirectory()) pending.push(child);
    }
  }
}

const runPowerShell: RecycleRunner = request => new Promise((resolve, reject) => {
  const child = spawn(request.executable, request.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', settled = false;
  const finish = (error?: Error, exitCode?: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve({ exitCode: exitCode ?? null, stdout, stderr });
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error('Windows 回收站操作超时；未取得可验证的回收凭据'));
  }, request.timeoutMs);
  for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]] as const) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      if (capture) stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 128 * 1024) {
        child.kill();
        finish(new Error('Windows 回收站返回内容超过限制'));
      }
    });
  }
  child.on('error', error => finish(error));
  child.stdin.on('error', error => finish(error));
  child.on('close', code => finish(undefined, code));
  child.stdin.end(request.stdin, 'utf8');
});

/** Only pass a disposable, independently verified recovery package here. Windows
 * can permanently delete that copy when recycling is unavailable. Never pass the
 * only copy of user data; callers must retain originals until they verify this receipt. */
export async function recycleDirectory(directory: string, allowedRoot: string, runner: RecycleRunner = runPowerShell): Promise<{ recycledPath: string }> {
  if (process.platform !== 'win32') throw new Error('此删除功能需要 Windows 回收站');
  validateManagedTree(directory, allowedRoot);
  if (!lstatSync(directory).isDirectory()) throw new Error('一次性回收包必须是目录');
  const target = checkedPath(directory), root = checkedPath(allowedRoot);
  const windowsRoot = checkedPath(process.env.SystemRoot || 'C:\\Windows');
  const result = await runner({
    executable: path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', fileURLToPath(new URL('./native/recycle.ps1', import.meta.url))],
    stdin: JSON.stringify({ directory: target, allowedRoot: root }),
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(`Windows 回收站操作失败；原始数据应保留${result.stderr ? `：${result.stderr.trim().slice(0, 1500)}` : ''}`);
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as Record<string, unknown>; }
  catch { throw new Error('Windows 回收站未返回有效凭据'); }
  if (!receipt || receipt.version !== 1 || receipt.recycleConfirmed !== true || receipt.aborted !== false || typeof receipt.sourcePath !== 'string' || !samePath(checkedPath(receipt.sourcePath), target) || typeof receipt.recycledPath !== 'string') {
    throw new Error('Windows 回收站凭据不完整或操作已中止');
  }
  const recycledPath = checkedPath(receipt.recycledPath);
  const volumeRoot = path.parse(target).root;
  if (!samePath(path.parse(recycledPath).root, volumeRoot) || !/^\$Recycle\.Bin[\\/]S-\d+(?:-\d+)+[\\/]\$R[^\\/]+$/i.test(path.relative(volumeRoot, recycledPath))) {
    throw new Error('回收凭据未指向当前卷的 Windows 回收站项目');
  }
  validateManagedTree(recycledPath, path.join(volumeRoot, '$Recycle.Bin'));
  if (!lstatSync(recycledPath).isDirectory()) throw new Error('回收站凭据必须指向完整的包目录');
  if (existsSync(target)) throw new Error('回收操作未移走一次性复制包');
  return { recycledPath };
}
