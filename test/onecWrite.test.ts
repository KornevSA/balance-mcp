// Тесты тулзов записи в 1С и ЕГРЮЛ: подменный balance (http-сервер) + перехват обработчиков тулзов.
// Запуск: npm test (tsc -p tsconfig.test.json && node --test build-test/test/).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

type Call = { method: string; path: string; body: any; auth: string };
type Reply = { status?: number; json: any } | ((c: Call) => { status?: number; json: any });

let server: http.Server;
let calls: Call[] = [];
let routes: Record<string, Reply> = {};
let tools = new Map<string, { def: any; h: (a: any, extra: any) => Promise<any> }>();

const UID = "c626c989-afe1-11ec-8f54-00155d00030f";
const extra = { authInfo: { token: "tkn-user" }, requestInfo: { headers: { host: "balance.test", "x-forwarded-proto": "https" } } };

function okEnv(data: any, status = 200): { status: number; json: any } { return { status, json: { ok: true, data } }; }
function errEnv(status: number, code: string, message: string, more: any = {}) { return { status, json: { ok: false, error: { code, message, ...more } } }; }
function route(method: string, path: string, reply: Reply) { routes[`${method} ${path}`] = reply; }

async function callTool(name: string, args: any) {
  const t = tools.get(name);
  assert.ok(t, `нет тулза ${name}`);
  const parsed = z.object(t!.def.inputSchema).parse(args);
  return t!.h(parsed, extra);
}
const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
const tokenFrom = (r: any) => r?.structuredContent?.confirm_token as string | undefined;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const c: Call = { method: req.method || "", path: (req.url || "").replace(/^\/api\/v1/, ""), body: raw ? JSON.parse(raw) : undefined,
        auth: String(req.headers.authorization || "") };
      calls.push(c);
      const r = routes[`${c.method} ${c.path}`];
      const out = typeof r === "function" ? r(c) : r;
      res.writeHead(out?.status ?? (out ? 200 : 404), { "Content-Type": "application/json" });
      res.end(JSON.stringify(out ? out.json : { ok: false, error: { code: "not_found", message: "нет маршрута в тесте: " + c.method + " " + c.path } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.BALANCE_API_BASE = `http://127.0.0.1:${port}/api/v1`;
  process.env.DADATA_TOKEN = "";
  const fake: any = { registerTool: (name: string, def: any, h: any) => tools.set(name, { def, h }) };
  (await import("../src/tools/onecWrite.js")).registerOneCWriteTools(fake);
  (await import("../src/tools/customers.js")).registerCustomerTools(fake);
});
after(() => { server.close(); });
beforeEach(() => { calls = []; routes = {}; });

// ---------------------------------------------------------------- акт сверки
const reconPreview = { org_id: 1, organization: "ИП Корнев", will: "create", counterparty: { id: UID, name: "АО ВТБ", inn: "5610083568", kpp: "771401001" },
  customer_id: 42, contract: null, split_by_contracts: false, post: false, stamp: true, existing: null,
  settlement: { totals: { balance: -98620 } }, warnings: [], dry_run: true, request_id: "mcp-1" };

test("акт сверки: превью — dry_run в balance, токен, ничего не записано", async () => {
  route("POST", "/onec/1/reconciliations", okEnv(reconPreview));
  const r = await callTool("create_onec_reconciliation", { org_id: 1, customer_id: 42, from: "2026-01-01", to: "2026-09-30" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.dry_run, true);
  assert.equal(calls[0].body.post, false, "post по умолчанию false");
  assert.equal(calls[0].body.stamp, true, "stamp по умолчанию true");
  assert.equal(calls[0].body.customer_id, 42);
  assert.equal(calls[0].auth, "Bearer tkn-user");
  assert.ok(tokenFrom(r));
  assert.match(textOf(r), /будет СОЗДАН/);
  assert.match(textOf(r), /Ничего не записано/);
  assert.match(textOf(r), /мы должны контрагенту/);
});

test("акт сверки: подтверждение тем же набором — запись, PDF ссылкой без base64", async () => {
  route("POST", "/onec/1/reconciliations", (c) => c.body?.dry_run ? okEnv(reconPreview) : okEnv({
    org_id: 1, dry_run: false, result: "created", external_id: "balance:recon:1:x", document: { id: "d1", number: "000Б-1", date: "2026-10-12", posted: false },
    reconciliation: { opening_balance: 0, debit: 10, credit: 5, closing_balance: 5 },
    pdf: { form: "АктСверки", form_name: "Акт сверки", stamp: true, files: [{ filename: "Акт сверки.pdf", content_type: "application/pdf", size: 8, data: Buffer.from("%PDF-1.4").toString("base64") }] },
  }));
  const p = await callTool("create_onec_reconciliation", { org_id: 1, customer_id: 42, from: "2026-01-01", to: "2026-09-30" });
  const tok = tokenFrom(p)!;
  // явные значения по умолчанию — тот же набор полей
  const r = await callTool("create_onec_reconciliation", { org_id: 1, customer_id: 42, from: "2026-01-01", to: "2026-09-30", post: false, stamp: true, confirm: tok });
  assert.equal(r.isError, undefined, textOf(r));
  const w = calls[calls.length - 1];
  assert.equal(w.body.dry_run, undefined, "запись без dry_run");
  assert.match(textOf(r), /создан в 1С/);
  assert.match(textOf(r), /https:\/\/balance\.test\/mcp\/file\/[0-9a-f]{48}\//);
  assert.doesNotMatch(JSON.stringify(r), /JVBERi0x/, "base64 PDF не уходит модели");
  assert.equal(r.structuredContent.pdf.files[0].size_bytes, 8);
});

test("акт сверки: изменили поле после превью — токен не подходит, в balance не ходим", async () => {
  route("POST", "/onec/1/reconciliations", okEnv(reconPreview));
  const p = await callTool("create_onec_reconciliation", { org_id: 1, customer_id: 42, from: "2026-01-01", to: "2026-09-30" });
  calls = [];
  const r = await callTool("create_onec_reconciliation", { org_id: 1, customer_id: 42, from: "2026-01-01", to: "2026-09-30", post: true, confirm: tokenFrom(p) });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /не совпал/);
  assert.equal(calls.length, 0);
});

test("акт сверки: помеченный акт — превью без токена, ошибка", async () => {
  route("POST", "/onec/1/reconciliations", okEnv({ ...reconPreview, will: "refill", existing: { number: "7", date: "2026-10-01", deleted: true }, blocked: true, warnings: ["помечен на удаление"] }));
  const r = await callTool("create_onec_reconciliation", { org_id: 1, onec_counterparty_id: UID, from: "2026-01-01", to: "2026-09-30" });
  assert.equal(r.isError, true);
  assert.equal(tokenFrom(r), undefined);
  assert.equal(calls[0].body.counterparty_id, UID);
});

test("акт сверки: нужен ровно один из customer_id / onec_counterparty_id", async () => {
  const r = await callTool("create_onec_reconciliation", { org_id: 1, from: "2026-01-01", to: "2026-09-30" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test("ошибка balance (403 onec_write_disabled) доходит до модели с кодом", async () => {
  route("POST", "/onec/4/reconciliations", errEnv(403, "onec_write_disabled", "Запись в 1С из MCP для организации выключена", { request_id: "mcp-x" }));
  const r = await callTool("create_onec_reconciliation", { org_id: 4, customer_id: 1, from: "2026-01-01", to: "2026-01-31" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /onec_write_disabled/);
  assert.match(textOf(r), /mcp-x/);
});

// ---------------------------------------------------------------- ЕГРЮЛ
test("ЕГРЮЛ: customer_id → контрагент 1С, превью и запись по uid", async () => {
  route("GET", "/customers/7/onec?org_id=1", okEnv({ counterparty: { id: UID.toUpperCase(), name: "АО ВТБ" }, match: { by: "map" } }));
  route("POST", `/onec/1/counterparties/${UID}/fill-from-registry`, (c) => c.body?.dry_run
    ? okEnv({ dry_run: true, counterparty: { id: UID, name: "АО ВТБ", inn: "5610083568" }, changes: [{ label: "Юр. адрес", old: "", new: "Москва" }],
              warnings: [], blocked: [], dupes: [], registry: { kind: "legal", status_name: "Действующее" }, nothing_to_change: false })
    : okEnv({ result: "updated", changes: [{ label: "Юр. адрес", old: "", new: "Москва" }], counterparty: { name: "АО ВТБ" } }));
  const p = await callTool("fill_onec_counterparty_from_registry", { org_id: 1, customer_id: 7, keep_name: true });
  assert.match(textOf(p), /Юр\. адрес: «» → «Москва»/);
  assert.equal(calls[1].body.keep_name, true);
  const r = await callTool("fill_onec_counterparty_from_registry", { org_id: 1, customer_id: 7, keep_name: true, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.match(textOf(r), /обновлён по реестру/);
  const w = calls[calls.length - 1];
  assert.equal(w.body.dry_run, undefined);
  assert.equal(Object.keys(w.body).some((k) => k.startsWith("allow_")), false, "флаги allow_* не уходят");
});

test("ЕГРЮЛ: КПП подразделения — без токена", async () => {
  route("POST", `/onec/1/counterparties/${UID}/fill-from-registry`, okEnv({ dry_run: true, counterparty: { id: UID, name: "X" }, changes: [],
    warnings: ["КПП подразделения"], blocked: ["1С такую запись остановит"], dupes: [], nothing_to_change: false }));
  const r = await callTool("fill_onec_counterparty_from_registry", { org_id: 1, onec_id: UID });
  assert.equal(r.isError, true);
  assert.equal(tokenFrom(r), undefined);
});

// ---------------------------------------------------------------- клиент и договор
test("клиент в 1С: уже есть — подтверждать нечего", async () => {
  route("POST", "/customers/5/onec", okEnv({ result: "exists", customer_name: "ООО", match: { by: "inn" }, counterparty: { id: UID, name: "ООО" } }));
  const r = await callTool("create_onec_counterparty", { org_id: 1, customer_id: 5 });
  assert.equal(tokenFrom(r), undefined);
  assert.match(textOf(r), /уже есть в 1С/);
});

test("клиент в 1С: создание по подтверждению, org_id в теле", async () => {
  route("POST", "/customers/5/onec", (c) => c.body?.dry_run
    ? okEnv({ result: "absent", will: "create", customer_name: "ООО", payload: { external_id: "balance:5", inn: "7702020025", fill_from_registry: true } })
    : okEnv({ result: "created", counterparty: { id: UID, name: "ООО Бета" }, warnings: [] }));
  const p = await callTool("create_onec_counterparty", { org_id: 2, customer_id: 5 });
  assert.equal(calls[0].body.org_id, 2);
  const r = await callTool("create_onec_counterparty", { org_id: 2, customer_id: 5, confirm: tokenFrom(p) });
  assert.match(textOf(r), /заведён в 1С org 2/);
  // токен привязан к организации
  const bad = await callTool("create_onec_counterparty", { org_id: 1, customer_id: 5, confirm: tokenFrom(p) });
  assert.equal(bad.isError, true);
});

test("договор: дубли в 1С — без токена; привязка — с токеном", async () => {
  route("POST", "/contracts/3003/onec", okEnv({ will: "nothing", result: "ambiguous", contract: { number: "Д-3", date: "2026-03-01", org_id: 1 }, note: "дубли", candidates: [{}, {}] }));
  const r = await callTool("create_onec_contract", { contract_id: 3003 });
  assert.equal(r.isError, true);
  route("POST", "/contracts/3002/onec", (c) => c.body?.dry_run
    ? okEnv({ will: "link", result: "found", contract: { number: "Д-2", org_id: 1 }, onec_contract: { id: UID, name: "Д-2" } })
    : okEnv({ result: "linked", onec_contract: { id: UID, name: "Д-2" } }));
  const p = await callTool("create_onec_contract", { contract_id: 3002 });
  assert.ok(tokenFrom(p));
  const w = await callTool("create_onec_contract", { contract_id: 3002, confirm: tokenFrom(p) });
  assert.match(textOf(w), /привязан/);
});

// ---------------------------------------------------------------- штатные выгрузки
test("отправка: отказ механизма — без токена, текст как у кнопки", async () => {
  route("POST", "/documents/2002/onec/send", okEnv({ dry_run: true, org_id: 3, route: "old", route_name: "прежний сервис", ok: false, state: "blocked", message: "НотиСенд: …" }));
  const r = await callTool("send_document_to_onec", { doc_id: 2002 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Не отправится: НотиСенд/);
});

test("отправка: оплата — превью с проводками, подтверждение, реализации следом", async () => {
  route("POST", "/documents/2004/onec/send", (c) => c.body?.dry_run
    ? okEnv({ dry_run: true, org_id: 1, route: "pay", route_name: "выгрузка оплат", ok: true, state: "checked", message: "Дт 57.03 Кт 62.02 — 500.00", sales: [{ doc_id: 2005 }] })
    : okEnv({ dry_run: false, org_id: 1, route: "pay", route_name: "выгрузка оплат", ok: true, state: "ok", message: "Создан: ОК-1",
              sales_export: [{ doc_id: 2005, ok: true, message: "Создана реализация РЛ-1" }] }));
  const p = await callTool("send_document_to_onec", { doc_id: 2004 });
  assert.match(textOf(p), /Дт 57\.03/);
  assert.match(textOf(p), /Следом уйдут реализации: #2005/);
  const r = await callTool("send_document_to_onec", { doc_id: 2004, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /реализация #2005: Создана/);
});

test("отправка: уже в 1С — подтверждать нечего", async () => {
  route("POST", "/documents/2001/onec/send", okEnv({ org_id: 1, route: "old", route_name: "прежний сервис", ok: true, state: "ok", result: "exists", message: "Уже в 1С" }));
  const r = await callTool("send_document_to_onec", { doc_id: 2001 });
  assert.equal(tokenFrom(r), undefined);
  assert.equal(r.isError, undefined);
});

test("оплаты из 1С: нечего загружать — без токена; есть — токен, days в теле", async () => {
  route("POST", "/onec/1/bank-pull", okEnv({ days: 14, from: "2026-09-28", result: { fetched: 3, created: 0, exists: 3, skipped: {}, unknown: [], new_customers: [], error: "" } }));
  const r0 = await callTool("pull_onec_bank_payments", { org_id: 1 });
  assert.equal(tokenFrom(r0), undefined);
  assert.equal(calls[0].body.days, 14);
  route("POST", "/onec/1/bank-pull", okEnv({ days: 7, from: "2026-10-05", result: { fetched: 3, created: 2, exists: 0, skipped: { "эквайринг": 1 }, unknown: [],
    new_customers: [{ inn: "7708080084", name: "Тета", dry: true }], error: "" } }));
  const p = await callTool("pull_onec_bank_payments", { org_id: 1, days: 7 });
  assert.match(textOf(p), /будет загружено: 2/);
  assert.match(textOf(p), /ИНН 7708080084/);
  assert.ok(tokenFrom(p));
});

// ---------------------------------------------------------------- проведение и пометка
test("пометка по id 1С: превью DELETE с ?dry_run=true, запись DELETE без тела", async () => {
  const doc = { kind: "reconciliation", kind_name: "Акт сверки", number: "7", date: "2026-10-12", amount: 0, posted: true, deleted: false };
  route("DELETE", `/onec/1/documents/${UID}?dry_run=true`, okEnv({ org_id: 1, dry_run: true, action: "delete", action_name: "пометить на удаление", document: doc,
    origin: { links: [{ src: "mcp", text: "создан из MCP" }] }, effect: "будет помечен", noop: false, blocked: null }));
  route("DELETE", `/onec/1/documents/${UID}`, okEnv({ org_id: 1, action: "delete", result: "done", document: { ...doc, deleted: true, posted: false } }));
  const p = await callTool("set_onec_document_state", { action: "delete", org_id: 1, onec_id: UID });
  assert.match(textOf(p), /Создан balance: создан из MCP/);
  const r = await callTool("set_onec_document_state", { action: "delete", org_id: 1, onec_id: UID, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].body, undefined);
});

test("проведение по doc_id: POST /documents/{id}/onec/post; ничего не изменится — без токена", async () => {
  route("POST", "/documents/2009/onec/unpost", okEnv({ org_id: 1, dry_run: true, action: "unpost", action_name: "отменить проведение",
    document: { kind_name: "Счет", number: "2009", posted: false }, origin: { links: [] }, effect: "не проведён — ничего не изменится", noop: true }));
  const r = await callTool("set_onec_document_state", { action: "unpost", doc_id: 2009 });
  assert.equal(tokenFrom(r), undefined);
  assert.match(textOf(r), /Подтверждать нечего/);
});

test("проведение: документ бухгалтера — 403 от balance", async () => {
  route("POST", "/documents/2008/onec/post", errEnv(403, "onec_not_balance_document", "Документ 1С «Поступление на расчетный счет» через MCP не меняется"));
  const r = await callTool("set_onec_document_state", { action: "post", doc_id: 2008 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /onec_not_balance_document/);
});

// ---------------------------------------------------------------- ЕГРЮЛ для lookup_company_by_inn / find_or_create_customer
const reg = { kind: "legal", inn: "5610083568", kpp: "771401001", ogrn: "1045605469744", name: "АО ВТБ РЕГИСТРАТОР",
  full_name: "Акционерное общество ВТБ РЕГИСТРАТОР", short_name: "АО ВТБ РЕГИСТРАТОР", status: { code: "001", name: "Действующее" },
  termination_date: null, legal_address: "127015, Москва", head: { position: "Генеральный Директор", name: "Петров К. С." } };

test("lookup_company_by_inn: реестр через 1С", async () => {
  route("GET", "/onec/registry/5610083568", okEnv(reg));
  const r = await callTool("lookup_company_by_inn", { inn: "5610083568" });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.source, "1c");
  assert.equal(r.structuredContent.kpp, "771401001");
  assert.equal(r.structuredContent.director, "Петров К. С.");
  assert.equal(r.structuredContent.active, true);
  assert.match(textOf(r), /ЕГРЮЛ\/ЕГРИП через 1С/);
});

test("lookup_company_by_inn: прекращена — предупреждение", async () => {
  route("GET", "/onec/registry/5610083568", okEnv({ ...reg, status: { name: "Ликвидирована" }, termination_date: "2025-01-10T00:00:00" }));
  const r = await callTool("lookup_company_by_inn", { inn: "5610083568" });
  assert.match(textOf(r), /⚠ статус: Ликвидирована, прекращена 2025-01-10/);
});

test("lookup_company_by_inn: реестр недоступен, DaData не настроен — понятная ошибка", async () => {
  route("GET", "/onec/registry/5610083568", errEnv(503, "onec_registry_unavailable", "Сервис 1С:Контрагент недоступен"));
  const r = await callTool("lookup_company_by_inn", { inn: "5610083568" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /недоступен.*DaData не настроен/s);
  route("GET", "/onec/registry/5610083568", errEnv(403, "forbidden", "Токену не выдан scope: onec:read"));
  const r2 = await callTool("lookup_company_by_inn", { inn: "5610083568" });
  assert.match(textOf(r2), /onec:read/);
});

test("lookup_company_by_inn: не найден в реестре — без DaData", async () => {
  route("GET", "/onec/registry/7707083893", errEnv(404, "onec_not_found", "ИНН не найден в ЕГРЮЛ"));
  const r = await callTool("lookup_company_by_inn", { inn: "7707083893" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /ничего не найдено/);
  assert.equal(calls.length, 1);
});

test("find_or_create_customer: имя и реквизиты из реестра через 1С", async () => {
  route("GET", "/customers?inn=5610083568", okEnv({ items: [] }));
  route("GET", "/onec/registry/5610083568", okEnv(reg));
  route("POST", "/customers", (c) => okEnv({ customer_id: 99, ...c.body }, 201));
  const r = await callTool("find_or_create_customer", { inn: "5610083568" });
  assert.equal(r.isError, undefined, textOf(r));
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.body.name, "Акционерное общество ВТБ РЕГИСТРАТОР");   // DADATA_NAME_FORM=full по умолчанию
  assert.equal(post.body.kpp, "771401001");
  assert.equal(post.body.urpost, "127015, Москва");
  assert.equal(post.body.official_func, "Генеральный Директор");
  assert.match(textOf(r), /через 1С/);
});

test("find_or_create_customer: существующий по ИНН — реестр не спрашивается", async () => {
  route("GET", "/customers?inn=5610083568", okEnv({ items: [{ customer_id: 5 }] }));
  const r = await callTool("find_or_create_customer", { inn: "5610083568" });
  assert.match(textOf(r), /уже существует: #5/);
  assert.equal(calls.length, 1);
});

test("обрыв по тайм-ауту записи — текст «запись могла пройти»", async () => {
  const { balanceCall } = await import("../src/balanceClient.js");
  const hang = http.createServer(() => { /* не отвечаем */ });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
  const { CFG } = await import("../src/config.js");
  const prev = CFG.balanceApiBase;
  (CFG as any).balanceApiBase = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
  try {
    const env = await balanceCall("t", "POST", "/x", { a: 1 }, { timeoutMs: 200, write: true });
    assert.equal(env.ok, false);
    assert.match((env as any).error.message, /Запись могла пройти/);
    const env2 = await balanceCall("t", "GET", "/x", undefined, { timeoutMs: 200 });
    assert.match((env2 as any).error.message, /только чтение/);
  } finally {
    (CFG as any).balanceApiBase = prev;
    hang.closeAllConnections();
    hang.close();
  }
});

// ---------------------------------------------------------------- счёт-фактура налогового агента
const PAY1 = "f4c84f2b-a341-11f1-a825-00155d017501";
const PAY2 = "f4c84f2c-a341-11f1-a825-00155d017501";
const taPayment = (id: string, n: string) => ({ id, kind: "bank_out", kind_name: "Списание с расчетного счета", number: n, date: "2026-07-22",
  amount: 675000, title: `«Списание с расчетного счета» № ${n} от 2026-07-22`, counterparty: { name: "КЛАУДЭЙАЙ ООО" }, contracts: ["2026/EE-02 от 10.05.2026"] });
const taDoc = (n: string) => ({ id: "e76b97cd-bc2e-c17b-f0f3-be0a2e9c72cf", kind: "vat_invoice", kind_name: "Счет-фактура выданный", number: n,
  date: "2026-07-22", amount: 823500, posted: true, deleted: false, type_name: "Налоговый агент", operation_code: "06", vat_rate: "НДС22_122",
  total: 823500, total_vat: 148500, contract: { name: "2026/EE-02 от 10.05.2026" }, responsible: "KornevSA", head: "Корнев Николай Александрович",
  advances: [{ line: 1, nomenclature: "Доступ к моделям искусственного интеллекта", content: "Доступ к моделям искусственного интеллекта",
    amount: 823500, vat_rate: "НДС22_122", vat_amount: 148500 }] });
const taPreview = (id: string, n: string, exists = false) => okEnv({ org_id: 2, dry_run: true, kind: "vat_invoice", external_id: `tax-agent:${id}`,
  payment: taPayment(id, n), document: taDoc(exists ? "ИН00-0001316" : "ИН00-0002558"),
  ...(exists ? { result: "exists", will: "nothing", note: "На эту оплату счёт-фактура налогового агента уже есть (выписана в 1С не из MCP) — ничего не создаётся" }
    : { result: "absent", will: "create", entries: [{ debit: "76.НА", credit: "68.32", amount: 148500 }], warnings: [] }) });

test("СФ налогового агента: превью по двум оплатам — dry_run на каждую, токен, текст с заполнением 1С", async () => {
  route("POST", "/onec/2/tax-agent-invoices", (c) => c.body.payment_id === PAY1 ? taPreview(PAY1, "ИН00-043000") : taPreview(PAY2, "ИН00-043001", true));
  const r = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1.toUpperCase(), PAY2, PAY1] });
  assert.equal(calls.length, 2, "повтор id в списке — один вызов");
  assert.deepEqual(calls.map((c) => c.body.payment_id), [PAY1, PAY2]);
  assert.ok(calls.every((c) => c.body.dry_run === true && c.body.post === true), "dry_run и post=true по умолчанию");
  assert.ok(calls.every((c) => !("content" in c.body) && !("nomenclature_id" in c.body)), "необязательные поля не уходят");
  assert.ok(tokenFrom(r));
  const t = textOf(r);
  assert.match(t, /«Налоговый агент», код операции 06/);
  assert.match(t, /НДС 148\s?500,00 \(НДС22_122\)/);
  assert.match(t, /Дт 76\.НА Кт 68\.32/);
  assert.match(t, /уже есть/);
  assert.match(t, /Будет выписано: 1, с проведением/);
  assert.match(t, /Ничего не записано/);
});

test("СФ налогового агента: подтверждение — запись по каждой оплате; изменили поля — токен не подходит", async () => {
  route("POST", "/onec/2/tax-agent-invoices", (c) => {
    if (c.body.dry_run) return taPreview(c.body.payment_id, "ИН00-043000");
    return okEnv({ org_id: 2, dry_run: false, result: "created", payment: taPayment(c.body.payment_id, "ИН00-043000"),
      document: taDoc("ИН00-0002558"), warnings: [] }, 200);
  });
  const p = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1, PAY2], content: "Доступ к моделям" });
  const bad = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1], content: "Доступ к моделям", confirm: tokenFrom(p) });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Токен подтверждения не совпал/);
  calls = [];
  const r = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1, PAY2], content: "Доступ к моделям", confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.body.dry_run === undefined && c.body.content === "Доступ к моделям"));
  assert.match(textOf(r), /выписано 2, уже было 0/);
});

test("СФ налогового агента: на все оплаты СФ уже есть — без токена", async () => {
  route("POST", "/onec/2/tax-agent-invoices", (c) => taPreview(c.body.payment_id, "ИН00-042162", true));
  const r = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1] });
  assert.equal(tokenFrom(r), undefined);
  assert.match(textOf(r), /Подтверждать нечего/);
});

