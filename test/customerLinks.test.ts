// Тесты тулзов кабинетов и слияния (customerLinks.ts) и create_contract / новых полей update_contract:
// подменный balance (http-сервер) + перехват обработчиков тулзов, как в contracts.test.ts.
// Сценарий — случай 20.11.2026: кабинет RouterAI 79032 у автокарточки 64688, ИП — КА 67251, договор 3790.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

type Call = { method: string; path: string; body: any };
let server: http.Server;
let calls: Call[] = [];
let replies: Array<{ status: number; json: any }> = [];
const tools = new Map<string, { def: any; h: (a: any, extra: any) => Promise<any> }>();
const extra = { authInfo: { token: "tkn-user" } };

async function callTool(name: string, args: any) {
  const t = tools.get(name);
  assert.ok(t, `нет тулза ${name}`);
  return t!.h(z.object(t!.def.inputSchema).parse(args), extra);
}
const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
const reply = (...r: Array<{ status: number; json: any }>) => { replies = r; };

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ method: req.method || "", path: (req.url || "").replace(/^\/api\/v1/, ""), body: raw ? JSON.parse(raw) : undefined });
      const r = replies.shift() ?? { status: 200, json: { ok: true, data: {} } };
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.BALANCE_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const fake: any = { registerTool: (name: string, def: any, h: any) => tools.set(name, { def, h }) };
  (await import("../src/tools/customerLinks.js")).registerCustomerLinkTools(fake);
  (await import("../src/tools/contracts.js")).registerContractTools(fake);
});
after(() => { server.close(); });
beforeEach(() => { calls = []; replies = []; });

test("link_customer_to_cabinet: POST связки, перенос получателя и предупреждения в тексте", async () => {
  reply({ status: 201, json: { ok: true, data: { created: true, link: { id: 60787 }, recipient_taken_from: 64688,
    changes: { link: { from: null, to: "9:79032" }, is_payment_recipient: { from: 0, to: 1 } },
    warnings: ["Получатель — карточка с ИНН, а в кабинете есть автокарточка физлица без ИНН (КА 64688)."] } } });
  const r = await callTool("link_customer_to_cabinet",
    { customer_id: 67251, customer_group_id: 9, remote_id: "79032", is_payment_recipient: true });
  assert.deepEqual(calls, [{ method: "POST", path: "/customers/67251/links",
    body: { customer_group_id: 9, remote_id: "79032", is_payment_recipient: true } }]);
  const t = textOf(r);
  assert.match(t, /^КА #67251 привязан к кабинету 79032 \(дилер 9\), связка #60787; получатель платежей перенесён с КА #64688/);
  assert.match(t, /⚠ Получатель — карточка с ИНН/);
});

test("link_customer_to_cabinet: 403 user_only сервисного ключа виден агенту", async () => {
  reply({ status: 403, json: { ok: false, error: { code: "user_only", message: "Связки с кабинетами меняет только сотрудник" } } });
  const r = await callTool("link_customer_to_cabinet", { customer_id: 67251, customer_group_id: 9, remote_id: "79032" });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "Связки с кабинетами меняет только сотрудник");
});

test("update_customer_link: PATCH только переданного, false схема не пускает", async () => {
  reply({ status: 200, json: { ok: true, data: { changes: { is_payment_recipient: { from: 0, to: 1 } }, recipient_taken_from: 64688, warnings: [] } } });
  const r = await callTool("update_customer_link", { customer_id: 67251, link_id: 60787, is_payment_recipient: true });
  assert.deepEqual(calls, [{ method: "PATCH", path: "/customers/67251/links/60787", body: { is_payment_recipient: true } }]);
  assert.equal(textOf(r).split("\n")[0], "Связка #60787 изменена (is_payment_recipient); получатель платежей перенесён с КА #64688");
  await assert.rejects(callTool("update_customer_link", { customer_id: 1, link_id: 1, is_payment_recipient: false }));
  const empty = await callTool("update_customer_link", { customer_id: 1, link_id: 1 });
  assert.equal(empty.isError, true);
  assert.equal(calls.length, 1);
});

test("unlink_customer_from_cabinet: DELETE, куда ушёл получатель", async () => {
  reply({ status: 200, json: { ok: true, data: { remoteid: "79032", recipient_moved_to: null, warnings: [] } } });
  const r = await callTool("unlink_customer_from_cabinet", { customer_id: 64688, link_id: 58039 });
  assert.deepEqual(calls, [{ method: "DELETE", path: "/customers/64688/links/58039", body: undefined }]);
  assert.equal(textOf(r).split("\n")[0], "Связка #58039 снята: КА #64688 отвязан от кабинета 79032");
});

