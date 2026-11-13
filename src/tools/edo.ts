// Тулзы ЭДО (Диадок, Saby) — ЧТЕНИЕ (задача пользователя 13.10.2026, Saby — 16.10.2026) и ЧЕРНОВИКИ (11.11.2026):
// create_edo_draft / delete_edo_draft / list_edo_drafts — документ balance или 1С черновиком в СБИС (по умолчанию) или
// Диадок; отправляет оператор, balance не подписывает (balance /api/v1/edo/drafts, onec:write + право edo.draft).
// С 13.11.2026 — и файлы balance: договор, доп. соглашение, письмо, произвольный документ (kind + file_id / contract_id,
// миграция balance 184).
//
// MCP в Диадок и Saby не ходит: тулзы зовут balance /api/v1/edo/…, а balance сам берёт ящик организации, ключи
// и проверяет скоуп onec:read, право onec.view (пользователю с зоной дилера — 403: ящик организации —
// сквозной список). Документы Диадока читаются живьём; входящие Saby balance дочитывает с курсора
// (СБИС.СписокИзменений) и отдаёт из своей таблицы, документ целиком — живьём. У входящих balance ищет, заведены
// ли они в 1С — по ключу diadoc:<MessageId>:<EntityId> или saby:<документ>:<вложение> (так создаёт balance) или по
// входящему номеру у контрагента с тем же ИНН (так заводит бухгалтер). Создание в 1С — create_onec_supplier_document
// (onecWrite.ts).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall, type Envelope } from "../balanceClient.js";
import { tokenOf, qs, ok, fail, confirmToken, verifyConfirmToken } from "./util.js";
import { onecFail, money, docLine, UUID_RE, DATE_RE } from "./onec.js";

/** Диадок + проверка в 1С по каждому входящему — дольше обычного чтения 1С; balance держит до 150 с. */
const EDO_TIMEOUT_MS = 150_000;
/** Черновик: 1С (карточка, PDF) + оператор (контрагент, дубли, сборка УПД) — balance держит до 240 с. */
const DRAFT_TIMEOUT_MS = 230_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DRAFT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DRAFT_DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const PROVIDER_NAMES: Record<string, string> = { saby: "СБИС (Saby)", diadoc: "Диадок" };

const orgId = () => z.number().int().positive().describe("Организация — ящик Диадока: org_id из get_edo_status (он же база 1С)");
const guid = (what: string) => z.string().regex(UUID_RE, "GUID документа Диадока").describe(`${what} документа Диадока (из list_diadoc_documents)`);
const date = (what: string) => z.string().regex(DATE_RE, "ГГГГ-ММ-ДД").describe(`${what}, ГГГГ-ММ-ДД`);

const TYPE_NAMES: Record<string, string> = {
  UniversalTransferDocument: "УПД",
  ProformaInvoice: "Счёт",
  XmlAcceptanceCertificate: "Акт",
  Nonformalized: "Неформализованный документ",
  // типы вложений Saby
  УпдСчфДоп: "УПД",
  УпдДоп: "УПД (передаточный)",
  УпдСчф: "Счёт-фактура (УПД)",
  СчФктр: "Счёт-фактура",
};
const sabyGuid = (what: string) => z.string().regex(UUID_RE, "GUID Saby").describe(`${what} (из list_saby_documents)`);

/** GET к balance с тайм-аутом для Диадока и 1С. */
function get(extra: any, path: string): Promise<Envelope> {
  return balanceCall(tokenOf(extra), "GET", path, undefined, { timeoutMs: EDO_TIMEOUT_MS });
}

/** «УПД № 15 от 2026-10-01 на 12 000,00, ООО Ромашка ИНН 7700000000» */
function edoLine(d: any): string {
  if (!d) return "";
  const ca = d.counteragent || {};
  return `${TYPE_NAMES[d.type] || d.type || "документ"} № ${d.number || "—"} от ${d.date || "—"}` +
    (d.total !== null && d.total !== undefined ? ` на ${money(d.total)}` : "") +
    (ca.name || ca.inn ? `, ${ca.name || "—"}${ca.inn ? ` ИНН ${ca.inn}` : ""}` : "");
}

