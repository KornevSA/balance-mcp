// Тулзы 1С — ЧТЕНИЕ (этапы 1–2 проекта docs/onec-api-design.md). Запись (этапы 3–5) — onecWrite.ts.
//
// MCP в 1С не ходит: каждый тулз зовёт balance /api/v1 (/onec/…, /customers/{id}/onec,
// /documents/{id}/onec), а balance сам выбирает базу 1С по org_id, проверяет скоуп onec:read,
// право onec.view и зону видимости, пишет журнал onec_audit_log и ходит в API v1 базы.
// Одна организация = одна база 1С (ИП Корнев, Интер, НотиСенд). id 1С — UUID; customer_id
// и doc_id — id balance. Тайм-аут вызова balance — 120 с: холодная 1С отвечает долго.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall, balanceFetchBinary, type Envelope } from "../balanceClient.js";
import { CFG } from "../config.js";
import { putDownload, linkTtlMinutes } from "../downloadStore.js";
import { tokenOf, qs, ok, fail, publicBaseOf } from "./util.js";

export const ONEC_TIMEOUT_MS = 120_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = [
  "sale", "sale_return", "sale_correction", "invoice", "vat_invoice", "purchase",
  "bank_in", "bank_out", "cash_in", "cash_out", "card_payment", "reconciliation",
] as const;

const orgId = () => z.number().int().positive().describe("Организация = база 1С: org_id из list_onec_bases");
const onecUuid = (what: string) => z.string().regex(UUID_RE, "UUID ссылки 1С").describe(`id ${what} в 1С (UUID)`);
const date = (what: string) => z.string().regex(DATE_RE, "ГГГГ-ММ-ДД").describe(`${what}, ГГГГ-ММ-ДД`);
const limit = () => z.number().int().min(1).max(200).optional().describe("Размер страницы, 1–200 (по умолчанию 50)");
const offset = () => z.number().int().min(0).max(10000).optional().describe("Смещение, 0–10000");

/** GET к balance с тайм-аутом для 1С. */
function get(extra: any, path: string): Promise<Envelope> {
  return balanceCall(tokenOf(extra), "GET", path, undefined, { timeoutMs: ONEC_TIMEOUT_MS });
}

/** Ошибка balance/1С для модели: текст + код + request_id (+ кандидаты, если balance их вернул). */
export function onecFail(env: any) {
  const e = env?.error || {};
  let t = String(e.message || "Ошибка");
  if (e.code) t += ` [${e.code}]`;
  if (e.request_id) t += ` (запрос ${e.request_id})`;
  if (Array.isArray(e.candidates) && e.candidates.length) {
    t += `\nПодходящие контрагенты в 1С (выберите id и вызовите по onec_id):\n${JSON.stringify(e.candidates)}`;
  }
  if (Array.isArray(e.warnings) && e.warnings.length) t += `\n${e.warnings.join("\n")}`;
  return fail(t);
}

export function money(v: any): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v ?? "—");
}

export function docLine(d: any): string {
  if (!d) return "";
  const flags = [d.posted === false ? "не проведён" : "", d.deleted ? "помечен на удаление" : ""].filter(Boolean).join(", ");
  return `${d.kind_name || d.kind || "документ"} № ${d.number ?? "—"} от ${String(d.date ?? "").slice(0, 10)} на ${money(d.amount)}` +
    (d.counterparty?.name ? `, ${d.counterparty.name}` : "") + (flags ? ` (${flags})` : "");
}

