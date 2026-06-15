// Политика доставки файлов в ответе тулза:
//   ≤ inlineMaxBytes  → embedded resource (base64 blob) + текстовая сводка;
//   > inlineMaxBytes  → только метаданные (инлайн превысил бы контекст);
//   302 (внешний док)  → текст со ссылкой.
import { balanceFetchBinary } from "./balanceClient.js";
import { CFG } from "./config.js";

export async function deliverFile(token: string, path: string, label: string) {
  const f = await balanceFetchBinary(token, path);

  if (f.redirectUrl) {
    return { content: [{ type: "text" as const, text: `${label}: внешний документ доступен по ссылке: ${f.redirectUrl}` }] };
  }
  if (!f.ok) {
    return { isError: true, content: [{ type: "text" as const, text: `Не удалось получить файл (${label}): HTTP ${f.status}` }] };
  }

  const name = f.filename || label;
  const size = f.buffer.length;
  if (size > CFG.inlineMaxBytes) {
    return {
      content: [{
        type: "text" as const,
        text: `Файл «${name}» (${(size / 1048576).toFixed(1)} МБ, ${f.contentType}) превышает лимит инлайна `
            + `${Math.round(CFG.inlineMaxBytes / 1048576)} МБ — не вложен. Откройте его в интерфейсе Balance.`,
      }],
    };
  }

  return {
    content: [
      { type: "text" as const, text: `Файл «${name}» — ${(size / 1024).toFixed(0)} КБ, ${f.contentType}.` },
      {
        type: "resource" as const,
        resource: {
          uri: `balance://file/${encodeURIComponent(name)}`,
          mimeType: f.contentType || "application/octet-stream",
          blob: f.buffer.toString("base64"),
        },
      },
    ],
  };
}
