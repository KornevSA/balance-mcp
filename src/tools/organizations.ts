import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, ok, fail } from "./util.js";

export function registerOrganizationTools(server: McpServer) {
  server.registerTool("list_organizations", {
    title: "Организации-эмитенты",
    description:
      "Список организаций, от имени которых выставляются документы. Для каждой: org_id, name, ИНН, " +
      "ставка НДС (vat, %) и с какой даты она применяется (vat_from), включена ли выгрузка в 1С. " +
      "Используйте, чтобы выбрать орг-эмитент и знать её ставку НДС перед выставлением счёта/акта.",
    inputSchema: {},
  }, async (_a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/organizations");
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Организаций: ${n}`, env.data);
  });
}
