// Резолвер реквизитов российских юрлиц/ИП по ИНН через DaData
// (suggestions API, метод findById/party). Нужен бесплатный API-ключ кабинета
// DaData (заголовок Authorization: Token …). Без ключа резолвер мягко выключен —
// find_or_create_customer тогда требует явный name, как раньше.
import { CFG } from "./config.js";

export type CompanyInfo = {
  inn: string;
  kpp?: string;
  ogrn?: string;
  name_short?: string;    // короткое с ОПФ: ООО «Ромашка»
  name_full?: string;     // полное с ОПФ
  address?: string;       // юридический адрес одной строкой
  director?: string;      // ФИО руководителя
  director_post?: string; // должность руководителя
  status?: string;        // ACTIVE | LIQUIDATING | LIQUIDATED | BANKRUPT | REORGANIZING
  type?: string;          // LEGAL | INDIVIDUAL
  branch?: string;        // MAIN | BRANCH
};

export function dadataEnabled(): boolean {
  return !!CFG.dadataToken;
}

// Наименование в нужной форме (CFG.dadataNameForm) с фолбэком на вторую форму.
export function preferredName(info: CompanyInfo): string | undefined {
  return CFG.dadataNameForm === "short"
    ? (info.name_short || info.name_full)
    : (info.name_full || info.name_short);
}

const DADATA_FIND_BY_ID =
  "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party";

// Основная запись по ИНН (предпочитаем головную, branch_type=MAIN), либо null.
// Любая ошибка/таймаут/пустой ответ → null: вызывающий мягко падает на «нужен name».
export async function lookupCompanyByInn(inn: string): Promise<CompanyInfo | null> {
  if (!CFG.dadataToken) return null;
  const clean = String(inn).replace(/\D/g, "");
  if (clean.length !== 10 && clean.length !== 12) return null; // 10 — юрлицо, 12 — ИП/физлицо

  let r: Response;
  try {
    r = await fetch(DADATA_FIND_BY_ID, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Token ${CFG.dadataToken}`,
      },
      body: JSON.stringify({ query: clean, count: 5 }),
    });
  } catch {
    return null;
  }
  if (!r.ok) return null;

  let body: any;
  try { body = await r.json(); } catch { return null; }
  const sug: any[] = Array.isArray(body?.suggestions) ? body.suggestions : [];
  if (!sug.length) return null;

  // По ИНН может вернуться несколько записей (головная + филиалы) — берём головную.
  const pick = sug.find((s) => s?.data?.branch_type === "MAIN") || sug[0];
  const d = pick?.data || {};
  const kpp = typeof d.kpp === "string" && /^\d{9}$/.test(d.kpp) ? d.kpp : undefined;
  return {
    inn: d.inn || clean,
    kpp,
    ogrn: d.ogrn || undefined,
    name_short: d.name?.short_with_opf || d.name?.short || undefined,
    name_full: d.name?.full_with_opf || d.name?.full || undefined,
    address: d.address?.unrestricted_value || d.address?.value || undefined,
    director: d.management?.name || undefined,
    director_post: d.management?.post || undefined,
    status: d.state?.status || undefined,
    type: d.type || undefined,
    branch: d.branch_type || undefined,
  };
}