test("СФ налогового агента: отказ 1С по одной оплате — без токена, причина и код в тексте", async () => {
  route("POST", "/onec/2/tax-agent-invoices", (c) => c.body.payment_id === PAY1 ? taPreview(PAY1, "ИН00-043000")
    : errEnv(422, "onec_rejected", "1С отказала: В оплате № ИН00-042431 от 03.08.2026 нет договора с признаком налогового агента по НДС"));
  const r = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1, PAY2] });
  assert.equal(r.isError, true);
  assert.equal(tokenFrom(r), undefined);
  assert.match(textOf(r), /нет договора с признаком налогового агента/);
  assert.match(textOf(r), /onec_rejected/);
  assert.match(textOf(r), /По 1 опл\. 1С отказала/);
});

test("СФ налогового агента: старое расширение 1С — 501 доходит до модели", async () => {
  route("POST", "/onec/2/tax-agent-invoices", errEnv(501, "onec_extension_outdated", "Расширение BalanceAPI в базе 1С этой организации старое"));
  const r = await callTool("create_onec_tax_agent_invoice", { org_id: 2, payment_ids: [PAY1] });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /onec_extension_outdated/);
});

// ---------------------------------------------------------------- правка оплаты поставщику и договор с иностранным поставщиком
const PAYX = "05666c82-73a2-11f1-a7fc-00155d013700";
const IN01 = "04ac68ce-7e95-11f1-a806-00155d013700";
const CLOUDAI = "09ed6ccb-7388-11f1-a7fc-00155d013700";
const payDoc = { id: PAYX, kind: "bank_out", kind_name: "Списание с расчетного счета", number: "ИН00-041240", date: "2026-04-10", amount: 536250, posted: true, deleted: false };

