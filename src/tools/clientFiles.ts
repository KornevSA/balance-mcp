import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { deliverFile } from "../fileTransfer.js";
import { fetchExternalFile, FETCH_MAX_BYTES } from "../safeFetch.js";
import { tokenOf, qs, ok, fail, publicBaseOf } from "./util.js";

// Синхронно с FilesController::ALLOWED_EXT (balance api/v1).
const ALLOWED_EXT = ["png","jpg","jpeg","gif","pdf","zip","rar","7z",
  "doc","docx","xls","xlsx","ppt","pptx","rtf","odt","ods","txt","csv"];

// Расширение по MIME — когда ни URL, ни Content-Disposition имени не дали.
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "application/zip": "zip", "text/plain": "txt", "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

export function registerClientFileTools(server: McpServer) {
  server.registerTool("list_customer_files", {
    title: "Файлы контрагента",
    description: "Список файлов (вложений) контрагента. Только метаданные; байты — через get_customer_file.",
    inputSchema: {
      customer_id: z.number().int().positive(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
  }, async (a, extra) => {
    const { customer_id, ...q } = a;
    const env = await balanceCall(tokenOf(extra), "GET", `/customers/${customer_id}/files` + qs(q));
    if (!env.ok) return fail(env.error.message);
    return ok(`Файлов: ${env.data?.pagination?.total ?? env.data?.items?.length ?? 0}`, env.data);
  });

  server.registerTool("get_customer_file", {
    title: "Скачать файл контрагента",
    description: "Скачать файл контрагента по file_id (из list_customer_files). Небольшие — инлайном.",
    inputSchema: { file_id: z.number().int().positive() },
  }, async (a, extra) => {
    return await deliverFile(tokenOf(extra), `/files/${a.file_id}/content`, `file_${a.file_id}`);
  });

  server.registerTool("upload_customer_file", {
    title: "Сохранить файл контрагенту",
    description:
      "Загрузить/сохранить файл в раздел «Файлы контрагента» по customer_id. " +
      "Передайте имя файла и содержимое в base64. Допустимые типы: pdf, doc(x), xls(x), ppt(x), " +
      "txt, csv, rtf, odt/ods, изображения, архивы. Скачать потом — get_customer_file по возвращённому file_id.",
    inputSchema: {
      customer_id: z.number().int().positive(),
      filename: z.string().describe("Имя файла с расширением, напр. «акт-2026.pdf»"),
      content_base64: z.string().describe("Содержимое файла в base64"),
      document_name: z.string().optional().describe("Отображаемое имя в карточке (по умолчанию = filename)"),
      mime: z.string().optional(),
    },
  }, async (a, extra) => {
    const { customer_id, ...body } = a;
    const env = await balanceCall(tokenOf(extra), "POST", `/customers/${customer_id}/files`, body);
    if (!env.ok) return fail(env.error.message);
    return ok(`Файл сохранён контрагенту #${customer_id}: #${env.data?.file_id} ${env.data?.name}`, env.data);
  });

  server.registerTool("upload_customer_file_from_url", {
    title: "Сохранить файл контрагенту по URL",
    description:
      "Скачать файл по ПУБЛИЧНОМУ http(s)-URL на стороне сервера и сохранить в «Файлы контрагента» — " +
      "содержимое НЕ передаётся через модель, поэтому размер не проблема (лимит 25 МБ). " +
      "Используйте вместо upload_customer_file, когда файл доступен по ссылке. " +
      "Внутренние/приватные адреса запрещены. Если файл есть только у пользователя " +
      "(вложение в чате, локальный диск) — создайте ссылку create_customer_upload_link.",
    inputSchema: {
      customer_id: z.number().int().positive(),
      url: z.string().describe("Публичный http(s)-URL файла"),
      filename: z.string().optional()
        .describe("Имя файла с расширением; по умолчанию — из Content-Disposition или URL"),
      document_name: z.string().optional().describe("Отображаемое имя в карточке (по умолчанию = filename)"),
    },
  }, async (a, extra) => {
    let got;
    try {
      got = await fetchExternalFile(a.url);
    } catch (e: any) {
      return fail(`Не удалось скачать файл: ${e?.message || e}`);
    }

    // Имя: аргумент → Content-Disposition → последний сегмент URL → по MIME.
    let name = (a.filename || got.filename || "").trim();
    if (!name) {
      const seg = decodeURIComponent(new URL(got.finalUrl).pathname.split("/").pop() || "");
      if (seg && seg.includes(".")) name = seg;
    }
    if (!name) {
      const ext = MIME_EXT[got.contentType];
      if (ext) name = `файл.${ext}`;
    }
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (!name || !ALLOWED_EXT.includes(ext)) {
      return fail(
        `Не удалось определить допустимое имя файла (получилось «${name || "?"}», Content-Type ${got.contentType}). ` +
        `Передайте filename явно с одним из расширений: ${ALLOWED_EXT.join(", ")}.`
      );
    }

    const env = await balanceCall(tokenOf(extra), "POST", `/customers/${a.customer_id}/files`, {
      filename: name,
      content_base64: got.buffer.toString("base64"),
      document_name: a.document_name,
      mime: got.contentType,
    });
    if (!env.ok) return fail(env.error.message);
    const kb = Math.round(got.buffer.length / 1024);
    return ok(
      `Файл скачан (${kb} КБ) и сохранён контрагенту #${a.customer_id}: #${env.data?.file_id} ${env.data?.name}`,
      { ...env.data, source_url: got.finalUrl, size_bytes: got.buffer.length }
    );
  });

  server.registerTool("create_customer_upload_link", {
    title: "Ссылка загрузки файлов для человека",
    description:
      "Создать ВРЕМЕННУЮ ссылку, по которой человек загрузит файлы в «Файлы контрагента» " +
      "через браузер — байты идут напрямую в balance, минуя модель. Это ЕДИНСТВЕННЫЙ способ " +
      "принять файл, который есть только у пользователя (вложение в чате, файл на его диске): " +
      "протащить содержимое через content_base64 модель физически не может. " +
      "Полученную ссылку отдайте пользователю. По умолчанию действует 72 часа, до 10 файлов.",
    inputSchema: {
      customer_id: z.number().int().positive(),
      ttl_hours: z.number().int().min(1).max(168).optional().describe("Срок жизни в часах, по умолч. 72"),
      max_files: z.number().int().min(1).max(50).optional().describe("Максимум файлов, по умолч. 10"),
    },
  }, async (a, extra) => {
    const { customer_id, ...body } = a;
    const env = await balanceCall(tokenOf(extra), "POST", `/customers/${customer_id}/upload-links`, body);
    if (!env.ok) return fail(env.error.message);
    const base = publicBaseOf(extra);
    const url = base ? base + String(env.data?.path || "") : String(env.data?.path || "");
    return ok(
      `Ссылка загрузки файлов для «${env.data?.customer_name}» (#${customer_id}), ` +
      `действует до ${env.data?.expires_at}, максимум ${env.data?.max_files} файлов — отдайте её пользователю:\n${url}`,
      { ...env.data, url }
    );
  });
}
