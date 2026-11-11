// Тест update_contract: подменный balance (http-сервер) + перехват обработчиков тулзов.
// Запуск: npm test (tsc -p tsconfig.test.json && node --test build-test/test/).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

type Call = { method: string; path: string; body: any };
let server: http.Server;
let calls: Call[] = [];
let reply: { status: number; json: any } = { status: 200, json: { ok: true, data: {} } };
const tools = new Map<string, { def: any; h: (a: any, extra: any) => Promise<any> }>();
const extra = { authInfo: { token: "tkn-user" } };

async function callTool(name: string, args: any) {
  const t = tools.get(name);
  assert.ok(t, `нет тулза ${name}`);
  return t!.h(z.object(t!.def.inputSchema).parse(args), extra);
}
const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ method: req.method || "", path: (req.url || "").replace(/^\/api\/v1/, ""), body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.BALANCE_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const fake: any = { registerTool: (name: string, def: any, h: any) => tools.set(name, { def, h }) };
  (await import("../src/tools/contracts.js")).registerContractTools(fake);
});
after(() => { server.close(); });
beforeEach(() => { calls = []; });

test("update_contract: PATCH только переданных полей, итог — что изменилось", async () => {
  reply = { status: 200, json: { ok: true, data: { contract_id: 2863,
    changes: { contract_date: { from: "2026-10-19", to: "2026-11-10" }, contract_status: { from: 0, to: 2 } },
    warnings: ["Документы, уже созданные в 1С, остаются на прежнем договоре 1С."] } } };
  const r = await callTool("update_contract", { id: 2863, contract_date: "2026-11-10", contract_status: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].path, "/contracts/2863");
  assert.deepEqual(calls[0].body, { contract_date: "2026-11-10", contract_status: 2 });
  assert.match(textOf(r), /Договор #2863 изменён \(contract_date, contract_status\) ⚠ см\. warnings/);
  assert.notEqual(r.isError, true);
});

test("update_contract: без полей — отказ без вызова balance", async () => {
  const r = await callTool("update_contract", { id: 2863 });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test("update_contract: ошибки полей из 422 видны агенту", async () => {
  reply = { status: 422, json: { ok: false, error: { code: "validation_failed", message: "Невалидные данные",
    errors: { contract_date: "Дата — ГГГГ-ММ-ДД" } } } };
  const r = await callTool("update_contract", { id: 2863, contract_date: "2026-02-30" });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "Невалидные данные — contract_date: Дата — ГГГГ-ММ-ДД");
});

test("update_contract: схема не пускает дату не в ГГГГ-ММ-ДД и чужой статус", async () => {
  await assert.rejects(callTool("update_contract", { id: 1, contract_date: "10.11.2026" }));
  await assert.rejects(callTool("update_contract", { id: 1, contract_status: 5 }));
  assert.equal(calls.length, 0);
});

test("update_contract: без изменений — так и пишет", async () => {
  reply = { status: 200, json: { ok: true, data: { contract_id: 7, changes: {}, warnings: [] } } };
  const r = await callTool("update_contract", { id: 7, comment: "x" });
  assert.match(textOf(r), /Договор #7: изменений нет/);
});
