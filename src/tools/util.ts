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

export function ok(text: string, structured?: any) {
  const r: any = { content: [{ type: "text", text }] };
  if (structured !== undefined) r.structuredContent = structured;
  return r;
}

export function fail(text: string) {
  return { isError: true, content: [{ type: "text", text }] };
}
