import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { deliverFile } from "../fileTransfer.js";
import { tokenOf, qs, ok, fail } from "./util.js";

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
}
