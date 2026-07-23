import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerKbTools(server: McpServer) {
  server.registerTool("list_kb_articles", {
    title: "База знаний: список статей",
    description:
      "Статьи базы знаний / должностных инструкций balance — БЕЗ тела (id, title, category, status, " +
      "привязки к должностям и брендам). Отдаются ВСЕ статусы: draft (черновик), published, archived. " +
      "Тело статьи — отдельным вызовом get_kb_article. Фильтры: status, category (точное имя), " +
      "q (поиск по заголовку и тексту), role_id (статьи должности), brend_id.",
    inputSchema: {
      status: z.enum(["draft", "published", "archived"]).optional().describe("Фильтр по статусу"),
      category: z.string().optional().describe("Категория (точное имя, см. list_kb_categories)"),
      q: z.string().optional().describe("Поиск по заголовку и содержимому"),
      role_id: z.number().int().positive().optional().describe("Только статьи этой должности (role_id)"),
      brend_id: z.number().int().positive().optional().describe("Только статьи этого бренда"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/kb/articles" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Статей: ${n}`, env.data);
  });

  server.registerTool("get_kb_article", {
    title: "База знаний: статья целиком",
    description:
      "Одна статья БЗ с полным содержимым. format=text (по умолчанию) — плоский текст без HTML, " +
      "удобен для чтения; format=html — исходная разметка (для правок/цитирования вёрстки).",
    inputSchema: {
      id: z.number().int().positive().describe("id статьи"),
      format: z.enum(["html", "text"]).optional().describe("Формат содержимого (по умолчанию html)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/kb/articles/${a.id}` + qs({ format: a.format }));
    if (!env.ok) return fail(env.error.message);
    return ok(`Статья #${a.id}: ${env.data?.title ?? ""}`, env.data);
  });

  server.registerTool("list_kb_categories", {
    title: "База знаний: категории",
    description: "Категории базы знаний с количеством статей в каждой.",
    inputSchema: {},
  }, async (_a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/kb/categories");
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Категорий: ${n}`, env.data);
  });
}
