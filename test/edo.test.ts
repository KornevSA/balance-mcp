// Тесты тулзов ЭДО (Диадок, чтение) и документов поставщиков в 1С (запись с подтверждением):
// подменный balance (http-сервер) + перехват обработчиков тулзов, как в onecWrite.test.ts.
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

const ORG_ID = 2;
const UID = "c626c989-afe1-11ec-8f54-00155d00030f";
const NOM = "0b5e8a3c-1111-11ef-8f54-00155d00030f";
const MSG = "1A2B3C4D-0000-4000-8000-00000000000A";
const ENT = "5E6F7A8B-0000-4000-8000-00000000000B";
const extra = { authInfo: { token: "tkn-user" }, requestInfo: { headers: { host: "balance.test", "x-forwarded-proto": "https" } } };

function okEnv(data: any, status = 200): { status: number; json: any } { return { status, json: { ok: true, data } }; }
function errEnv(status: number, code: string, message: string, more: any = {}) { return { status, json: { ok: false, error: { code, message, ...more } } }; }
/** Маршрут: точный путь с query или путь без query (тогда query проверяют по calls). */
function route(method: string, path: string, reply: Reply) { routes[`${method} ${path}`] = reply; }

async function callTool(name: string, args: any) {
  const t = tools.get(name);
  assert.ok(t, `нет тулза ${name}`);
  const parsed = z.object(t!.def.inputSchema).parse(args);
  return t!.h(parsed, extra);
}
const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
const tokenFrom = (r: any) => r?.structuredContent?.confirm_token as string | undefined;
const query = (c: Call) => new URL("http://x" + c.path).searchParams;
const last = () => calls[calls.length - 1];

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const c: Call = { method: req.method || "", path: (req.url || "").replace(/^\/api\/v1/, ""), body: raw ? JSON.parse(raw) : undefined,
        auth: String(req.headers.authorization || "") };
      calls.push(c);
      const r = routes[`${c.method} ${c.path}`] ?? routes[`${c.method} ${c.path.split("?")[0]}`];
      const out = typeof r === "function" ? r(c) : r;
      res.writeHead(out?.status ?? (out ? 200 : 404), { "Content-Type": "application/json" });
      res.end(JSON.stringify(out ? out.json : { ok: false, error: { code: "not_found", message: "нет маршрута в тесте: " + c.method + " " + c.path } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.BALANCE_API_BASE = `http://127.0.0.1:${port}/api/v1`;
  const fake: any = { registerTool: (name: string, def: any, h: any) => tools.set(name, { def, h }) };
  (await import("../src/tools/edo.js")).registerEdoTools(fake);
  (await import("../src/tools/onecWrite.js")).registerOneCWriteTools(fake);
  (await import("../src/tools/onec.js")).registerOneCTools(fake);
});
after(() => { server.close(); });
beforeEach(() => { calls = []; routes = {}; });

// ---------------------------------------------------------------- ЭДО: чтение
const inItem = (status: string, n: string) => ({ message_id: MSG.toLowerCase(), entity_id: ENT.toLowerCase(), direction: "in", type: "UniversalTransferDocument",
  number: n, date: "2026-10-01", total: 12000, vat: 2000, counteragent: { inn: "7700000000", kpp: "770001001", name: "ООО Ромашка", box_id: "b1" },
  state: "signed", status_text: "Подписан", deleted: false, onec: { status, matches: [], counterparties: [] } });

test("list_diadoc_documents: входящие по умолчанию — onec_check=1, types через запятую", async () => {
  route("GET", "/edo/documents", okEnv({ org_id: ORG_ID, direction: "in", from: "2026-07-15", to: null, total_in_diadoc: 3,
    items: [inItem("absent", "1"), inItem("found", "2"), inItem("no_counterparty", "3")], box_id: "x", note: null }));
  const r = await callTool("list_diadoc_documents", { org_id: ORG_ID, types: ["UniversalTransferDocument", "ProformaInvoice"], counteragent_inn: "7700000000" });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].auth, "Bearer tkn-user");
  const q = query(calls[0]);
  assert.equal(q.get("org_id"), String(ORG_ID));
  assert.equal(q.get("direction"), "in");
  assert.equal(q.get("onec_check"), "1", "у входящих проверка в 1С по умолчанию");
  assert.equal(q.get("not_in_onec"), null);
  assert.equal(q.get("types"), "UniversalTransferDocument,ProformaInvoice");
  assert.equal(q.get("counteragent_inn"), "7700000000");
  assert.match(textOf(r), /нет в 1С: 1, уже в 1С: 1, поставщика нет в 1С: 1/);
});

