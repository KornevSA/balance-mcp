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
//
// Документы поставщиков (задача пользователя 13.10.2026, balance class/onec_api_supplier.php, право onec.write):
// поступление или счёт от поставщика из входящего документа Диадока, Saby (16.10.2026) или из данных пользователя,
// поставщик по ИНН с договором, номенклатура и правка такого документа (PUT). Чтение Диадока и Saby — edo.ts.
//
// Счёт-фактура налогового агента (задача 15.10.2026, balance POST /onec/{org}/tax-agent-invoices): на оплату иностранному
// поставщику, как «Создать на основании» у бухгалтера; превью — пробная запись 1С с откатом по каждой оплате.
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

/** Без null/undefined: в balance уходят только переданные поля. */
function dropNulls<T extends Record<string, any>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

const lc = (s?: string | null): string | null => (s ? s.toLowerCase() : null);
const INN_RE = /^\d{10}(\d{2})?$/;

/** Строка документа поставщика (create_onec_supplier_document). */
const supplierLine = () => z.object({
  line: z.number().int().positive().optional().describe("Номер строки (по умолчанию — по порядку с 1); на него ссылается line_nomenclature"),
  content: z.string().min(1).max(1000).describe("Текст строки — наименование товара или услуги"),
  quantity: z.number().positive().optional().describe("Количество (по умолчанию 1)"),
  amount: z.number().nonnegative().optional().describe("Сумма строки С НДС (при vat_included=false — БЕЗ НДС) — или price"),
  price: z.number().nonnegative().optional().describe("Цена за единицу С НДС (при vat_included=false — БЕЗ НДС) — или amount"),
  vat_rate: z.string().min(1).max(20).describe("Ставка НДС: 22, 20, 10, 7, 5, 0, none (без НДС) или код 1С (НДС22, БезНДС…)"),
  vat_amount: z.number().nonnegative().optional().describe("Сумма НДС строки, если известна"),
  nomenclature_id: onecUuid("номенклатуры этой строки").optional(),
});

/** Счета учёта строки (update_onec_document): коды плана счетов, аналитика — id или наименование. */
const acc = () => z.string().min(1).max(150);
const itemAccounts = () => z.object({
  expense: acc().optional().describe("Счёт затрат: 26, 44.01…"),
  expense_analytics: z.union([acc(), z.array(acc()).min(1).max(3)]).optional().describe("Аналитика счёта затрат — id или наименование (до трёх: статья затрат…)"),
  expense_department_id: acc().optional().describe("Подразделение затрат — id или наименование"),
  vat: acc().optional().describe("Счёт учёта НДС: 19.04…"),
  inventory: acc().optional().describe("Счёт учёта товара: 41.01, 10.01…"),
});
const settlementAccounts = () => z.object({
  settlement: acc().optional().describe("Счёт расчётов с поставщиком: 60.01…"),
  advances: acc().optional().describe("Счёт авансов: 60.02…"),
});

/** Строка документа поставщика при правке: заменяет строки целиком. */
const editItem = () => z.object({
  nomenclature_id: onecUuid("номенклатуры").optional(),
  content: z.string().min(1).max(1000).optional().describe("Текст строки"),
  quantity: z.number().positive().optional().describe("Количество (по умолчанию 1)"),
  price: z.number().nonnegative().describe("Цена за единицу С НДС (если у документа «НДС сверху» — vat_included=false — БЕЗ НДС)"),
  vat_rate: z.string().min(1).max(20).describe("Ставка НДС: 22, 20, 10, 7, 5, 0, none (без НДС) или код 1С (НДС22, БезНДС…)"),
  vat_amount: z.number().nonnegative().optional().describe("Сумма НДС строки"),
  accounts: itemAccounts().optional().describe("Счета учёта строки"),
});

