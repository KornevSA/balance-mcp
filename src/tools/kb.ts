import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail, confirmToken, verifyConfirmToken } from "./util.js";

// Изменяемые поля статьи (общие для create/update). Токен подтверждения и id/confirm
// в него не входят. Порядок значения не имеет — токен канонизирует ключи.
const KB_WRITABLE = ["title", "content", "category", "status", "export_to_agents"] as const;
function pickKbFields(a: any): Record<string, any> {
  const f: Record<string, any> = {};
  for (const k of KB_WRITABLE) if (a[k] !== undefined) f[k] = a[k];
  return f;
}

// HTML → читаемый текст для превью (те же блочные теги, что и format=text на бэке).
function kbTextPreview(html: any, max = 500): string {
  const t = String(html ?? "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Человекочитаемый дифф «было→стало» для update.
function kbUpdatePreview(cur: any, fields: Record<string, any>): string {
  const lines: string[] = [];
  const cmp = (label: string, oldV: any, newV: any) => {
    const o = String(oldV ?? ""), n = String(newV ?? "");
    lines.push(o === n ? `• ${label}: (без изменений) ${o}` : `• ${label}: «${o}» → «${n}»`);
  };
  if ("title" in fields) cmp("Заголовок", cur?.title, fields.title);
  if ("category" in fields) cmp("Категория", cur?.category, fields.category);
  if ("status" in fields) cmp("Статус", cur?.status, fields.status + " (публикация/смена статуса применится только у супер-админа)");
  if ("export_to_agents" in fields) cmp("Доступно агентам", cur?.export_to_agents, fields.export_to_agents);
  if ("content" in fields) {
    lines.push(
      `• Содержимое: ~${String(cur?.content ?? "").length}→${String(fields.content).length} симв. Новый текст (превью):\n` +
      kbTextPreview(fields.content),
    );
  }
  return lines.join("\n");
}

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

  // ======================= ЗАПИСЬ (двухшаговое подтверждение) =======================
  // Все три тулза требуют scope kb:write + право job_descriptions.edit. Бэкенд вдобавок
  // пускает ТОЛЬКО пользовательский OAuth-принципал (коннектор) — сервисному ключу
  // agentpool запись в БЗ запрещена. Явное подтверждение: без confirm — превью+токен,
  // без записи; правка/создание/удаление применяются лишь повторным вызовом с confirm.

  server.registerTool("update_kb_article", {
    title: "База знаний: изменить статью (с подтверждением)",
    description:
      "Изменить существующую статью БЗ. ДВУХШАГОВО: вызовите СНАЧАЛА без confirm — вернётся превью " +
      "«было→стало» и токен confirm, НИЧЕГО не сохранится. Затем повторите вызов С ТЕМИ ЖЕ полями и " +
      "confirm=<токен> — только тогда правка применяется (идёт в прод и зеркалится в KB агентов). " +
      "Токен привязан к точному изменению и живёт 15 минут. Публикация/смена status — только у " +
      "супер-админа. Требует scope kb:write и право job_descriptions.edit.",
    inputSchema: {
      id: z.number().int().positive().describe("id статьи (см. list_kb_articles)"),
      title: z.string().min(1).optional().describe("Новый заголовок"),
      content: z.string().optional().describe("Новое содержимое (HTML; санитизируется на сервере)"),
      category: z.string().optional().describe("Категория (точное имя)"),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Статус (публикация — только супер-админ)"),
      export_to_agents: z.boolean().optional().describe("Доступно ИИ-агентам (экспорт в agentpool)"),
      confirm: z.string().optional().describe("Токен подтверждения из превью-вызова. БЕЗ него правка НЕ применяется"),
    },
    annotations: { title: "Изменить статью БЗ", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (a, extra) => {
    const token = tokenOf(extra);
    const id = a.id;
    const fields = pickKbFields(a);
    if (Object.keys(fields).length === 0)
      return fail("Укажите хотя бы одно изменяемое поле: title, content, category, status или export_to_agents.");

    if (!a.confirm) {
      const cur = await balanceCall(token, "GET", `/kb/articles/${id}` + qs({ format: "text" }));
      if (!cur.ok) return fail(cur.error.message);
      const ct = confirmToken("update", id, fields);
      return ok(
        `Проверьте изменения статьи #${id} и подтвердите:\n${kbUpdatePreview(cur.data, fields)}\n\n` +
        `Ничего не сохранено. Чтобы применить — повторите update_kb_article с ТЕМИ ЖЕ полями и confirm="${ct}".`,
        { requires_confirmation: true, confirm_token: ct, article_id: id, changes: fields },
      );
    }
    const v = verifyConfirmToken(a.confirm, "update", id, fields);
    if (!v.ok)
      return fail(`Токен подтверждения ${v.reason}. Вызовите update_kb_article без confirm, чтобы получить свежее превью и токен.`);
    const env = await balanceCall(token, "PATCH", `/kb/articles/${id}`, fields);
    if (!env.ok) return fail(env.error.message);
    return ok(`Статья #${id} обновлена (${Object.keys(fields).join(", ")}). Статус: ${env.data?.status ?? "?"}.`, env.data);
  });

  server.registerTool("create_kb_article", {
    title: "База знаний: создать статью (с подтверждением)",
    description:
      "Создать новую статью БЗ. ДВУХШАГОВО: сначала без confirm — вернётся превью и токен, ничего не " +
      "создаётся; затем повтор С ТЕМИ ЖЕ полями и confirm=<токен>. Новая статья по умолчанию в статусе " +
      "draft (публикует супер-админ). Требует scope kb:write и право job_descriptions.edit.",
    inputSchema: {
      title: z.string().min(1).describe("Заголовок (обязательно)"),
      content: z.string().optional().describe("Содержимое (HTML; санитизируется на сервере)"),
      category: z.string().optional().describe("Категория (по умолчанию «Должностные инструкции»)"),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Статус (публикация — только супер-админ; по умолчанию draft)"),
      export_to_agents: z.boolean().optional().describe("Доступно ИИ-агентам"),
      confirm: z.string().optional().describe("Токен подтверждения из превью-вызова"),
    },
    annotations: { title: "Создать статью БЗ", readOnlyHint: false, destructiveHint: false },
  }, async (a, extra) => {
    const token = tokenOf(extra);
    const fields = pickKbFields(a);

    if (!a.confirm) {
      const ct = confirmToken("create", 0, fields);
      return ok(
        `Будет создана новая статья БЗ:\n` +
        `• Заголовок: ${fields.title}\n` +
        `• Категория: ${fields.category ?? "Должностные инструкции"}\n` +
        `• Статус: ${fields.status ?? "draft"} (публикация — только супер-админ)\n` +
        ("content" in fields ? `• Содержимое (превью):\n${kbTextPreview(fields.content)}\n` : "") +
        `\nНичего не создано. Чтобы создать — повторите create_kb_article с ТЕМИ ЖЕ полями и confirm="${ct}".`,
        { requires_confirmation: true, confirm_token: ct, changes: fields },
      );
    }
    const v = verifyConfirmToken(a.confirm, "create", 0, fields);
    if (!v.ok)
      return fail(`Токен подтверждения ${v.reason}. Вызовите create_kb_article без confirm, чтобы получить свежий токен.`);
    const env = await balanceCall(token, "POST", "/kb/articles", fields);
    if (!env.ok) return fail(env.error.message);
    return ok(`Статья создана: #${env.data?.id} — ${env.data?.title ?? fields.title} (${env.data?.status ?? "draft"}).`, env.data);
  });

  server.registerTool("delete_kb_article", {
    title: "База знаний: удалить статью (с подтверждением)",
    description:
      "Мягко удалить (в архив) статью БЗ. ДВУХШАГОВО: сначала без confirm — вернётся, что будет удалено, " +
      "и токен; затем повтор с confirm=<токен>. Статья скрывается из списка и из KB агентов, но остаётся " +
      "в БД (is_active=0, восстановимо через веб). Требует scope kb:write и право job_descriptions.edit.",
    inputSchema: {
      id: z.number().int().positive().describe("id статьи"),
      confirm: z.string().optional().describe("Токен подтверждения из превью-вызова"),
    },
    annotations: { title: "Удалить статью БЗ", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (a, extra) => {
    const token = tokenOf(extra);
    const id = a.id;

    if (!a.confirm) {
      const cur = await balanceCall(token, "GET", `/kb/articles/${id}` + qs({ format: "text" }));
      if (!cur.ok) return fail(cur.error.message);
      const ct = confirmToken("delete", id, {});
      return ok(
        `Будет удалена в архив статья #${id}: «${cur.data?.title ?? ""}» [${cur.data?.category ?? ""}], статус ${cur.data?.status ?? ""}.\n` +
        `Ничего не удалено. Чтобы удалить — повторите delete_kb_article с confirm="${ct}".`,
        { requires_confirmation: true, confirm_token: ct, article_id: id },
      );
    }
    const v = verifyConfirmToken(a.confirm, "delete", id, {});
    if (!v.ok)
      return fail(`Токен подтверждения ${v.reason}. Вызовите delete_kb_article без confirm, чтобы получить свежий токен.`);
    const env = await balanceCall(token, "DELETE", `/kb/articles/${id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Статья #${id} удалена в архив.`, env.data);
  });
}
