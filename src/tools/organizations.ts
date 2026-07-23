import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, ok, fail } from "./util.js";

export function registerOrganizationTools(server: McpServer) {
  server.registerTool("list_organizations", {
    title: "Организации-эмитенты (реквизиты)",
    description:
      "Список наших организаций, от имени которых выставляются документы, с ПОЛНЫМИ реквизитами: " +
      "название/полное наименование, ИНН/КПП/ОГРН, юридический и почтовый адреса, подписант " +
      "(official_short/official_func, act_base «действующий на основании…»), телефон/email, " +
      "ставка НДС (vat, %; vat_from — с какой даты), статус 1С и банковские счета banks[] " +
      "(acc_num — р/с, bank_bik, kor_num — к/с, is_default). " +
      "Используйте для подстановки реквизитов в договоры/письма/платёжки и выбора орг-эмитента.",
    inputSchema: {},
  }, async (_a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/organizations");
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Организаций: ${n}`, env.data);
  });

  server.registerTool("get_organization", {
    title: "Организация (одна)",
    description:
      "Полные реквизиты одной организации-эмитента по org_id (те же поля, что в list_organizations, " +
      "включая банковские счета).",
    inputSchema: {
      id: z.number().int().positive().describe("org_id"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/organizations/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Организация #${a.id}: ${env.data?.name ?? ""}`, env.data);
  });

  server.registerTool("list_brands", {
    title: "Бренды платформы",
    description:
      "Справочник whitelabel-брендов (MainSMS, NotiSend, RouterAI и др.): brend_id, название " +
      "(полное и короткое), сайт, email поддержки. Бренд ≠ организация: бренд — витрина сервиса, " +
      "организация — юрлицо-эмитент документов. brend_id используется в договорах, должностях и статьях БЗ.",
    inputSchema: {},
  }, async (_a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/brands");
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Брендов: ${n}`, env.data);
  });
}
