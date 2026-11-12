export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(!isForm && options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(45_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `请求未完成（${response.status}）`);
  return data as T;
}

export const body = (value: unknown) => JSON.stringify(value);
export const errorText = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请重试。';
