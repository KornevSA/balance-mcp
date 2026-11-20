// Связки контрагента с кабинетами дилеров и слияние дублей (balance /customers/{id}/links, /merge).
//
// Кабинет — пара (дилер, remote_id): MainSMS (1), NotiSend (7), RouterAI (9). Один кабинет бывает
// у нескольких карточек (автокарточка кассы «Пользователь RouterAi (id N)» и карточка организации),
// у кабинета один получатель платежей — на него касса зачисляет оплаты картой и СБП.
// Шрам 20.11.2026: кабинет RouterAI 79032 остался у пустой автокарточки получателем, а карточку ИП
// с ИНН к нему привязывали руками — инструментов не было.
//
// balance пускает сюда только пользователя OAuth с customer.edit и в его зоне (сервисный ключ — 403
// user_only). Слияние — два шага: план и токен, затем тот же вызов с confirm.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, ok, fail, confirmToken, verifyConfirmToken } from "./util.js";

/** Текст ошибки balance с ошибками полей. */
function errText(e: { message: string; errors?: Record<string, unknown> }): string {
  const errs = e.errors && typeof e.errors === "object"
    ? Object.entries(e.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
  return errs ? `${e.message} — ${errs}` : e.message;
}

const warnSuffix = (d: any) => ((d?.warnings ?? []).length ? `\n⚠ ${(d.warnings as string[]).join("\n⚠ ")}` : "");

const MERGE_OP = "merge_customers";

export function registerCustomerLinkTools(server: McpServer) {
  server.registerTool("list_customer_links", {
    title: "Кабинеты контрагента",
    description:
      "Связки карточки с кабинетами дилеров (MainSMS 1, NotiSend 7, RouterAI 9): link_id, customer_group_id, remoteid, " +
      "is_primary (основная связка у дилера — по ней ссылка в ЛК), is_payment_recipient (на эту карточку касса зачисляет " +
      "оплаты из кабинета картой и СБП), shared_with — другие карточки того же кабинета (имя, ИНН, кто получатель), " +
      "payment_recipient_customer_id — получатель кабинета (0 — вне вашей зоны). Найти карточки по кабинету — " +
      "search_customers(remote_id, group_id).",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { customer_id: z.number().int().positive().describe("customer_id") },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/customers/${a.customer_id}/links`);
    if (!env.ok) return fail(errText(env.error));
    return ok(`Связок с кабинетами у КА #${a.customer_id}: ${env.data?.total ?? 0}`, env.data);
  });

  server.registerTool("link_customer_to_cabinet", {
    title: "Привязать контрагента к кабинету",
    description:
      "Привязать СУЩЕСТВУЮЩУЮ карточку к кабинету дилера (customer_group_id + remote_id) — например, карточку с ИНН, " +
      "заведённую отдельно от автокарточки кабинета. Уже привязана — меняются только переданные признаки. " +
      "is_payment_recipient=true — оплаты из кабинета через кассу (карта, СБП) пойдут на эту карточку, у прежнего " +
      "получателя признак снимется; без него получателем станет, только если у кабинета его нет. is_primary=true — " +
      "основная связка у этого дилера (ссылка в ЛК, customer.remoteid). Прежде чем переносить получателя с автокарточки " +
      "физлица («Пользователь … (id N)», без ИНН) на организацию, уточните у человека: касса пробивает чеки физлицу, " +
      "организация обычно платит по счетам — balance предупредит об этом в warnings. Связку без привязки к ИНН " +
      "проверяйте: кабинет открывает карточке документы и сальдо. Только сотрудник с правом правки клиентов.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      customer_id: z.number().int().positive().describe("Карточка, которую привязываем"),
      customer_group_id: z.number().int().positive().describe("Дилер кабинета: 1 MainSMS, 7 NotiSend, 9 RouterAI"),
      remote_id: z.string().min(1).max(64).describe("ID кабинета у дилера (у RouterAI — id учётной записи)"),
      is_payment_recipient: z.boolean().optional().describe("true — сделать получателем платежей кабинета"),
      is_primary: z.boolean().optional().describe("true — основная связка у этого дилера"),
      comment: z.string().max(255).optional().describe("Комментарий к связке"),
    },
  }, async (a, extra) => {
    const { customer_id, ...body } = a;
    const env = await balanceCall(tokenOf(extra), "POST", `/customers/${customer_id}/links`, body);
    if (!env.ok) return fail(errText(env.error));
    const d = env.data;
    const changed = Object.keys(d?.changes ?? {});
    const head = d?.created
      ? `КА #${customer_id} привязан к кабинету ${a.remote_id} (дилер ${a.customer_group_id}), связка #${d?.link?.id}`
      : `КА #${customer_id} уже привязан к кабинету ${a.remote_id}` + (changed.length ? ` — изменено: ${changed.join(", ")}` : " — без изменений");
    const rec = d?.recipient_taken_from ? `; получатель платежей перенесён с КА #${d.recipient_taken_from}` : "";
    return ok(head + rec + warnSuffix(d), d);
  });

  server.registerTool("update_customer_link", {
    title: "Получатель платежей / основная связка",
    description:
      "Изменить связку карточки с кабинетом (link_id — из list_customer_links): is_payment_recipient=true — получателем " +
      "платежей кабинета становится эта карточка (снять получателя нельзя: назначьте другую карточку кабинета или снимите " +
      "связку unlink_customer_from_cabinet); is_primary=true — основная связка у дилера; comment — комментарий " +
      "(пустая строка — очистить). Ответ — связка, все связки карточки, changes и warnings.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      customer_id: z.number().int().positive().describe("customer_id владельца связки"),
      link_id: z.number().int().positive().describe("id связки (list_customer_links)"),
      is_payment_recipient: z.literal(true).optional().describe("true — сделать получателем платежей кабинета"),
      is_primary: z.literal(true).optional().describe("true — основная связка у дилера"),
      comment: z.string().max(255).optional(),
    },
  }, async (a, extra) => {
    const { customer_id, link_id, ...rest } = a;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    if (Object.keys(body).length === 0) return fail("Нечего менять: передайте is_payment_recipient, is_primary или comment.");
    const env = await balanceCall(tokenOf(extra), "PATCH", `/customers/${customer_id}/links/${link_id}`, body);
    if (!env.ok) return fail(errText(env.error));
    const d = env.data;
    const changed = Object.keys(d?.changes ?? {});
    const rec = d?.recipient_taken_from ? `; получатель платежей перенесён с КА #${d.recipient_taken_from}` : "";
    return ok((changed.length ? `Связка #${link_id} изменена (${changed.join(", ")})` : `Связка #${link_id}: изменений нет`) + rec + warnSuffix(d), d);
  });

  server.registerTool("unlink_customer_from_cabinet", {
    title: "Отвязать контрагента от кабинета",
    description:
      "Снять связку карточки с кабинетом (link_id — из list_customer_links) — например, лишнюю автокарточку, когда кабинет " +
      "уже привязан к карточке организации. Документы, оплаты и чеки остаются у карточки, на которую пришли. Была " +
      "получателем платежей — получателем станет старейшая из оставшихся карточек кабинета (recipient_moved_to); " +
      "поэтому сначала назначьте нужного получателя (update_customer_link), потом снимайте лишнюю связку. Если кабинет " +
      "ни к кому больше не привязан, следующая оплата из него заведёт новую автокарточку (warnings).",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      customer_id: z.number().int().positive().describe("customer_id владельца связки"),
      link_id: z.number().int().positive().describe("id связки (list_customer_links)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "DELETE", `/customers/${a.customer_id}/links/${a.link_id}`);
    if (!env.ok) return fail(errText(env.error));
    const d = env.data;
    const moved = d?.recipient_moved_to ? `; получатель платежей кабинета теперь КА #${d.recipient_moved_to}` : "";
    return ok(`Связка #${a.link_id} снята: КА #${a.customer_id} отвязан от кабинета ${d?.remoteid ?? ""}${moved}` + warnSuffix(d), d);
  });

  server.registerTool("merge_customers", {
    title: "Слить дубль контрагента",
    description:
      "Слить карточку-дубль (from_customer_id) в основную (customer_id). Два шага: без confirm — план (что переедет, " +
      "какие пустые поля основной дополнятся, что мешает) и токен; слияние — повторный вызов с теми же id и confirm. " +
      "Переезжают связки с кабинетами (получатель платежей передаётся), договоры, файлы, задачи, КП; дубль помечается " +
      "удалённым, его журнал остаётся при нём. Сливается ТОЛЬКО карточка без истории: ИНН пуст или тот же, нет " +
      "документов, возвратов, связей с 1С и ЭДО. Автокарточку кабинета с оплатами не сливают — перевяжите кабинет: " +
      "link_customer_to_cabinet / update_customer_link(is_payment_recipient) на нужную карточку и " +
      "unlink_customer_from_cabinet у автокарточки; её оплаты и чеки остаются при ней.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      customer_id: z.number().int().positive().describe("Основная карточка — остаётся"),
      from_customer_id: z.number().int().positive().describe("Дубль — сливается в основную и помечается удалённым"),
      confirm: z.string().optional().describe("Токен из ответа первого шага; без него — только план"),
    },
  }, async (a, extra) => {
    const token = tokenOf(extra);
    const fields = { from_customer_id: a.from_customer_id };
    if (!a.confirm) {
      const env = await balanceCall(token, "POST", `/customers/${a.customer_id}/merge`, { ...fields, dry_run: true });
      if (!env.ok) return fail(errText(env.error));
      const p = env.data;
      if (!p?.can_merge) {
        const why = (p?.blockers ?? []).map((b: any) => b.label + (b.count > 1 ? ` (${b.count})` : "")).join("; ");
        return fail(
          `КА #${a.from_customer_id} в КА #${a.customer_id} не сливается: ${why}.\n` +
          "Если это автокарточка кабинета с оплатами — перевяжите кабинет (link_customer_to_cabinet, update_customer_link, " +
          "unlink_customer_from_cabinet), история останется у неё. Иначе — к сотруднику.\n" + JSON.stringify(p)
        );
      }
      const moves = Object.entries(p.moves ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k}: ${n}`).join(", ");
      const fill = Object.keys(p.fill_fields ?? {});
      return ok(
        `План слияния КА #${a.from_customer_id} «${p.source?.name}» → КА #${a.customer_id} «${p.target?.name}»: ` +
        `переедет ${moves || "ничего"}` + (fill.length ? `; дополнятся поля: ${fill.join(", ")}` : "") +
        `. Дубль будет помечен удалённым. Покажите план человеку; слить — тот же вызов с confirm (15 минут).` + warnSuffix(p),
        { ...p, confirm: confirmToken(MERGE_OP, a.customer_id, fields) }
      );
    }
    const v = verifyConfirmToken(a.confirm, MERGE_OP, a.customer_id, fields);
    if (!v.ok) return fail(`Токен подтверждения ${v.reason} — вызовите merge_customers без confirm и покажите новый план.`);
    const env = await balanceCall(token, "POST", `/customers/${a.customer_id}/merge`, { ...fields, dry_run: false });
    // 409 merge_blocked: за время между планом и подтверждением у дубля появилась история —
    // причины уже в тексте balance.
    if (!env.ok) return fail(errText(env.error));
    return ok(`КА #${a.from_customer_id} слит в КА #${a.customer_id}; дубль помечен удалённым` + warnSuffix(env.data), env.data);
  });
}
