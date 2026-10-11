// Тонкий клиент к balance /api/v1. Пробрасывает ТОТ ЖЕ пользовательский Bearer.
import { CFG } from "./config.js";

export type Envelope<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; [k: string]: any } };

/**
 * Необязательные параметры вызова. timeoutMs — сколько ждать ответа balance
 * (по умолчанию без ограничения, как раньше). Тулзы 1С ставят 120 с: холодная
 * база 1С отвечает десятки секунд, а balance сам ограничивает каждый вызов 1С.
 * write — вызов что-то записывает (тулзы записи в 1С): на обрыв другой текст —
 * запись могла пройти, повтор безопасен только потому, что ключи записи постоянные.
 */
export type CallOpts = { timeoutMs?: number; write?: boolean };

function isTimeout(e: any): boolean {
  const n = String(e?.name || "");
  return n === "TimeoutError" || n === "AbortError";
}

function timeoutMessage(ms: number, write = false): string {
  return `balance не ответил за ${Math.round(ms / 1000)} с (1С отвечает долго: холодный старт базы или блокировка). ` +
    (write
      ? `Запись могла пройти. Повтор безопасен (ключ записи тот же — 1С вернёт уже созданное), но сначала посмотрите результат в 1С.`
      : `Повтор безопасен — это только чтение.`);
}

export async function balanceCall<T = any>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts: CallOpts = {}
): Promise<Envelope<T>> {
  let r: Response;
  let text: string;
  try {
    r = await fetch(CFG.balanceApiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    text = await r.text();
  } catch (e: any) {
    if (opts.timeoutMs && isTimeout(e)) {
      return { ok: false, error: { code: "timeout", message: timeoutMessage(opts.timeoutMs, opts.write) } };
    }
    return { ok: false, error: { code: "network", message: String(e?.message || e) } };
  }
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
  headers?: Headers;
  /** Обрыв по тайм-ауту или сети (status = 0): текст для модели. */
  error?: string;
};

// Скачивание байтов (PDF/файл). 302 (внешний документ) не следуем — возвращаем URL.
export async function balanceFetchBinary(token: string, path: string, opts: CallOpts = {}): Promise<BinaryResult> {
  let r: Response;
  let ab: ArrayBuffer;
  try {
    r = await fetch(CFG.balanceApiBase + path, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (r.status >= 300 && r.status < 400) {
      return { ok: true, status: r.status, contentType: "", buffer: Buffer.alloc(0), redirectUrl: r.headers.get("location") || undefined };
    }
    ab = await r.arrayBuffer();
  } catch (e: any) {
    // Без тайм-аута — прежнее поведение (исключение наверх).
    if (!opts.timeoutMs) throw e;
    const error = isTimeout(e) ? timeoutMessage(opts.timeoutMs) : `balance недоступен: ${String(e?.message || e)}`;
    return { ok: false, status: 0, contentType: "", buffer: Buffer.alloc(0), error };
  }
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
    headers: r.headers,
  };
}
