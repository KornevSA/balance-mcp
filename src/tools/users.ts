import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerUserTools(server: McpServer) {
  server.registerTool("list_users", {
    title: "Сотрудники (операторы)",
    description:
      "Наши сотрудники-операторы balance (НЕ клиенты — для клиентов есть search_customers): " +
      "имя, логин, email, статус (is_active: работает/уволен), онлайн-индикатор (is_online — " +
      "активность < 5 мин, last_seen), последний вход, роли-должности (roles, с флагом " +
      "is_superadmin) и дилер-группы (groups — чьи данные видит; пусто = все). " +
      "Используйте, чтобы узнать «кто у нас работает», кто сейчас в сети, у кого какая роль " +
      "и кому назначать задачи (user_id → assignee_id в create_task).",
    inputSchema: {
      status: z.enum(["active", "fired", "all"]).optional().describe("Фильтр: работающие | уволенные | все (по умолч. все)"),
      q: z.string().optional().describe("Поиск по имени, логину, email"),
      role_id: z.number().int().positive().optional().describe("Только сотрудники с этой ролью-должностью"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/users" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Сотрудников: ${n}`, env.data);
  });

  server.registerTool("get_user", {
    title: "Сотрудник (один)",
    description:
      "Один сотрудник-оператор по user_id: учётка, статус, онлайн, роли-должности, дилер-группы.",
    inputSchema: {
      id: z.number().int().positive().describe("user_id сотрудника"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/users/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Сотрудник #${a.id}: ${env.data?.name ?? ""}`, env.data);
  });
}
