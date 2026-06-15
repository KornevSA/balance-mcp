// Тонкий клиент к balance /api/v1. Пробрасывает ТОТ ЖЕ пользовательский Bearer.
import { CFG } from "./config.js";

export type Envelope<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export async function balanceCall<T = any>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Envelope<T>> {
  let r: Response;
  try {
    r = await fetch(CFG.balanceApiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    return { ok: false, error: { code: "network", message: String(e?.message || e) } };
  }
  const text = await r.text();
  try {
    return JSON.parse(text) as Envelope<T>;
  } catch {
    return { ok: false, error: { code: "bad_response", message: `HTTP ${r.status}: ${text.slice(0, 200)}` } };
  }
}

export type BinaryResult = {
  ok: boolean;
  status: number;
  contentType: string;
  buffer: Buffer;
  filename?: string;
  redirectUrl?: string;
};

// Скачивание байтов (PDF/файл). 302 (внешний документ) не следуем — возвращаем URL.
export async function balanceFetchBinary(token: string, path: string): Promise<BinaryResult> {
  const r = await fetch(CFG.balanceApiBase + path, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  if (r.status >= 300 && r.status < 400) {
    return { ok: true, status: r.status, contentType: "", buffer: Buffer.alloc(0), redirectUrl: r.headers.get("location") || undefined };
  }
  const ab = await r.arrayBuffer();
  const cd = r.headers.get("content-disposition") || "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  let filename: string | undefined;
  if (m) { try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; } }
  return {
    ok: r.ok,
    status: r.status,
    contentType: r.headers.get("content-type") || "application/octet-stream",
    buffer: Buffer.from(ab),
    filename,
  };
}
