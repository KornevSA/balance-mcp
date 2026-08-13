// Политика доставки файлов в ответе тулза — ССЫЛКОЙ, а не байтами.
//
// Раньше файл возвращался embedded-ресурсом (base64 blob). Это не работало ни в
// Claude Code, ни в коннекторе: до клиента доезжал `resource` БЕЗ `blob` (и с
// `_meta: null`), клиент валидировал результат по схеме ContentBlock и падал с
// `-32602 Invalid tools/call result … invalid_union … path: content[1]` — то есть
// ошибкой отваливался ВЕСЬ вызов, файл не доходил никак. Проверено 13.08.2026 на
// get_customer_file и get_document_pdf.
//
// Теперь: байты кладём в память процесса (downloadStore) и отдаём временную
// ссылку `${base}/mcp/file/<token>/<имя>` — её открывает браузер человека, а
// клиент-агент при необходимости просто скачивает файл сам. Через модель байты
// не идут вообще, поэтому лимит инлайна больше не ограничивает размер.
//
//   302 (внешний док) → текст со ссылкой 1С/внешнего хранилища;
//   текстовый файл ≤ textInlineMaxBytes → плюс само содержимое в тексте ответа;
//   больше linkMaxBytes → только метаданные (ссылку не заводим).
import { balanceFetchBinary } from "./balanceClient.js";
import { CFG } from "./config.js";
import { putDownload, linkTtlMinutes } from "./downloadStore.js";
import { publicBaseOf } from "./tools/util.js";

/** Текстовые типы, которые не жалко продублировать в ответе тулза. */
function isTextual(ctype: string, name: string): boolean {
  const c = (ctype || "").toLowerCase();
  if (c.startsWith("text/") || c.includes("json") || c.includes("xml") || c.includes("csv")) return true;
  return /\.(txt|csv|json|xml|md)$/i.test(name);
}

function humanSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} КБ`
    : `${(bytes / 1048576).toFixed(1)} МБ`;
}

export async function deliverFile(token: string, path: string, label: string, extra?: any) {
  const f = await balanceFetchBinary(token, path);

  if (f.redirectUrl) {
    return { content: [{ type: "text" as const, text: `${label}: внешний документ доступен по ссылке: ${f.redirectUrl}` }] };
  }
  if (!f.ok) {
    return { isError: true, content: [{ type: "text" as const, text: `Не удалось получить файл (${label}): HTTP ${f.status}` }] };
  }

  const name = f.filename || label;
  const size = f.buffer.length;
  const ctype = f.contentType || "application/octet-stream";

  const dlToken = putDownload(f.buffer, name, ctype);
  if (!dlToken) {
    return {
      content: [{
        type: "text" as const,
        text: `Файл «${name}» (${humanSize(size)}, ${ctype}) больше лимита ссылки `
            + `${Math.round(CFG.linkMaxBytes / 1048576)} МБ — откройте его в интерфейсе Balance.`,
      }],
    };
  }

  // Имя в хвосте URL — косметика: браузер и агент понимают по нему тип файла.
  // Сам файл резолвится только по токену. Слэши из имени убираем ДО кодирования:
  // Apache по умолчанию (AllowEncodedSlashes off) отвечает 404 на %2F в пути.
  const base = publicBaseOf(extra);
  const seg = encodeURIComponent(name.replace(/[\\/]+/g, "_"));
  const url = `${base}/mcp/file/${dlToken}/${seg}`;

  let text = `Файл «${name}» — ${humanSize(size)}, ${ctype}.\n`
           + `Ссылка (живёт ${linkTtlMinutes()} мин, откроется в браузере без авторизации): ${url}`;

  if (isTextual(ctype, name) && size <= CFG.textInlineMaxBytes) {
    text += `\n\nСодержимое:\n${f.buffer.toString("utf8")}`;
  }

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { name, size_bytes: size, content_type: ctype, url, ttl_minutes: linkTtlMinutes() },
  };
}
