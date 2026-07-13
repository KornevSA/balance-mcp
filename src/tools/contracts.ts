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
}
