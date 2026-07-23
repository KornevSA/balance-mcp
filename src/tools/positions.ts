import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, ok, fail } from "./util.js";

export function registerPositionTools(server: McpServer) {
  server.registerTool("list_positions", {
    title: "Должности (оргструктура)",
    description:
      "Все должности компании (должность = роль): кто на ней работает (members), какие бренды " +
      "покрывает (brend_ids), рабочие места-ссылки «куда идти» (links), статьи БЗ должности " +
      "(articles, с флагом required — обязательна к прочтению) и эскалации/подчинение " +
      "(escalations: kind=supervisor|escalation, цель — другая роль или внешний код вида " +
      "agentpool:developer). Плюс справочник brands. Используйте, чтобы понять «кто за что отвечает» " +
      "и куда эскалировать вопрос.",
    inputSchema: {},
  }, async (_a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/positions");
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Должностей: ${n}`, env.data);
  });

  server.registerTool("get_position", {
    title: "Должность (одна)",
    description:
      "Полная карточка одной должности по числовому role_id или строковому slug " +
      "(например support_manager, moderator).",
    inputSchema: {
      id: z.union([z.number().int().positive(), z.string().min(1)]).describe("role_id или slug"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/positions/${encodeURIComponent(String(a.id))}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Должность: ${env.data?.name ?? a.id}`, env.data);
  });
}
