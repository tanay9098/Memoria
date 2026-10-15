export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError("Cannot reach the Memoria server. Is `npm run dev` still running?", "network", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, data.code ?? "error", res.status);
  return data as T;
}
