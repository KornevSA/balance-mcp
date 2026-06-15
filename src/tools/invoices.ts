import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, ok, fail } from "./util.js";

export function registerInvoiceTools(server: McpServer) {
  server.registerTool("create_invoice", {
    title: "Выставить счёт",
    description:
      "Создать счёт (счёт на оплату) для существующего контрагента. Укажите либо детальные позиции " +
      "lines[], либо общую сумму amount. Цены — С НДС (НДС выделяется автоматически по ставке " +
      "организации-эмитента). Всегда передавайте стабильный external_id, чтобы повтор не создал дубль. " +
      "Возвращает doc_id; PDF забирайте отдельным get_document_pdf.",
    inputSchema: {
      customer_id: z.number().int().positive().describe("ID существующего контрагента"),
      lines: z.array(z.object({
        name: z.string(),
        quantity: z.number().positive(),
        price: z.number().positive().describe("Цена за единицу, С НДС"),
      })).optional().describe("Позиции (приоритетно). total = Σ price*quantity"),
      amount: z.number().positive().optional().describe("Итоговая сумма С НДС, если без детализации"),
      description: z.string().optional().describe("Наименование строки при использовании amount"),
      org_id: z.number().int().positive().optional().describe("Организация-эмитент (иначе авто)"),
      date: z.string().optional().describe("Дата счёта (по умолчанию сейчас)"),
      comment: z.string().optional(),
      external_id: z.string().optional().describe("Ключ идемпотентности (ID в вашей системе)"),
    },
  }, async (a, extra) => {
    if (!a.lines && !a.amount) return fail("Передайте lines[] или amount.");
    const env = await balanceCall(tokenOf(extra), "POST", "/invoices", a);
    if (!env.ok) return fail(`Не удалось создать счёт: ${env.error.message}`);
    const d = env.data;
    return ok(
      `${d.existing ? "Счёт уже существовал" : "Счёт создан"}: doc_id=${d.doc_id}, № ${d.number}, ` +
      `сумма ${d.total} (НДС ${d.vat_total}). Для PDF вызовите get_document_pdf с doc_id=${d.doc_id}.`,
      d
    );
  });
}