test("правка оплаты: превью — dry_run rebind, изменения, проводки и перезаполнение СФ; подтверждение — запись", async () => {
  route("POST", `/onec/2/documents/${PAYX}/rebind`, (c) => c.body.dry_run ? okEnv({ org_id: 2, dry_run: true, document: payDoc,
    counterparty_before: { name: "КЛАУДЭЙАЙ ООО" }, contracts_before: ["2026/EE-02 от 10.05.2026"], will: "update", result: "will_change",
    changes: [{ field: "payments", old: "1: 2026/EE-02 от 10.05.2026 536250.00", new: "1: 2026/IN-01 от 20.03.2026 536250.00" }],
    entries: [{ debit: "60.02", credit: "51", amount: 536250 }],
    vat_invoice: { title: "«Счет-фактура выданный» № ИН00-0000957 от 2026-04-10", contract: { name: "2026/IN-01 от 20.03.2026" }, total_vat: 117975, vat_rate: "НДС22_122" },
    vat_invoice_entries: [{ debit: "76.НА", credit: "68.32", amount: 117975 }], note: "Оплата проведена — после правки будет перепроведена" })
    : okEnv({ org_id: 2, dry_run: false, result: "updated", after: payDoc, document: payDoc,
      vat_invoice: { title: "«Счет-фактура выданный» № ИН00-0000957 от 2026-04-10", contract: { name: "2026/IN-01 от 20.03.2026" }, total_vat: 117975 } }));
  const p = await callTool("update_onec_supplier_payment", { org_id: 2, onec_id: PAYX.toUpperCase(), contract_id: IN01, refill_vat_invoice: true });
  assert.equal(calls[0].body.dry_run, true);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["contract_id", "dry_run", "refill_vat_invoice"]);
  const t = textOf(p);
  assert.match(t, /2026\/EE-02 от 10\.05\.2026 536250\.00 → 1: 2026\/IN-01/);
  assert.match(t, /Дт 60\.02 Кт 51/);
  assert.match(t, /СФ налогового агента .*ИН00-0000957.*договор 2026\/IN-01/);
  assert.match(t, /Дт 76\.НА Кт 68\.32/);
  assert.ok(tokenFrom(p));
  const r = await callTool("update_onec_supplier_payment", { org_id: 2, onec_id: PAYX, contract_id: IN01, refill_vat_invoice: true, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(calls[1].body.dry_run, undefined);
  assert.match(textOf(r), /Оплата изменена .* перезаполнен .*ИН00-0000957/);
});

test("правка оплаты: смена контрагента без договора — отказ без вызова; СФ без refill — 409 от 1С доходит до модели", async () => {
  const r = await callTool("update_onec_supplier_payment", { org_id: 2, onec_id: PAYX, counterparty_id: CLOUDAI });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  route("POST", `/onec/2/documents/${PAYX}/rebind`, errEnv(409, "onec_conflict",
    "Конфликт в 1С: На оплату выписан счёт-фактура налогового агента № ИН00-0000957 от 10.04.2026. Передайте refill_vat_invoice: true"));
  const r2 = await callTool("update_onec_supplier_payment", { org_id: 2, onec_id: PAYX, contract_id: IN01 });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /refill_vat_invoice/);
  assert.equal(tokenFrom(r2), undefined);
});

