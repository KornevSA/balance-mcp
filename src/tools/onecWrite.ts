// Тулзы 1С — ЗАПИСЬ (этапы 3, 3б, 4, 5 проекта docs/onec-api-design.md, решения пользователя 12.10.2026).
//
// MCP в 1С не ходит: каждый тулз зовёт balance /api/v1, а balance сам проверяет скоуп onec:write, право
// (onec.write — этап 3, onec.export — этап 4, onec.documents — этап 5), организацию (onec_api_write_orgs)
// и свежесть базы, строит тело запроса 1С из своих полей и пишет журнал.
//
// Любая запись — ДВА ШАГА, как у статей базы знаний: вызов без confirm делает в balance dry_run (в 1С ничего
// не пишется) и возвращает превью + токен; запись — только повторным вызовом с ТЕМИ ЖЕ полями и confirm.
// Токен — HMAC от операции и полей (util.ts), 15 минут. Где делать нечего (уже есть, ничего не изменится)
// или нельзя (дубли, документ бухгалтера, режим выключен) — токена нет.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall, type Envelope } from "../balanceClient.js";
import { CFG } from "../config.js";
import { putDownload, linkTtlMinutes } from "../downloadStore.js";
import { tokenOf, qs, ok, fail, publicBaseOf, confirmToken, verifyConfirmToken } from "./util.js";
import { onecFail, money, docLine, UUID_RE, DATE_RE } from "./onec.js";

/** Запись в 1С: balance ограничивает каждый вызов 1С 90 с, акт сверки с PDF — два вызова. */
const WRITE_TIMEOUT_MS = 150_000;
/** Штатные выгрузки (оплата + её реализации) и забор поступлений: balance держит до 300 с. */
const LONG_TIMEOUT_MS = 290_000;

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const orgId = () => z.number().int().positive().describe("Организация = база 1С: org_id из list_onec_bases");
const onecUuid = (what: string) => z.string().regex(UUID_RE, "UUID ссылки 1С").describe(`id ${what} в 1С (UUID)`);
const date = (what: string) => z.string().regex(DATE_RE, "ГГГГ-ММ-ДД").describe(`${what}, ГГГГ-ММ-ДД`);
const confirm = () => z.string().optional().describe("Токен подтверждения из превью-вызова. БЕЗ него ничего не записывается");

function call(extra: any, method: string, path: string, body?: unknown, timeoutMs = WRITE_TIMEOUT_MS): Promise<Envelope> {
  return balanceCall(tokenOf(extra), method, path, body, { timeoutMs, write: true });
}

/** Превью с токеном: что будет сделано, ничего не записано. */
function preview(op: string, id: number, fields: Record<string, any>, text: string, data: any) {
  const ct = confirmToken(op, id, fields);
  return ok(
    `${text}\n\nНичего не записано. Чтобы выполнить — повторите вызов с ТЕМИ ЖЕ полями и confirm="${ct}" (токен живёт 15 минут).`,
    { requires_confirmation: true, confirm_token: ct, preview: data },
  );
}

/** Превью без токена: делать нечего. */
function nothingToDo(text: string, data: any) {
  return ok(`${text}\nПодтверждать нечего — ничего не записано.`, { requires_confirmation: false, preview: data });
}

function badToken(tool: string, reason?: string) {
  return fail(`Токен подтверждения ${reason ?? "неверен"}. Вызовите ${tool} без confirm — получите свежее превью и токен.`);
}

function who(balance: any): string {
  const n = Number(balance);
  if (!Number.isFinite(n) || n === 0) return "расчёты закрыты";
  return n > 0 ? "контрагент должен нам" : "мы должны контрагенту (или аванс)";
}

function lines(items: string[]): string {
  return items.filter(Boolean).map((s) => `• ${s}`).join("\n");
}