function accText(o: Record<string, any> | undefined): string {
  return Object.entries(o || {}).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(" / ") : v}`).join(", ");
}

/** Превью документа поставщика человеческим текстом. */
function supplierDocText(d: any): string {
  const src = d.source || {};
  const cp = d.counterparty || {};
  const t = d.totals || {};
  const items: any[] = d.payload?.items || [];
  const by: Record<string, string> = { given: "передан onec_counterparty_id", inn_kpp: "найден по ИНН и КПП", inn: "найден по ИНН" };
  const has = (v: any) => v !== null && v !== undefined;
  return `${d.kind_name || d.kind || "Документ поставщика"} в 1С org ${d.org_id}${d.organization ? ` «${d.organization}»` : ""}:\n` + lines([
    src.type === "diadoc"
      ? `Источник: Диадок — «${src.title || "—"}» (${src.diadoc_type || "—"})${src.status_text ? `, ${src.status_text}` : ""}${src.grounds ? `; основание: ${src.grounds}` : ""}`
      : src.type === "saby"
        ? `Источник: Saby — «${src.title || "—"}» (${src.saby_type || "—"})${src.status_text ? `, ${src.status_text}` : ""}${src.grounds ? `; основание: ${src.grounds}` : ""}`
        : `Источник: данные пользователя (продавец ИНН ${src.seller?.inn || "—"}${src.seller?.name ? ` «${src.seller.name}»` : ""})`,
    has(d.incoming_number) ? `Входящий № ${d.incoming_number || "—"} от ${d.incoming_date || "—"}; дата документа в 1С ${d.date || "—"}` : "",
    cp.id
      ? `Поставщик в 1С: «${cp.name}» ИНН ${cp.inn || "—"}${cp.kpp ? ` КПП ${cp.kpp}` : ""} (id ${cp.id}, ${by[cp.by] || cp.by})`
      : `Поставщик: ${cp.note || "в 1С не найден"}${(cp.candidates || []).length ? `\n${JSON.stringify(cp.candidates)}` : ""}`,
    d.contract ? `Договор: «${d.contract.name ?? ""}» (id ${d.contract.id})` : "",
    items.length ? `Строк: ${items.length}; сумма ${money(t.sum)}, НДС ${money(t.vat)}` +
      (d.vat_included === false ? `, всего ${money(t.total)} — НДС сверху (цены без НДС)` : "") +
      (has(t.source_total) ? `; итог документа ${money(t.source_total)}` : "") : "",
    has(d.post) ? `Проводить: ${d.post ? "да" : "нет"}${has(d.upd) ? `; УПД (со счётом-фактурой): ${d.upd ? "да" : "нет"}` : ""}` : "",
    d.external_id ? `Ключ (external_id): ${d.external_id}` : "",
    ...((d.checks || []) as string[]),
    ...((d.warnings || []) as string[]).map((w) => `⚠ ${w}`),
  ]);
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
      "balance, оплата картой и её реализация из выгрузки, акт сверки из MCP, поступление или счёт от поставщика, созданные " +
      "через MCP (create_onec_supplier_document). Документы бухгалтера (выписки, касса, ручные) " +
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

  // ======================================================================= документы поставщиков
  server.registerTool("create_onec_supplier_document", {
    title: "Документ поставщика в 1С: поступление или счёт (с подтверждением)",
    description:
      "Завести в 1С документ поставщика: поступление (kind=purchase — акт, накладная, УПД) или счёт от поставщика " +
      "(supplier_invoice). Источники: source=diadoc — входящий документ Диадока (message_id и entity_id из " +
      "list_diadoc_documents; продавец, номер, дата и строки УПД берутся из XML; вид по умолчанию: счёт Диадока — счёт от " +
      "поставщика, остальное — поступление; у счёта-файла и прочих видов строк нет — передайте lines, они же заменяют строки " +
      "УПД); source=saby — входящий документ Saby (СБИС): document_id и attachment_id из list_saby_documents, строки — из XML " +
      "УПД, как у Диадока; source=manual — данные, которые дал пользователь (seller, number, date, lines, kind обязателен; ключ дублей — как " +
      "у «Первички», так что тот же документ, заведённый по фото, не задвоится). Поставщик ищется в 1С по ИНН продавца (КПП " +
      "уточняет); нет — сначала create_onec_supplier, несколько — передайте onec_counterparty_id. Договор не передан, а в " +
      "основании УПД (Диадок, Saby) есть договор, который у поставщика в 1С один, — берётся он. У поступления КАЖДОЙ строке " +
      "нужна номенклатура 1С (nomenclature_id — общая, line_nomenclature или lines[].nomenclature_id — по строкам; найти — " +
      "search_onec_nomenclature, завести — create_onec_nomenclature); у счёта от поставщика — не обязательна, строка пишется " +
      "текстом. Дубли: тот же документ (тот же ключ) вернёт уже созданный; документ с тем же входящим номером у того же " +
      "контрагента (обычно его завёл бухгалтер) — отказ, allow_duplicate=true — только если это точно другой документ. " +
      "Договор не указан — 1С подставит основной. Суммы строк по умолчанию с НДС; vat_included=false — «НДС сверху» (так у " +
      "налогового агента: иностранный поставщик, НДС начисляет покупатель) — суммы строк без НДС, 1С добавит НДС к ним. " +
      "Проводить (post) — только если об этом явно попросили (по умолчанию нет). " +
      "ДВУХШАГОВО: без confirm — превью (поставщик, договор, строки, суммы, проверки) и токен, ничего не создаётся; с confirm " +
      "и ТЕМИ ЖЕ полями — запись. Поправить потом — update_onec_document.",
    inputSchema: {
      org_id: orgId(),
      source: z.enum(["diadoc", "saby", "manual"]).optional()
        .describe("diadoc — входящий документ Диадока, saby — входящий документ Saby (СБИС), manual — данные пользователя " +
          "(по умолчанию diadoc, если передан message_id; saby, если передан document_id)"),
      message_id: z.string().regex(UUID_RE, "GUID документа Диадока").optional().describe("source=diadoc: message_id документа Диадока (list_diadoc_documents)"),
      entity_id: z.string().regex(UUID_RE, "GUID документа Диадока").optional().describe("source=diadoc: entity_id документа Диадока"),
      document_id: z.string().regex(UUID_RE, "GUID документа Saby").optional().describe("source=saby: document_id документа Saby (list_saby_documents)"),
      attachment_id: z.string().regex(UUID_RE, "GUID вложения Saby").optional()
        .describe("source=saby: attachment_id вложения (УПД) из list_saby_documents; без него — основное вложение"),
      kind: z.enum(["purchase", "supplier_invoice"]).optional()
        .describe("purchase — поступление (акт, накладная, УПД), supplier_invoice — счёт от поставщика; для manual обязателен"),
      seller: z.object({
        inn: z.string().regex(INN_RE, "10 или 12 цифр").optional().describe("ИНН продавца"),
        kpp: z.string().regex(/^\d{9}$/, "9 цифр").optional().describe("КПП продавца"),
        name: z.string().max(255).optional().describe("Наименование продавца"),
      }).optional().describe("source=manual: продавец (нужен inn или onec_counterparty_id)"),
      number: z.string().min(1).max(30).optional().describe("source=manual: номер документа поставщика (входящий номер)"),
      date: date("source=manual: дата документа поставщика").optional(),
      lines: z.array(supplierLine()).min(1).max(200).optional()
        .describe("Строки: для manual обязательны; для diadoc — замена строк документа (у счёта-файла и прочих видов — нужны)"),
      onec_counterparty_id: onecUuid("поставщика").optional().describe("id поставщика в 1С, если по ИНН он не находится однозначно"),
      onec_contract_id: onecUuid("договора").optional().describe("Договор с поставщиком (list_onec_contracts); по умолчанию — основной"),
      nomenclature_id: onecUuid("номенклатуры").optional().describe("Номенклатура 1С для всех строк (search_onec_nomenclature)"),
      line_nomenclature: z.array(z.object({
        line: z.number().int().positive().describe("Номер строки"),
        nomenclature_id: onecUuid("номенклатуры"),
      })).max(200).optional().describe("Номенклатура по строкам: [{line, nomenclature_id}] — важнее общей"),
      document_date: date("Дата документа в 1С (по умолчанию — дата документа поставщика)").optional(),
      upd: z.boolean().optional().describe("Поступление: УПД со счётом-фактурой (по умолчанию — по функции УПД Диадока; для manual — нет)"),
      vat_included: z.boolean().optional()
        .describe("Сумма включает НДС (по умолчанию true). false — НДС сверху: amount/price строк без НДС, 1С добавит НДС (налоговый агент, иностранный поставщик)"),
      post: z.boolean().optional().describe("Провести в 1С — только если об этом явно попросили (по умолчанию false)"),
      comment: z.string().max(1000).optional().describe("Комментарий в 1С (по умолчанию — откуда документ)"),
      allow_duplicate: z.boolean().optional().describe("Создать, хотя в 1С есть документ с тем же входящим номером у того же контрагента (по умолчанию false)"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    const source = a.source ?? (a.message_id || a.entity_id ? "diadoc" : a.document_id || a.attachment_id ? "saby" : "manual");
    if (source !== "diadoc" && (a.message_id || a.entity_id)) return fail("message_id и entity_id — только для source=diadoc.");
    if (source !== "saby" && (a.document_id || a.attachment_id)) return fail("document_id и attachment_id — только для source=saby.");
    if (source === "diadoc" || source === "saby") {
      if (source === "diadoc" && (!a.message_id || !a.entity_id)) return fail("Для source=diadoc нужны message_id и entity_id документа (list_diadoc_documents).");
      if (source === "saby" && !a.document_id) return fail("Для source=saby нужен document_id документа Saby (и attachment_id вложения — list_saby_documents).");
      if (a.seller || a.number || a.date) {
        return fail(`Для source=${source} продавец, номер и дата берутся из документа ${source === "saby" ? "Saby" : "Диадока"} — не передавайте ` +
          "seller, number, date (дата документа в 1С — document_date).");
      }
    } else {
      if (!a.kind) return fail("Для ручного ввода нужен kind: purchase (поступление) или supplier_invoice (счёт от поставщика).");
      if (!a.number || !a.date) return fail("Для ручного ввода нужны number и date документа поставщика.");
      if (!a.lines?.length) return fail("Для ручного ввода нужны строки lines.");
      if (!a.seller?.inn && !a.onec_counterparty_id) return fail("Нужен seller.inn (ИНН продавца) или onec_counterparty_id.");
    }
    for (const [i, l] of (a.lines || []).entries()) {
      if ((l.amount === undefined) === (l.price === undefined)) {
        const vat = a.vat_included === false ? "без НДС" : "с НДС";
        return fail(`lines[${i}]: передайте что-то одно — amount (сумма строки ${vat}) или price (цена ${vat}).`);
      }
    }
    const fields = {
      org_id: a.org_id, source,
      message_id: lc(a.message_id), entity_id: lc(a.entity_id),
      document_id: lc(a.document_id), attachment_id: lc(a.attachment_id),
      kind: a.kind ?? null,
      seller: source === "manual" ? { inn: a.seller?.inn ?? null, kpp: a.seller?.kpp ?? null, name: a.seller?.name?.trim() || null } : null,
      number: a.number?.trim() || null, date: a.date ?? null,
      lines: a.lines ? a.lines.map((l, i) => ({
        line: l.line ?? i + 1, content: l.content.trim(), quantity: l.quantity ?? 1, amount: l.amount ?? null, price: l.price ?? null,
        vat_rate: l.vat_rate.trim(), vat_amount: l.vat_amount ?? null, nomenclature_id: lc(l.nomenclature_id),
      })) : null,
      onec_counterparty_id: lc(a.onec_counterparty_id), onec_contract_id: lc(a.onec_contract_id), nomenclature_id: lc(a.nomenclature_id),
      line_nomenclature: a.line_nomenclature ? a.line_nomenclature.map((x) => ({ line: x.line, nomenclature_id: x.nomenclature_id.toLowerCase() })) : null,
      document_date: a.document_date ?? null, upd: a.upd ?? null, vat_included: a.vat_included ?? null, post: a.post ?? false,
      comment: a.comment?.trim() || null, allow_duplicate: a.allow_duplicate ?? false,
    };
    const { org_id: _org, ...rest } = fields;
    const body = dropNulls({ ...rest, seller: fields.seller ? dropNulls(fields.seller) : null, lines: fields.lines ? fields.lines.map((l) => dropNulls(l)) : null });
    const path = `/onec/${a.org_id}/supplier-documents`;

    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...body, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const text = supplierDocText(d);
      if (d.result === "blocked" || d.blocked) return fail(`${text}\nСоздать нельзя: ${d.blocked ?? d.note ?? "см. проверки"}`);
      if (d.will === "nothing") {
        if (d.result === "exists") return nothingToDo(`${text}\nУже создан в 1С: ${docLine(d.document)} (id ${d.document?.id ?? d.onec_id}). ${d.note ?? ""}`, d);
        const dups = ((d.duplicates || []) as any[]).map((x) => `${docLine(x)}, входящий № ${x.incoming_number || "—"} от ${x.incoming_date || "—"} (id ${x.id})`);
        return nothingToDo(`${text}\n${d.note ?? "В 1С уже есть такой документ"}${dups.length ? "\n" + lines(dups) : ""}`, d);
      }
      return preview("onec_supplier_doc", 0, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_supplier_doc", 0, fields);
    if (!v.ok) return badToken("create_onec_supplier_document", v.reason);
    const env = await call(extra, "POST", path, body);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const doc = d.document || {};
    return ok(`${d.kind_name || "Документ поставщика"} ${d.result === "created" ? "создан" : "уже был"} в 1С org ${d.org_id}: ${docLine(doc)} (id ${doc.id ?? d.onec_id}).` +
      ((d.warnings || []).length ? `\n⚠ ${(d.warnings as string[]).join("\n⚠ ")}` : "") +
      "\nПроверить — get_onec_document; поправить строки, счета учёта, договор — update_onec_document; провести — set_onec_document_state.", d);
  });

  server.registerTool("create_onec_supplier", {
    title: "Поставщик в 1С по ИНН и договор с ним (с подтверждением)",
    description:
      "Найти поставщика в базе 1С по ИНН или завести его по ЕГРЮЛ/ЕГРИП (наименование и реквизиты 1С берёт из реестра) и по " +
      "желанию — договор «С поставщиком» (contract: номер и дата; если такой у поставщика уже есть — новый не создаётся). " +
      "Нужен перед create_onec_supplier_document, когда поставщика в 1С нет. Клиента в balance не заводит. Если " +
      "контрагентов с этим ИНН в 1С несколько — ничего не делается: укажите kpp или пусть бухгалтер разберёт дубли. name — " +
      "только на случай, если реестр недоступен (тогда поставщик заводится по нему). Иностранный поставщик без ИНН, который " +
      "уже есть в 1С, — onec_counterparty_id вместо inn: тогда заводится только договор. Договор с иностранным поставщиком, " +
      "за которого НДС платим мы (налоговый агент, п. 2 ст. 161 НК), — contract.tax_agent=true (вид «Нерезидент» 1С поставит " +
      "сама) и contract.advance_invoice_nomenclature_id — номенклатура строки счетов-фактур налогового агента (как у прежнего " +
      "договора: get_onec_contract → advance_invoice_nomenclature). ДВУХШАГОВО: без confirm — превью и токен; с confirm и ТЕМИ " +
      "ЖЕ полями — запись.",
    inputSchema: {
      org_id: orgId(),
      inn: z.string().regex(INN_RE, "10 или 12 цифр").optional().describe("ИНН поставщика (или onec_counterparty_id)"),
      onec_counterparty_id: onecUuid("поставщика").optional()
        .describe("Поставщик, который уже есть в 1С (иностранный без ИНН) — вместо inn; заводится только договор"),
      kpp: z.string().regex(/^\d{9}$/, "9 цифр").optional().describe("КПП — если у ИНН несколько подразделений"),
      name: z.string().min(1).max(100).optional().describe("Наименование — только на случай недоступного ЕГРЮЛ/ЕГРИП"),
      contract: z.object({
        number: z.string().min(1).max(50).describe("Номер договора"),
        date: date("Дата договора"),
        name: z.string().max(100).optional().describe("Наименование договора (по умолчанию 1С сложит из номера и даты)"),
        tax_agent: z.boolean().optional().describe("Налоговый агент по НДС (иностранный поставщик: НДС платим мы)"),
        tax_agent_kind: z.string().max(50).optional()
          .describe("Вид агентского договора 1С: Нерезидент, НерезидентЭлектронныеУслуги, Аренда… (у иностранного поставщика по умолчанию — Нерезидент)"),
        advance_invoice_nomenclature_id: onecUuid("номенклатуры").optional()
          .describe("Номенклатура строки счетов-фактур налогового агента («Наименование для счёта-фактуры на аванс»)"),
      }).optional().describe("Договор «С поставщиком», если нужен"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    if (!a.inn === !a.onec_counterparty_id) return fail("Передайте что-то одно: inn (поставщик по ИНН) или onec_counterparty_id (уже есть в 1С, без ИНН).");
    if (a.onec_counterparty_id && !a.contract) return fail("По onec_counterparty_id заводится только договор — передайте contract.");
    const c = a.contract;
    const fields = {
      org_id: a.org_id, inn: a.inn ?? null, onec_counterparty_id: lc(a.onec_counterparty_id), kpp: a.kpp ?? null, name: a.name?.trim() || null,
      contract: c ? {
        number: c.number.trim(), date: c.date, name: c.name?.trim() || null, tax_agent: c.tax_agent ?? null,
        tax_agent_kind: c.tax_agent_kind?.trim() || null, advance_invoice_nomenclature_id: lc(c.advance_invoice_nomenclature_id),
      } : null,
    };
    const body = dropNulls({ inn: fields.inn, onec_counterparty_id: fields.onec_counterparty_id, kpp: fields.kpp, name: fields.name,
      contract: fields.contract ? dropNulls(fields.contract) : null });
    const path = `/onec/${a.org_id}/suppliers`;
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...body, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      if (d.result === "ambiguous") return fail(`${d.note}\n${JSON.stringify(d.candidates || [])}`);
      const cp = d.counterparty || {};
      const ct = d.contract;
      const inn = d.inn ?? a.inn;
      const supplier = inn ? `ИНН ${inn}` : `«${cp.name ?? "—"}» без ИНН${cp.country ? ` (${cp.country})` : ""}`;
      const text = `Поставщик ${supplier}${d.kpp ? ` КПП ${d.kpp}` : ""} в 1С org ${d.org_id ?? a.org_id}:\n` + lines([
        cp.result === "exists"
          ? `Уже есть: «${cp.name}» (id ${cp.id}${cp.kpp ? `, КПП ${cp.kpp}` : ""})`
          : `Не найден — будет заведён по ЕГРЮЛ/ЕГРИП${cp.payload?.external_id ? ` (ключ ${cp.payload.external_id})` : ""}` +
            (fields.name ? `; если реестр недоступен — по наименованию «${fields.name}»` : ""),
        ct ? (ct.result === "exists" ? `Договор уже есть: «${ct.name}» (id ${ct.id})` : (ct.note || `Будет заведён договор «С поставщиком» № ${fields.contract?.number} от ${fields.contract?.date}`)) : "",
        ...((d.warnings || []) as string[]).map((w) => `⚠ ${w}`),
      ]);
      if (d.will === "nothing") return nothingToDo(text, d);
      return preview("onec_supplier", 0, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_supplier", 0, fields);
    if (!v.ok) return badToken("create_onec_supplier", v.reason);
    const env = await call(extra, "POST", path, body);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const cp = d.counterparty || {};
    const ct = d.contract;
    const verb = (r: string) => (r === "created" ? "заведён" : "уже был");
    return ok(`Поставщик «${cp.name}» (id ${cp.id}) ${verb(cp.result)} в 1С org ${d.org_id ?? a.org_id}` +
      (ct ? `; договор «${ct.name}» (id ${ct.id}) ${verb(ct.result)}` : "") + "." +
      ((d.warnings || []).length ? `\n⚠ ${(d.warnings as string[]).join("\n⚠ ")}` : ""), d);
  });

  server.registerTool("create_onec_nomenclature", {
    title: "Номенклатура в 1С (с подтверждением)",
    description:
      "Завести позицию номенклатуры (услугу или товар) в базе 1С — она нужна строкам поступления (create_onec_supplier_document). " +
      "Сначала поищите подходящую (search_onec_nomenclature). Если позиция с точно таким наименованием уже есть — новая не " +
      "заводится, превью вернёт её id. Вид номенклатуры (kind) — из get_onec_meta (nomenclature_kinds): если подходящих видов " +
      "несколько, без kind 1С откажет — превью их перечислит, повторите с kind. ДВУХШАГОВО: без confirm — превью и токен; с " +
      "confirm и ТЕМИ ЖЕ полями — запись.",
    inputSchema: {
      org_id: orgId(),
      name: z.string().min(1).max(100).describe("Наименование (до 100 символов)"),
      full_name: z.string().max(1000).optional().describe("Полное наименование (для документов)"),
      is_service: z.boolean().optional().describe("Услуга (по умолчанию true) или товар (false)"),
      kind: z.string().max(100).optional().describe("Вид номенклатуры 1С (get_onec_meta → nomenclature_kinds)"),
      unit: z.string().max(50).optional().describe("Единица измерения"),
      vat_rate: z.string().max(20).optional().describe("Ставка НДС по умолчанию — код 1С (НДС22, БезНДС…)"),
      article: z.string().max(50).optional().describe("Артикул"),
      group_id: onecUuid("группы номенклатуры").optional().describe("Группа (search_onec_nomenclature groups=true)"),
      comment: z.string().max(1000).optional(),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    const t = (s?: string) => s?.trim() || null;
    const fields = {
      org_id: a.org_id, name: a.name.trim(), full_name: t(a.full_name), is_service: a.is_service ?? true, kind: t(a.kind),
      unit: t(a.unit), vat_rate: t(a.vat_rate), article: t(a.article), group_id: lc(a.group_id), comment: t(a.comment),
    };
    if (!fields.name) return fail("name — от 1 до 100 символов.");
    const { org_id: _org, ...rest } = fields;
    const body = dropNulls(rest);
    const path = `/onec/${a.org_id}/nomenclature`;
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...body, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      if (d.result === "exists" || d.will === "nothing") {
        const found = ((d.nomenclature || []) as any[]).map((n) => `«${n.name}» (id ${n.id}${n.is_service === false ? ", товар" : ""})`).join("; ");
        return nothingToDo(`Номенклатура «${fields.name}» уже есть в 1С org ${a.org_id}: ${found || "—"}. Используйте её id.`, d);
      }
      const kinds: string[] = (d.kinds || []).filter(Boolean);
      const p = d.payload || {};
      const text = `Номенклатура «${fields.name}» в 1С org ${a.org_id} не найдена — будет заведена:\n` + lines([
        `${p.is_service === false ? "Товар" : "Услуга"}${p.kind ? `, вид «${p.kind}»` : ""}${p.unit ? `, ед. ${p.unit}` : ""}${p.vat_rate ? `, НДС ${p.vat_rate}` : ""}${p.article ? `, артикул ${p.article}` : ""}`,
        p.full_name ? `Полное наименование: «${p.full_name}»` : "",
        p.external_id ? `Ключ (external_id): ${p.external_id}` : "",
        kinds.length === 1 && !fields.kind ? `Вид номенклатуры: «${kinds[0]}» (единственный подходящий)` : "",
      ]);
      if (!fields.kind && kinds.length > 1) {
        return fail(`${text}\nПодходящих видов номенклатуры несколько — без kind 1С откажет. Повторите с kind — одним из: ${kinds.map((k) => `«${k}»`).join(", ")}.`);
      }
      return preview("onec_nom", 0, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_nom", 0, fields);
    if (!v.ok) return badToken("create_onec_nomenclature", v.reason);
    const env = await call(extra, "POST", path, body);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const n = d.nomenclature || {};
    return ok(`Номенклатура «${n.name ?? fields.name}» ${d.result === "created" ? "заведена" : "уже была"} в 1С org ${a.org_id}: id ${n.id}.`, d);
  });

  server.registerTool("update_onec_document", {
    title: "Поправить документ поставщика в 1С (с подтверждением)",
    description:
      "Поправить в 1С поступление или счёт от поставщика, СОЗДАННЫЙ ЧЕРЕЗ MCP (create_onec_supplier_document): комментарий, " +
      "входящий номер и дату, дату документа, договор, строки (items — ЗАМЕНЯЮТ строки целиком: цена с НДС, при «НДС сверху» — " +
      "без НДС, ставка — код 1С НДС22/БезНДС…, номенклатура, счета учёта строки), счета учёта отдельных строк по номеру " +
      "(item_accounts — без замены строк), счета расчётов (accounts: settlement, advances), «Сумма включает НДС» (vat_included: " +
      "false — НДС сверху; без items 1С пересчитает НДС строк по текущим ценам), проведение (post — только если об этом явно попросили). " +
      "Остальные документы (бухгалтера, реализации, счета клиентам) не правятся — balance откажет. Проведённый документ после " +
      "правки перепроводится. Нужно хотя бы одно поле. ДВУХШАГОВО: без confirm — документ сейчас (строки, счета) и что " +
      "изменится, токен; с confirm и ТЕМИ ЖЕ полями — запись.",
    inputSchema: {
      org_id: orgId(),
      onec_id: onecUuid("документа"),
      comment: z.string().max(1000).optional().describe("Комментарий (пустая строка — очистить)"),
      incoming_number: z.string().max(30).optional().describe("Входящий номер"),
      incoming_date: date("Входящая дата").optional(),
      date: date("Дата документа в 1С").optional(),
      contract_id: onecUuid("договора").optional().describe("Договор с поставщиком (list_onec_contracts)"),
      post: z.boolean().optional().describe("Провести (true) — только если об этом явно попросили"),
      vat_included: z.boolean().optional().describe("Сумма включает НДС: false — НДС сверху (цены без НДС), true — цены с НДС"),
      items: z.array(editItem()).min(1).max(200).optional().describe("Строки — ЗАМЕНЯЮТ строки документа целиком"),
      item_accounts: z.array(z.object({
        line: z.number().int().positive().describe("Номер строки документа"),
        accounts: itemAccounts(),
      })).min(1).max(200).optional().describe("Счета учёта отдельных строк: [{line, accounts}]"),
      accounts: settlementAccounts().optional().describe("Счета расчётов с поставщиком"),
      confirm: confirm(),
    },
    annotations: DESTRUCTIVE,
  }, async (a, extra) => {
    const ch: Record<string, any> = {};
    if (a.comment !== undefined) ch.comment = a.comment.trim();
    if (a.incoming_number !== undefined) ch.incoming_number = a.incoming_number.trim();
    if (a.incoming_date !== undefined) ch.incoming_date = a.incoming_date;
    if (a.date !== undefined) ch.date = a.date;
    if (a.contract_id !== undefined) ch.contract_id = a.contract_id.toLowerCase();
    if (a.post !== undefined) ch.post = a.post;
    if (a.vat_included !== undefined) ch.vat_included = a.vat_included;
    if (a.items !== undefined) {
      ch.items = a.items.map((it) => dropNulls({
        nomenclature_id: lc(it.nomenclature_id), content: it.content?.trim() || null, quantity: it.quantity ?? 1, price: it.price,
        vat_rate: it.vat_rate.trim(), vat_amount: it.vat_amount ?? null, accounts: it.accounts ?? null,
      }));
    }
    if (a.item_accounts !== undefined) ch.item_accounts = a.item_accounts.map((x) => ({ line: x.line, accounts: x.accounts }));
    if (a.accounts !== undefined) ch.accounts = a.accounts;
    const emptyAcc = [...(ch.items || []).map((it: any) => it.accounts), ...(ch.item_accounts || []).map((x: any) => x.accounts), ch.accounts]
      .some((o) => o !== undefined && o !== null && !Object.keys(o).length);
    if (emptyAcc) return fail("Счета (accounts) переданы пустым объектом — укажите хотя бы один счёт или уберите поле.");
    if (!Object.keys(ch).length) {
      return fail("Нечего менять: передайте хотя бы одно поле — comment, incoming_number, incoming_date, date, contract_id, post, vat_included, items, item_accounts или accounts.");
    }
    const uid = a.onec_id.toLowerCase();
    const fields = { org_id: a.org_id, onec_id: uid, changes: ch };
    const path = `/onec/${a.org_id}/documents/${uid}`;

    if (!a.confirm) {
      const env = await call(extra, "PUT", path, { ...ch, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const before: any[] = d.items_before || [];
      const sum = (ch.items || []).reduce((s: number, it: any) => s + Number(it.price) * Number(it.quantity ?? 1), 0);
      const text = `Правка в 1С org ${d.org_id ?? a.org_id}: ${docLine(d.document)} (id ${uid}).\n` + lines([
        "comment" in ch ? `Комментарий: «${ch.comment}»` : "",
        "incoming_number" in ch ? `Входящий номер: ${ch.incoming_number || "(пусто)"}` : "",
        "incoming_date" in ch ? `Входящая дата: ${ch.incoming_date}` : "",
        "date" in ch ? `Дата документа: ${ch.date}` : "",
        "contract_id" in ch ? `Договор: id ${ch.contract_id}` : "",
        "post" in ch ? `Провести: ${ch.post ? "да" : "нет"}` : "",
        "vat_included" in ch ? `Сумма включает НДС: ${ch.vat_included ? "да" : "нет — НДС сверху"}` : "",
        ch.items ? `Строки заменяются целиком: было ${before.length}, станет ${ch.items.length} на ${money(sum)}${ch.vat_included === false ? " без НДС" : ""}` : "",
        ch.item_accounts ? `Счета учёта строк: ${(ch.item_accounts as any[]).map((x) => `№ ${x.line} — ${accText(x.accounts)}`).join("; ")}` : "",
        ch.accounts ? `Счета расчётов: ${accText(ch.accounts)}` : "",
        d.note,
      ]);
      return preview("onec_doc_edit", 0, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_doc_edit", 0, fields);
    if (!v.ok) return badToken("update_onec_document", v.reason);
    const env = await call(extra, "PUT", path, ch);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    return ok(`Изменён в 1С org ${d.org_id ?? a.org_id}: ${docLine(d.summary || d.document)} (было: ${docLine(d.before)}).`, d);
  });

  server.registerTool("create_onec_tax_agent_invoice", {
    title: "Счёт-фактура налогового агента в 1С на оплату иностранному поставщику (с подтверждением)",
    description:
      "Выписать в 1С счёт-фактуру налогового агента на оплату иностранному поставщику (НДС за нерезидента, п. 2 ст. 161 НК) — " +
      "так же, как бухгалтер: «Создать на основании → Счёт-фактура выданный» из списания с расчётного счёта. 1С заполняет " +
      "сама: вид «Налоговый агент», код операции 06, договор и НДС сверху по проводкам оплаты (с 2026 — 22/122), «не " +
      "выставляется»; номенклатура строки — из договора или как у прежних таких СФ по договору. Нужны id оплат в 1С — " +
      "списаний с расчётного счёта (list_onec_documents kind=bank_out по контрагенту; get_onec_document оплаты покажет, есть ли " +
      "уже СФ — поле vat_invoice). Оплата должна быть проведена и по договору с признаком налогового агента. На оплату — одна " +
      "СФ: уже выписанная (бухгалтером или из MCP) не задваивается. Проводится по умолчанию: без проведения НДС не " +
      "начисляется. До 20 оплат за вызов. ДВУХШАГОВО: без confirm — пробная запись в 1С с откатом (как 1С заполнит каждую СФ, " +
      "проводки, предупреждения) и токен, ничего не создаётся; с confirm и ТЕМИ ЖЕ полями — запись. Отменить созданную из " +
      "MCP — set_onec_document_state (delete).",
    inputSchema: {
      org_id: orgId(),
      payment_ids: z.array(onecUuid("оплаты поставщику — списания с расчётного счёта")).min(1).max(20)
        .describe("id оплат (списаний с р/с) в 1С, на каждую — своя СФ"),
      nomenclature_id: onecUuid("номенклатуры").optional()
        .describe("Номенклатура строки СФ (по умолчанию — из договора: «наименование для СФ на аванс», иначе как у прежних СФ по договору)"),
      content: z.string().min(1).max(1000).optional()
        .describe("Содержание строки (по умолчанию — как у прежних СФ по договору или полное наименование номенклатуры)"),
      date: date("Дата СФ — одна на все оплаты, не раньше оплаты (по умолчанию — дата каждой оплаты; обычно не передают)").optional(),
      comment: z.string().max(1000).optional().describe("Комментарий в 1С"),
      post: z.boolean().optional().describe("Провести (по умолчанию true: без проведения НДС не начисляется)"),
      confirm: confirm(),
    },
    annotations: WRITE,
  }, async (a, extra) => {
    const ids = [...new Set(a.payment_ids.map((x) => x.toLowerCase()))];
    const fields = {
      org_id: a.org_id, payment_ids: ids, nomenclature_id: lc(a.nomenclature_id), content: a.content?.trim() || null,
      date: a.date ?? null, comment: a.comment?.trim() || null, post: a.post ?? true,
    };
    const { org_id: _org, payment_ids: _ids, ...rest } = fields;
    const common = dropNulls(rest);
    const path = `/onec/${a.org_id}/tax-agent-invoices`;

    if (!a.confirm) {
      const items: any[] = [];
      const texts: string[] = [];
      let errors = 0;
      for (const id of ids) {
        const env = await call(extra, "POST", path, { payment_id: id, ...common, dry_run: true });
        if (!env.ok) {
          errors++;
          texts.push(`Оплата ${id}: ✖ ${textOfFail(onecFail(env))}`);
          items.push({ payment_id: id, error: env.error ?? null });
          continue;
        }
        items.push(env.data || {});
        texts.push(taxAgentText(env.data || {}));
      }
      const head = `Счета-фактуры налогового агента в 1С org ${a.org_id} — пробная запись с откатом, ${ids.length} опл.:\n`;
      const data = { org_id: a.org_id, items };
      if (errors) {
        return fail(`${head}${texts.join("\n\n")}\n\nПо ${errors} опл. 1С отказала — уберите их из payment_ids или исправьте в 1С и вызовите снова. Ничего не записано.`);
      }
      const toCreate = items.filter((d) => d.will === "create").length;
      if (!toCreate) return nothingToDo(`${head}${texts.join("\n\n")}\nНа все оплаты счета-фактуры уже есть.`, data);
      return preview("onec_tax_agent_invoice", 0, fields, `${head}${texts.join("\n\n")}\n\nБудет выписано: ${toCreate}` +
        (fields.post ? ", с проведением" : ", без проведения") + ".", data);
    }

    const v = verifyConfirmToken(a.confirm, "onec_tax_agent_invoice", 0, fields);
    if (!v.ok) return badToken("create_onec_tax_agent_invoice", v.reason);
    const items: any[] = [];
    const texts: string[] = [];
    let errors = 0;
    for (const id of ids) {
      const env = await call(extra, "POST", path, { payment_id: id, ...common });
      if (!env.ok) {
        errors++;
        texts.push(`Оплата ${id}: ✖ ${textOfFail(onecFail(env))}`);
        items.push({ payment_id: id, error: env.error ?? null });
        continue;
      }
      const d = env.data || {};
      items.push(d);
      const doc = d.document || {};
      texts.push(`${d.result === "created" ? "Выписан" : "Уже был"}: ${docLine(doc)}, НДС ${money(doc.total_vat)} (id ${doc.id ?? d.onec_id}) — ` +
        `на оплату ${d.payment?.title ?? id}` + ((d.warnings || []).length ? `\n  ⚠ ${(d.warnings as string[]).join("\n  ⚠ ")}` : ""));
    }
    const created = items.filter((d) => d.result === "created").length;
    const text = `Счета-фактуры налогового агента в 1С org ${a.org_id}: выписано ${created}, уже было ${items.length - created - errors}` +
      (errors ? `, ошибок ${errors}` : "") + ".\n" + lines(texts) +
      (errors ? "\nПовтор безопасен: на оплату, где СФ уже выписана, вторая не создаётся." : "") +
      "\nПроверить — get_onec_document (блок vat_invoice); отменить созданную из MCP — set_onec_document_state.";
    return errors ? fail(text) : ok(text, { org_id: a.org_id, items });
  });

  server.registerTool("update_onec_supplier_payment", {
    title: "Оплата поставщику в 1С: другой контрагент или договор (с подтверждением)",
    description:
      "Поправить в 1С оплату поставщику — списание с расчётного счёта из выписки: другой контрагент и/или договор. Например, " +
      "выписка записала оплату иностранному поставщику на банк-посредник («ФИЛИАЛ ЦЕНТРАЛЬНЫЙ БАНКА ВТБ») или оплата " +
      "разнесена не на тот договор. Как правка в форме: 1С перезаполняет строки расшифровки (договор, способ погашения, " +
      "ставку НДС, счета расчётов 60.01/60.02), счёт контрагента — основной счёт нового; сумма и назначение платежа — из банка, не " +
      "меняются. При смене контрагента нужен contract_id (договор с ним: list_onec_contracts). Если на оплату уже выписан " +
      "счёт-фактура налогового агента, а договор меняется — 1С откажет, пока не передан refill_vat_invoice=true: тогда СФ " +
      "перезаполнится по оплате (номер и дата прежние). Нет СФ, а договор агентский — после правки выпишите её: " +
      "create_onec_tax_agent_invoice. Проведённая оплата перепроводится. ДВУХШАГОВО: без confirm — пробная правка в 1С с " +
      "откатом (что изменится, проводки оплаты и СФ) и токен; с confirm и ТЕМИ ЖЕ полями — запись.",
    inputSchema: {
      org_id: orgId(),
      onec_id: onecUuid("оплаты (списания с расчётного счёта)"),
      counterparty_id: onecUuid("нового контрагента").optional().describe("Новый контрагент (search_onec_counterparties); тогда нужен и contract_id"),
      contract_id: onecUuid("договора").optional().describe("Договор для всех строк оплаты (list_onec_contracts)"),
      refill_vat_invoice: z.boolean().optional().describe("Перезаполнить СФ налогового агента на эту оплату (по умолчанию false)"),
      comment: z.string().max(1000).optional().describe("Комментарий в 1С (пустая строка — очистить)"),
      post: z.boolean().optional().describe("Провести после правки (по умолчанию — как было: проведённая перепроводится)"),
      confirm: confirm(),
    },
    annotations: DESTRUCTIVE,
  }, async (a, extra) => {
    if (a.counterparty_id && !a.contract_id) return fail("При смене контрагента нужен contract_id — договор с новым контрагентом (list_onec_contracts).");
    if (!a.contract_id && a.comment === undefined) return fail("Нечего менять: передайте contract_id (и counterparty_id, если меняется контрагент) или comment.");
    const ch: Record<string, any> = dropNulls({
      counterparty_id: lc(a.counterparty_id), contract_id: lc(a.contract_id), refill_vat_invoice: a.refill_vat_invoice ?? null, post: a.post ?? null,
    });
    if (a.comment !== undefined) ch.comment = a.comment.trim();
    const uid = a.onec_id.toLowerCase();
    const fields = { org_id: a.org_id, onec_id: uid, changes: ch };
    const path = `/onec/${a.org_id}/documents/${uid}/rebind`;
    if (!a.confirm) {
      const env = await call(extra, "POST", path, { ...ch, dry_run: true });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const text = paymentEditText(d);
      if (d.will === "nothing") return nothingToDo(`${text}\nНичего не изменится.`, d);
      return preview("onec_payment_rebind", 0, fields, text, d);
    }
    const v = verifyConfirmToken(a.confirm, "onec_payment_rebind", 0, fields);
    if (!v.ok) return badToken("update_onec_supplier_payment", v.reason);
    const env = await call(extra, "POST", path, ch);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    return ok(`Оплата ${d.result === "updated" ? "изменена" : "не изменилась"} в 1С org ${d.org_id ?? a.org_id}: ${docLine(d.after || d.document)}` +
      (d.vat_invoice ? `; перезаполнен ${d.vat_invoice.title} (договор ${d.vat_invoice.contract?.name ?? "—"}, НДС ${money(d.vat_invoice.total_vat)})` : "") +
      ". Счёт-фактура налогового агента, если её ещё нет, — create_onec_tax_agent_invoice.", d);
  });
}

/** Превью правки оплаты поставщику: было, что изменится, проводки оплаты и СФ налогового агента. */
function paymentEditText(d: any): string {
  const ent = (xs: any[]) => (xs || []).map((e) => `Дт ${e.debit} Кт ${e.credit} ${money(e.amount)}`).join("; ");
  const sf = d.vat_invoice;
  return `Оплата в 1С org ${d.org_id}: ${docLine(d.document)}\n` + lines([
    `Сейчас: ${d.counterparty_before?.name ?? "—"}, договор ${(d.contracts_before || []).join(", ") || "—"}`,
    ...((d.changes || []) as any[]).map((c) => `${c.field}: ${typeof c.old === "object" && c.old ? c.old.name : c.old ?? "—"} → ` +
      `${typeof c.new === "object" && c.new ? c.new.name : c.new ?? "—"}`),
    (d.entries || []).length ? `Проводки оплаты после правки: ${ent(d.entries)}` : "",
    sf ? `СФ налогового агента ${sf.title}: договор ${sf.contract?.name ?? "—"}, НДС ${money(sf.total_vat)} (${sf.vat_rate ?? "—"})` +
      ((d.vat_invoice_entries || []).length ? `; проводки: ${ent(d.vat_invoice_entries)}` : "") : "",
    d.note,
  ]);
}

/** Текст ошибки из результата fail() — для сводки по нескольким оплатам. */
function textOfFail(r: any): string {
  return String(r?.content?.[0]?.text ?? "Ошибка");
}

/** Пробная СФ налогового агента (превью balance) — одной строкой с подробностями. */
function taxAgentText(d: any): string {
  const p = d.payment || {};
  const doc = d.document || {};
  const pay = `Оплата ${p.title ?? "—"} на ${money(p.amount)}${p.counterparty?.name ? `, ${p.counterparty.name}` : ""}` +
    ((p.contracts || []).length ? `, договор ${(p.contracts as string[]).join(", ")}` : "");
  if (d.will === "nothing") return `${pay}\n  → ${d.note ?? "СФ уже есть"}: ${docLine(doc)} (id ${doc.id ?? "—"})`;
  const rows = ((doc.advances || []) as any[]).map((r) =>
    `«${r.content || r.nomenclature || "без содержания"}» ${money(r.amount)}, НДС ${money(r.vat_amount)} (${r.vat_rate ?? "—"})` +
    (r.nomenclature && r.nomenclature !== r.content ? `, номенклатура «${r.nomenclature}»` : ""));
  const entries = ((d.entries || []) as any[]).map((e) => `Дт ${e.debit} Кт ${e.credit} ${money(e.amount)}`);
  return `${pay}\n` + lines([
    `СФ «${doc.type_name ?? "—"}», код операции ${doc.operation_code ?? "—"}, от ${doc.date ?? "—"}: ${money(doc.total)}, НДС ${money(doc.total_vat)} (${doc.vat_rate ?? "—"})` +
      (doc.contract?.name ? `, договор ${doc.contract.name}` : ""),
    ...rows.map((r) => `Строка: ${r}`),
    entries.length ? `Проводки: ${entries.join("; ")}` : "",
    doc.responsible ? `Ответственный ${doc.responsible}${doc.head ? `, руководитель ${doc.head}` : ""}` : "",
    ...((d.warnings || []) as string[]).map((w) => `⚠ ${w}`),
  ]);
}
