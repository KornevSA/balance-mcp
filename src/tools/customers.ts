import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";
import { lookupCompanyByInn, preferredName, dadataEnabled } from "../dadata.js";

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
      "Название (name) НЕ обязательно при наличии inn — оно подтянется из ЕГРЮЛ (DaData) " +
      "вместе с КПП, юр.адресом и руководителем. Передайте name явно, чтобы задать своё. " +
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

    // 2) Создаём. Если название не передали — резолвим его по ИНН из ЕГРЮЛ (DaData)
    //    и заодно подтягиваем КПП/юр.адрес/руководителя (поля whitelisted в balance).
    const body: any = {};
    let name = (a.name ?? "").trim();
    let nameNote = "";
    if (!name && a.inn) {
      const info = await lookupCompanyByInn(a.inn);
      const resolved = info ? preferredName(info) : undefined;
      if (info && resolved) {
        name = resolved;
        nameNote = " (реквизиты из ЕГРЮЛ по ИНН)";
        if (info.kpp)           body.kpp = info.kpp;
        if (info.address)       body.urpost = info.address;
        if (info.director)      body.official = info.director;
        if (info.director_post) body.official_func = info.director_post;
      }
    }
    if (!name) {
      return fail(
        a.inn
          ? (dadataEnabled()
              ? `По ИНН ${a.inn} в ЕГРЮЛ ничего не найдено — проверьте ИНН или передайте name явно.`
              : `Нужно название (name): авто-резолв по ИНН выключен (не задан DADATA_TOKEN).`)
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
    return ok(`Контрагент создан: #${created.data?.customer_id}${nameNote} — ${name}`, created.data);
  });

  server.registerTool("lookup_company_by_inn", {
    title: "Реквизиты по ИНН (ЕГРЮЛ)",
    description:
      "Определить наименование и реквизиты организации/ИП по ИНН из ЕГРЮЛ (DaData), " +
      "НЕ создавая контрагента. Используйте, чтобы подставить/подтвердить название перед " +
      "созданием КА и выставлением счёта. Возвращает name_short, name_full, kpp, ogrn, " +
      "адрес, руководителя и статус (ACTIVE / ликвидирована и т.п.).",
    inputSchema: {
      inn: z.string().describe("ИНН: 10 цифр — юрлицо, 12 — ИП"),
    },
  }, async (a) => {
    if (!dadataEnabled()) return fail("Резолвер ЕГРЮЛ (DaData) не настроен: задайте DADATA_TOKEN.");
    const info = await lookupCompanyByInn(a.inn);
    if (!info) return fail(`По ИНН ${a.inn} ничего не найдено в ЕГРЮЛ (проверьте корректность ИНН).`);
    const title = preferredName(info) || `ИНН ${info.inn}`;
    const warn = info.status && info.status !== "ACTIVE" ? ` ⚠ статус: ${info.status}` : "";
    return ok(`${title}${warn}`, info);
  });
}