/** PDF из ответа balance (base64) → временные ссылки; base64 в ответ модели не попадает. */
function deliverPdfFiles(extra: any, pdf: any): { text: string; files: any[] } {
  const out: any[] = [];
  const texts: string[] = [];
  for (const f of (pdf?.files || []) as any[]) {
    const buf = Buffer.from(String(f.data || ""), "base64");
    const name = String(f.filename || "Акт сверки.pdf");
    const ctype = String(f.content_type || "application/pdf");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const human = buf.length < 1048576 ? `${Math.max(1, Math.round(buf.length / 1024))} КБ` : `${(buf.length / 1048576).toFixed(1)} МБ`;
    const token = putDownload(buf, name, ctype);
    if (!token) {
      texts.push(`PDF «${name}» (${human}) больше лимита ссылки ${Math.round(CFG.linkMaxBytes / 1048576)} МБ — откройте документ в 1С.`);
      out.push({ name, size_bytes: buf.length, sha256, content_type: ctype });
      continue;
    }
    const url = `${publicBaseOf(extra)}/mcp/file/${token}/${encodeURIComponent(name.replace(/[\\/]+/g, "_"))}`;
    texts.push(`PDF «${name}» — ${human}, ссылка (живёт ${linkTtlMinutes()} мин, откроется без авторизации): ${url}`);
    out.push({ name, size_bytes: buf.length, sha256, content_type: ctype, url, ttl_minutes: linkTtlMinutes() });
  }
  return { text: texts.join("\n"), files: out };
}

/** Контрагент 1С клиента balance (GET /customers/{id}/onec) — для тулзов, принимающих customer_id. */
async function resolveCounterparty(extra: any, orgIdV: number, customerId: number): Promise<{ id?: string; err?: any }> {
  const env = await balanceCall(tokenOf(extra), "GET", `/customers/${customerId}/onec` + qs({ org_id: orgIdV }), undefined, { timeoutMs: 120_000 });
  if (!env.ok) return { err: onecFail(env) };
  const id = env.data?.counterparty?.id;
  if (id) return { id: String(id).toLowerCase() };
  const c: any[] = env.data?.match?.candidates || [];
  return {
    err: fail(`Контрагент 1С для клиента balance #${customerId} в базе org ${orgIdV} однозначно не найден` +
      (c.length ? `: подходят ${c.length} — передайте onec_id одного из них:\n${JSON.stringify(c)}` :
        " — заведите его (create_onec_counterparty) или передайте onec_id")),
  };
}

