import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { balanceCall } from "../balanceClient.js";
import { tokenOf, qs, ok, fail } from "./util.js";

export function registerContractTools(server: McpServer) {
  server.registerTool("list_contracts", {
    title: "Договоры контрагента",
    description:
      "Договоры одного КА: номер, дата, наименование, тип печатной формы (contract_type), " +
      "ставка НДС по договору (vat), орг-эмитент (org_id), статус. Нужно, чтобы сослаться на договор " +
      "в счёте/акте и проверить условия.",
    inputSchema: {
      customer_id: z.number().int().positive().describe("customer_id"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", "/contracts" + qs(a));
    if (!env.ok) return fail(env.error.message);
    const n = env.data?.items?.length ?? 0;
    return ok(`Договоров у КА #${a.customer_id}: ${n}`, env.data);
  });

  server.registerTool("get_contract", {
    title: "Договор",
    description: "Получить один договор по contract_id.",
    inputSchema: {
      id: z.number().int().positive().describe("contract_id"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/contracts/${a.id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Договор #${a.id}`, env.data);
  });

  server.registerTool("update_contract", {
    title: "Изменить договор",
    description:
      "Частично изменить договор balance (PATCH): номер, дату, название, статус, комментарий — передавайте только " +
      "изменяемые поля. Организация, тип печатной формы, НДС и строки документов меняются только в карточке клиента. " +
      "Статусы: 0 черновик, 1 на подписании, 2 действует (подписан — включает правила договора: ставку НДС и строку " +
      "документов), 3 исполнен, -1 отклонён. Договор в финальном статусе (-1, 2, 3) правится только сменой статуса: " +
      "сначала верните 0 или 1 отдельным вызовом, потом меняйте поля. Уже созданные в 1С документы остаются на " +
      "прежнем договоре 1С; следующие счета и акты прежний сервис 1С найдёт или заведёт по новым номеру, дате и " +
      "названию — основание счёта печатается как «<название> <номер> от <дата>». Ответ — договор, changes (было → " +
      "стало) и warnings. Правка пишется в журнал.",
    inputSchema: {
      id: z.number().int().positive().describe("contract_id"),
      contract_number: z.string().min(1).max(50).optional().describe("Номер договора"),
      contract_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Дата договора, ГГГГ-ММ-ДД"),
      contract_name: z.string().min(1).max(1000).optional()
        .describe("Название: «Договор», «Лицензионный договор»… (в 1С к нему допишутся номер и дата)"),
      contract_status: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional()
        .describe("-1 отклонён, 0 черновик, 1 на подписании, 2 действует, 3 исполнен"),
      comment: z.string().max(5000).optional().describe("Комментарий (пустая строка — очистить)"),
    },
  }, async (a, extra) => {
    const { id, ...rest } = a;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    if (Object.keys(body).length === 0) return fail("Нечего обновлять: передайте хотя бы одно поле кроме id.");
    const env = await balanceCall(tokenOf(extra), "PATCH", `/contracts/${id}`, body);
    if (!env.ok) {
      const errs = env.error.errors && typeof env.error.errors === "object"
        ? Object.entries(env.error.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      return fail(errs ? `${env.error.message} — ${errs}` : env.error.message);
    }
    const changed = Object.keys(env.data?.changes ?? {});
    const warn = (env.data?.warnings ?? []).length ? " ⚠ см. warnings" : "";
    return ok(changed.length ? `Договор #${id} изменён (${changed.join(", ")})${warn}` : `Договор #${id}: изменений нет`, env.data);
  });

  // Вложения договора (balance: files.contract_id — «Файлы» карточки договора).
  server.registerTool("list_contract_files", {
    title: "Файлы договора",
    description:
      "Вложения договора: подписанные сканы, правленые docx, сохранённые выгрузки (attach_contract_document). " +
      "Скачать — get_customer_file по file_id. Подписан ли договор, смотрите по статусу (get_contract), " +
      "наличие скана само по себе статус не меняет.",
    inputSchema: { contract_id: z.number().int().positive().describe("contract_id (list_contracts)") },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "GET", `/contracts/${a.contract_id}/files`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Файлов у договора #${a.contract_id}: ${env.data?.total ?? 0}`, env.data);
  });

  server.registerTool("attach_file_to_contract", {
    title: "Прикрепить файл к договору",
    description:
      "Прикрепить УЖЕ ЗАГРУЖЕННЫЙ файл контрагента к его договору — прежде всего подписанный клиентом экземпляр " +
      "(скан, PDF с подписью, правленый docx). Байты сюда не передаются: сначала файл контрагенту — " +
      "create_customer_upload_link (вложение из чата, файл пользователя), upload_customer_file_from_url или " +
      "upload_customer_file, потом этот вызов с file_id. Файл обязан принадлежать тому же контрагенту. " +
      "У вложения один договор: файл, уже прикреплённый к другому договору, вернёт ошибку с его contract_id. " +
      "Статус договора НЕ меняется — если договор теперь подписан обеими сторонами, отдельно " +
      "update_contract(contract_status=2). Файл появится в «Файлах» карточки договора в balance.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      contract_id: z.number().int().positive().describe("contract_id (list_contracts)"),
      file_id: z.number().int().positive().describe("Файл контрагента (list_customer_files или ответ загрузки)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "POST", `/contracts/${a.contract_id}/files`, { file_id: a.file_id });
    if (!env.ok) return fail(env.error.message);
    const name = env.data?.file?.name ? ` «${env.data.file.name}»` : "";
    return ok(env.data?.changed === false
      ? `Файл #${a.file_id}${name} уже прикреплён к договору #${a.contract_id}`
      : `Файл #${a.file_id}${name} прикреплён к договору #${a.contract_id}`, env.data);
  });

  server.registerTool("detach_file_from_contract", {
    title: "Открепить файл от договора",
    description:
      "Снять файл с договора — например, прикрепили не к тому договору. Сам файл НЕ удаляется и остаётся в " +
      "файлах контрагента; потом его можно прикрепить к нужному договору (attach_file_to_contract).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      contract_id: z.number().int().positive().describe("contract_id"),
      file_id: z.number().int().positive().describe("file_id вложения (list_contract_files)"),
    },
  }, async (a, extra) => {
    const env = await balanceCall(tokenOf(extra), "DELETE", `/contracts/${a.contract_id}/files/${a.file_id}`);
    if (!env.ok) return fail(env.error.message);
    return ok(`Файл #${a.file_id} откреплён от договора #${a.contract_id} (остался в файлах контрагента)`, env.data);
  });
}