/** Черновик (превью или созданный) — текстом: что, кому, откуда номер, файл, предупреждения, где искать. */
function draftText(d: any): string {
  const ca = d.counteragent || {};
  const upd = d.upd || {};
  const lines = [
    `${PROVIDER_NAMES[d.provider] || d.provider}: ${d.kind_name || d.kind} № ${d.number || "—"} от ${d.date || "—"}` +
      (d.total !== null && d.total !== undefined ? ` на ${money(d.total)}` : "") + (d.vat ? ` (НДС ${money(d.vat)})` : "") +
      ` — ${ca.edo_name || ca.name || "—"}${ca.inn ? ` ИНН ${ca.inn}` : ""}${ca.status ? `; в Диадоке: ${ca.status}` : ""}` +
      `; от ${d.organization || `org ${d.org_id}`}`,
    d.kind === "upd" ? `УПД ${upd.function || d.function || ""}: номер — ${upd.number_from || "из 1С"}; строк: ${(upd.items || []).length}` +
      `${upd.basis ? `; основание: ${upd.basis}` : "; без основания"}` : "",
    d.file ? `Файл: ${d.file.name}${d.file.size ? ` (${Math.max(1, Math.round(d.file.size / 1024))} КБ)` : ""}${d.file.from ? `, ${d.file.from}` : ""}` : "",
    d.doc_id ? `Документ balance #${d.doc_id}` + (d.onec_id ? `, документ 1С ${d.onec_id}` : "") : d.onec_id ? `Документ 1С ${d.onec_id}` : "",
    d.contract && (d.contract.number || d.contract.contract_id)
      ? `${d.kind === "agreement" ? "Основной договор" : "Договор"}: № ${d.contract.number || "—"} от ${d.contract.date || "—"}` +
        (d.contract.contract_id ? ` (договор balance #${d.contract.contract_id})` : "") : "",
    d.kind === "document" ? `Подпись получателя: ${d.need_signature ? "запрошена" : "не нужна (только получение)"}` : "",
    ...((d.warnings || []) as string[]).map((w) => `⚠ ${w}`),
    d.where ? `Оператору: ${d.where}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Есть ли входящий документ в 1С — человеческим текстом. */
function onecText(o: any, inn?: string): string {
  if (!o) return "";
  switch (o.status) {
    case "found":
      return `уже есть в 1С: ${((o.matches || []) as any[]).map((m) => docLine(m) + (m.by === "external_id" ? " (создан balance)" : ` (входящий № ${m.incoming_number || "—"})`)).join("; ")}`;
    case "absent":
      return "в 1С не найден — можно создать (create_onec_supplier_document)";
    case "no_counterparty":
      return `поставщика${inn ? ` с ИНН ${inn}` : ""} в 1С нет — сначала create_onec_supplier`;
    default:
      return "в 1С не проверялся";
  }
}

export function registerEdoTools(server: McpServer) {
  server.registerTool("get_edo_status", {
    title: "ЭДО (Диадок, Saby): подключение и ящики",
    description:
      "Подключение balance к Диадоку: настроено ли (configured), ящики организаций — у какого ящика есть доступ к API " +
      "(api_ok; без него документы ящика не читаются, причина — в note), и последняя фоновая синхронизация пометок «ушёл " +
      "через ЭДО» у документов balance (включена ли, за сколько дней смотрит, когда запускалась, последняя ошибка, " +
      "статистика). То же для Saby (СБИС): настроен ли, наши организации в учётке Saby — есть ли документооборот, сколько " +
      "входящих прочитано. Вызывайте первым, чтобы выбрать org_id для list_diadoc_documents / list_saby_documents и понять, " +
      "куда можно положить черновик (create_edo_draft: СБИС — организация с документооборотом, Диадок — ящик с api_ok). Секреты не отдаются.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async (_a, extra) => {
    const env = await get(extra, "/edo/status");
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const boxes = ((d.boxes || []) as any[]).map((b) => `org ${b.org_id} «${b.organization || b.box}»: ` +
      (b.api_ok === true ? "API доступен" : b.api_ok === false ? `нет доступа к API${b.note ? ` — ${b.note}` : ""}` : "не проверялся")).join("; ");
    const sync = d.sync_enabled
      ? `включена (за ${d.sync_days} дн.)${d.last_run_at ? `, последний запуск ${d.last_run_at}` : ""}${d.last_error ? `, ошибка: ${d.last_error}` : ""}`
      : "выключена";
    const sb = d.providers?.saby;
    const sabyText = !sb ? "" : !sb.installed ? "\nSaby: в balance не установлено (миграция 167)." :
      `\nSaby: ${sb.configured ? "подключён" : "НЕ настроен («Настройки → ЭДО (Диадок, Saby)»)"}${sb.last_error ? `, последняя ошибка: ${sb.last_error}` : ""}. ` +
      `Организации: ${((sb.organizations || []) as any[]).map((o) => `org ${o.org_id} «${o.organization || o.saby_name}»: ` +
        (o.edo_ok ? `документооборот есть, входящих прочитано ${o.incoming_docs ?? 0}` : `нет документооборота${o.note ? ` — ${o.note}` : ""}`)).join("; ") ||
        "ещё не найдены (найдутся при первом list_saby_documents)"}.`;
    return ok(`Диадок: ${d.configured ? "подключён" : "НЕ настроен («Настройки → ЭДО (Диадок)»)"}; ` +
      `синхронизация пометок «ушёл через ЭДО»: ${sync}. Ящики: ${boxes || "нет"}.${sabyText}`, d);
  });

  server.registerTool("list_diadoc_documents", {
    title: "Документы в Диадоке",
    description:
      "Документы ящика организации в Диадоке (живьём, не из кэша): входящие (direction=in, по умолчанию) — УПД, акты, " +
      "счета и прочее от поставщиков; исходящие (out) — что ушло клиентам, со связанным документом balance (balance_doc_id). " +
      "У входящих balance по умолчанию проверяет, заведены ли они в 1С (onec.status: found — есть, absent — нет, " +
      "no_counterparty — поставщика с таким ИНН в 1С нет вовсе; onec.matches — найденные документы 1С). Порядок работы с " +
      "входящими: not_in_onec=true — только ещё не заведённые в 1С → get_diadoc_document (строки УПД) → " +
      "create_onec_supplier_document (поставщика нет в 1С — сначала create_onec_supplier). Период по дате документа, без from — " +
      "последние 90 дней. Удалённые в Диадоке не показываются.",
    inputSchema: {
      org_id: orgId(),
      direction: z.enum(["in", "out"]).optional().describe("in — входящие от поставщиков (по умолчанию), out — исходящие клиентам"),
      from: date("С даты документа (по умолчанию 90 дней назад)").optional(),
      to: date("По дату документа (по умолчанию без ограничения)").optional(),
      types: z.array(z.string().regex(/^[A-Za-z]{3,64}$/, "тип Диадока латиницей")).max(10).optional()
        .describe("Типы Диадока: UniversalTransferDocument (УПД), ProformaInvoice (счёт), XmlAcceptanceCertificate (акт), Nonformalized (прочее); по умолчанию эти четыре"),
      counteragent_inn: z.string().regex(/^\d{10}(\d{2})?$/, "10 или 12 цифр").optional().describe("Только документы контрагента с этим ИНН"),
      limit: z.number().int().min(1).max(200).optional().describe("Сколько документов вернуть, 1–200 (по умолчанию 50)"),
      onec_check: z.boolean().optional().describe("Входящие: проверить, есть ли каждый в 1С (по умолчанию true; false — быстрее, без 1С)"),
      not_in_onec: z.boolean().optional().describe("Входящие: только те, которых в 1С ещё нет (status absent или no_counterparty); проверку в 1С включает сам"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const dir = a.direction ?? "in";
    if (dir === "out" && a.not_in_onec) return fail("not_in_onec — только для входящих (direction=in): исходящие в 1С не ищутся.");
    if (a.from && a.to && a.from > a.to) return fail("from позже to.");
    const check = dir === "in" && (a.onec_check !== false || !!a.not_in_onec);
    const path = "/edo/documents" + qs({
      org_id: a.org_id, direction: dir, from: a.from, to: a.to, types: a.types, counteragent_inn: a.counteragent_inn,
      limit: a.limit, onec_check: check ? 1 : undefined, not_in_onec: a.not_in_onec ? 1 : undefined,
    });
    const env = await get(extra, path);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const items: any[] = d.items || [];
    const head = `Документов Диадока org ${d.org_id ?? a.org_id} (${dir === "in" ? "входящие" : "исходящие"}, ${d.from ?? a.from ?? "—"} — ${d.to ?? a.to ?? "…"}): ` +
      `${items.length}${d.total_in_diadoc !== null && d.total_in_diadoc !== undefined ? ` (по фильтру в Диадоке всего ${d.total_in_diadoc})` : ""}`;
    let tail = "";
    if (dir === "in" && check) {
      const n = (s: string) => items.filter((it) => it.onec?.status === s).length;
      tail = a.not_in_onec ? `; все — нет в 1С (из них поставщика нет в 1С: ${n("no_counterparty")})` : `; нет в 1С: ${n("absent")}, уже в 1С: ${n("found")}, поставщика нет в 1С: ${n("no_counterparty")}`;
    } else if (dir === "out") {
      tail = `; связаны с документами balance: ${items.filter((it) => it.balance_doc_id).length}`;
    }
    return ok(`${head}${tail}.${d.has_more ? "\nЕсть ещё документы — увеличьте limit или сузьте период." : ""}${d.note ? `\n⚠ ${d.note}` : ""}`, d);
  });

  server.registerTool("get_diadoc_document", {
    title: "Документ Диадока со строками",
    description:
      "Один документ Диадока целиком: реквизиты, статус документооборота, продавец и покупатель, строки УПД из XML (lines: " +
      "наименование, код, единица, количество, цена, сумма без НДС, ставка и сумма НДС, сумма, услуга ли), итоги (totals) и " +
      "вид документа 1С, который из него получится (onec_kind: purchase — поступление, supplier_invoice — счёт от " +
      "поставщика). У счетов (файл, обычно PDF) и прочих видов строк нет (lines=null, причина — parse_note): для 1С строки " +
      "передаются сами. У входящих — заведён ли он уже в 1С (onec, как в list_diadoc_documents; onec_check=false — не " +
      "проверять). Следующий шаг — create_onec_supplier_document с этими message_id и entity_id.",
    inputSchema: {
      org_id: orgId(),
      message_id: guid("message_id"),
      entity_id: guid("entity_id"),
      onec_check: z.boolean().optional().describe("Проверить, есть ли входящий документ в 1С (по умолчанию true)"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const path = `/edo/documents/${a.message_id.toLowerCase()}/${a.entity_id.toLowerCase()}` +
      qs({ org_id: a.org_id, onec_check: a.onec_check === false ? 0 : undefined });
    const env = await get(extra, path);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const t = d.totals || {};
    const seller = d.seller || d.counteragent || {};
    const lns: any[] | null = Array.isArray(d.lines) ? d.lines : null;
    const out = [
      `${d.direction === "in" ? "Входящий" : "Исходящий"} ${edoLine(d)}${d.title ? ` («${d.title}»)` : ""}; в Диадоке: ${d.status_text || d.state || "—"}`,
      lns ? `Строк: ${lns.length}; итого ${money(t.total)}${t.vat !== null && t.vat !== undefined ? `, НДС ${money(t.vat)}` : ""}` : `Строк нет: ${d.parse_note || "не разобраны"}`,
      d.direction === "in" ? `В 1С: ${d.onec ? onecText(d.onec, seller.inn) : "не проверялся"}; вид документа 1С по умолчанию — ${d.onec_kind === "supplier_invoice" ? "счёт от поставщика" : "поступление"}` : "",
      d.balance_doc_id ? `Документ balance #${d.balance_doc_id}` : "",
    ].filter(Boolean).join("\n");
    return ok(out, d);
  });

  // ---------------------------------------------------------------------------------------------- Saby
  server.registerTool("list_saby_documents", {
    title: "Входящие документы в Saby (СБИС)",
    description:
      "Входящие УПД и акты поставщиков (тип Saby ДокОтгрВх) организации в Saby (СБИС) — например, ежемесячные акты ООО «БК». " +
      "balance сначала дочитывает новые события Saby с прошлого раза, потом отбирает документы по дате документа (без from — " +
      "последние 90 дней; раньше уже прочитанного — перечитает с этой даты). Одна строка — один документ: document_id и " +
      "attachment_id основного вложения (УПД), номер, дата, сумма, НДС, контрагент, состояние документооборота. По умолчанию " +
      "balance проверяет, заведён ли каждый в 1С (onec.status: found — есть, absent — нет, no_counterparty — поставщика с таким " +
      "ИНН в 1С нет; onec.matches — найденные документы 1С). Порядок: not_in_onec=true — только ещё не заведённые → " +
      "get_saby_document (строки УПД) → create_onec_supplier_document с source=saby (поставщика нет в 1С — сначала " +
      "create_onec_supplier). Исходящие здесь не показываются: их balance читает фоном только для пометки «ушёл через СБИС». " +
      "Удалённые не показываются.",
    inputSchema: {
      org_id: z.number().int().positive().describe("Организация: org_id из get_edo_status (providers.saby.organizations; он же база 1С)"),
      from: date("С даты документа (по умолчанию 90 дней назад)").optional(),
      to: date("По дату документа (по умолчанию без ограничения)").optional(),
      counteragent_inn: z.string().regex(/^\d{10}(\d{2})?$/, "10 или 12 цифр").optional().describe("Только документы контрагента с этим ИНН"),
      limit: z.number().int().min(1).max(200).optional().describe("Сколько документов вернуть, 1–200 (по умолчанию 50)"),
      onec_check: z.boolean().optional().describe("Проверить, есть ли каждый в 1С (по умолчанию true; false — быстрее, без 1С)"),
      not_in_onec: z.boolean().optional().describe("Только те, которых в 1С ещё нет (status absent или no_counterparty); проверку в 1С включает сам"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    if (a.from && a.to && a.from > a.to) return fail("from позже to.");
    const check = a.onec_check !== false || !!a.not_in_onec;
    const env = await get(extra, "/edo/documents" + qs({
      provider: "saby", org_id: a.org_id, from: a.from, to: a.to, counteragent_inn: a.counteragent_inn, limit: a.limit,
      onec_check: check ? 1 : undefined, not_in_onec: a.not_in_onec ? 1 : undefined,
    }));
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const items: any[] = d.items || [];
    const n = (s: string) => items.filter((it) => it.onec?.status === s).length;
    const tail = !check ? "" : a.not_in_onec ? `; все — нет в 1С (из них поставщика нет в 1С: ${n("no_counterparty")})`
      : `; нет в 1С: ${n("absent")}, уже в 1С: ${n("found")}, поставщика нет в 1С: ${n("no_counterparty")}`;
    const rows = items.slice(0, 30).map((it) => `• ${edoLine(it)}${check ? ` — ${onecText(it.onec, it.counteragent?.inn)}` : ""}` +
      `${it.attachment_id ? "" : " (вложения ещё нет)"}`);
    return ok(`Входящие Saby org ${d.org_id ?? a.org_id}${d.organization ? ` «${d.organization}»` : ""} (${d.from ?? a.from ?? "—"} — ${d.to ?? a.to ?? "…"}): ` +
      `${items.length}${tail}.${d.has_more ? "\nЕсть ещё документы — увеличьте limit или сузьте период." : ""}${d.note ? `\n⚠ ${d.note}` : ""}` +
      (rows.length ? "\n" + rows.join("\n") : ""), d);
  });

  server.registerTool("get_saby_document", {
    title: "Документ Saby со строками",
    description:
      "Один входящий документ Saby (СБИС) целиком: реквизиты, состояние документооборота, основание (договор), вложения, " +
      "продавец и покупатель, строки УПД из XML вложения (lines: наименование, код, единица, количество, цена, сумма без НДС, " +
      "ставка и сумма НДС, сумма, услуга ли), итоги (totals) и вид документа 1С (onec_kind: purchase — поступление). " +
      "attachment_id не передан — основное вложение (УПД). Неформализованные вложения (скан, PDF) строк не дают (lines=null, " +
      "причина — parse_note). Заведён ли уже в 1С — onec (как в list_saby_documents; onec_check=false — не проверять). " +
      "Следующий шаг — create_onec_supplier_document с source=saby и этими document_id и attachment_id.",
    inputSchema: {
      org_id: z.number().int().positive().describe("Организация: org_id из get_edo_status (providers.saby.organizations)"),
      document_id: sabyGuid("document_id документа Saby"),
      attachment_id: sabyGuid("attachment_id вложения").optional(),
      onec_check: z.boolean().optional().describe("Проверить, есть ли документ в 1С (по умолчанию true)"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const path = `/edo/documents/${a.document_id.toLowerCase()}${a.attachment_id ? `/${a.attachment_id.toLowerCase()}` : ""}` +
      qs({ provider: "saby", org_id: a.org_id, onec_check: a.onec_check === false ? 0 : undefined });
    const env = await get(extra, path);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const t = d.totals || {};
    const seller = d.seller || d.counteragent || {};
    const lns: any[] | null = Array.isArray(d.lines) ? d.lines : null;
    const out = [
      `Входящий ${edoLine(d)}${d.title ? ` («${d.title}»)` : ""}; в Saby: ${d.status_text || d.state || "—"}${d.grounds ? `; основание: ${d.grounds}` : ""}`,
      lns ? `Строк: ${lns.length}; итого ${money(t.total)}${t.vat !== null && t.vat !== undefined ? `, НДС ${money(t.vat)}` : ""}\n` +
        lns.map((l) => `  ${l.line}. ${l.name} — ${money(l.amount)} (${l.vat_rate || "—"}${l.vat_amount ? `, НДС ${money(l.vat_amount)}` : ""})`).join("\n")
        : `Строк нет: ${d.parse_note || "не разобраны"}`,
      `В 1С: ${d.onec ? onecText(d.onec, seller.inn) : "не проверялся"}; вид документа 1С по умолчанию — поступление`,
      d.attachment_id ? `Создать: create_onec_supplier_document, source=saby, document_id=${d.document_id}, attachment_id=${d.attachment_id}` : "",
    ].filter(Boolean).join("\n");
    return ok(out, d);
  });

  // ---------------------------------------------------------------------------------------------- Черновики
  // Задача пользователя 11.11.2026: прямой отправки из balance в ЭДО нет — агент кладёт документ ЧЕРНОВИКОМ
  // в кабинет нашей организации, оператор проверяет, подписывает и отправляет сам. Оба оператора, по умолчанию
  // СБИС (Saby). Две фазы, как вся запись: превью (balance dry_run) → токен → создание с теми же полями.
  server.registerTool("create_edo_draft", {
    title: "Положить документ черновиком в СБИС или Диадок (с подтверждением)",
    description:
      "Положить документ ЧЕРНОВИКОМ в ЭДО нашей организации — по умолчанию в СБИС (Saby), provider=diadoc — в Диадок. " +
      "balance ничего не отправляет и не подписывает: черновик видит только наша организация, оператор открывает его, " +
      "проверяет, подписывает и отправляет сам (отправить без подписи КЭП ни СБИС, ни Диадок не дают). Источник — один из трёх: " +
      "(1) документ balance (doc_id); (2) документ 1С (org_id + onec_id, например акт сверки из create_onec_reconciliation); " +
      "(3) файл balance — договор, доп. соглашение, письмо или произвольный документ (kind + file_id и/или contract_id). " +
      "Что кладётся: счёт — PDF; УПД (акт balance или реализация 1С) — формализованный УПД 5.03, номер, дата, строки, ставки и " +
      "договор берутся из 1С: есть счёт-фактура выданный — СЧФДОП с её номером на печать, нет и строки без НДС — ДОП с номером " +
      "реализации (документ balance должен быть в 1С — send_document_to_onec); акт сверки — PDF. Файлы — как есть (PDF, DOCX, " +
      "XLSX, сканы): kind=contract — договор (Диадок «Договор», СБИС ДоговорДок; подписывают обе стороны): contract_id без " +
      "file_id — единственный файл договора, номер и дата — из договора balance (get_contract), если файлов несколько — укажите " +
      "file_id; kind=agreement — доп. соглашение: нужны number и date соглашения, основной договор — contract_id, договор файла " +
      "или contract_number + contract_date; kind=letter — письмо (Диадоку нужен number — исходящий номер); kind=document — " +
      "произвольный документ, need_signature=true просит подпись получателя (только Диадок; в СБИС получатель лишь " +
      "подтверждает получение). Файл клиента без договора — с org_id (от какой организации). Файлы — list_customer_files; " +
      "новый файл сначала загрузить upload_customer_file. Не кладёт (blockers в превью): клиент не наш контрагент в Диадоке или " +
      "его нет в СБИС как участника ЭДО; такой документ (тот же файл) уже лежит черновиком или уже ушёл клиенту (по данным " +
      "balance и живому поиску у оператора по номеру и ИНН); у организации нет ящика или документооборота. ДВУХШАГОВО: без " +
      "confirm — превью (что, кому, номер, строки УПД, файл, предупреждения), в ЭДО ничего не пишется; с confirm и ТЕМИ ЖЕ " +
      "полями — черновик. Использовать только по явной просьбе пользователя.",
    inputSchema: {
      provider: z.enum(["saby", "diadoc"]).optional().describe("Куда: saby — СБИС (по умолчанию), diadoc — Диадок"),
      doc_id: z.number().int().positive().optional().describe("Документ balance: счёт, УПД (акт) или акт сверки"),
      org_id: z.number().int().positive().optional()
        .describe("С onec_id — организация = база 1С (list_onec_bases); с file_id без договора — от какой организации класть"),
      onec_id: z.string().regex(UUID_RE, "UUID ссылки 1С").optional().describe("Документ 1С (счёт, реализация, акт сверки) — вместо doc_id"),
      kind: z.enum(["contract", "agreement", "letter", "document"]).optional()
        .describe("Для файла balance: contract — договор (по умолчанию при contract_id), agreement — доп. соглашение, letter — письмо, document — произвольный"),
      file_id: z.number().int().positive().optional().describe("Файл balance — клиента или договора (list_customer_files)"),
      contract_id: z.number().int().positive().optional().describe("Договор balance (list_contracts): договор или основной договор доп. соглашения"),
      number: z.string().max(100).optional().describe("Номер документа (договор — по умолчанию из договора balance; письмо — исходящий номер)"),
      date: z.string().regex(DATE_RE, "ГГГГ-ММ-ДД").optional().describe("Дата документа, ГГГГ-ММ-ДД (договор — из договора balance; письмо и документ — по умолчанию сегодня)"),
      contract_number: z.string().max(100).optional().describe("Доп. соглашение: номер основного договора, если нет contract_id"),
      contract_date: z.string().regex(DATE_RE, "ГГГГ-ММ-ДД").optional().describe("Доп. соглашение: дата основного договора, ГГГГ-ММ-ДД"),
      total: z.number().nonnegative().optional().describe("Сумма: цена договора или доп. соглашения (необязательно)"),
      need_signature: z.boolean().optional().describe("kind=document: запросить подпись получателя (Диадок)"),
      confirm: z.string().optional().describe("Токен подтверждения из превью-вызова. БЕЗ него ничего не записывается"),
    },
    annotations: DRAFT_WRITE,
  }, async (a, extra) => {
    const provider = a.provider ?? "saby";
    const isFile = Boolean(a.file_id || a.contract_id);
    const fileOnly = [a.kind, a.number, a.date, a.contract_number, a.contract_date, a.total, a.need_signature].some((v) => v !== undefined);
    if ([a.doc_id, a.onec_id, isFile || undefined].filter(Boolean).length > 1) {
      return fail("Передайте что-то одно: doc_id (документ balance), org_id + onec_id (документ 1С) или файл balance (file_id / contract_id).");
    }
    if (!isFile && fileOnly) return fail("kind, number, date, contract_*, total, need_signature — только для файла balance (file_id / contract_id).");
    if (a.doc_id && a.org_id) return fail("org_id не нужен с doc_id: организация — из документа balance.");
    let src: Record<string, unknown>;
    if (isFile) {
      if (a.file_id && !a.contract_id && !a.kind) return fail("Для файла без договора укажите kind: contract, agreement, letter или document.");
      src = Object.fromEntries(Object.entries({
        kind: a.kind, file_id: a.file_id, contract_id: a.contract_id, org_id: a.org_id, number: a.number, date: a.date,
        contract_number: a.contract_number, contract_date: a.contract_date, total: a.total, need_signature: a.need_signature,
      }).filter(([, v]) => v !== undefined));
    } else if (a.doc_id) {
      src = { doc_id: a.doc_id };
    } else if (a.org_id && a.onec_id) {
      src = { org_id: a.org_id, onec_id: String(a.onec_id).toLowerCase() };
    } else {
      return fail("Нужен doc_id (документ balance), org_id + onec_id (документ 1С) или файл balance: kind + file_id и/или contract_id.");
    }
    const fields = { provider, ...src };
    const id = a.doc_id ?? a.file_id ?? a.contract_id ?? a.org_id ?? 0;
    const call = (dry: boolean) => balanceCall(tokenOf(extra), "POST", "/edo/drafts", { provider, ...src, dry_run: dry, source: "MCP" },
      { timeoutMs: DRAFT_TIMEOUT_MS, write: !dry });
    if (!a.confirm) {
      const env = await call(true);
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      if (!d.can_create) {
        return fail(`Черновик не положить (${PROVIDER_NAMES[provider]}):\n${((d.blockers || []) as string[]).map((b) => `• ${b}`).join("\n")}` +
          `${d.number ? `\n\n${draftText(d)}` : ""}`);
      }
      const ct = confirmToken("edo_draft", id, fields);
      return ok(`Будет положен черновик — ${draftText(d)}\n\nНичего не записано. Чтобы положить — повторите вызов с ТЕМИ ЖЕ полями и ` +
        `confirm="${ct}" (токен живёт 15 минут). Отправку делает оператор.`, { requires_confirmation: true, confirm_token: ct, preview: d });
    }
    const v = verifyConfirmToken(a.confirm, "edo_draft", id, fields);
    if (!v.ok) return fail(`Токен подтверждения ${v.reason ?? "неверен"}. Вызовите create_edo_draft без confirm — получите свежее превью и токен.`);
    const env = await call(false);
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    if (!d.created) {
      return fail(`Черновик не положен:\n${((d.blockers || []) as string[]).map((b) => `• ${b}`).join("\n")}`);
    }
    const dr = d.draft || {};
    return ok(`Черновик #${dr.id} положен — ${draftText(d)}` + (dr.link ? `\nОткрыть: ${dr.link}` : "") +
      `\nОтправляет оператор; balance отметит документ, когда увидит его отправленным. Удалить черновик — delete_edo_draft.`, d);
  });

  server.registerTool("list_edo_drafts", {
    title: "Черновики в ЭДО, положенные balance",
    description:
      "Черновики, которые balance положил в СБИС или Диадок (create_edo_draft): по документу balance, организации и " +
      "состоянию (draft — лежит у оператора, sent — оператор отправил, deleted — удалён). Состояние обновляет фоновая " +
      "синхронизация ЭДО; у draft есть ссылка (СБИС) и id для delete_edo_draft.",
    inputSchema: {
      doc_id: z.number().int().positive().optional().describe("Только по этому документу balance"),
      org_id: z.number().int().positive().optional().describe("Только этой организации"),
      state: z.enum(["draft", "sent", "deleted"]).optional().describe("Состояние (по умолчанию все)"),
      limit: z.number().int().min(1).max(200).optional().describe("Сколько вернуть (по умолчанию 50)"),
    },
    annotations: READ_ONLY,
  }, async (a, extra) => {
    const env = await get(extra, "/edo/drafts" + qs({ doc_id: a.doc_id, org_id: a.org_id, state: a.state, limit: a.limit }));
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    const items: any[] = d.items || [];
    const st: Record<string, string> = { draft: "лежит у оператора", sent: "отправлен оператором", deleted: "удалён" };
    const rows = items.slice(0, 50).map((r) => `• #${r.id} ${PROVIDER_NAMES[r.provider] || r.provider}: ${r.kind_name} № ${r.number || "—"} от ${r.date}` +
      ` — ${r.counteragent?.name || "—"}${r.counteragent?.inn ? ` ИНН ${r.counteragent.inn}` : ""}; ${st[r.state] || r.state}` +
      `${r.doc_id ? `; документ #${r.doc_id}` : ""}${r.file_id ? `; файл #${r.file_id}${r.file_name ? ` «${r.file_name}»` : ""}` : ""}` +
      `${r.link && r.state === "draft" ? `; ${r.link}` : ""}`);
    return ok(`Черновиков: ${items.length}${d.note ? ` (${d.note})` : ""}${rows.length ? "\n" + rows.join("\n") : ""}`, d);
  });

  server.registerTool("delete_edo_draft", {
    title: "Удалить черновик из СБИС или Диадока (с подтверждением)",
    description:
      "Удалить черновик, который положил balance (id из create_edo_draft / list_edo_drafts), у оператора: Диадок — " +
      "RecycleDraft, СБИС — СБИС.УдалитьДокумент. Отправленный оператором черновик не удаляется (balance отметит его " +
      "sent); уже удалённый у оператора — просто отмечается. Нужен, чтобы положить документ заново (черновик нельзя " +
      "править). ДВУХШАГОВО: без confirm — что будет удалено; с confirm — удаление.",
    inputSchema: {
      draft_id: z.number().int().positive().describe("id черновика balance"),
      confirm: z.string().optional().describe("Токен подтверждения из превью-вызова. БЕЗ него ничего не удаляется"),
    },
    annotations: DRAFT_DELETE,
  }, async (a, extra) => {
    const path = `/edo/drafts/${a.draft_id}`;
    const fields = { draft_id: a.draft_id };
    const line = (r: any) => `#${r.id} ${PROVIDER_NAMES[r.provider] || r.provider}: ${r.kind_name} № ${r.number} от ${r.date}` +
      ` — ${r.counteragent?.name || "—"}${r.counteragent?.inn ? ` ИНН ${r.counteragent.inn}` : ""}`;
    if (!a.confirm) {
      const env = await balanceCall(tokenOf(extra), "DELETE", path + "?dry_run=1", undefined, { timeoutMs: EDO_TIMEOUT_MS });
      if (!env.ok) return onecFail(env);
      const d = env.data || {};
      const ct = confirmToken("edo_draft_delete", a.draft_id, fields);
      return ok(`Будет удалён черновик ${line(d.draft || {})}${d.already_gone ? " (у оператора его уже нет — balance только отметит)" : ""}.\n\n` +
        `Ничего не удалено. Чтобы удалить — повторите вызов с confirm="${ct}" (токен живёт 15 минут).`,
        { requires_confirmation: true, confirm_token: ct, preview: d });
    }
    const v = verifyConfirmToken(a.confirm, "edo_draft_delete", a.draft_id, fields);
    if (!v.ok) return fail(`Токен подтверждения ${v.reason ?? "неверен"}. Вызовите delete_edo_draft без confirm — получите свежее превью и токен.`);
    const env = await balanceCall(tokenOf(extra), "DELETE", path, undefined, { timeoutMs: EDO_TIMEOUT_MS, write: true });
    if (!env.ok) return onecFail(env);
    const d = env.data || {};
    return ok(`Черновик ${line(d.draft || {})} удалён${d.already_gone ? " (у оператора его уже не было)" : ""}.`, d);
  });
}
