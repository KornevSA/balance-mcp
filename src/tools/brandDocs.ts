// Документ бренда по умолчанию (balance: class/BrandDocs.php, миграция 177, ручки
// BrandDocumentsController): типовой договор бренда — описание с оглавлением, бланк
// для ознакомления и договор, заполненный на контрагента.
//
//   GET /brands/{id}/documents                                   → get_brand_document
//   GET /brands/{id}/documents/contract?format=&section=          → get_brand_contract_blank
//   GET /customers/{id}/contract?format=&brend_id=&section=       → get_customer_contract_document
//
// text — JSON с разделами (n, title, text); pdf/docx/html — файл, его отдаём временной
// ссылкой (как deliverFile), а что именно собрано (по записи договора или проект), balance
// пишет в заголовки X-Contract-*. Проект — не подписанный договор: модель не должна
// выдавать его за действующий, поэтому предупреждение — в первой строке ответа.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall, balanceFetchBinary } from "../balanceClient.js";
import { CFG } from "../config.js";
import { putDownload, linkTtlMinutes } from "../downloadStore.js";
import { tokenOf, qs, ok, fail, publicBaseOf } from "./util.js";

// Генератор договора + headless Chromium для PDF: на холодном контейнере — десятки секунд.
const RENDER_TIMEOUT_MS = 120_000;

const STATUS: Record<string, string> = {
  "-1": "отклонён", "0": "черновик", "1": "на подписании", "2": "действует", "3": "исполнен",
};
const RELATION: Record<string, string> = {
  same_form: "та же форма",
  other_form: "другая форма этого бренда",
  other_brand: "договор другого бренда",
};

export type ContractMeta = {
  source: string;
  contract_id: number | null;
  contract_number: string | null;
  contract_date: string | null;
  contract_status: number | null;
  number_conflict: boolean;
  other_contracts: Array<{ number?: string; date?: string | null; status?: number; type?: string; relation?: string }>;
};

/** meta из заголовков X-Contract-* файлового ответа (номер и others — в URL-кодировке). */
export function metaFromHeaders(h: Headers | undefined): ContractMeta {
  const get = (k: string) => h?.get(k) ?? null;
  const dec = (v: string | null) => {
    if (v === null) return null;
    try { return decodeURIComponent(v); } catch { return v; }
  };
  let others: ContractMeta["other_contracts"] = [];
  const rawOthers = dec(get("x-contract-others"));
  if (rawOthers) {
    try { const j = JSON.parse(rawOthers); if (Array.isArray(j)) others = j; } catch { /* битый заголовок — без списка */ }
  }
  const id = get("x-contract-id");
  const st = get("x-contract-status");
  return {
    source: get("x-contract-source") || "",
    contract_id: id !== null && /^\d+$/.test(id) ? Number(id) : null,
    contract_number: dec(get("x-contract-number")),
    contract_date: get("x-contract-date"),
    contract_status: st !== null && /^-?\d+$/.test(st) ? Number(st) : null,
    number_conflict: get("x-contract-number-conflict") === "1",
    other_contracts: others,
  };
}

/**
 * Что именно отдано — строками для модели. Первая — главное: бланк, договор клиента по
 * записи (со статусом) или проект; дальше — конфликт номера и другие договоры клиента.
 */
export function describeMeta(m: Partial<ContractMeta> | undefined | null): string[] {
  if (!m || !m.source) return [];
  const lines: string[] = [];
  const num = m.contract_number ? `№ ${m.contract_number}` : "без номера";
  const date = m.contract_date ? ` от ${m.contract_date}` : "";
  if (m.source === "blank") {
    lines.push("Бланк для ознакомления: без контрагента и даты, поля — прочерками.");
  } else if (m.source === "record") {
    const st = m.contract_status === null || m.contract_status === undefined ? "" : String(m.contract_status);
    const stText = STATUS[st] ?? (st || "статус неизвестен");
    const warn = st === "2" ? "" : " — договор ещё НЕ действует, не называйте его подписанным";
    lines.push(`Договор клиента по записи balance (contract_id ${m.contract_id ?? "?"}): ${num}${date}, статус «${stText}»${warn}.`);
  } else if (m.source === "draft") {
    lines.push(`ПРОЕКТ договора: договора этой формы у клиента нет, ${num}${date} — это не подписанный договор, не выдавайте его за действующий.`);
  } else {
    lines.push(`Источник документа: ${m.source}.`);
  }
  if (m.number_conflict) {
    lines.push("Номер оставлен прочерком: у клиента уже есть договор с номером = id контрагента (другой редакции).");
  }
  const others = m.other_contracts ?? [];
  if (others.length) {
    const list = others.map((c) => {
      const st = c.status === undefined ? "" : (STATUS[String(c.status)] ?? String(c.status));
      const rel = c.relation ? (RELATION[c.relation] ?? c.relation) : "";
      return `№ ${c.number ?? "?"}${c.date ? ` от ${c.date}` : ""} (${[c.type, st, rel].filter(Boolean).join(", ")})`;
    });
    lines.push(`Другие договоры клиента: ${list.join("; ")}.`);
  }
  return lines;
}

