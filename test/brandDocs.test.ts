// Тесты тулзов документа бренда: подменный balance (http-сервер) + перехват обработчиков.
// Запуск: npm test (tsc -p tsconfig.test.json && node --test build-test/test/).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

type Reply = { status: number; json?: any; body?: Buffer; headers?: Record<string, string> };
let server: http.Server;
let paths: string[] = [];
let reply: Reply = { status: 200, json: { ok: true, data: {} } };
const tools = new Map<string, { def: any; h: (a: any, extra: any) => Promise<any> }>();
const extra = { authInfo: { token: "tkn-user" }, requestInfo: { headers: { host: "balance.test", "x-forwarded-proto": "https" } } };

async function callTool(name: string, args: any) {
  const t = tools.get(name);
  assert.ok(t, `нет тулза ${name}`);
  return t!.h(z.object(t!.def.inputSchema).parse(args), extra);
}
const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");

before(async () => {
  server = http.createServer((req, res) => {
    paths.push((req.url || "").replace(/^\/api\/v1/, ""));
    if (reply.body) {
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body);
      return;
    }
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.BALANCE_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const fake: any = { registerTool: (name: string, def: any, h: any) => tools.set(name, { def, h }) };
  (await import("../src/tools/brandDocs.js")).registerBrandDocTools(fake);
});
after(() => { server.close(); });
beforeEach(() => { paths = []; });

test("get_brand_document: описание, исполнитель, НДС и число разделов в шапке", async () => {
  reply = { status: 200, json: { ok: true, data: {
    brend_id: 3, brand: "RouterAI.ru", site: "routerai.ru", service_type: "Доступ к нейросетям",
    document: { kind: "contract", contract_type: "routerai_v3", name: "RouterAI лицензия (ред. 3, без НДС)",
      org_id: 2, org_name: "ООО \"Интер\"", vat: "no", available: true, formats: ["text", "pdf", "docx", "html"],
      sections: [{ n: 1, title: "Предмет", chars: 900 }, { n: 2, title: "Оплата", chars: 1200 }] } } } };
  const r = await callTool("get_brand_document", { brend_id: 3 });
  assert.deepEqual(paths, ["/brands/3/documents"]);
  assert.match(textOf(r), /^Бренд RouterAI\.ru: «RouterAI лицензия \(ред\. 3, без НДС\)» \(routerai_v3\), исполнитель ООО "Интер", без НДС, разделов 2\./);
  assert.equal(r.structuredContent.document.sections.length, 2);
});

test("get_brand_document: документ не назначен", async () => {
  reply = { status: 200, json: { ok: true, data: { brend_id: 1, brand: "MainSMS.ru", document: null } } };
  const r = await callTool("get_brand_document", { brend_id: 1 });
  assert.match(textOf(r), /MainSMS\.ru: документ по умолчанию не назначен/);
});

test("get_brand_contract_blank: text по умолчанию — разделы текстом и пометка «бланк»", async () => {
  reply = { status: 200, json: { ok: true, data: { brend_id: 3, name: "RouterAI лицензия", customer_id: null,
    meta: { source: "blank", contract_id: null, contract_number: null, contract_date: null, contract_status: null,
      number_conflict: false, other_contracts: [] },
    sections: [{ n: 2, title: "Оплата", text: "Лицензиат оплачивает…" }] } } };
  const r = await callTool("get_brand_contract_blank", { brend_id: 3, section: 2 });
  assert.deepEqual(paths, ["/brands/3/documents/contract?format=text&section=2"]);
  const t = textOf(r);
  assert.match(t, /^«RouterAI лицензия» — бланк, раздел 2\./);
  assert.match(t, /Бланк для ознакомления/);
  assert.match(t, /## 2\. Оплата\nЛицензиат оплачивает…/);
  assert.equal(r.structuredContent.sections[0].n, 2);
});

test("section не для text — отказ без вызова balance", async () => {
  const r1 = await callTool("get_brand_contract_blank", { brend_id: 3, format: "pdf", section: 1 });
  const r2 = await callTool("get_customer_contract_document", { customer_id: 5, format: "docx", section: 1 });
  assert.equal(r1.isError, true);
  assert.equal(r2.isError, true);
  assert.equal(paths.length, 0);
});

test("get_customer_contract_document: PDF проекта — ссылка, ПРОЕКТ первой строкой, другие договоры из заголовков", async () => {
  const others = [{ number: "51730", date: "19.10.2025", status: 2, type: "routerai_v2", relation: "other_form" }];
  reply = { status: 200, body: Buffer.alloc(2048, 1), headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="x.pdf"; filename*=UTF-8''${encodeURIComponent("RouterAI.ru — договор — ООО Ромашка (проект).pdf")}`,
    "X-Contract-Source": "draft",
    "X-Contract-Number": encodeURIComponent("51730"),
    "X-Contract-Date": "13.11.2026",
    "X-Contract-Others": encodeURIComponent(JSON.stringify(others)),
  } };
  const r = await callTool("get_customer_contract_document", { customer_id: 51730, format: "pdf", brend_id: 3 });
  assert.deepEqual(paths, ["/customers/51730/contract?format=pdf&brend_id=3"]);
  const t = textOf(r);
  assert.match(t.split("\n")[0], /^ПРОЕКТ договора: договора этой формы у клиента нет, № 51730 от 13\.11\.2026/);
  assert.match(t, /Другие договоры клиента: № 51730 от 19\.10\.2025 \(routerai_v2, действует, другая форма этого бренда\)/);
  assert.match(t, /Ссылка .*: https:\/\/balance\.test\/mcp\/file\/[0-9a-f]{48}\//);
  assert.equal(r.structuredContent.meta.source, "draft");
  assert.equal(r.structuredContent.meta.other_contracts[0].relation, "other_form");
  assert.equal(r.structuredContent.name, "RouterAI.ru — договор — ООО Ромашка (проект).pdf");
});

test("get_customer_contract_document: 422 missing_fields у файла — список полей в ошибке", async () => {
  reply = { status: 422, body: Buffer.from(JSON.stringify({ ok: false, error: { code: "missing_fields",
    message: "Для договора не хватает реквизитов клиента: КПП, БИК банка",
    fields: { kpp: "КПП", bik: "БИК банка" } } })), headers: { "Content-Type": "application/json" } };
  const r = await callTool("get_customer_contract_document", { customer_id: 7, format: "docx" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /\[missing_fields\] — не хватает: КПП, БИК банка\. Спросите эти данные у клиента/);
});

test("get_customer_contract_document: text по записи не в статусе «действует» — предупреждение", async () => {
  reply = { status: 200, json: { ok: true, data: { brend_id: 3, name: "RouterAI лицензия", customer_id: 9,
    meta: { source: "record", contract_id: 2863, contract_number: "51730", contract_date: "10.11.2026", contract_status: 1,
      number_conflict: false, other_contracts: [] },
    sections: [{ n: 1, title: "Предмет", text: "…" }] } } };
  const r = await callTool("get_customer_contract_document", { customer_id: 9, format: "text" });
  assert.deepEqual(paths, ["/customers/9/contract?format=text"]);
  assert.match(textOf(r), /Договор клиента по записи balance \(contract_id 2863\): № 51730 от 10\.11\.2026, статус «на подписании» — договор ещё НЕ действует/);
});

test("ошибка JSON-ручки: render_unavailable — пометка, что это сбой balance", async () => {
  reply = { status: 502, json: { ok: false, error: { code: "render_unavailable", message: "Генератор договора недоступен (HTTP 500)" } } };
  const r = await callTool("get_brand_contract_blank", { brend_id: 3 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Генератор договора недоступен \(HTTP 500\) \[render_unavailable\] Это сбой генератора/);
});
