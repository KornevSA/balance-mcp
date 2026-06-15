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
}