/** Ошибка ручки balance → текст для модели (+ каких реквизитов клиента не хватает). */
export function errorText(err: { code?: string; message?: string; fields?: Record<string, string> } | undefined, status?: number): string {
  const msg = err?.message || (status ? `HTTP ${status}` : "ошибка balance");
  const code = err?.code ? ` [${err.code}]` : "";
  const fields = err?.fields && typeof err.fields === "object" ? Object.values(err.fields) : [];
  let hint = "";
  if (err?.code === "missing_fields") hint = " Спросите эти данные у клиента и внесите в карточку (update_customer), затем повторите.";
  else if (err?.code === "render_unavailable") hint = " Это сбой генератора или печати в balance, а не вопрос к клиенту.";
  else if (err?.code === "no_default_document") hint = " Документ бренда назначают в balance: «Шаблоны документов».";
  return `${msg}${code}${fields.length ? ` — не хватает: ${fields.join(", ")}.` : ""}${hint}`;
}

function humanSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`;
}

/** Ответ format=text: шапка + разделы читаемым текстом; данные целиком — в structuredContent. */
function textResult(head: string, data: any) {
  const lines = [head, ...describeMeta(data?.meta)];
  const sections: any[] = Array.isArray(data?.sections) ? data.sections : [];
  const body = sections.map((s) => `## ${s.n}. ${s.title ?? ""}\n${s.text ?? ""}`).join("\n\n");
  return {
    content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${body}`.trimEnd() }],
    structuredContent: data,
  };
}

/** Файл (pdf/docx/html): ссылкой, плюс что именно собрано (X-Contract-*). */
async function fileResult(token: string, path: string, label: string, extra: any, withMeta: boolean) {
  const f = await balanceFetchBinary(token, path, { timeoutMs: RENDER_TIMEOUT_MS });
  if (f.error) return fail(f.error);
  if (!f.ok) {
    let env: any = null;
    try { env = JSON.parse(f.buffer.toString("utf8")); } catch { /* не JSON */ }
    return fail(errorText(env?.error, f.status));
  }
  const name = f.filename || label;
  const size = f.buffer.length;
  const ctype = f.contentType || "application/octet-stream";
  const meta = withMeta ? metaFromHeaders(f.headers) : null;
  const metaLines = describeMeta(meta);

  const dlToken = putDownload(f.buffer, name, ctype);
  if (!dlToken) {
    return ok([`Файл «${name}» (${humanSize(size)}, ${ctype}) больше лимита ссылки `
      + `${Math.round(CFG.linkMaxBytes / 1048576)} МБ — скачайте его в интерфейсе Balance («Шаблоны документов»).`,
      ...metaLines].join("\n"));
  }
  const seg = encodeURIComponent(name.replace(/[\\/]+/g, "_"));
  const url = `${publicBaseOf(extra)}/mcp/file/${dlToken}/${seg}`;
  const text = [...metaLines,
    `Файл «${name}» — ${humanSize(size)}, ${ctype}.`,
    `Ссылка (живёт ${linkTtlMinutes()} мин, откроется в браузере без авторизации): ${url}`].join("\n");
  const structured: Record<string, any> = { name, size_bytes: size, content_type: ctype, url, ttl_minutes: linkTtlMinutes() };
  if (meta) structured.meta = meta;
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

const formatSchema = z.enum(["text", "pdf", "docx", "html"]);
const sectionSchema = z.number().int().positive().optional()
  .describe("Только для format=text: номер раздела из оглавления get_brand_document; без него — весь договор");

export function registerBrandDocTools(server: McpServer) {
  server.registerTool("get_brand_document", {
    title: "Документ бренда: описание и оглавление",
    description:
      "Тип услуг бренда и его типовой договор (документ по умолчанию, раздел balance «Шаблоны документов»): " +
      "код печатной формы (contract_type), название, исполнитель (org_id, org_name), НДС (vat: 5 | 22 | no), " +
      "доступен ли документ (available) и оглавление sections[] (n, title, chars). Начинайте отсюда: потом " +
      "get_brand_contract_blank (бланк) или get_customer_contract_document (на клиента) с section=N — договор " +
      "целиком длинный (у RouterAI ≈120 тыс. знаков). У бренда один документ; КП и формы с печатью сюда не входят. " +
      "brend_id — из list_brands.",
    inputSchema: {
      brend_id: z.number().int().positive().describe("brend_id (list_brands)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/brands/${a.brend_id}/documents`, undefined, { timeoutMs: RENDER_TIMEOUT_MS });
    if (!env.ok) return fail(errorText(env.error));
    const d = env.data ?? {};
    const doc = d.document;
    let head: string;
    if (!doc) {
      head = `Бренд ${d.brand ?? a.brend_id}: документ по умолчанию не назначен.`;
    } else {
      const vat = doc.vat === "no" ? "без НДС" : doc.vat ? `НДС ${doc.vat}%` : "НДС по линейке";
      head = `Бренд ${d.brand ?? a.brend_id}: «${doc.name || doc.contract_type}» (${doc.contract_type}), `
        + `исполнитель ${doc.org_name || `org ${doc.org_id}`}, ${vat}, разделов ${doc.sections?.length ?? 0}`
        + (doc.available ? "" : " — документ НЕДОСТУПЕН для выдачи")
        + (doc.error?.message ? ` — ошибка сборки: ${doc.error.message}` : "") + ".";
    }
    return ok(head, d);
  });

  server.registerTool("get_brand_contract_blank", {
    title: "Бланк типового договора бренда",
    description:
      "Бланк типового договора бренда для ознакомления — без контрагента и даты, поля прочерками, без печати и " +
      "подписи. format: text (по умолчанию) — текст по разделам, чтобы отвечать по условиям или сравнить с " +
      "редакцией клиента; pdf | docx | html — файл временной ссылкой (отправить клиенту, отдать на правку). " +
      "section=N — один раздел (только text). Договор на конкретного клиента — get_customer_contract_document.",
    inputSchema: {
      brend_id: z.number().int().positive().describe("brend_id (list_brands)"),
      format: formatSchema.default("text").describe("text | pdf | docx | html"),
      section: sectionSchema,
    },
  }, async (a, extra) => {
    if (a.section !== undefined && a.format !== "text") return fail("section — только для format=text.");
    const path = `/brands/${a.brend_id}/documents/contract` + qs({ format: a.format, section: a.section });
    if (a.format !== "text") return fileResult(tokenOf(extra), path, `Бланк договора бренда ${a.brend_id}.${a.format}`, extra, false);
    const env = await balanceCall(tokenOf(extra), "GET", path, undefined, { timeoutMs: RENDER_TIMEOUT_MS });
    if (!env.ok) return fail(errorText(env.error));
    const n = env.data?.sections?.length ?? 0;
    return textResult(`«${env.data?.name ?? "Договор"}» — бланк, ${a.section ? `раздел ${a.section}` : `разделов ${n}`}.`, env.data);
  });

  server.registerTool("get_customer_contract_document", {
    title: "Договор бренда на контрагента",
    description:
      "Типовой договор бренда, заполненный реквизитами контрагента: по его записи договора этой формы (номер, дата, " +
      "юрлицо и НДС — из записи) или ПРОЕКТ, если такого договора у клиента нет (номер = id контрагента, дата — сегодня). " +
      "Что собрано — в первой строке ответа и в meta (source = record | draft, contract_status, other_contracts): проект " +
      "не выдавайте за подписанный договор, а при действующем договоре другой формы не говорите, что договора нет. " +
      "Бренд — brend_id или основной дилер клиента. format: text — разделами (section=N — один); pdf | docx | html — " +
      "файл ссылкой. Не хватает реквизитов в карточке — ошибка со списком полей. Печать и подпись не ставятся. " +
      "Только по документу бренда по умолчанию (get_brand_document); договоры других форм так не собрать.",
    inputSchema: {
      customer_id: z.number().int().positive().describe("customer_id"),
      format: formatSchema.describe("text — читать и сравнивать; pdf | docx | html — файл для клиента"),
      brend_id: z.number().int().positive().optional().describe("brend_id; без него — бренд основного дилера клиента"),
      section: sectionSchema,
    },
  }, async (a, extra) => {
    if (a.section !== undefined && a.format !== "text") return fail("section — только для format=text.");
    const path = `/customers/${a.customer_id}/contract` + qs({ format: a.format, brend_id: a.brend_id, section: a.section });
    if (a.format !== "text") return fileResult(tokenOf(extra), path, `Договор КА ${a.customer_id}.${a.format}`, extra, true);
    const env = await balanceCall(tokenOf(extra), "GET", path, undefined, { timeoutMs: RENDER_TIMEOUT_MS });
    if (!env.ok) return fail(errorText(env.error));
    const n = env.data?.sections?.length ?? 0;
    return textResult(`«${env.data?.name ?? "Договор"}» на КА #${a.customer_id}, ${a.section ? `раздел ${a.section}` : `разделов ${n}`}.`, env.data);
  });
}
