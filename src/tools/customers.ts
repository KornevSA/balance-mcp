import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerCustomerTools(server: McpServer) {
  server.registerTool("search_customers", {
    title: "Поиск контрагентов",
    description: "Найти контрагентов (КА) по ИНН, имени, email или remote_id. Возвращает список с customer_id.",
    inputSchema: {
      inn: z.string().optional().describe("ИНН"),
      name: z.string().optional(),
      email: z.string().optional(),
      remote_id: z.string().optional().describe("Внешний ID кабинета дилера"),
      group_id: z.number().optional().describe("ID дилера (для remote_id)"),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/customers" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Найдено контрагентов: ${n}`, env.data);
  });

  server.registerTool("get_customer", {
    title: "Карточка контрагента",
    description: "Получить контрагента по его customer_id.",
    inputSchema: { id: z.number().int().positive().describe("customer_id") },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/customers/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Контрагент #${a.id}`, env.data);
  });

  server.registerTool("find_or_create_customer", {
    title: "Найти или создать контрагента",
    description:
      "Идемпотентно по ИНН: если КА с таким ИНН есть — вернёт его (existing=true), иначе создаст. " +
      "Для привязки к кабинету дилера передайте remote_id вместе с customer_group_id.",
    inputSchema: {
      name: z.string().describe("Название КА"),
      inn: z.string().optional().describe("ИНН (ключ идемпотентности)"),
      email: z.string().optional(),
      remote_id: z.string().optional(),
      customer_group_id: z.number().optional(),
    },
  }, async (a, extra) => {
    const token = tokenOf(extra);
    if (a.inn) {
      const found = await balanceCall(token, "GET", "/customers" + qs({ inn: a.inn }));
      if (found.ok && found.data?.items?.length) {
        return ok(`Контрагент уже существует: #${found.data.items[0].customer_id}`, { ...found.data.items[0], existing: true });
      }
    }
    const body: any = { name: a.name };
    if (a.inn) body.inn = a.inn;
    if (a.email) body.email = a.email;
    if (a.remote_id) body.remote_id = a.remote_id;
    if (a.customer_group_id) body.customer_group_id = a.customer_group_id;
    const created = await balanceCall(token, "POST", "/customers", body);
    if (!created.ok) return fail(created.error.message);
    return ok(`Контрагент создан: #${created.data?.customer_id}`, created.data);
  });
}