test("list_diadoc_documents: исходящие без проверки 1С, onec_check=false, not_in_onec", async () => {
  route("GET", "/edo/documents", okEnv({ items: [{ direction: "out", balance_doc_id: 5 }, { direction: "out", balance_doc_id: null }], total_in_diadoc: 2 }));
  const out = await callTool("list_diadoc_documents", { org_id: ORG_ID, direction: "out", from: "2026-09-01", to: "2026-09-30", limit: 10 });
  let q = query(calls[0]);
  assert.equal(q.get("direction"), "out");
  assert.equal(q.get("onec_check"), null, "исходящие в 1С не ищутся");
  assert.equal(q.get("from"), "2026-09-01");
  assert.equal(q.get("limit"), "10");
  assert.match(textOf(out), /связаны с документами balance: 1/);

  await callTool("list_diadoc_documents", { org_id: ORG_ID, onec_check: false });
  assert.equal(query(calls[1]).get("onec_check"), null);

  await callTool("list_diadoc_documents", { org_id: ORG_ID, onec_check: false, not_in_onec: true });
  q = query(calls[2]);
  assert.equal(q.get("not_in_onec"), "1");
  assert.equal(q.get("onec_check"), "1", "not_in_onec включает проверку сам");

  calls = [];
  const bad = await callTool("list_diadoc_documents", { org_id: ORG_ID, direction: "out", not_in_onec: true });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 0);
});

