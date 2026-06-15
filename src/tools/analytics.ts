import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerAnalyticsTools(server: McpServer) {
  server.registerTool("get_customer_settlement", {
    title: "Взаиморасчёты с контрагентом",
    description:
      "Сальдо и обороты по контрагенту за период: входящее сальдо, поступления от КА (action_id=1), " +
      "реализации/акты (action_id=2), исходящее сальдо, список движений. closing_saldo>0 = переплата " +
      "контрагента (мы должны ему), <0 = долг контрагента нам. Помогает находить странности во " +
      "взаиморасчётах. Считается из реестра документов Balance (не из факта оплаты в 1С).",
    inputSchema: {
      customer_id: z.number().int().positive(),
      from: z.string().optional().describe("YYYY-MM-DD (по умолчанию начало года)"),
      to: z.string().optional().describe("YYYY-MM-DD (по умолчанию сегодня)"),
      org_id: z.number().optional().describe("Наша организация (иначе все)"),
    },
  }, async (a, extra) => {
    const { customer_id, ...q } = a;
    const env = await balanceCall(tokenOf(extra), "GET", `/customers/${customer_id}/settlement` + qs(q));
    if (!env.ok) return fail(env.error.message);
    const d = env.data;
    return ok(
      `Взаиморасчёты с «${d.customer_name}»: сальдо вход ${d.opening_saldo}, поступления ${d.payments_total}, ` +
      `реализации ${d.realizations_total}, сальдо исход ${d.closing_saldo}. ${d.summary}`,
      d
    );
  });

  server.registerTool("find_missing_acts", {
    title: "Забытые акты (конец месяца)",
    description:
      "Находит платежи контрагентов за период, на которые НЕ выставлен закрывающий акт (УПД/реализация). " +
      "Сопоставление: по parent_doc_id, иначе по сумме+дате. Сгруппировано по контрагентам. " +
      "Используйте на конец месяца, чтобы не забыть выставить акты.",
    inputSchema: {
      from: z.string().optional().describe("YYYY-MM-DD (по умолчанию начало текущего месяца)"),
      to: z.string().optional().describe("YYYY-MM-DD (по умолчанию сегодня)"),
      org_id: z.number().optional(),
      customer_id: z.number().optional().describe("Ограничить одним контрагентом"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/reconciliation/missing-acts" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const t = env.data?.totals;
    return ok(
      `Платежей без акта: ${t?.unmatched_count ?? 0} на сумму ${t?.unmatched_sum ?? 0} ` +
      `(контрагентов: ${env.data?.customers?.length ?? 0}).`,
      env.data
    );
  });
}
