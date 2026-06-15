import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { deliverFile } from "../fileTransfer.js";
import { tokenOf, ok, fail } from "./util.js";

export function registerMyFileTools(server: McpServer) {
  server.registerTool("list_my_files", {
    title: "Мои файлы",
    description: "Список ваших личных файлов («Мои файлы») в Balance. Только метаданные.",
    inputSchema: {},
  }, async (_a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/me/files");
    if (!env.ok) return fail(env.error.message);
    return ok(`Личных файлов: ${env.data?.items?.length ?? 0}`, env.data);
  });

  server.registerTool("get_my_file", {
    title: "Скачать мой файл",
    description: "Скачать ваш личный файл по id (из list_my_files). Небольшие — инлайном.",
    inputSchema: { id: z.number().int().positive() },
  }, async (a, extra) => {
    return await deliverFile(tokenOf(extra), `/me/files/${a.id}/content`, `my_file_${a.id}`);
  });

  server.registerTool("upload_my_file", {
    title: "Загрузить мой файл",
    description:
      "Загрузить файл в ваши «Мои файлы». Передайте имя файла и его содержимое в base64. " +
      "Допустимые типы: pdf, doc(x), xls(x), ppt(x), txt, csv, rtf, odt/ods, изображения, архивы.",
    inputSchema: {
      filename: z.string().describe("Имя файла с расширением, напр. «отчёт.pdf»"),
      content_base64: z.string().describe("Содержимое файла в base64"),
      mime: z.string().optional(),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "POST", "/me/files", a);
    if (!env.ok) return fail(env.error.message);
    return ok(`Загружен файл #${env.data?.id}: ${env.data?.display_name}`, env.data);
  });
}
