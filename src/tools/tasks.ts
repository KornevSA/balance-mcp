import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

// Поля пункта чеклиста — общие для create_task.items[] и add_task_item.
const itemFields = {
  label: z.string().min(1).describe("Название пункта (обязательно)"),
  instruction: z.string().optional().describe("Стоячая инструкция «что сделать/отправить»"),
  customer_id: z.number().int().positive().optional().describe("Привязка к контрагенту (customer_id)"),
  customer_inn: z.string().optional().describe("ИНН, если КА ещё не заведён"),
  kind: z.enum(["doc", "task"]).optional().describe("doc — документ к отправке (по умолч.), task — дело"),
  link_url: z.string().optional().describe("Ссылка для пункта-дела"),
  optional: z.boolean().optional().describe("Необязательный пункт (не блокирует автозавершение)"),
};

export function registerTaskTools(server: McpServer) {
  server.registerTool("list_tasks", {
    title: "Задачи по контрагентам: список",
    description:
      "Задачи раздела «Задачи» balance: одноразовые и экземпляры-периоды цикличных серий, с прогрессом " +
      "чеклистов (items_done/items_total). include_templates=true добавляет ШАБЛОНЫ серий (по ним " +
      "управляют повтором: cyclicity, active). customer_id находит и задачи, где КА фигурирует " +
      "пунктом чеклиста.",
    inputSchema: {
      status: z.enum(["open", "done", "all"]).optional().describe("open (по умолч.) | done | all"),
      assignee_id: z.number().int().positive().optional().describe("Только задачи этого ответственного"),
      customer_id: z.number().int().positive().optional().describe("Задачи контрагента (вкл. пункты чеклистов)"),
      q: z.string().optional().describe("Поиск по названию задачи и пунктам"),
      include_templates: z.boolean().optional().describe("Включить шаблоны цикличных серий"),
      limit: z.number().int().positive().max(300).optional().describe("Максимум записей (по умолч. 100)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/tasks" + qs({
      ...a,
      include_templates: a.include_templates ? 1 : undefined,
    }));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Задач: ${n}`, env.data);
  });

  server.registerTool("get_task", {
    title: "Задача: детально",
    description:
      "Одна задача: карточка (task), информация о серии-повторе (series), пункты чеклиста (items — " +
      "с id для отметки через update_task_item) и прогресс (progress.remaining — сколько обязательных " +
      "пунктов осталось).",
    inputSchema: {
      id: z.number().int().positive().describe("id задачи"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/tasks/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    const p = env.data?.progress;
    return ok(`Задача #${a.id}: ${env.data?.task?.title ?? ""} (${p?.done ?? 0}/${p?.total ?? 0})`, env.data);
  });

  server.registerTool("create_task", {
    title: "Создать задачу",
    description:
      "Создать задачу или цикличный шаблон. cyclicity ≠ none превращает задачу в ШАБЛОН серии: " +
      "экземпляры-периоды создаются автоматически (текущий — сразу), deadline у шаблона игнорируется " +
      "(считается по due_day). items[] — сразу заполнить чеклист (пункты с привязкой к КА). " +
      "Требует право tasks.manage.",
    inputSchema: {
      title: z.string().min(1).describe("Название задачи (обязательно)"),
      description: z.string().optional().describe("Описание"),
      kind: z.enum(["task", "checklist"]).optional().describe("task (по умолч.) | checklist"),
      priority: z.enum(["low", "medium", "high"]).optional().describe("Приоритет (по умолч. medium)"),
      cyclicity: z.enum(["none", "daily", "weekly", "monthly", "quarterly", "yearly"]).optional()
        .describe("Повтор; ≠ none → создаётся шаблон серии"),
      assignee_id: z.number().int().positive().optional().describe("Ответственный (user_id) — получит уведомление"),
      customer_id: z.number().int().positive().optional().describe("Привязка задачи целиком к КА"),
      due_day: z.number().int().min(1).max(31).optional().describe("Для monthly: день месяца-дедлайн следующего месяца"),
      deadline: z.string().optional().describe("Дедлайн разовой задачи: YYYY-MM-DD [HH:MM]"),
      items: z.array(z.object(itemFields)).optional().describe("Пункты чеклиста (батч)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "POST", "/tasks", a);
    if (!env.ok) return fail(env.error.message);
    const d = env.data ?? {};
    return ok(
      `Создана ${d.is_template ? "цикличная серия (шаблон)" : "задача"} #${d.id}` +
      (d.items_added ? `, пунктов: ${d.items_added}` : ""),
      env.data,
    );
  });

  server.registerTool("update_task", {
    title: "Изменить задачу",
    description:
      "Частичное обновление задачи: передавайте только изменяемые поля. Для обычной задачи доступен " +
      "status (created/pending/in_progress/on_hold/completed). Для ШАБЛОНА серии: active=false — " +
      "пауза повтора, active=true — возобновление; смена cyclicity пересчитывает расписание; смена " +
      "assignee_id переносит и открытые периоды. Требует право tasks.manage.",
    inputSchema: {
      id: z.number().int().positive().describe("id задачи или шаблона"),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      kind: z.enum(["task", "checklist"]).optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      cyclicity: z.enum(["none", "daily", "weekly", "monthly", "quarterly", "yearly"]).optional(),
      assignee_id: z.number().int().min(0).optional().describe("Ответственный; 0 — снять"),
      customer_id: z.number().int().min(0).optional().describe("Контрагент; 0 — отвязать"),
      due_day: z.number().int().min(0).max(31).optional(),
      deadline: z.string().optional().describe("YYYY-MM-DD [HH:MM]; пустая строка — снять"),
      status: z.enum(["created", "pending", "in_progress", "on_hold", "completed"]).optional()
        .describe("Только для обычной задачи/экземпляра"),
      active: z.boolean().optional().describe("Только для шаблона серии: пауза/возобновление повтора"),
    },
  }, async (a, extra) => {
    const { id, ...body } = a;
    const env = await balanceCall(tokenOf(extra), "PATCH", `/tasks/${id}`, body);
    if (!env.ok) return fail(env.error.message);
    return ok(`Задача #${id} обновлена`, env.data);
  });

  server.registerTool("delete_task", {
    title: "Удалить задачу",
    description:
      "Мягко удалить задачу. Для шаблона серии with_instances=true удаляет и ОТКРЫТЫЕ периоды " +
      "(завершённые остаются историей). Требует право tasks.manage.",
    inputSchema: {
      id: z.number().int().positive().describe("id задачи или шаблона"),
      with_instances: z.boolean().optional().describe("Для шаблона: удалить и открытые периоды серии"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "DELETE",
      `/tasks/${a.id}` + qs({ with_instances: a.with_instances ? 1 : undefined }));
    if (!env.ok) return fail(env.error.message);
    const closed = env.data?.deleted_instances ?? 0;
    return ok(`Задача #${a.id} удалена` + (closed ? ` (+${closed} откр. периодов серии)` : ""), env.data);
  });

  server.registerTool("add_task_item", {
    title: "Добавить пункт чеклиста",
    description:
      "Добавить пункт в чеклист существующей задачи (или в шаблон серии — тогда пункт попадёт в " +
      "будущие периоды). Требует право tasks.manage.",
    inputSchema: {
      task_id: z.number().int().positive().describe("id задачи"),
      ...itemFields,
    },
  }, async (a, extra) => {
    const { task_id, ...body } = a;
    const env = await balanceCall(tokenOf(extra), "POST", `/tasks/${task_id}/items`, body);
    if (!env.ok) return fail(env.error.message);
    return ok(`Пункт #${env.data?.id} добавлен в задачу #${task_id}`, env.data);
  });

  server.registerTool("update_task_item", {
    title: "Отметить/изменить пункт чеклиста",
    description:
      "Отметка выполнения: done=true/false (+ channel: edo/telegram/email/other, period_comment) — " +
      "достаточно права tasks.check; отметка всех обязательных пунктов автозавершает задачу " +
      "(в ответе task_status). Структурная правка (label, instruction, optional, customer_id, " +
      "customer_inn, link_url) требует tasks.manage.",
    inputSchema: {
      id: z.number().int().positive().describe("id пункта (items[].id из get_task)"),
      done: z.boolean().optional().describe("Отметить (true) / снять отметку (false)"),
      channel: z.enum(["edo", "telegram", "email", "other"]).optional().describe("Канал отправки"),
      period_comment: z.string().optional().describe("Комментарий за период"),
      label: z.string().min(1).optional().describe("[manage] Название пункта"),
      instruction: z.string().optional().describe("[manage] Стоячая инструкция"),
      optional: z.boolean().optional().describe("[manage] Необязательный пункт"),
      customer_id: z.number().int().min(0).optional().describe("[manage] Контрагент; 0 — отвязать"),
      customer_inn: z.string().optional().describe("[manage] ИНН"),
      link_url: z.string().optional().describe("[manage] Ссылка"),
    },
  }, async (a, extra) => {
    const { id, ...body } = a;
    const env = await balanceCall(tokenOf(extra), "PATCH", `/task-items/${id}`, body);
    if (!env.ok) return fail(env.error.message);
    const d = env.data ?? {};
    return ok(
      `Пункт #${id}: ${d.items_done ?? "?"}/${d.items_total ?? "?"}, задача — ${d.task_status ?? "?"}`,
      env.data,
    );
  });

  server.registerTool("delete_task_item", {
    title: "Удалить пункт чеклиста",
    description: "Мягко удалить пункт чеклиста (статус задачи пересчитается). Требует право tasks.manage.",
    inputSchema: {
      id: z.number().int().positive().describe("id пункта"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "DELETE", `/task-items/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Пункт #${a.id} удалён`, env.data);
  });
}
