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

export function ok(text: string, structured?: any) {
  const r: any = { content: [{ type: "text", text }] };
  if (structured !== undefined) r.structuredContent = structured;
  return r;
}

export function fail(text: string) {
  return { isError: true, content: [{ type: "text", text }] };
}
