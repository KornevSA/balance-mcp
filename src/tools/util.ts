// Общие хелперы тулзов.
import { createHmac, timingSafeEqual } from "node:crypto";

export function tokenOf(extra: any): string {
  const t = extra?.authInfo?.token;
  if (!t) throw new Error("Нет access-токена в контексте запроса");
  return String(t);
}

// query-string; массивы → CSV (balance принимает CSV и repeated).
export function qs(params: Record<string, any>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { if (v.length) u.set(k, v.join(",")); }
    else u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

// Публичный базовый URL balance (https://balance.99p.ru) из заголовков ТЕКУЩЕГО
// MCP-запроса (X-Forwarded-*, как reqBase в index.ts) — web-UI и MCP живут на одном
// хосте. Нужен тулзам, отдающим ссылки для человека (create_customer_upload_link):
// сам balance API зовётся по внутреннему http://web и публичного хоста не знает.
export function publicBaseOf(extra: any): string {
  const headers = extra?.requestInfo?.headers ?? {};
  const pick = (k: string): string => {
    const v = headers[k];
    return String(Array.isArray(v) ? v[0] : v || "").split(",")[0].trim();
  };
  const host = pick("x-forwarded-host") || pick("host");
  const proto = pick("x-forwarded-proto") || "https";
  return host ? `${proto}://${host}` : "";
}

// Успешный результат тулза.
//
// ВАЖНО: полезную нагрузку кладём В ТЕКСТОВЫЙ БЛОК (content), а не только в
// structuredContent. MCP-клиенты (коннектор Claude.ai, Claude Code) показывают
// модели именно text-блоки; structuredContent надёжно используется лишь когда у
// тулза объявлена outputSchema — а у наших тулзов её нет. Без дублирования в text
// модель видела только «шапку» вида «Статей: 5», а сам список/тело статьи терялись
// (регресс, воспроизведён 23.07: list_kb_articles / list_kb_categories /
// list_positions / get_kb_article отдавали только счётчик). Спека MCP прямо требует
// дублировать структурированный ответ в TextContent для обратной совместимости.
// Держим ОДИН text-блок (сводка + компактный JSON) — так исключаем и риск «до
// клиента дошёл только первый блок». structuredContent оставляем: не мешает и
// помогает клиентам, которые умеют его читать.
export function ok(text: string, structured?: any) {
  const r: any = {
    content: [{
      type: "text",
      text: structured === undefined ? text : `${text}\n${JSON.stringify(structured)}`,
    }],
  };
  if (structured !== undefined) r.structuredContent = structured;
  return r;
}

export function fail(text: string) {
  return { isError: true, content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Двухшаговое подтверждение изменяющих тулзов (правка базы знаний).
//
// Токен привязан к ТОЧНОМУ изменению: HMAC(secret, op|id|issuedAt|поля). Первый
// вызов тулза (без confirm) возвращает превью + токен и НИЧЕГО не пишет; правка
// применяется только повторным вызовом с этим токеном и теми же полями. Любое
// изменение полей делает токен недействительным → нужно новое превью. TTL 15 мин.
// Секрет из ENV KB_CONFIRM_SECRET (фолбэк — константа: токен не про защиту от
// злоумышленника, а про принудительный второй шаг и показ диффа человеку; реальный
// гейт — requireUser + RBAC + подтверждение в клиенте).
// ---------------------------------------------------------------------------
const CONFIRM_SECRET = process.env.KB_CONFIRM_SECRET || "balance-mcp:kb-confirm:v1";
const CONFIRM_TTL_MS = 15 * 60 * 1000;

// Детерминированная сериализация (ключи отсортированы рекурсивно).
function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function macOf(op: string, id: number, fields: any, issuedAt: number): string {
  return createHmac("sha256", CONFIRM_SECRET)
    .update(`${op}|${id}|${issuedAt}|${stableStringify(fields ?? {})}`)
    .digest("base64url");
}

/** Выдать токен подтверждения для (операция, id, набор полей). */
export function confirmToken(op: string, id: number, fields: any): string {
  const issuedAt = Date.now();
  return `v1.${issuedAt}.${macOf(op, id, fields, issuedAt)}`;
}

/** Проверить токен против (операция, id, поля). ok=false с человекочитаемой причиной. */
export function verifyConfirmToken(
  token: string,
  op: string,
  id: number,
  fields: any,
): { ok: boolean; reason?: string } {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "неверного формата" };
  const issuedAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: "без метки времени" };
  if (Date.now() - issuedAt > CONFIRM_TTL_MS) return { ok: false, reason: "истёк (>15 минут)" };
  const expected = `v1.${issuedAt}.${macOf(op, id, fields, issuedAt)}`;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "не совпал с изменениями" };
  return { ok: true };
}
