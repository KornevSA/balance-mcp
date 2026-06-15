import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { deliverFile } from "../fileTransfer.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerDocumentTools(server: McpServer) {
  server.registerTool("list_customer_documents", {
    title: "Документы контрагента",
    description: "Список документов одного контрагента за период с фильтрами. Только метаданные.",
    inputSchema: {
      customer_id: z.number().int().positive(),
      type_id: z.number().optional().describe("3=Счёт, 5=УПД/Акт, 12=Акт сверки"),
      from: z.string().optional().describe("YYYY-MM-DD"),
      to: z.string().optional().describe("YYYY-MM-DD"),
      signed: z.number().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
  }, async (a, extra) => {
    const { customer_id, ...q } = a;
    const env = await balanceCall(tokenOf(extra), "GET", `/customers/${customer_id}/documents` + qs(q));
    if (!env.ok) return fail(env.error.message);
    return ok(`Документов: ${env.data?.pagination?.total ?? env.data?.items?.length ?? 0}`, env.data);
  });

  server.registerTool("get_document", {
    title: "Метаданные документа",
    description: "Получить метаданные документа по doc_id (+ инфо из 1С, если есть).",
    inputSchema: { doc_id: z.number().int().positive() },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/documents/${a.doc_id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Документ #${a.doc_id}`, env.data);
  });

  server.registerTool("get_document_pdf", {
    title: "PDF документа",
    description: "Скачать PDF документа (счёт/акт и т.п.) по doc_id. Небольшие файлы вкладываются инлайном.",
    inputSchema: { doc_id: z.number().int().positive() },
  }, async (a, extra) => {
    return await deliverFile(tokenOf(extra), `/documents/${a.doc_id}/file`, `Документ ${a.doc_id}.pdf`);
  });

  server.registerTool("search_documents", {
    title: "Поиск документов (кросс-КА, период)",
    description:
      "Поиск документов по ВСЕМ контрагентам за период с фильтрами по типу/статусу/организации/контрагенту " +
      "и текстом (q: ИНН/имя/номер). action_id: 1=наши счета/реализации, 2=платежи. Пагинация limit/offset. " +
      "all=true — выгрузить все страницы (с предохранителем). Только метаданные.",
    inputSchema: {
      from: z.string().optional(), to: z.string().optional(),
      type_ids: z.array(z.number()).optional().describe("Напр. [3] счета, [5] акты"),
      status: z.array(z.number()).optional(),
      org_id: z.array(z.number()).optional(),
      customer_id: z.number().optional(),
      action_id: z.number().optional(),
      q: z.string().optional(),
      limit: z.number().optional(), offset: z.number().optional(),
      all: z.boolean().optional().describe("Выгрузить все страницы"),
    },
  }, async (a, extra) => {
    const token = tokenOf(extra);
    if (a.all) {
      const limit = 500; let offset = 0; let items: any[] = []; let total = 0; let guard = 0;
      do {
        const env = await balanceCall(token, "GET", "/documents" + qs({ ...a, all: undefined, limit, offset }));
        if (!env.ok) return fail(env.error.message);
        items = items.concat(env.data?.items || []);
        total = env.data?.pagination?.total ?? items.length;
        offset += limit; guard++;
      } while (items.length < total && guard < 20);   // потолок ~10000
      const truncated = items.length < total;
      return ok(`Документов: ${items.length}${truncated ? ` (усечено из ${total} — сузьте период/фильтры)` : ""}`,
        { items, total, truncated });
    }
    const env = await balanceCall(token, "GET", "/documents" + qs(a));
    if (!env.ok) return fail(env.error.message);
    return ok(`Документов на странице: ${env.data?.items?.length ?? 0} из ${env.data?.pagination?.total ?? 0}`, env.data);
  });

  server.registerTool("documents_summary", {
    title: "Сводка по документам за период",
    description:
      "Агрегаты SUM/COUNT по типам документов за период (+ дебет action1 / кредит action2 / net). " +
      "Помогает заметить странности (например, только дебет без кредита).",
    inputSchema: {
      from: z.string().optional(), to: z.string().optional(),
      type_ids: z.array(z.number()).optional(),
      org_id: z.array(z.number()).optional(),
      customer_id: z.number().optional(),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/documents/summary" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const t = env.data?.totals;
    return ok(`Документов: ${t?.count ?? 0}, поступления ${t?.payments_action1 ?? 0}, реализации ${t?.realizations_action2 ?? 0}, net ${t?.net ?? 0}`, env.data);
  });
}
