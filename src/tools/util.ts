// Общие хелперы тулзов.

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
