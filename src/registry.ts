// Реквизиты юрлица/ИП по ИНН для lookup_company_by_inn и find_or_create_customer.
//
// Источник — ЕГРЮЛ/ЕГРИП через сервис 1С:Контрагент баз 1С (balance GET /onec/registry/{inn}: кэш 24 ч,
// журнал, тот же источник, по которому 1С заполняет контрагентов — решение пользователя 12.10.2026).
// DaData — только запасной вариант: реестр 1С недоступен (нет готовой базы, сервис 1С:Контрагент лежит,
// лимит, обрыв, у токена нет скоупа onec:read / права onec.view) И задан DADATA_TOKEN. Ответ реестра
// «ИНН не найден» или «неверный ИНН» — это ответ, к DaData с ним не ходим.
import { balanceCall } from "./balanceClient.js";
import { lookupCompanyByInn, dadataEnabled, type CompanyInfo } from "./dadata.js";

export type RegistryInfo = CompanyInfo & {
  /** Откуда сведения: 1c — ЕГРЮЛ/ЕГРИП через 1С:Контрагент, dadata — запасной DaData. */
  source: "1c" | "dadata";
  /** Действующее ли (нет даты прекращения, статус «Действующее» / ACTIVE). */
  active: boolean;
  status_name?: string;
  termination_date?: string | null;
  registration_date?: string | null;
  okved?: string;
  /** Почему не 1С (для source = dadata). */
  fallback_reason?: string;
};

export type RegistryResult =
  | { ok: true; info: RegistryInfo; raw?: any }
  | { ok: false; notFound: boolean; message: string };

const REGISTRY_TIMEOUT_MS = 60_000;

function digits(v: any): string { return String(v ?? "").replace(/\D/g, ""); }

/** Ответ GET /onec/registry/{inn} → CompanyInfo (те же поля, что давал DaData) + статус. */
export function fromOneCRegistry(d: any): RegistryInfo {
  const ip = d?.kind === "ip";
  const fio = [d?.last_name, d?.first_name, d?.middle_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  const statusName = String(d?.status?.name ?? "").trim();
  const termination = d?.termination_date ? String(d.termination_date).slice(0, 10) : null;
  const kpp = digits(d?.kpp);
  return {
    source: "1c",
    inn: digits(d?.inn),
    kpp: !ip && kpp.length === 9 ? kpp : undefined,
    ogrn: d?.ogrn || undefined,
    name_short: String(d?.short_name || d?.name || "").trim() || undefined,
    name_full: String(d?.full_name || "").trim() || undefined,
    address: String(d?.legal_address || "").trim() || undefined,
    director: (ip ? fio : String(d?.head?.name ?? "").trim()) || undefined,
    director_post: ip ? (fio ? "Индивидуальный предприниматель" : undefined) : (String(d?.head?.position ?? "").trim() || undefined),
    status: statusName || undefined,
    status_name: statusName || undefined,
    type: ip ? "INDIVIDUAL" : "LEGAL",
    active: !termination && (statusName === "" || /^действ/i.test(statusName)),
    termination_date: termination,
    registration_date: d?.registration_date ? String(d.registration_date).slice(0, 10) : null,
    okved: d?.okved?.code ? `${d.okved.code} ${d.okved.name ?? ""}`.trim() : undefined,
  };
}

/** Коды balance, при которых реестр 1С «недоступен» (а не «ответил»): тогда — запасной DaData. */
const UNAVAILABLE = new Set([
  "forbidden", "onec_base_not_ready", "onec_registry_unavailable", "onec_rate_limited", "onec_timeout",
  "onec_unavailable", "onec_error", "onec_no_rights", "onec_busy", "onec_org_not_found", "timeout", "network", "bad_response",
  "server_error", "not_found",
]);

export async function lookupRegistry(token: string, inn: string): Promise<RegistryResult> {
  const clean = digits(inn);
  if (clean.length !== 10 && clean.length !== 12) {
    return { ok: false, notFound: false, message: "ИНН — 10 цифр (юрлицо) или 12 (ИП)" };
  }
  const env = await balanceCall(token, "GET", `/onec/registry/${clean}`, undefined, { timeoutMs: REGISTRY_TIMEOUT_MS });
  if (env.ok) return { ok: true, info: fromOneCRegistry(env.data), raw: env.data };

  const code = String(env.error?.code || "");
  const message = String(env.error?.message || "ошибка");
  if (code === "onec_not_found") {
    return { ok: false, notFound: true, message: `По ИНН ${clean} в ЕГРЮЛ/ЕГРИП ничего не найдено (${message})` };
  }
  if (code === "bad_request" || code === "onec_bad_request") {
    return { ok: false, notFound: false, message: `ИНН ${clean} не принят: ${message}` };
  }
  const reason = UNAVAILABLE.has(code) ? message : `${message} [${code || "?"}]`;
  if (!dadataEnabled()) {
    return { ok: false, notFound: false, message: `Реестр ЕГРЮЛ/ЕГРИП через 1С недоступен: ${reason}. Запасной DaData не настроен (DADATA_TOKEN).` };
  }
  const d = await lookupCompanyByInn(clean);
  if (!d) {
    return { ok: false, notFound: true, message: `Реестр через 1С недоступен (${reason}); запасной DaData по ИНН ${clean} ничего не нашёл` };
  }
  return {
    ok: true,
    info: {
      ...d, source: "dadata", active: !d.status || d.status === "ACTIVE", status_name: d.status,
      fallback_reason: reason,
    },
  };
}
