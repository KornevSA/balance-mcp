import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerContractTools(server: McpServer) {
  server.registerTool("list_contracts", {
    title: "Договоры контрагента",
    description:
      "Договоры одного КА: номер, дата, наименование, тип печатной формы (contract_type), " +
      "ставка НДС по договору (vat), орг-эмитент (org_id), статус. Нужно, чтобы сослаться на договор " +
      "в счёте/акте и проверить условия.",
    inputSchema: {
      customer_id: z.number().int().positive().describe("customer_id"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/contracts" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Договоров у КА #${a.customer_id}: ${n}`, env.data);
  });

  server.registerTool("get_contract", {
    title: "Договор",
    description: "Получить один договор по contract_id.",
    inputSchema: {
      id: z.number().int().positive().describe("contract_id"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/contracts/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Договор #${a.id}`, env.data);
  });

  server.registerTool("update_contract", {
    title: "Изменить договор",
    description:
      "Частично изменить договор balance (PATCH): номер, дату, название, статус, комментарий — передавайте только " +
      "изменяемые поля. Организация, тип печатной формы, НДС и строки документов меняются только в карточке клиента. " +
      "Статусы: 0 черновик, 1 на подписании, 2 действует (подписан — включает правила договора: ставку НДС и строку " +
      "документов), 3 исполнен, -1 отклонён. Договор в финальном статусе (-1, 2, 3) правится только сменой статуса: " +
      "сначала верните 0 или 1 отдельным вызовом, потом меняйте поля. Уже созданные в 1С документы остаются на " +
      "прежнем договоре 1С; следующие счета и акты прежний сервис 1С найдёт или заведёт по новым номеру, дате и " +
      "названию — основание счёта печатается как «<название> <номер> от <дата>». Ответ — договор, changes (было → " +
      "стало) и warnings. Правка пишется в журнал.",
    inputSchema: {
      id: z.number().int().positive().describe("contract_id"),
      contract_number: z.string().min(1).max(50).optional().describe("Номер договора"),
      contract_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Дата договора, ГГГГ-ММ-ДД"),
      contract_name: z.string().min(1).max(1000).optional()
        .describe("Название: «Договор», «Лицензионный договор»… (в 1С к нему допишутся номер и дата)"),
      contract_status: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional()
        .describe("-1 отклонён, 0 черновик, 1 на подписании, 2 действует, 3 исполнен"),
      comment: z.string().max(5000).optional().describe("Комментарий (пустая строка — очистить)"),
    },
  }, async (a, extra) => {
    const { id, ...rest } = a;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    if (Object.keys(body).length === 0) return fail("Нечего обновлять: передайте хотя бы одно поле кроме id.");
    const env = await balanceCall(tokenOf(extra), "PATCH", `/contracts/${id}`, body);
    if (!env.ok) {
      const errs = env.error.errors && typeof env.error.errors === "object"
        ? Object.entries(env.error.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      return fail(errs ? `${env.error.message} — ${errs}` : env.error.message);
    }
    const changed = Object.keys(env.data?.changes ?? {});
    const warn = (env.data?.warnings ?? []).length ? " ⚠ см. warnings" : "";
    return ok(changed.length ? `Договор #${id} изменён (${changed.join(", ")})${warn}` : `Договор #${id}: изменений нет`, env.data);
  });
}
