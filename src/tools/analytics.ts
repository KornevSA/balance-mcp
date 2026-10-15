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
      "Клиенты, у которых на конец периода аванс, а акта нет: в регулярном для клиента месяце нет реализации " +
      "(акты были в 2 из 3 предыдущих месяцев; текущий месяц проверяется в последние 5 дней) или есть оплата, " +
      "после которой реализаций не было. Реализации — из BALANCE и из 1С (акты, заведённые прямо в 1С, тоже " +
      "считаются; одна и та же реализация — один раз), клиент — ИНН, аванс — сальдо счёта 62 в 1С на конец " +
      "периода. Отдельно — unlinked_counterparties: контрагенты 1С с реализациями в периоде, не связанные с " +
      "клиентом BALANCE (обычно другой КПП), с причиной. Без доступа к 1С (onec.view) — только по документам " +
      "BALANCE, см. warnings. Используйте на конец месяца или квартала. Тяжёлый запрос: читает реализации 1С " +
      "за период и lookback_months до него.",
    inputSchema: {
      from: z.string().optional().describe("YYYY-MM-DD (по умолчанию начало текущего месяца)"),
      to: z.string().optional().describe("YYYY-MM-DD (по умолчанию сегодня)"),
      org_id: z.number().optional().describe("Организация (иначе все, у кого есть документы)"),
      customer_id: z.number().optional().describe("Ограничить одним клиентом (и его ИНН)"),
      lookback_months: z.number().int().min(0).max(12).optional()
        .describe("Сколько месяцев до периода смотреть, чтобы понять, как часто клиенту выставляют акты (по умолчанию 3)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/reconciliation/missing-acts" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const d = env.data ?? {};
    const t = d.totals ?? {};
    const lines = [
      `Клиентов с авансом без акта: ${t.customers ?? 0} на сумму ${t.advance_sum ?? 0} ` +
      `(проверено ${t.checked ?? 0}, без аванса отсеяно ${t.dismissed ?? 0}).`,
      ...(d.customers ?? []).slice(0, 20).map((c: any) => `— ${c.customer_name}: ${c.text}`),
      `Контрагентов 1С без связи с клиентом BALANCE: ${t.unlinked ?? 0}.`,
      ...(d.unlinked_counterparties ?? []).slice(0, 20).map((u: any) => `— ${u.name} (ИНН ${u.inn || "нет"}): ${u.reason}`),
      ...(d.warnings ?? []).map((w: string) => `⚠ ${w}`),
    ];
    return ok(lines.join("\n"), d);
  });
}
