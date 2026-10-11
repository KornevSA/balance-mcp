import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";
import { preferredName } from "../dadata.js";
import { lookupRegistry } from "../registry.js";

export function registerCustomerTools(server: McpServer) {
  server.registerTool("search_customers", {
    title: "Поиск контрагентов",
    description: "Найти контрагентов (КА) по ИНН, имени, email или remote_id. Возвращает список с customer_id.",
    inputSchema: {
      inn: z.string().optional().describe("ИНН"),
      name: z.string().optional(),
      email: z.string().optional(),
      remote_id: z.string().optional().describe("Внешний ID кабинета дилера"),
      group_id: z.number().optional().describe("ID дилера (для remote_id)"),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/customers" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Найдено контрагентов: ${n}`, env.data);
  });

  server.registerTool("get_customer", {
    title: "Карточка контрагента",
    description: "Получить контрагента по его customer_id.",
    inputSchema: { id: z.number().int().positive().describe("customer_id") },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/customers/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Контрагент #${a.id}`, env.data);
  });

  server.registerTool("find_or_create_customer", {
    title: "Найти или создать контрагента",
    description:
      "Идемпотентно по ИНН: если КА с таким ИНН есть — вернёт его (existing=true), иначе создаст. " +
      "Название (name) НЕ обязательно при наличии inn — оно подтянется из ЕГРЮЛ/ЕГРИП (через сервис " +
      "1С:Контрагент; если реестр 1С недоступен — запасной DaData) вместе с КПП, юр.адресом и руководителем. " +
      "Передайте name явно, чтобы задать своё. " +
      "Для привязки к кабинету дилера передайте remote_id вместе с customer_group_id.",
    inputSchema: {
      name: z.string().optional().describe("Название КА. Необязательно при наличии inn — возьмём из ЕГРЮЛ"),
      inn: z.string().optional().describe("ИНН (ключ идемпотентности и источник реквизитов из ЕГРЮЛ)"),
      email: z.string().optional(),
      remote_id: z.string().optional(),
      customer_group_id: z.number().optional(),
    },
  }, async (a, extra) => {
    const token = tokenOf(extra);

    // 1) Идемпотентность: КА с таким ИНН уже есть → возвращаем без создания
    //    (название при этом вообще не нужно — главный фикс кейса «дал только ИНН»).
    if (a.inn) {
      const found = await balanceCall(token, "GET", "/customers" + qs({ inn: a.inn }));
      if (found.ok && found.data?.items?.length) {
        return ok(`Контрагент уже существует: #${found.data.items[0].customer_id}`, { ...found.data.items[0], existing: true });
      }
    }

    // 2) Создаём. Если название не передали — резолвим его по ИНН из ЕГРЮЛ/ЕГРИП (через 1С:Контрагент,
    //    запасной — DaData) и заодно подтягиваем КПП/юр.адрес/руководителя (поля whitelisted в balance).
    const body: any = {};
    let name = (a.name ?? "").trim();
    let nameNote = "";
    let regWarn = "";
    if (!name && a.inn) {
      const r = await lookupRegistry(token, a.inn);
      if (!r.ok) return fail(`${r.message}. Проверьте ИНН или передайте name явно.`);
      const info = r.info;
      const resolved = preferredName(info);
      if (resolved) {
        name = resolved;
        nameNote = info.source === "1c"
          ? " (реквизиты из ЕГРЮЛ/ЕГРИП через 1С)"
          : ` (реквизиты из ЕГРЮЛ через DaData — реестр 1С недоступен: ${info.fallback_reason})`;
        if (!info.active) regWarn = ` ⚠ в реестре: ${info.status_name || "не действует"}${info.termination_date ? `, прекращена ${info.termination_date}` : ""}`;
        if (info.kpp)           body.kpp = info.kpp;
        if (info.address)       body.urpost = info.address;
        if (info.director)      body.official = info.director;
        if (info.director_post) body.official_func = info.director_post;
      }
    }
    if (!name) {
      return fail(
        a.inn
          ? `По ИНН ${a.inn} в реестре нет наименования — передайте name явно.`
          : "Для создания контрагента нужно название (name) либо ИНН (inn) для авто-резолва из ЕГРЮЛ."
      );
    }

    body.name = name;
    if (a.inn) body.inn = a.inn;
    if (a.email) body.email = a.email;
    if (a.remote_id) body.remote_id = a.remote_id;
    if (a.customer_group_id) body.customer_group_id = a.customer_group_id;

    const created = await balanceCall(token, "POST", "/customers", body);
    if (!created.ok) return fail(created.error.message);
    return ok(`Контрагент создан: #${created.data?.customer_id}${nameNote} — ${name}${regWarn}`, created.data);
  });

  server.registerTool("update_customer", {
    title: "Обновить контрагента",
    description:
      "Частично обновить карточку КА (PATCH). Передавайте только изменяемые поля. " +
      "Полезно, чтобы починить тип взаиморасчётов (acc_type_id: 0/1=по оплатам — автосоздание актов работает, " +
      "2=по затратам за месяц, 3=акты вручную — оба вне автосоздания), сменить орг-эмитента (org_id), " +
      "дилер-группу (customer_group_id) или реквизиты. ИНН при смене проверяется на конфликт с другим КА. " +
      "Изменения пишутся в аудит (было→стало).",
    inputSchema: {
      id: z.number().int().positive().describe("customer_id"),
      name: z.string().optional(),
      inn: z.string().optional(),
      kpp: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      urpost: z.string().optional().describe("Юр. адрес"),
      post: z.string().optional().describe("Почтовый адрес"),
      bank_name: z.string().optional(),
      bik: z.string().optional(),
      rnum: z.string().optional().describe("Расчётный счёт"),
      kor_num: z.string().optional().describe("Корр. счёт"),
      official: z.string().optional().describe("Руководитель (ФИО)"),
      official_func: z.string().optional().describe("Должность руководителя"),
      act_base: z.string().optional().describe("Действует на основании"),
      comment: z.string().optional(),
      acc_type_id: z.number().int().optional().describe("Тип взаиморасчётов: 0/1=по оплатам, 2=по затратам за месяц, 3=акты вручную"),
      org_id: z.number().int().optional().describe("Орг-эмитент по умолчанию"),
      customer_group_id: z.number().int().optional().describe("Дилер-группа"),
    },
  }, async (a, extra) => {
    const { id, ...rest } = a;
    const body: any = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    if (Object.keys(body).length === 0) return fail("Нечего обновлять: передайте хотя бы одно поле кроме id.");
    const env = await balanceCall(tokenOf(extra), "PATCH", `/customers/${id}`, body);
    if (!env.ok) return fail(env.error.message);
    return ok(`Контрагент #${id} обновлён (${Object.keys(body).join(", ")})`, env.data);
  });

  server.registerTool("lookup_company_by_inn", {
    title: "Реквизиты по ИНН (ЕГРЮЛ/ЕГРИП)",
    description:
      "Определить наименование и реквизиты организации/ИП по ИНН из ЕГРЮЛ/ЕГРИП (сервис 1С:Контрагент " +
      "через базы 1С; если реестр 1С недоступен — запасной DaData, если настроен), НЕ создавая контрагента. " +
      "Используйте, чтобы подставить/подтвердить название перед созданием КА и выставлением счёта. Возвращает " +
      "name_short, name_full, kpp, ogrn, адрес, руководителя, статус и active (действует ли), source (1c | dadata). " +
      "Историю наименований, КПП и адресов даёт lookup_onec_registry.",
    inputSchema: {
      inn: z.string().describe("ИНН: 10 цифр — юрлицо, 12 — ИП"),
    },
  }, async (a, extra) => {
    const r = await lookupRegistry(tokenOf(extra), a.inn);
    if (!r.ok) return fail(r.message);
    const info = r.info;
    const title = preferredName(info) || `ИНН ${info.inn}`;
    const warn = !info.active ? ` ⚠ статус: ${info.status_name || info.status || "не действует"}${info.termination_date ? `, прекращена ${info.termination_date}` : ""}` : "";
    const src = info.source === "1c" ? "ЕГРЮЛ/ЕГРИП через 1С" : `DaData (реестр 1С недоступен: ${info.fallback_reason})`;
    return ok(`${title}${warn} — источник: ${src}`, info);
  });
}