export function registerOneCWriteTools(server: McpServer) {
  // ======================================================================= этап 3: акт сверки
  server.registerTool("create_onec_reconciliation", {
    title: "Акт сверки в 1С (с подтверждением)",
    description:
      "Акт сверки взаиморасчётов с контрагентом в 1С за период и его PDF (временная ссылка). ДВУХШАГОВО: без confirm — " +
      "превью (контрагент, период, договор, будет создан или перезаполнен, сальдо по данным 1С на конец периода) и токен, " +
      "ничего не создаётся; с confirm и ТЕМИ ЖЕ полями — запись. На один контрагент, период и договор в 1С заводится один " +
      "акт: повторный вызов перезаполняет его по текущим данным, а не создаёт новый. Проводится, только если post=true " +
      "(по умолчанию — нет; уже проведённый при перезаполнении остаётся проведённым). PDF по умолчанию с факсимиле подписи " +
      "и печати (stamp=false — без). Контрагент — customer_id (клиент balance) или onec_counterparty_id (id 1С). " +
      "Остаток > 0 — контрагент должен нам. Период — не длиннее трёх лет.",
    inputSchema: {
      org_id: orgId(),
      customer_id: z.number().int().positive().optional().describe("id клиента в balance"),
      onec_counterparty_id: onecUuid("контрагента").optional(),
      from: date("Начало периода"),
      to: date("Конец периода"),
      onec_contract_id: onecUuid("договора").optional().describe("Сверка по одному договору (id договора 1С, list_onec_contracts)"),
      split_by_contracts: z.boolean().optional().describe("Разбить акт по договорам (по умолчанию нет)"),
      post: z.boolean().optional().describe("Провести акт в 1С — только если об этом явно попросили (по умолчанию false)"),
      stamp: z.boolean().optional().describe("PDF с факсимиле подписи и печати (по умолчанию true)"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    if (!!a.customer_id === !!a.onec_counterparty_id) return fail("Передайте что-то одно: customer_id (balance) или onec_counterparty_id (1С).");
    if (a.from > a.to) return fail("from позже to.");
    const fields = {
      org_id: a.org_id, customer_id: a.customer_id ?? null, onec_counterparty_id: a.onec_counterparty_id?.toLowerCase() ?? null,
      from: a.from, to: a.to, onec_contract_id: a.onec_contract_id?.toLowerCase() ?? null,
      split_by_contracts: a.split_by_contracts ?? false, post: a.post ?? false, stamp: a.stamp ?? true,
    };
    const body = {
      customer_id: fields.customer_id ?? undefined, counterparty_id: fields.onec_counterparty_id ?? undefined,
      from: a.from, to: a.to, contract_id: fields.onec_contract_id ?? undefined,
      split_by_contracts: fields.split_by_contracts, post: fields.post, stamp: fields.stamp,
    };
    const path = `/onec/${a.org_id}/reconciliations`;

    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...body, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const cp = d.counterparty || {};
      const t = d.settlement?.totals || {};
      const head = d.will === "create"
        ? "будет СОЗДАН новый акт"
        : `будет ПЕРЕЗАПОЛНЕН существующий акт № ${d.existing?.number} от ${d.existing?.date}${d.existing?.posted ? " (проведён)" : ""}`;
      const text = `Акт сверки в 1С org ${d.org_id} «${d.organization}»: ${head}.\n` + lines([
        `Контрагент: «${cp.name}» ИНН ${cp.inn || "—"}${cp.kpp ? ` КПП ${cp.kpp}` : ""} (id 1С ${cp.id})${d.customer_id ? `, клиент balance #${d.customer_id}` : ""}`,
        `Период: ${a.from} — ${a.to}; ${d.contract ? `договор «${d.contract.name}»` : "все договоры"}${d.split_by_contracts ? ", с разбивкой по договорам" : ""}`,
        `Проводить: ${d.post ? "да" : "нет"}; PDF ${d.stamp ? "с факсимиле подписи и печати" : "без факсимиле"}`,
        `Сальдо по данным 1С на ${a.to}: ${money(t.balance)} — ${who(t.balance)}`,
        ...((d.warnings || []) as string[]).map((w) => `⚠ ${w}`),
      ]);
      if (d.blocked) return fail(`${text}\nЗаписать нельзя — см. предупреждение.`);
      return preview("onec_recon", 0, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_recon", 0, fields);
    if (!v.ok) return badToken("create_onec_reconciliation", v.reason);
    const env = await call(extra, "POST", path, body);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const doc = d.document || {};
    const rec = d.reconciliation || {};
    const verb = d.result === "refilled" ? "перезаполнен" : d.result === "created" ? "создан" : "уже был";
    const pdf = d.pdf ? deliverPdfFiles(extra, d.pdf) : { text: "", files: [] };
    const text = `Акт сверки № ${doc.number} от ${doc.date} ${verb} в 1С org ${d.org_id}; ${doc.posted ? "проведён" : "не проведён"}. ` +
      `Остаток на конец периода ${money(rec.closing_balance)} — ${who(rec.closing_balance)} ` +
      `(на начало ${money(rec.opening_balance)}, дебет ${money(rec.debit)}, кредит ${money(rec.credit)}).\n` +
      (pdf.text || `PDF не получен${d.pdf_error ? `: ${d.pdf_error}` : ""} — возьмите его get_onec_document_pdf (org_id ${d.org_id}, onec_id ${doc.id}, form АктСверки).`);
    const structured = { ...d, pdf: d.pdf ? { form: d.pdf.form, form_name: d.pdf.form_name, stamp: d.pdf.stamp, files: pdf.files } : null };
    return ok(text, structured);
  });

  // ======================================================================= этап 3: ЕГРЮЛ
  server.registerTool("fill_onec_counterparty_from_registry", {
    title: "Контрагент 1С по ЕГРЮЛ/ЕГРИП (с подтверждением)",
    description:
      "Обновить контрагента в 1С по ЕГРЮЛ/ЕГРИП, как кнопка «Заполнить по ИНН» (наименования, КПП, ОГРН, адреса, история). " +
      "ДВУХШАГОВО: без confirm 1С показывает, что изменится (было → стало) и предупреждения, ничего не записывая; с confirm и " +
      "теми же полями — запись. keep_name — не менять наименование. inn — только если у контрагента в 1С ИНН нет или он " +
      "неверный. Подразделения, иностранные и помеченные на удаление, а также случаи, когда КПП подразделения сменился бы на " +
      "головной или появился бы дубль, через MCP не заполняются — это решает бухгалтер в 1С. Клиента в balance не меняет " +
      "(для этого — update_customer). Контрагент — onec_id или customer_id.",
    inputSchema: {
      org_id: orgId(),
      onec_id: onecUuid("контрагента").optional(),
      customer_id: z.number().int().positive().optional().describe("id клиента в balance — его контрагент в 1С"),
      keep_name: z.boolean().optional().describe("Не менять наименование (по умолчанию меняется, как кнопка в 1С)"),
      inn: z.string().regex(/^\d{10}(\d{2})?$/, "10 или 12 цифр").optional().describe("ИНН, если у контрагента в 1С его нет или он неверный"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    if (!!a.onec_id === !!a.customer_id) return fail("Передайте что-то одно: onec_id (1С) или customer_id (balance).");
    let uid = a.onec_id?.toLowerCase();
    if (a.customer_id) {
      const r = await resolveCounterparty(extra, a.org_id, a.customer_id);
      if (r.err) return r.err;
      uid = r.id;
    }
    const fields = { org_id: a.org_id, onec_id: uid, keep_name: a.keep_name ?? false, inn: a.inn ?? null };
    const body = { keep_name: fields.keep_name, inn: a.inn };
    const path = `/onec/${a.org_id}/counterparties/${uid}/fill-from-registry`;

    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...body, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const cp = d.counterparty || {};
      const ch = ((d.changes || []) as any[]).map((c) => `${c.label}: «${c.old}» → «${c.new}»`);
      const head = `Контрагент 1С «${cp.name}» (id ${cp.id}, ИНН ${d.inn || cp.inn || "—"}) по данным ${d.registry?.kind === "ip" ? "ЕГРИП" : "ЕГРЮЛ"}` +
        (d.registry?.status_name ? ` (${d.registry.status_name})` : "") + ":";
      const warn = [...((d.warnings || []) as string[]), ...((d.blocked || []) as string[])].map((w) => `⚠ ${w}`);
      if ((d.dupes || []).length) warn.push(`Дубли в 1С: ${JSON.stringify(d.dupes)}`);
      if ((d.blocked || []).length) return fail(`${head}\n${lines([...ch, ...warn])}\nЧерез MCP это не заполняется — решает бухгалтер в 1С.`);
      if (d.nothing_to_change) return nothingToDo(`${head} изменений нет — в 1С уже как в реестре.${warn.length ? "\n" + lines(warn) : ""}`, d);
      return preview("onec_fill", 0, fields, `${head}\n${lines([...ch, ...warn])}${fields.keep_name ? "\n(наименование не меняется — keep_name)" : ""}`, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_fill", 0, fields);
    if (!v.ok) return badToken("fill_onec_counterparty_from_registry", v.reason);
    const env = await call(extra, "POST", path, body);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const ch = ((d.changes || []) as any[]).map((c) => `${c.label}: «${c.old}» → «${c.new}»`);
    return ok(d.result === "updated"
      ? `Контрагент 1С «${d.counterparty?.name}» обновлён по реестру:\n${lines(ch)}`
      : `Без изменений — в 1С уже как в реестре.`, d);
  });

  // ======================================================================= этап 3: клиент → контрагент
  server.registerTool("create_onec_counterparty", {
    title: "Завести клиента balance в 1С (с подтверждением)",
    description:
      "Завести клиента balance контрагентом в базе 1С организации (или найти уже заведённого) и запомнить связь. Ищет так " +
      "же, как balance: сохранённая связь → ключ, с которым клиента заводит выгрузка оплат → ИНН. Клиента с ИНН 1С заполнит " +
      "по ЕГРЮЛ/ЕГРИП; без ИНН (клиент дилера) — заведёт физлицом «Пользователь <дилер> (ID: N)», как выгрузка оплат, поэтому " +
      "дубля потом не будет. ДВУХШАГОВО: без confirm — что будет отправлено и кто уже есть в 1С; с confirm — запись. Если " +
      "подходящих контрагентов несколько — ничего не создаётся, нужен человек.",
    inputSchema: {
      org_id: orgId(),
      customer_id: z.number().int().positive().describe("id клиента в balance"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    const fields = { org_id: a.org_id, customer_id: a.customer_id };
    const path = `/customers/${a.customer_id}/onec`;
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { org_id: a.org_id, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const name = `Клиент balance #${a.customer_id} «${d.customer_name ?? ""}»`;
      if (d.result === "exists") {
        const by: Record<string, string> = { map: "по сохранённой связи", external_id: `по ключу ${d.match?.external_id}`, inn: "по ИНН" };
        return nothingToDo(`${name} уже есть в 1С org ${a.org_id}: «${d.counterparty?.name}» (id ${d.counterparty?.id}), найден ${by[d.match?.by] || d.match?.by}.`, d);
      }
      if (d.result === "ambiguous") return fail(`${name}: ${d.note}\n${JSON.stringify(d.match?.candidates || [])}`);
      const p = d.payload || {};
      return preview("onec_cp", a.customer_id, fields, `${name} в 1С org ${a.org_id} не найден — будет заведён.\n` + lines([
        `Ключ (external_id): ${p.external_id}`,
        p.fill_from_registry ? `ИНН ${p.inn}${p.kpp ? `, КПП ${p.kpp}` : ""} — наименования и реквизиты 1С возьмёт из ЕГРЮЛ/ЕГРИП` : `Наименование: «${p.name}», вид: ${p.kind}`,
        p.group_name ? `Группа: ${p.group_name}` : "",
        "Если в 1С найдётся такой же по ИНН — 1С вернёт его, второго не заведёт",
      ]), d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_cp", a.customer_id, fields);
    if (!v.ok) return badToken("create_onec_counterparty", v.reason);
    const env = await call(extra, "POST", path, { org_id: a.org_id });
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const verb: Record<string, string> = { created: "заведён", matched: "найден по ИНН", found: "уже был", exists: "уже был" };
    return ok(`Клиент balance #${a.customer_id} ${verb[d.result] || d.result} в 1С org ${a.org_id}: «${d.counterparty?.name}» (id ${d.counterparty?.id}); связь запомнена.` +
      ((d.warnings || []).length ? `\n⚠ ${(d.warnings as string[]).join("\n⚠ ")}` : ""), d);
  });

  // ======================================================================= этап 3б: договор
  server.registerTool("create_onec_contract", {
    title: "Завести договор balance в 1С (с подтверждением)",
    description:
      "Завести договор balance (contract_id из list_contracts) в 1С у контрагента клиента и запомнить его id 1С. Если в 1С уже " +
      "есть договор этого контрагента с тем же номером и датой — новый не создаётся, запоминается связь с ним; если таких " +
      "несколько — ничего не делается (это дубли, решает бухгалтер). Контрагент клиента должен быть в 1С (create_onec_counterparty). " +
      "Новый договор — «с покупателем»; основным он станет, только если основного такого вида у контрагента нет. ДВУХШАГОВО: " +
      "без confirm — превью; с confirm — запись.",
    inputSchema: {
      contract_id: z.number().int().positive().describe("id договора в balance"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    const fields = { contract_id: a.contract_id };
    const path = `/contracts/${a.contract_id}/onec`;
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const k = d.contract || {};
      const name = `Договор balance #${a.contract_id} № ${k.number || "—"} от ${k.date || "—"} «${k.name || ""}» (org ${k.org_id})`;
      if (d.will === "nothing") {
        if (d.result === "exists") return nothingToDo(`${name} уже есть в 1С: «${d.onec_contract?.name}» (id ${d.onec_contract?.id}).`, d);
        return fail(`${name}: ${d.note}` + (d.candidates ? `\n${JSON.stringify(d.candidates)}` : ""));
      }
      if (d.will === "link") {
        return preview("onec_contract", a.contract_id, fields,
          `${name}: в 1С есть договор с тем же номером и датой — «${d.onec_contract?.name}» (id ${d.onec_contract?.id}). Будет запомнена связь, в 1С ничего не создаётся.`, d);
      }
      const p = d.payload || {};
      return preview("onec_contract", a.contract_id, fields, `${name} в 1С не найден — будет заведён у «${d.counterparty?.name}»:\n` + lines([
        `Номер ${p.number ?? "—"}, дата ${p.date ?? "—"}, наименование «${p.name ?? "по номеру и дате"}», вид ${p.kind}`,
        `Ключ (external_id): ${p.external_id}`,
        d.note,
      ]), d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_contract", a.contract_id, fields);
    if (!v.ok) return badToken("create_onec_contract", v.reason);
    const env = await call(extra, "POST", path, {});
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const verb: Record<string, string> = { created: "заведён", linked: "привязан к найденному", found: "уже был", exists: "уже был" };
    return ok(`Договор balance #${a.contract_id} ${verb[d.result] || d.result} в 1С: «${d.onec_contract?.name}» (id ${d.onec_contract?.id}).`, d);
  });

  // ======================================================================= этап 4: штатные выгрузки
  server.registerTool("send_document_to_onec", {
    title: "Отправить документ balance в 1С (с подтверждением)",
    description:
      "Отправить документ balance в 1С ТЕМ ЖЕ путём, что кнопка в balance, — без дублей (тот же ключ, повтор вернёт уже " +
      "созданное): оплату картой или СБП — выгрузкой оплат (следом уходит её реализация), акт к такой оплате — выгрузкой " +
      "реализаций, счёт или акт клиенту — прежним сервисом 1С («Создать в 1С»). ДВУХШАГОВО: без confirm — каким путём пойдёт " +
      "и что мешает (режим организации выключен, нет ИНН или договора, оплата раньше 01.07.2026), у оплат — проводки пробного " +
      "проведения; с confirm — отправка. Подчиняется режимам выгрузки организаций. Использовать только по явной просьбе: " +
      "обычно документы уходят в 1С сами.",
    inputSchema: {
      doc_id: z.number().int().positive().describe("id документа в balance"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    const fields = { doc_id: a.doc_id };
    const path = `/documents/${a.doc_id}/onec/send`;
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { dry_run: true }, LONG_TIMEOUT_MS);
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const head = `Документ balance #${a.doc_id} → 1С org ${d.org_id}: ${d.route_name}.`;
      if (d.result === "exists" || d.state === "ok") return nothingToDo(`${head}\n${d.message}`, d);
      if (!d.ok || d.state === "blocked" || d.state === "busy") return fail(`${head}\nНе отправится: ${d.message}`);
      return preview("onec_send", a.doc_id, fields, `${head}\n${d.message}${d.note ? `\n${d.note}` : ""}` +
        ((d.sales || []).length ? `\nСледом уйдут реализации: ${(d.sales as any[]).map((s) => `#${s.doc_id}`).join(", ")}` : ""), d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_send", a.doc_id, fields);
    if (!v.ok) return badToken("send_document_to_onec", v.reason);
    const env = await call(extra, "POST", path, {}, LONG_TIMEOUT_MS);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const sales = ((d.sales_export || []) as any[]).map((s) => `реализация #${s.doc_id}: ${s.ok ? "" : "НЕ ВЫГРУЖЕНА — "}${s.message}`);
    const text = `Документ balance #${a.doc_id} → 1С org ${d.org_id} (${d.route_name}): ${d.message}` + (sales.length ? `\n${lines(sales)}` : "");
    return d.ok ? ok(text, d) : fail(text);
  });

  server.registerTool("pull_onec_bank_payments", {
    title: "Загрузить поступления из 1С (с подтверждением)",
    description:
      "Загрузить в balance поступления на расчётный счёт из базы 1С организации — то же, что кнопка «Запросить оплаты из 1С» " +
      "(за последние days дней, до 90; или с даты from — до сегодня). Новые платежи встают в «Оплаты» к зачислению; плательщика, " +
      "которого нет в balance, balance заводит сам (реквизиты из ЕГРЮЛ). Эквайринг, переводы между своими организациями и уже " +
      "загруженные пропускаются. ДВУХШАГОВО: без confirm — сколько будет загружено и кто из плательщиков новый; с confirm — загрузка.",
    inputSchema: {
      org_id: orgId(),
      days: z.number().int().min(1).max(90).optional().describe("За сколько дней назад (по умолчанию 14)"),
      from: date("С какой даты (вместо days), не раньше 90 дней назад").optional(),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    if (a.days && a.from) return fail("Передайте что-то одно: days или from.");
    const fields = { org_id: a.org_id, days: a.from ? null : (a.days ?? 14), from: a.from ?? null };
    const body = { days: fields.days ?? undefined, from: fields.from ?? undefined };
    const path = `/onec/${a.org_id}/bank-pull`;
    const summary = (d: any, dry: boolean) => {
      const r = d.result || {};
      const skipped = Object.entries(r.skipped || {}).map(([k, n]) => `${k}: ${n}`).join("; ");
      const fresh = ((r.new_customers || []) as any[]).map((c) => `ИНН ${c.inn}${c.name ? ` «${c.name}»` : ""}${c.customer_id ? ` → клиент #${c.customer_id}` : ""}`);
      return lines([
        `Поступлений в 1С с ${d.from}: ${r.fetched ?? 0}; ${dry ? "будет загружено" : "загружено"}: ${r.created ?? 0}; уже были: ${r.exists ?? 0}`,
        skipped ? `Пропущено — ${skipped}` : "",
        fresh.length ? `Новые плательщики (${dry ? "будут заведены" : "заведены"}): ${fresh.join(", ")}` : "",
        (r.unknown || []).length ? `Не загружены, разберите вручную: ${JSON.stringify(r.unknown)}` : "",
        r.error ? `Ошибка: ${r.error}` : "",
      ]);
    };
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...body, dry_run: true }, LONG_TIMEOUT_MS);
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const text = `Поступления из 1С org ${a.org_id} за ${d.days} дн.:\n${summary(d, true)}`;
      if (d.result?.error) return fail(text);
      if (!d.result?.created) return nothingToDo(text, d);
      return preview("onec_pull", a.org_id, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_pull", a.org_id, fields);
    if (!v.ok) return badToken("pull_onec_bank_payments", v.reason);
    const env = await call(extra, "POST", path, body, LONG_TIMEOUT_MS);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const text = `Поступления из 1С org ${a.org_id} за ${d.days} дн.:\n${summary(d, false)}`;
    return d.result?.error ? fail(text) : ok(text, d);
  });

  // ======================================================================= этап 5: проведение и пометка
  server.registerTool("set_onec_document_state", {
    title: "Провести / распровести / пометить документ 1С (с подтверждением)",
    description:
      "Провести (post), отменить проведение (unpost), пометить на удаление (delete — физически не удаляется, проведённый " +
      "распроводится) или снять пометку (restore) у документа 1С, КОТОРЫЙ СОЗДАЛ balance: счёт или акт, отправленный из " +
      "balance, оплата картой и её реализация из выгрузки, акт сверки из MCP. Документы бухгалтера (выписки, касса, ручные) " +
      "не трогаются — balance откажет. Закрытый период 1С не обходится. Только по явной просьбе. ДВУХШАГОВО: без confirm — " +
      "документ, откуда он и что изменится; с confirm — действие. Документ — doc_id (balance) или org_id + onec_id.",
    inputSchema: {
      action: z.enum(["post", "unpost", "delete", "restore"]).describe("post — провести, unpost — отменить проведение, delete — пометить на удаление, restore — снять пометку"),
      doc_id: z.number().int().positive().optional().describe("id документа в balance"),
      org_id: orgId().optional(),
      onec_id: onecUuid("документа").optional(),
      confirm: confirm(),
    },
    annotations: DESTRUCTIVE,
  }, async (a, extra) => {
    if (a.doc_id && a.onec_id) return fail("Передайте что-то одно: doc_id (balance) или org_id + onec_id (1С).");
    if (!a.doc_id && !(a.onec_id && a.org_id)) return fail("Передайте doc_id (balance) или org_id + onec_id (документ 1С).");
    const fields = { action: a.action, doc_id: a.doc_id ?? null, org_id: a.doc_id ? null : a.org_id ?? null, onec_id: a.onec_id?.toLowerCase() ?? null };
    let method = "POST";
    let path: string;
    if (a.doc_id) path = `/documents/${a.doc_id}/onec/${a.action}`;
    else if (a.action === "delete") { method = "DELETE"; path = `/onec/${a.org_id}/documents/${fields.onec_id}`; }
    else path = `/onec/${a.org_id}/documents/${fields.onec_id}/${a.action}`;
    const id = a.doc_id ?? 0;

    if (!a.confirm) {
      const env = method === "DELETE"
        ? await call(extra, "DELETE", path + qs({ dry_run: true }))
        : await call(extra, "POST", path, { dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const origin = ((d.origin?.links || []) as any[]).map((l) => l.text + (l.doc_id ? ` (документ balance #${l.doc_id})` : "")).join("; ");
      const text = `${d.action_name ? d.action_name[0].toUpperCase() + d.action_name.slice(1) : a.action}: ${docLine(d.document)} в 1С org ${d.org_id}.\n` +
        lines([`Создан balance: ${origin}`, `Что будет: ${d.effect}`]);
      if (d.blocked) return fail(text);
      if (d.noop) return nothingToDo(text, d);
      return preview("onec_state", id, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_state", id, fields);
    if (!v.ok) return badToken("set_onec_document_state", v.reason);
    const env = await call(extra, method, path, method === "DELETE" ? undefined : {});
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    return ok(`Готово (${a.action}): ${docLine(d.document)} в 1С org ${d.org_id}.`, d);
  });
}