test("merge_customers: без confirm — план и токен, с токеном — слияние", async () => {
  const plan = { can_merge: true, source: { name: "Пользователь RouterAi (id 81000)" }, target: { name: "ИП Иванов" },
    moves: { links: 2, contracts: 1, files: 0 }, fill_fields: { phone: "+7 900" }, warnings: [] };
  reply({ status: 200, json: { ok: true, data: plan } });
  const r1 = await callTool("merge_customers", { customer_id: 67251, from_customer_id: 700 });
  assert.deepEqual(calls[0], { method: "POST", path: "/customers/67251/merge", body: { from_customer_id: 700, dry_run: true } });
  assert.match(textOf(r1), /переедет links: 2, contracts: 1; дополнятся поля: phone/);
  const confirm = r1.structuredContent.confirm;
  assert.match(confirm, /^v1\./);

  reply({ status: 200, json: { ok: true, data: { done: true, warnings: [] } } });
  const r2 = await callTool("merge_customers", { customer_id: 67251, from_customer_id: 700, confirm });
  assert.deepEqual(calls[1], { method: "POST", path: "/customers/67251/merge", body: { from_customer_id: 700, dry_run: false } });
  assert.match(textOf(r2), /КА #700 слит в КА #67251/);
});

test("merge_customers: токен другого дубля не подходит, balance не зовётся", async () => {
  reply({ status: 200, json: { ok: true, data: { can_merge: true, moves: {}, fill_fields: {} } } });
  const r1 = await callTool("merge_customers", { customer_id: 67251, from_customer_id: 700 });
  const r2 = await callTool("merge_customers", { customer_id: 67251, from_customer_id: 64688, confirm: r1.structuredContent.confirm });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Токен подтверждения не совпал/);
  assert.equal(calls.length, 1);
});

test("merge_customers: автокарточка с оплатами — отказ с подсказкой перевязать кабинет, токена нет", async () => {
  reply({ status: 200, json: { ok: true, data: { can_merge: false,
    blockers: [{ code: "documents", label: "документы (счета, оплаты, акты, УПД)", count: 4 }] } } });
  const r = await callTool("merge_customers", { customer_id: 67251, from_customer_id: 64688 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /не сливается: документы \(счета, оплаты, акты, УПД\) \(4\)/);
  assert.match(textOf(r), /перевяжите кабинет/);
  assert.equal(r.structuredContent, undefined);
});

test("create_contract: POST с переданными полями, итог — форма, организация, НДС", async () => {
  reply({ status: 201, json: { ok: true, data: { contract_id: 3801, contract_number: "67251", contract_type: "routerai_v3",
    org_id: 2, vat: "no", contract_status: 0, defaults_source: { contract_type: "brand_document" },
    warnings: ["Форма routerai_v3 задаёт документам ставку договора (без НДС) — когда договор «Действует» (статус 2)."] } } });
  const r = await callTool("create_contract", { customer_id: 67251, contract_name: "Партнёрский договор" });
  assert.deepEqual(calls, [{ method: "POST", path: "/contracts", body: { customer_id: 67251, contract_name: "Партнёрский договор" } }]);
  assert.match(textOf(r), /^Договор #3801 № 67251 заведён у КА #67251: форма routerai_v3, организация 2, НДС no, статус 0 ⚠ Форма routerai_v3/);
  await assert.rejects(callTool("create_contract", { customer_id: 1, contract_status: 2 }));
  await assert.rejects(callTool("create_contract", { customer_id: 1, vat: "20" }));
  assert.equal(calls.length, 1);
});

test("update_contract: форма, НДС и организация уходят в PATCH; 409 организации виден", async () => {
  reply({ status: 200, json: { ok: true, data: { contract_id: 3790,
    changes: { contract_type: { from: "routerai_saas_v2", to: "routerai_v3" }, vat: { from: "5", to: "no" },
               org_id: { from: 0, to: 2 }, brend_id: { from: 0, to: 3 } }, warnings: [] } } });
  const r = await callTool("update_contract", { id: 3790, contract_type: "routerai_v3", vat: "no", org_id: 2 });
  assert.deepEqual(calls[0].body, { contract_type: "routerai_v3", vat: "no", org_id: 2 });
  assert.match(textOf(r), /^Договор #3790 изменён \(contract_type, vat, org_id, brend_id\)/);

  reply({ status: 409, json: { ok: false, error: { code: "contract_has_documents",
    message: "Организацию договора не меняем: по договору уже есть документы другой организации (2)" } } });
  const r2 = await callTool("update_contract", { id: 3790, org_id: 1 });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /по договору уже есть документы другой организации/);
});