test("get_diadoc_document: GUID в нижнем регистре, onec_check=0, строки и статус 1С в тексте", async () => {
  route("GET", `/edo/documents/${MSG.toLowerCase()}/${ENT.toLowerCase()}`, okEnv({ ...inItem("absent", "15"),
    seller: { inn: "7700000000", kpp: "770001001", name: "ООО Ромашка" }, buyer: { inn: "500100732259" },
    lines: [{ line: 1, name: "Услуги связи", quantity: 1, price: 12000, amount: 12000, vat_rate: "20%", vat_amount: 2000, is_service: true }],
    totals: { net: 10000, vat: 2000, total: 12000 }, parse_note: null, onec_kind: "purchase", upd_function: "СЧФДОП" }));
  const r = await callTool("get_diadoc_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(query(calls[0]).get("org_id"), String(ORG_ID));
  assert.equal(query(calls[0]).get("onec_check"), null);
  assert.match(textOf(r), /Строк: 1; итого 12.000.00/);
  assert.match(textOf(r), /в 1С не найден/);
  assert.match(textOf(r), /поступление/);
  await callTool("get_diadoc_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT, onec_check: false });
  assert.equal(query(calls[1]).get("onec_check"), "0");
});

test("get_edo_status и ошибка Диадока с кодом", async () => {
  route("GET", "/edo/status", okEnv({ provider: "diadoc", configured: true, sync_enabled: true, sync_days: 21, last_run_at: "2026-10-13 10:00:00",
    last_error: null, boxes: [{ org_id: 1, organization: "ИП Корнев", box: "ИП", api_ok: true }, { org_id: 3, organization: "НотиСенд", api_ok: false, note: "нет подписки" }] }));
  const s = await callTool("get_edo_status", {});
  assert.match(textOf(s), /Диадок: подключён/);
  assert.match(textOf(s), /org 3 «НотиСенд»: нет доступа к API — нет подписки/);
  route("GET", "/edo/documents", errEnv(402, "diadoc_no_api_subscription", "У ящика нет доступа к API Диадока", { request_id: "mcp-e" }));
  const r = await callTool("list_diadoc_documents", { org_id: 3 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /diadoc_no_api_subscription/);
  assert.match(textOf(r), /mcp-e/);
});

test("list_onec_documents: вид supplier_invoice", async () => {
  route("GET", "/onec/1/documents", okEnv({ items: [], total: 0, period: {} }));
  const r = await callTool("list_onec_documents", { org_id: 1, from: "2026-10-01", kind: ["purchase", "supplier_invoice"] });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(query(calls[0]).get("kind"), "purchase,supplier_invoice");
});

// ---------------------------------------------------------------- документ поставщика
const cp = { id: UID, name: "ООО Ромашка", inn: "7700000000", kpp: "770001001", by: "inn_kpp", candidates: [], note: null };
const docPreview = { dry_run: true, org_id: ORG_ID, organization: "Интер", kind: "purchase", kind_name: "Поступление (акт, накладная, УПД)",
  source: { type: "diadoc", message_id: MSG.toLowerCase(), entity_id: ENT.toLowerCase(), diadoc_type: "UniversalTransferDocument", title: "УПД № 15", status_text: "Подписан", grounds: "" },
  external_id: `diadoc:${MSG.toLowerCase()}:${ENT.toLowerCase()}`, onec_id: "d0000000-0000-0000-0000-000000000001", counterparty: cp,
  date: "2026-10-01", incoming_number: "15", incoming_date: "2026-10-01", contract: null, totals: { sum: 12000, vat: 2000, source_total: 12000 },
  post: false, upd: true, payload: { items: [{ content: "Услуги связи", quantity: 1, price: 12000, vat_rate: "НДС20", nomenclature_id: NOM }] },
  checks: ["Договор не указан — 1С подставит основной договор контрагента"], warnings: [], result: "absent", will: "create", note: "Будет создан" };

test("документ поставщика из Диадока: превью dry_run → токен → запись без dry_run", async () => {
  route("POST", `/onec/${ORG_ID}/supplier-documents`, (c) => c.body?.dry_run ? okEnv(docPreview) : okEnv({
    ...docPreview, dry_run: false, result: "created", payload: undefined,
    document: { id: docPreview.onec_id, kind: "purchase", kind_name: "Поступление", number: "0000-000123", date: "2026-10-01", amount: 12000, posted: false },
    sent: {} }));
  const args = { org_id: ORG_ID, message_id: MSG, entity_id: ENT, nomenclature_id: NOM };
  const p = await callTool("create_onec_supplier_document", args);
  assert.equal(p.isError, undefined, textOf(p));
  const b0 = calls[0].body;
  assert.equal(b0.dry_run, true);
  assert.equal(b0.source, "diadoc", "источник выводится из message_id");
  assert.equal(b0.message_id, MSG.toLowerCase());
  assert.equal(b0.entity_id, ENT.toLowerCase());
  assert.equal(b0.nomenclature_id, NOM);
  assert.equal(b0.post, false, "post по умолчанию false");
  assert.equal(b0.allow_duplicate, false);
  assert.equal("lines" in b0, false, "строки Диадока не подменяются, если не переданы");
  assert.equal("seller" in b0, false);
  assert.equal("upd" in b0, false);
  assert.ok(tokenFrom(p));
  assert.match(textOf(p), /Поставщик в 1С: «ООО Ромашка»/);
  assert.match(textOf(p), /Договор не указан/);
  assert.match(textOf(p), /Ничего не записано/);

  // те же поля (source и post явно, регистр GUID другой) — токен подходит
  const r = await callTool("create_onec_supplier_document", { ...args, source: "diadoc", post: false, message_id: MSG.toLowerCase(), confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  const w = last();
  assert.equal(w.body.dry_run, undefined, "запись без dry_run");
  const { dry_run: _dry, ...b0rest } = b0;
  assert.deepEqual(w.body, b0rest, "запись — то же тело, что превью");
  assert.match(textOf(r), /создан в 1С org 2/);
  assert.match(textOf(r), /update_onec_document/);
});

test("документ поставщика: изменили поле после превью — токен не подходит, в balance не ходим", async () => {
  route("POST", `/onec/${ORG_ID}/supplier-documents`, okEnv(docPreview));
  const p = await callTool("create_onec_supplier_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT, nomenclature_id: NOM });
  calls = [];
  const r = await callTool("create_onec_supplier_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT, nomenclature_id: NOM, post: true, confirm: tokenFrom(p) });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /не совпал/);
  assert.equal(calls.length, 0);
});

test("документ поставщика: нет номенклатуры у поступления — ошибка без токена, с причиной и проверками", async () => {
  route("POST", `/onec/${ORG_ID}/supplier-documents`, okEnv({ ...docPreview, result: "blocked", will: "nothing",
    blocked: "У поступления каждой строке нужна номенклатура 1С: нет у строк 1", checks: ["Договор не указан — 1С подставит основной договор контрагента"] }));
  const r = await callTool("create_onec_supplier_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT });
  assert.equal(r.isError, true);
  assert.equal(tokenFrom(r), undefined);
  assert.match(textOf(r), /Создать нельзя: У поступления каждой строке нужна номенклатура/);
  assert.match(textOf(r), /Договор не указан/);
});

test("документ поставщика: уже создан или дубль по входящему номеру — подтверждать нечего", async () => {
  route("POST", `/onec/${ORG_ID}/supplier-documents`, okEnv({ ...docPreview, result: "exists", will: "nothing", payload: undefined, totals: undefined,
    incoming_number: undefined, post: undefined, checks: undefined,
    document: { id: docPreview.onec_id, kind_name: "Поступление", number: "123", date: "2026-10-01", amount: 12000, posted: true }, note: "Этот документ уже создан в 1С из balance" }));
  const r = await callTool("create_onec_supplier_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT, nomenclature_id: NOM });
  assert.equal(r.isError, undefined);
  assert.equal(tokenFrom(r), undefined);
  assert.match(textOf(r), /Уже создан в 1С: Поступление № 123/);
  assert.match(textOf(r), /Подтверждать нечего/);

  route("POST", `/onec/${ORG_ID}/supplier-documents`, okEnv({ ...docPreview, result: "duplicate", will: "nothing", payload: undefined,
    duplicates: [{ id: UID, kind_name: "Поступление", number: "77", date: "2026-10-02", amount: 12000, posted: true, incoming_number: "15", incoming_date: "2026-10-01" }],
    note: "В 1С уже есть документ поставщика с входящим номером 15 (1) — allow_duplicate: true" }));
  const d = await callTool("create_onec_supplier_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT, nomenclature_id: NOM });
  assert.equal(tokenFrom(d), undefined);
  assert.match(textOf(d), /входящий № 15 от 2026-10-01/);
  assert.match(textOf(d), /allow_duplicate/);
});

test("документ поставщика вручную: проверки до balance и тело запроса", async () => {
  const base = { org_id: ORG_ID, source: "manual", kind: "supplier_invoice", seller: { inn: "7700000000" }, number: " СЧ-7 ", date: "2026-10-05",
    lines: [{ content: "Хостинг", price: 1000, quantity: 3, vat_rate: "22" }, { content: "Домен", amount: 500, vat_rate: "none" }] };
  let r = await callTool("create_onec_supplier_document", { ...base, kind: undefined });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /нужен kind/);
  r = await callTool("create_onec_supplier_document", { ...base, lines: [{ content: "X", amount: 1, price: 1, vat_rate: "0" }] });
  assert.match(textOf(r), /что-то одно — amount/);
  r = await callTool("create_onec_supplier_document", { org_id: ORG_ID, message_id: MSG, entity_id: ENT, number: "1" });
  assert.match(textOf(r), /не передавайте seller, number, date/);
  r = await callTool("create_onec_supplier_document", { ...base, seller: undefined });
  assert.match(textOf(r), /seller\.inn/);
  assert.equal(calls.length, 0);

  route("POST", `/onec/${ORG_ID}/supplier-documents`, okEnv({ ...docPreview, kind: "supplier_invoice", kind_name: "Счёт от поставщика",
    source: { type: "manual", seller: { inn: "7700000000", kpp: "", name: "" } }, checks: ["Строки счёта будут без номенклатуры"] }));
  const p = await callTool("create_onec_supplier_document", base);
  assert.ok(tokenFrom(p), textOf(p));
  const b = calls[0].body;
  assert.equal(b.source, "manual");
  assert.deepEqual(b.seller, { inn: "7700000000" });
  assert.equal(b.number, "СЧ-7");
  assert.deepEqual(b.lines, [
    { line: 1, content: "Хостинг", quantity: 3, price: 1000, vat_rate: "22" },
    { line: 2, content: "Домен", quantity: 1, amount: 500, vat_rate: "none" },
  ]);
  assert.match(textOf(p), /Источник: данные пользователя \(продавец ИНН 7700000000\)/);

  // запись: balance нашёл дубль по входящему номеру — 409 с дублями
  route("POST", `/onec/${ORG_ID}/supplier-documents`, errEnv(409, "onec_duplicate", "В 1С уже есть документ поставщика с входящим номером СЧ-7",
    { duplicates: [{ id: UID, number: "88" }], request_id: "mcp-d" }));
  const w = await callTool("create_onec_supplier_document", { ...base, confirm: tokenFrom(p) });
  assert.equal(w.isError, true);
  assert.match(textOf(w), /onec_duplicate/);
  assert.match(textOf(w), /Уже в 1С:/);
  assert.match(textOf(w), /"number":"88"/);
});

// ---------------------------------------------------------------- поставщик и номенклатура
test("поставщик: заводится по ЕГРЮЛ с договором — превью, подтверждение", async () => {
  route("POST", `/onec/${ORG_ID}/suppliers`, (c) => c.body?.dry_run
    ? okEnv({ dry_run: true, org_id: ORG_ID, inn: "7700000000", kpp: null, warnings: [], result: "absent", will: "create",
        counterparty: { result: "absent", will: "create", payload: { external_id: "balance:supplier:7700000000", inn: "7700000000", fill_from_registry: true } },
        contract: { result: "absent", will: "create", note: "Будет заведён договор «С поставщиком» № П-1 от 2026-01-10" } })
    : okEnv({ dry_run: false, result: "done", org_id: ORG_ID, inn: "7700000000", warnings: [],
        counterparty: { id: UID, name: "ООО Ромашка", result: "created" }, contract: { id: NOM, name: "П-1 от 10.01.2026", result: "created" } }));
  const args = { org_id: ORG_ID, inn: "7700000000", contract: { number: "П-1", date: "2026-01-10" } };
  const p = await callTool("create_onec_supplier", args);
  assert.equal(calls[0].body.dry_run, true);
  assert.deepEqual(calls[0].body.contract, { number: "П-1", date: "2026-01-10" });
  assert.equal("kpp" in calls[0].body, false);
  assert.match(textOf(p), /будет заведён по ЕГРЮЛ\/ЕГРИП \(ключ balance:supplier:7700000000\)/);
  assert.match(textOf(p), /договор «С поставщиком» № П-1/);
  assert.ok(tokenFrom(p));
  const r = await callTool("create_onec_supplier", { ...args, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(last().body.dry_run, undefined);
  assert.match(textOf(r), /Поставщик «ООО Ромашка» .* заведён в 1С org 2; договор «П-1 от 10\.01\.2026» .* заведён/);
  // другой КПП — другой набор полей
  const bad = await callTool("create_onec_supplier", { ...args, kpp: "770001001", confirm: tokenFrom(p) });
  assert.equal(bad.isError, true);
});

test("поставщик: несколько с ИНН — ошибка с кандидатами; уже есть — подтверждать нечего", async () => {
  route("POST", `/onec/${ORG_ID}/suppliers`, okEnv({ result: "ambiguous", will: "nothing", note: "В 1С 2 контрагента с ИНН 7700000000 — однозначно не выбрать",
    candidates: [{ id: UID, kpp: "770001001" }, { id: NOM, kpp: "770101001" }] }));
  const a = await callTool("create_onec_supplier", { org_id: ORG_ID, inn: "7700000000" });
  assert.equal(a.isError, true);
  assert.match(textOf(a), /однозначно не выбрать/);
  assert.match(textOf(a), /770101001/);
  route("POST", `/onec/${ORG_ID}/suppliers`, okEnv({ org_id: ORG_ID, inn: "7700000000", result: "exists", will: "nothing", warnings: [],
    counterparty: { id: UID, name: "ООО Ромашка", kpp: "770001001", result: "exists" } }));
  const e = await callTool("create_onec_supplier", { org_id: ORG_ID, inn: "7700000000" });
  assert.equal(tokenFrom(e), undefined);
  assert.match(textOf(e), /Уже есть: «ООО Ромашка»/);
});

test("номенклатура: превью с токеном → запись; несколько видов без kind — без токена; уже есть — подтверждать нечего", async () => {
  route("POST", `/onec/${ORG_ID}/nomenclature`, (c) => c.body?.dry_run
    ? okEnv({ dry_run: true, org_id: ORG_ID, name: "Хостинг", result: "absent", will: "create", kinds: ["Услуги"],
        payload: { external_id: "balance:nom:abc", name: "Хостинг", is_service: true } })
    : okEnv({ result: "created", nomenclature: { id: NOM, name: "Хостинг" } }));
  const p = await callTool("create_onec_nomenclature", { org_id: ORG_ID, name: " Хостинг " });
  assert.equal(calls[0].body.name, "Хостинг");
  assert.equal(calls[0].body.is_service, true, "по умолчанию услуга");
  assert.match(textOf(p), /единственный подходящий/);
  const r = await callTool("create_onec_nomenclature", { org_id: ORG_ID, name: "Хостинг", is_service: true, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(last().body.dry_run, undefined);
  assert.match(textOf(r), new RegExp(`заведена в 1С org 2: id ${NOM}`));

  route("POST", `/onec/${ORG_ID}/nomenclature`, okEnv({ dry_run: true, result: "absent", will: "create", kinds: ["Услуги", "Услуги связи"],
    payload: { name: "Связь", is_service: true }, note: "Подходящих видов номенклатуры несколько — передайте kind" }));
  const k = await callTool("create_onec_nomenclature", { org_id: ORG_ID, name: "Связь" });
  assert.equal(k.isError, true);
  assert.equal(tokenFrom(k), undefined);
  assert.match(textOf(k), /«Услуги», «Услуги связи»/);

  route("POST", `/onec/${ORG_ID}/nomenclature`, okEnv({ result: "exists", will: "nothing", nomenclature: [{ id: NOM, name: "Связь" }] }));
  const e = await callTool("create_onec_nomenclature", { org_id: ORG_ID, name: "Связь" });
  assert.equal(tokenFrom(e), undefined);
  assert.match(textOf(e), new RegExp(`уже есть .*id ${NOM}`));
});

// ---------------------------------------------------------------- правка документа поставщика
test("правка документа: PUT с dry_run и только переданными полями → PUT без dry_run", async () => {
  const doc = { id: UID, kind: "purchase", kind_name: "Поступление", number: "123", date: "2026-10-01", amount: 12000, posted: true };
  route("PUT", `/onec/${ORG_ID}/documents/${UID}`, (c) => c.body?.dry_run
    ? okEnv({ dry_run: true, org_id: ORG_ID, document: doc, items_before: [{}, {}], accounts_before: null, changes: {}, note: "Документ проведён — после правки будет перепроведён" })
    : okEnv({ dry_run: false, result: "updated", org_id: ORG_ID, before: doc, document: { ...doc, amount: 3000 }, summary: { ...doc, amount: 3000 } }));
  const args = { org_id: ORG_ID, onec_id: UID.toUpperCase(), comment: "по письму",
    items: [{ content: "Хостинг", price: 1000, quantity: 3, vat_rate: "НДС22", nomenclature_id: NOM, accounts: { expense: "26", expense_analytics: ["Хостинг"] } }],
    item_accounts: [{ line: 1, accounts: { vat: "19.04" } }] };
  const p = await callTool("update_onec_document", args);
  assert.equal(p.isError, undefined, textOf(p));
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, `/onec/${ORG_ID}/documents/${UID}`);
  assert.deepEqual(calls[0].body, {
    comment: "по письму", dry_run: true,
    items: [{ nomenclature_id: NOM, content: "Хостинг", quantity: 3, price: 1000, vat_rate: "НДС22", accounts: { expense: "26", expense_analytics: ["Хостинг"] } }],
    item_accounts: [{ line: 1, accounts: { vat: "19.04" } }],
  });
  assert.match(textOf(p), /Строки заменяются целиком: было 2, станет 1 на 3.000.00/);
  assert.match(textOf(p), /будет перепроведён/);
  assert.ok(tokenFrom(p));
  const r = await callTool("update_onec_document", { ...args, confirm: tokenFrom(p) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(last().method, "PUT");
  assert.equal(last().body.dry_run, undefined);
  assert.match(textOf(r), /Изменён в 1С org 2: Поступление № 123 от 2026-10-01 на 3.000.00/);
  // другой комментарий — токен не подходит
  const bad = await callTool("update_onec_document", { ...args, comment: "иначе", confirm: tokenFrom(p) });
  assert.equal(bad.isError, true);
});

test("правка документа: числовая ставка уходит в balance как есть (нормализует balance)", async () => {
  route("PUT", `/onec/${ORG_ID}/documents/${UID}`, okEnv({ dry_run: true, document: { title: "«Поступление» № 1 от 2026-10-01" }, changes: {} }));
  await callTool("update_onec_document", { org_id: ORG_ID, onec_id: UID, items: [{ price: 10, vat_rate: "22" }] });
  assert.equal(last().method, "PUT");
  assert.equal(last().body.items[0].vat_rate, "22");
});

test("правка документа: нужно хотя бы одно поле; чужой документ — 403", async () => {
  let r = await callTool("update_onec_document", { org_id: ORG_ID, onec_id: UID });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Нечего менять/);
  r = await callTool("update_onec_document", { org_id: ORG_ID, onec_id: UID, accounts: {} });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);

  route("PUT", `/onec/${ORG_ID}/documents/${UID}`, errEnv(403, "onec_not_balance_document", "Через MCP правятся только поступления и счета от поставщика, созданные из MCP"));
  r = await callTool("update_onec_document", { org_id: ORG_ID, onec_id: UID, post: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /onec_not_balance_document/);
  assert.equal(calls[0].body.post, true);
});