test("поставщик без ИНН: договор налогового агента по onec_counterparty_id — признаки агента в теле", async () => {
  route("POST", "/onec/2/suppliers", okEnv({ org_id: 2, dry_run: true, inn: null, kpp: null, will: "create", result: "absent", warnings: [],
    counterparty: { id: CLOUDAI, name: "КЛАУДЭЙАЙ ООО", inn: "", result: "exists", country: "АРМЕНИЯ" },
    contract: { result: "absent", will: "create", note: "Будет заведён договор «С поставщиком» № 2026/IN-02 от 2026-08-20, налоговый агент по НДС" } }));
  const p = await callTool("create_onec_supplier", { org_id: 2, onec_counterparty_id: CLOUDAI,
    contract: { number: "2026/IN-02", date: "2026-08-20", tax_agent: true, advance_invoice_nomenclature_id: "04AC68CC-7E95-11F1-A806-00155D013700" } });
  assert.equal(calls[0].body.onec_counterparty_id, CLOUDAI);
  assert.equal(calls[0].body.inn, undefined);
  assert.deepEqual(calls[0].body.contract, { number: "2026/IN-02", date: "2026-08-20", tax_agent: true,
    advance_invoice_nomenclature_id: "04ac68cc-7e95-11f1-a806-00155d013700" });
  assert.match(textOf(p), /«КЛАУДЭЙАЙ ООО» без ИНН \(АРМЕНИЯ\)/);
  assert.match(textOf(p), /налоговый агент по НДС/);
  assert.ok(tokenFrom(p));
  const both = await callTool("create_onec_supplier", { org_id: 2, inn: "7707083893", onec_counterparty_id: CLOUDAI, contract: { number: "1", date: "2026-01-01" } });
  assert.equal(both.isError, true);
  const noContract = await callTool("create_onec_supplier", { org_id: 2, onec_counterparty_id: CLOUDAI });
  assert.equal(noContract.isError, true);
  assert.equal(calls.length, 1, "в balance ходили только за превью");
});
