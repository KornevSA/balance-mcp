// Скачивание файла по ВНЕШНЕМУ URL для upload_customer_file_from_url.
// SSRF-гард: только http/https, приватные/служебные адреса запрещены (включая
// docker-сеть, где живёт сам balance API), редиректы следуем вручную с
// перепроверкой каждого хопа, размер и время ограничены.
//
// Остаточный риск DNS-rebinding (резолв для проверки и резолв внутри fetch —
// два разных запроса) принят осознанно: тулз доступен только аутентифицированным
// операторам/агентам, а не анониму.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const FETCH_MAX_BYTES = 25 * 1024 * 1024; // 25 МБ
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export type FetchedFile = {
  buffer: Buffer;
  contentType: string;
  filename?: string;   // из Content-Disposition
  finalUrl: string;
};

function ipPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;             // link-local + cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  if (low.startsWith("::ffff:")) return ipPrivate(low.slice(7)); // v4-mapped
  return false;
}

async function assertPublicHost(u: URL): Promise<void> {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Разрешены только http/https URL");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    // !includes(".") отсекает голые docker-имена сервисов (web, db, balance-mcp).
    throw new Error(`Внутренний адрес «${host}» запрещён`);
  }
  if (isIP(host)) {
    if (ipPrivate(host)) throw new Error(`Приватный IP ${host} запрещён`);
    return;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Хост «${host}» не резолвится`);
  }
  if (!addrs.length) throw new Error(`Хост «${host}» не резолвится`);
  for (const a of addrs) {
    if (ipPrivate(a.address)) throw new Error(`Хост «${host}» указывает во внутреннюю сеть — запрещено`);
  }
}

function filenameFromDisposition(cd: string): string | undefined {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** Скачать файл по внешнему URL. Бросает Error с человекочитаемым текстом. */
export async function fetchExternalFile(rawUrl: string): Promise<FetchedFile> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Некорректный URL"); }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        redirect: "manual",
        signal: ctl.signal,
        headers: { "User-Agent": "balance-mcp/1.0 (file-fetch)", Accept: "*/*" },
      });

      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) throw new Error(`Редирект HTTP ${r.status} без Location`);
        url = new URL(loc, url); // относительные Location тоже валидны
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} при скачивании ${url.hostname}`);

      const declared = Number(r.headers.get("content-length") || 0);
      if (declared > FETCH_MAX_BYTES) {
        throw new Error(`Файл слишком большой (${Math.round(declared / 1048576)} МБ), лимит 25 МБ`);
      }

      // Читаем потоком с жёстким капом — Content-Length может врать/отсутствовать.
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (r.body) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > FETCH_MAX_BYTES) {
            void reader.cancel();
            throw new Error("Файл слишком большой, лимит 25 МБ");
          }
          chunks.push(value);
        }
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new Error("Сервер вернул пустой файл");

      return {
        buffer,
        contentType: r.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream",
        filename: filenameFromDisposition(r.headers.get("content-disposition") || ""),
        finalUrl: url.toString(),
      };
    } catch (e: any) {
      if (e?.name === "AbortError") throw new Error("Таймаут скачивания (30 с)");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Слишком много редиректов (>${MAX_REDIRECTS})`);
}