/** Байты из balance → временная ссылка /mcp/file/<token>/<имя>, как deliverFile (fileTransfer.ts). */
async function deliverOnecPdf(extra: any, path: string, label: string) {
  const f = await balanceFetchBinary(tokenOf(extra), path, { timeoutMs: ONEC_TIMEOUT_MS });
  if (f.error) return fail(f.error);
  if (f.redirectUrl) return fail(`balance ответил перенаправлением (${f.redirectUrl}) — PDF из 1С так не отдаётся`);
  if (!f.ok) {
    try {
      const j = JSON.parse(f.buffer.toString("utf8"));
      if (j && j.error) return onecFail(j);
    } catch { /* не JSON */ }
    return fail(`Не удалось получить PDF из 1С (${label}): HTTP ${f.status}`);
  }
  const name = f.filename || label;
  const size = f.buffer.length;
  const ctype = f.contentType || "application/pdf";
  const sha256 = createHash("sha256").update(f.buffer).digest("hex");
  let form = f.headers?.get("x-onec-form") || "";
  try { form = decodeURIComponent(form); } catch { /* как есть */ }
  const requestId = f.headers?.get("x-onec-request-id") || "";
  const human = size < 1048576 ? `${Math.max(1, Math.round(size / 1024))} КБ` : `${(size / 1048576).toFixed(1)} МБ`;

  const dl = putDownload(f.buffer, name, ctype);
  if (!dl) {
    return ok(`Файл «${name}» (${human}, ${ctype}) больше лимита ссылки ${Math.round(CFG.linkMaxBytes / 1048576)} МБ — ` +
      `откройте документ в 1С.`, { name, size_bytes: size, sha256, content_type: ctype, form, request_id: requestId });
  }
  const url = `${publicBaseOf(extra)}/mcp/file/${dl}/${encodeURIComponent(name.replace(/[\\/]+/g, "_"))}`;
  const text = `PDF из 1С${form ? ` (форма ${form})` : ""}: «${name}» — ${human} (${size} байт), ${ctype}, sha256 ${sha256}.\n` +
    `Ссылка (живёт ${linkTtlMinutes()} мин, откроется в браузере без авторизации): ${url}\n` +
    `Это печатная форма «как сейчас в 1С»; в balance она не сохранялась и клиенту не отправлялась.`;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { name, size_bytes: size, sha256, content_type: ctype, url, ttl_minutes: linkTtlMinutes(), form, request_id: requestId },
  };
}

/** Документ 1С задаётся либо doc_id balance, либо org_id + onec_id. Возвращает путь или текст ошибки. */
function docPath(a: { org_id?: number; onec_id?: string; doc_id?: number }, sub: string): { path?: string; err?: string } {
  if (a.doc_id && a.onec_id) return { err: "Передайте что-то одно: doc_id (документ balance) или onec_id (документ 1С)." };
  if (a.doc_id) return { path: `/documents/${a.doc_id}/onec${sub}` };
  if (a.onec_id) {
    if (!a.org_id) return { err: "Для onec_id нужен org_id — база 1С, где этот документ (list_onec_bases)." };
    return { path: `/onec/${a.org_id}/documents/${a.onec_id}${sub}` };
  }
  return { err: "Передайте doc_id (документ balance) или org_id + onec_id (документ 1С)." };
}

export function registerOneCTools(server: McpServer) {
  // ---------------------------------------------------------------- базы и справочники
  server.registerTool("list_onec_bases", {
    title: "Базы 1С по организациям",
    description:
      "Базы 1С по организациям: для каждой org_id — подключено ли API 1С (ready / v1_state=ok), когда проверялось, " +
      "имя публикации и версия API. Вызывайте первым, чтобы выбрать org_id для остальных тулзов 1С. " +
      "Одна организация — одна база 1С (ИП Корнев, Интер, НотиСенд). Тулзы get/list/search/lookup_onec_* только читают 1С; " +
      "запись — отдельные тулзы с подтверждением (create_onec_*, fill_onec_*, send_document_to_onec, pull_onec_bank_payments, " +
      "set_onec_document_state).",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async (_a, extra) => {
    const env = await get(extra, "/onec/bases");
    if (!env.ok) return onecFail(env);
    const items: any[] = env.data?.items || [];
    const line = items.map((b) => `org ${b.org_id} «${b.name}»${b.publication ? ` (${b.publication})` : ""}: ` +
      (b.ready ? "готова" : `не готова — ${b.not_ready_reason}`)).join("; ");
    return ok(`Баз 1С: ${items.length}. ${line}`, env.data);
  });

  server.registerTool("get_onec_meta", {
    title: "Справочники базы 1С",
    description:
      "Справочные данные базы 1С: организации базы, коды ставок НДС, виды документов (kind), виды номенклатуры, " +
      "виды оплат картой и СБП (эквайер, договор эквайринга, счёт). Нужно, чтобы понять коды в документах 1С. " +
      "Кэшируется в balance на 10 минут.",
    inputSchema: { org_id: orgId() },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const env = await get(extra, `/onec/${a.org_id}/meta`);
    if (!env.ok) return onecFail(env);
    const orgs = (env.data?.organizations || []).map((o: any) => o.name).join(", ");
    return ok(`База 1С org ${a.org_id}: API ${env.data?.api_version ?? "?"}, организации: ${orgs || "—"}`, env.data);
  });

  // ---------------------------------------------------------------- контрагенты
  server.registerTool("search_onec_counterparties", {
    title: "Поиск контрагентов в 1С",
    description:
      "Поиск контрагентов в базе 1С организации: по точному ИНН, части наименования (q) или дате создания " +
      "(created_from — так видны новые контрагенты, в том числе созданные загрузкой выписки). Нужен хотя бы один " +
      "параметр. Возвращает id 1С (UUID), а не customer_id balance; связанные клиенты balance — в " +
      "balance_customer_ids. Помеченные на удаление не показываются. Пользователю с зоной дилера доступен " +
      "только поиск по ИНН своих клиентов.",
    inputSchema: {
      org_id: orgId(),
      inn: z.string().regex(/^\d{10}(\d{2})?$/, "10 или 12 цифр").optional().describe("ИНН, точное совпадение"),
      q: z.string().max(100).optional().describe("Часть наименования или полного наименования"),
      created_from: date("Созданные с даты").optional(),
      limit: limit(),
      offset: offset(),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (!a.inn && !a.q && !a.created_from) return fail("Нужен хотя бы один параметр: inn, q или created_from.");
    const { org_id, ...q } = a;
    const env = await get(extra, `/onec/${org_id}/counterparties` + qs(q));
    if (!env.ok) return onecFail(env);
    const items: any[] = env.data?.items || [];
    return ok(`Контрагентов 1С на странице: ${items.length} из ${env.data?.total ?? items.length}` +
      (env.data?.hidden_by_zone ? ` (скрыто зоной видимости: ${env.data.hidden_by_zone})` : ""), env.data);
  });

  server.registerTool("get_onec_counterparty", {
    title: "Контрагент в 1С",
    description:
      "Карточка контрагента в 1С: реквизиты, адреса, договоры, банковские счета, версия данных. Передайте onec_id " +
      "(id 1С) или customer_id (клиент balance). По customer_id balance сам найдёт контрагента 1С — по сохранённой " +
      "связи, по ключу external_id, с которым его заводит balance, или по ИНН (+КПП) — и покажет, как нашёл " +
      "(match.by: map, external_id, inn). Найденного однозначно запоминает. Если подходят несколько — вернёт " +
      "кандидатов (match.candidates) и выбирать не будет.",
    inputSchema: {
      org_id: orgId(),
      onec_id: onecUuid("контрагента").optional(),
      customer_id: z.number().int().positive().optional().describe("id клиента в balance"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (!!a.onec_id === !!a.customer_id) return fail("Передайте что-то одно: onec_id (id 1С) или customer_id (balance).");
    if (a.onec_id) {
      const env = await get(extra, `/onec/${a.org_id}/counterparties/${a.onec_id}`);
      if (!env.ok) return onecFail(env);
      const d = env.data;
      return ok(`Контрагент 1С «${d?.name}» ИНН ${d?.inn || "—"}${d?.kpp ? ` КПП ${d.kpp}` : ""}; ` +
        `клиенты balance: ${(d?.balance_customer_ids || []).join(", ") || "не сопоставлен"}`, d);
    }
    const env = await get(extra, `/customers/${a.customer_id}/onec` + qs({ org_id: a.org_id }));
    if (!env.ok) return onecFail(env);
    const d = env.data;
    const by: Record<string, string> = { map: "по сохранённой связи", external_id: `по ключу ${d?.match?.external_id}`, inn: "по ИНН" };
    if (d?.counterparty) {
      return ok(`Клиент balance #${a.customer_id} в 1С org ${a.org_id}: «${d.counterparty.name}» (id ${d.counterparty.id}), ` +
        `найден ${by[d.match.by] || d.match.by}${d.match.remembered ? ", связь запомнена" : ""}`, d);
    }
    const n = d?.match?.candidates?.length || 0;
    return ok(`Клиент balance #${a.customer_id} в 1С org ${a.org_id} однозначно не найден` +
      (n ? `: подходят ${n} — выберите id 1С сами` : " — ни по связи, ни по ключу, ни по ИНН"), d);
  });

  server.registerTool("get_onec_settlement", {
    title: "Сальдо с контрагентом по 1С",
    description:
      "Сальдо расчётов с контрагентом по данным бухгалтерии 1С на конец дня date: счета 60, 62, 76 по договорам, " +
      "как есть. balance > 0 — контрагент должен нам, < 0 — мы ему (в том числе авансы). Знак ПРОТИВОПОЛОЖЕН " +
      "get_customer_settlement (там > 0 — переплата клиента). Может не совпадать с balance: например, в 1С " +
      "ИП Корнев реализации прошлых лет проведены на 62 без субсчёта и долги не зачтены с авансами — это вопрос " +
      "учёта у бухгалтера, а не ошибка. Передайте onec_id (id 1С) или customer_id (balance).",
    inputSchema: {
      org_id: orgId(),
      onec_id: onecUuid("контрагента").optional(),
      customer_id: z.number().int().positive().optional().describe("id клиента в balance"),
      date: date("На конец дня, по умолчанию сегодня").optional(),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (!!a.onec_id === !!a.customer_id) return fail("Передайте что-то одно: onec_id (id 1С) или customer_id (balance).");
    const path = a.onec_id
      ? `/onec/${a.org_id}/counterparties/${a.onec_id}/settlement` + qs({ date: a.date })
      : `/customers/${a.customer_id}/onec/settlement` + qs({ org_id: a.org_id, date: a.date });
    const env = await get(extra, path);
    if (!env.ok) return onecFail(env);
    const t = env.data?.totals || {};
    const bal = Number(t.balance);
    const who = !Number.isFinite(bal) || bal === 0 ? "расчёты закрыты" : bal > 0 ? "контрагент должен нам" : "мы должны контрагенту (или аванс)";
    return ok(`Сальдо по данным 1С на ${env.data?.date ?? "сегодня"}: ${money(t.balance)} — ${who} ` +
      `(дебет ${money(t.debit)}, кредит ${money(t.credit)}).`, env.data);
  });

  // ---------------------------------------------------------------- документы
  server.registerTool("list_onec_documents", {
    title: "Документы в 1С",
    description:
      "Документы в базе 1С: реализации, счета, поступления на счёт (bank_in), списания, касса, оплаты картой, " +
      "акты сверки и др. (kind). По контрагенту (onec_counterparty_id или customer_id) — новые сначала, без from — " +
      "за последний год. По всем контрагентам — по возрастанию даты, from обязателен, окно до 92 дней (только " +
      "пользователю без зоны дилера). Непроведённые показываются всегда, помеченные — с include_deleted. У " +
      "поступлений на счёт есть плательщик по выписке (payer), покупатель по номеру счёта (buyer, invoices) и " +
      "attention — признаки оплаты за третье лицо или через посредника. Связанные документы balance — balance_doc_id.",
    inputSchema: {
      org_id: orgId(),
      from: date("Начало периода").optional(),
      to: date("Конец периода").optional(),
      kind: z.array(z.enum(KINDS)).optional().describe("Виды документов 1С, по умолчанию все"),
      onec_counterparty_id: onecUuid("контрагента").optional(),
      customer_id: z.number().int().positive().optional().describe("id клиента в balance — его документы в 1С"),
      include_deleted: z.boolean().optional().describe("Вместе с помеченными на удаление"),
      limit: limit(),
      offset: offset(),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (a.onec_counterparty_id && a.customer_id) return fail("Передайте что-то одно: onec_counterparty_id или customer_id.");
    const q = { from: a.from, to: a.to, kind: a.kind, include_deleted: a.include_deleted, limit: a.limit, offset: a.offset };
    let path: string;
    if (a.onec_counterparty_id) path = `/onec/${a.org_id}/counterparties/${a.onec_counterparty_id}/documents` + qs(q);
    else if (a.customer_id) path = `/customers/${a.customer_id}/onec/documents` + qs({ org_id: a.org_id, ...q });
    else {
      if (!a.from) return fail("Для документов по всем контрагентам нужен from (окно до 92 дней) — или укажите контрагента.");
      path = `/onec/${a.org_id}/documents` + qs(q);
    }
    const env = await get(extra, path);
    if (!env.ok) return onecFail(env);
    const items: any[] = env.data?.items || [];
    const p = env.data?.period || {};
    const linked = items.filter((d) => d.balance_doc_id).length;
    return ok(`Документов 1С на странице: ${items.length} из ${env.data?.total ?? items.length}` +
      ` (период ${p.from ?? "—"} — ${p.to ?? "…"}), связаны с balance: ${linked}`, env.data);
  });

  server.registerTool("get_onec_document", {
    title: "Документ в 1С",
    description:
      "Документ в 1С со строками: номер, дата, проведён ли, помечен ли, сумма, контрагент, договор, строки с НДС и " +
      "счетами учёта, расшифровка платежа, счёт-фактура. Три способа: doc_id (документ balance — покажет, связан ли " +
      "он с 1С, откуда связь и совпадают ли номер, дата, сумма и контрагент: compare.state ok | suspect | foreign | " +
      "deleted | missing), org_id + onec_id (id 1С) или org_id + kind + external_id (документ, созданный через API " +
      "1С, например оплата картой). version меняется при любой правке в 1С. Данные и PDF, сохранённые в balance, — " +
      "get_document и get_document_pdf.",
    inputSchema: {
      org_id: orgId().optional(),
      onec_id: onecUuid("документа").optional(),
      doc_id: z.number().int().positive().optional().describe("id документа в balance"),
      kind: z.enum(KINDS).optional().describe("Вид документа — вместе с external_id"),
      external_id: z.string().max(100).optional().describe("Ключ документа, созданного через API 1С (balance:act:N, routerai:tx:N…)"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const ways = [a.doc_id ? 1 : 0, a.onec_id ? 1 : 0, a.external_id ? 1 : 0].reduce((x, y) => x + y, 0);
    if (ways !== 1) return fail("Передайте ровно одно: doc_id, onec_id (с org_id) или kind + external_id (с org_id).");
    if (a.doc_id) {
      const env = await get(extra, `/documents/${a.doc_id}/onec`);
      if (!env.ok) return onecFail(env);
      const d = env.data;
      if (!d?.linked) return ok(`Документ balance #${a.doc_id} с 1С не связан (${d?.link?.source ?? "связи нет"}).`, d);
      if (!d.onec) return ok(`Документ balance #${a.doc_id}: по связи (${d.link.source}) документа в 1С нет — ${d.compare?.text}`, d);
      return ok(`Документ balance #${a.doc_id} в 1С org ${d.link.org_id}: ${docLine(d.onec)}. Сверка: ${d.compare?.state} — ${d.compare?.text}`, d);
    }
    if (!a.org_id) return fail("Нужен org_id — база 1С (list_onec_bases).");
    if (!a.onec_id && !a.kind) return fail("Для external_id нужен kind — вид документа.");
    const path = a.onec_id
      ? `/onec/${a.org_id}/documents/${a.onec_id}`
      : `/onec/${a.org_id}/documents/by-external-id` + qs({ kind: a.kind, external_id: a.external_id });
    const env = await get(extra, path);
    if (!env.ok) return onecFail(env);
    return ok(`Документ 1С: ${docLine(env.data)}` + (env.data?.balance_doc_id ? `; в balance — документ #${env.data.balance_doc_id}` : ""), env.data);
  });

  // ---------------------------------------------------------------- договоры и номенклатура
  server.registerTool("list_onec_contracts", {
    title: "Договоры в 1С",
    description:
      "Договоры в 1С: основной ли (его 1С подставляет в новые документы), закрыт ли, сколько по нему документов, " +
      "дата последнего и сальдо по договору (balance > 0 — контрагент должен нам). Помогает найти дубли договоров " +
      "и понять, на какой договор легли оплаты. Отбор — контрагент (onec_counterparty_id или customer_id balance), " +
      "kind (СПокупателем, СПоставщиком, Прочее…), number, date; без контрагента — только пользователю без зоны дилера.",
    inputSchema: {
      org_id: orgId(),
      onec_counterparty_id: onecUuid("контрагента").optional(),
      customer_id: z.number().int().positive().optional().describe("id клиента в balance"),
      kind: z.string().max(50).optional().describe("Вид договора 1С: СПокупателем, СПоставщиком, Прочее…"),
      number: z.string().max(50).optional().describe("Точный номер договора"),
      date: date("Дата договора").optional(),
      include_deleted: z.boolean().optional(),
      limit: limit(),
      offset: offset(),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (a.onec_counterparty_id && a.customer_id) return fail("Передайте что-то одно: onec_counterparty_id или customer_id.");
    const { org_id, onec_counterparty_id, ...rest } = a;
    const env = await get(extra, `/onec/${org_id}/contracts` + qs({ counterparty_id: onec_counterparty_id, ...rest }));
    if (!env.ok) return onecFail(env);
    const items: any[] = env.data?.items || [];
    return ok(`Договоров 1С: ${items.length} из ${env.data?.total ?? items.length}`, env.data);
  });

  server.registerTool("get_onec_contract", {
    title: "Договор в 1С",
    description:
      "Один договор 1С: то же, что в списке (основной, закрыт, документов, сальдо), плюс комментарий, срок действия, " +
      "срок оплаты, сумма, подписан ли.",
    inputSchema: { org_id: orgId(), onec_id: onecUuid("договора") },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const env = await get(extra, `/onec/${a.org_id}/contracts/${a.onec_id}`);
    if (!env.ok) return onecFail(env);
    const d = env.data;
    return ok(`Договор 1С «${d?.name}»${d?.counterparty?.name ? ` с «${d.counterparty.name}»` : ""}, сальдо ${money(d?.balance)}`, d);
  });

  server.registerTool("search_onec_nomenclature", {
    title: "Номенклатура в 1С",
    description:
      "Номенклатура (товары и услуги) в базе 1С: по части наименования (q), точному артикулу или группе (parent_id); " +
      "groups=true — список групп. Наименования в 1С повторяются (например, две «Услуги по отправке сообщений») — " +
      "ориентируйтесь на id. Помеченные на удаление не показываются.",
    inputSchema: {
      org_id: orgId(),
      q: z.string().max(100).optional(),
      article: z.string().max(50).optional(),
      parent_id: onecUuid("группы").optional(),
      groups: z.boolean().optional().describe("true — список групп вместо позиций"),
      limit: limit(),
      offset: offset(),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (!a.q && !a.article && !a.parent_id && !a.groups) return fail("Нужен хотя бы один параметр: q, article, parent_id или groups=true.");
    const { org_id, ...q } = a;
    const env = await get(extra, `/onec/${org_id}/nomenclature` + qs(q));
    if (!env.ok) return onecFail(env);
    const items: any[] = env.data?.items || [];
    return ok(`Позиций номенклатуры 1С: ${items.length} из ${env.data?.total ?? items.length}`, env.data);
  });

  server.registerTool("lookup_onec_registry", {
    title: "ЕГРЮЛ/ЕГРИП через 1С",
    description:
      "Официальные сведения ЕГРЮЛ/ЕГРИП по ИНН через сервис 1С:Контрагент: наименования, КПП, ОГРН, адрес, " +
      "руководитель, статус (действует или прекращена, дата прекращения), ОКВЭД, налоговая, история наименований, " +
      "КПП и адресов. Ничего не создаёт ни в 1С, ни в balance. В отличие от lookup_company_by_inn (DaData) — с " +
      "историей изменений. Ответ кэшируется на сутки; лимит запросов сервиса общий для всех — не перебирайте ИНН пачками.",
    inputSchema: {
      inn: z.string().regex(/^\d{10}(\d{2})?$/, "10 или 12 цифр").describe("ИНН юрлица (10) или ИП (12)"),
      org_id: z.number().int().positive().optional().describe("Через какую базу 1С спросить; по умолчанию первая готовая"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const env = await get(extra, `/onec/registry/${a.inn}` + qs({ org_id: a.org_id }));
    if (!env.ok) return onecFail(env);
    const d = env.data;
    return ok(`${d?.full_name || d?.name || "—"}, ИНН ${d?.inn}${d?.kpp ? ` КПП ${d.kpp}` : ""}, ` +
      `статус: ${d?.status?.name || "—"}${d?.termination_date ? `, прекращена ${d.termination_date}` : ""}` +
      (d?.cached_at ? ` (из кэша от ${d.cached_at})` : ""), d);
  });

  // ---------------------------------------------------------------- история, печать, PDF (этап 2)
  server.registerTool("get_onec_document_history", {
    title: "История документа в 1С",
    description:
      "Кто и когда менял документ в 1С: версии (номер, дата, автор, тип, комментарий), с changes=true — какие " +
      "реквизиты изменились (было → стало) и в каких таблицах менялось число строк. Правки через API записаны на " +
      "пользователя 1С, под которым работает balance. История может быть пустой, если в 1С для этого вида не " +
      "включено версионирование. Документ — doc_id (balance) или org_id + onec_id.",
    inputSchema: {
      org_id: orgId().optional(),
      onec_id: onecUuid("документа").optional(),
      doc_id: z.number().int().positive().optional().describe("id документа в balance"),
      changes: z.boolean().optional().describe("Показать, что изменилось в каждой версии"),
      limit: limit(),
      offset: offset(),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const p = docPath(a, "/history");
    if (p.err) return fail(p.err);
    const env = await get(extra, p.path! + qs({ changes: a.changes, limit: a.limit, offset: a.offset }));
    if (!env.ok) return onecFail(env);
    const items: any[] = env.data?.items || [];
    return ok(`Версий документа в 1С: ${items.length}${env.data?.total !== undefined ? ` из ${env.data.total}` : ""}`, env.data);
  });

  server.registerTool("list_onec_print_forms", {
    title: "Печатные формы документа 1С",
    description:
      "Какие печатные формы есть у документа 1С (Акт, УПД, Счёт-фактура, ТОРГ-12, Счёт, Акт сверки…) — их " +
      "идентификаторы (form) для get_onec_document_pdf. Документ — doc_id (balance) или org_id + onec_id. " +
      "Первый вызов по виду документа бывает долгим (до 15 с).",
    inputSchema: {
      org_id: orgId().optional(),
      onec_id: onecUuid("документа").optional(),
      doc_id: z.number().int().positive().optional().describe("id документа в balance"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const p = docPath(a, "/print-forms");
    if (p.err) return fail(p.err);
    const env = await get(extra, p.path!);
    if (!env.ok) return onecFail(env);
    const forms: any[] = env.data?.items || [];
    return ok(`Печатные формы: ${forms.map((f) => `${f.form} («${f.name}»)`).join(", ") || "нет"}`, env.data);
  });

  server.registerTool("get_onec_document_pdf", {
    title: "PDF документа из 1С",
    description:
      "PDF печатной формы прямо из 1С — как документ выглядит в 1С сейчас. Возвращает ВРЕМЕННУЮ ссылку (30 минут). " +
      "Документ — doc_id (balance; форма по умолчанию: счёт — СчетЗаказ, реализация — УПД или Акт, акт сверки — " +
      "АктСверки) или org_id + onec_id (тогда form обязателен — список даёт list_onec_print_forms). stamp — с " +
      "факсимиле подписи и печати (по умолчанию да). Формируется до 20 секунд. Это НЕ тот PDF, что сохранён в " +
      "balance и уходит клиенту (тот — get_document_pdf); в balance этот файл не сохраняется.",
    inputSchema: {
      org_id: orgId().optional(),
      onec_id: onecUuid("документа").optional(),
      doc_id: z.number().int().positive().optional().describe("id документа в balance"),
      form: z.string().max(100).optional().describe("Идентификатор печатной формы: Акт, УниверсальныйПередаточныйДокумент, СчетЗаказ, АктСверки…"),
      stamp: z.boolean().optional().describe("С факсимиле подписи и печати (по умолчанию true)"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const p = docPath(a, "/pdf");
    if (p.err) return fail(p.err);
    if (a.onec_id && !a.form) return fail("Для onec_id нужен form — идентификатор печатной формы (list_onec_print_forms).");
    const label = a.doc_id ? `Документ ${a.doc_id} из 1С.pdf` : `Документ 1С ${a.onec_id}.pdf`;
    return await deliverOnecPdf(extra, p.path! + qs({ form: a.form, stamp: a.stamp }), label);
  });
}
