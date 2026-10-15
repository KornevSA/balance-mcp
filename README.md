# balance-mcp

Remote **MCP-сервер** (Model Context Protocol) поверх REST API биллинга **Balance**.
Подключается к Claude через диалог **«Add custom connector»**. Является OAuth 2.1
**Resource Server**: пользователь логинится в Balance (Balance = Authorization Server),
а MCP действует **от его имени**, пробрасывая пользовательский токен в `/api/v1`.

TypeScript + `@modelcontextprotocol/sdk`, транспорт **streamable HTTP**.

## Что умеет (tools)

| Tool | Назначение |
|---|---|
| `find_or_create_customer`, `search_customers`, `get_customer` | контрагенты (идемпотентно по ИНН; `name` необязателен — тянется из ЕГРЮЛ/ЕГРИП по ИНН) |
| `lookup_company_by_inn` | реквизиты юрлица/ИП по ИНН из ЕГРЮЛ/ЕГРИП через 1С:Контрагент (запасной — DaData), без создания КА |
| `create_invoice` | выставить счёт (+PDF через `get_document_pdf`) |
| `list_customer_documents`, `get_document`, `get_document_pdf` | документы и их PDF |
| `search_documents`, `documents_summary` | **кросс-КА поиск за период** (стр./полностью) и сводка |
| `get_customer_settlement` | **взаиморасчёты** (сальдо/обороты, поступления/реализации) |
| `find_missing_acts` | **детектор забытых актов** на конец месяца |
| `list_customer_files`, `get_customer_file` | файлы контрагента |
| `list_my_files`, `get_my_file`, `upload_my_file` | личные «Мои файлы» |
| `list_onec_bases`, `get_onec_meta` | **1С (только чтение)**: базы по организациям (`org_id`), справочники базы |
| `search_onec_counterparties`, `get_onec_counterparty`, `get_onec_settlement` | контрагенты 1С (в том числе по `customer_id` balance) и сальдо 60/62/76 по данным бухгалтерии |
| `list_onec_documents`, `get_onec_document` | документы 1С (по контрагенту или за период ≤ 92 дней), документ balance ↔ 1С со сверкой |
| `list_onec_contracts`, `get_onec_contract`, `search_onec_nomenclature`, `lookup_onec_registry` | договоры и номенклатура 1С, ЕГРЮЛ/ЕГРИП через 1С:Контрагент |
| `get_onec_document_history`, `list_onec_print_forms`, `get_onec_document_pdf` | история изменений, печатные формы и PDF «как в 1С» (ссылкой; в balance не сохраняется) |
| `create_onec_reconciliation` | **1С, запись с подтверждением**: акт сверки за период (создать или перезаполнить; провести — только по просьбе) + PDF ссылкой |
| `fill_onec_counterparty_from_registry`, `create_onec_counterparty`, `create_onec_contract` | контрагент 1С по ЕГРЮЛ/ЕГРИП; клиент balance → контрагент 1С; договор balance → договор 1С |
| `send_document_to_onec`, `pull_onec_bank_payments` | штатные выгрузки balance: документ в 1С тем же путём, что кнопка; «Запросить оплаты из 1С» |
| `set_onec_document_state` | провести / распровести / пометить на удаление / снять пометку — только документы, созданные balance |
| `get_edo_status`, `list_diadoc_documents`, `get_diadoc_document` | **ЭДО (Диадок, только чтение)**: подключение и ящики организаций; входящие от поставщиков (есть ли уже в 1С, `not_in_onec`) и исходящие клиентам (`balance_doc_id`); документ со строками УПД из XML |
| `create_onec_supplier_document` | **1С, запись с подтверждением**: поступление (акт, накладная, УПД) или счёт от поставщика — из входящего документа Диадока или из данных пользователя, без дублей (ключ, входящий номер у контрагента) |
| `create_onec_supplier`, `create_onec_nomenclature` | поставщик в 1С по ИНН (ЕГРЮЛ/ЕГРИП) с договором «С поставщиком» — или договор у иностранного поставщика без ИНН (`onec_counterparty_id`), в том числе налогового агента (`tax_agent`); позиция номенклатуры |
| `update_onec_document` | правка поступления или счёта от поставщика, созданного через MCP: строки (заменяются целиком), счета учёта, договор, комментарий, входящий номер и дата |
| `create_onec_tax_agent_invoice` | **1С, запись с подтверждением**: счёт-фактура налогового агента на оплату иностранному поставщику (списание с р/с) — как «Создать на основании» у бухгалтера; до 20 оплат за вызов, превью — пробная запись 1С с откатом, одна СФ на оплату |
| `update_onec_supplier_payment` | **1С, запись с подтверждением**: оплата поставщику (списание с р/с из выписки) — другой контрагент и/или договор, как правка в форме; СФ налогового агента на неё — перезаполнить (`refill_vat_invoice`) |

### Тулзы 1С

MCP в 1С не ходит: тулзы зовут balance `/api/v1/onec/…`, `/customers/{id}/onec`, `/documents/{id}/onec`,
`/contracts/{id}/onec`, а balance выбирает базу 1С по `org_id` (только с проверенным API v1), проверяет скоуп,
право и зону видимости, пишет журнал `onec_audit_log` (`trigger_source = mcp`, `request_id`; хранится 30 дней).
Чтение — скоуп `onec:read`, право `onec.view`. Тайм-аут вызова balance у тулзов 1С — 120 с (холодная база 1С).

**Запись** (`src/tools/onecWrite.ts`) — скоуп `onec:write`, права `onec.write` (акт сверки, ЕГРЮЛ, контрагент,
договор), `onec.export` (отправка документа, загрузка поступлений), `onec.documents` (проведение и пометка); только
пользователь OAuth, только организации из `onec_api_write_orgs` balance. Каждый тулз записи — **два шага**: без
`confirm` balance делает `dry_run` (в 1С ничего не пишется) и тулз возвращает превью и токен; запись — повторным
вызовом с теми же полями и `confirm` (токен — HMAC от операции и полей, 15 минут, как у базы знаний). Где делать
нечего или нельзя — токена нет. Документы в 1С уходят только штатными механизмами balance (тот же ключ, без дублей);
проводить и помечать можно только документы, созданные balance. На обрыв по тайм-ауту — текст «запись могла пройти,
повтор безопасен»: ключи записи постоянные.

**ЭДО (Диадок)** (`src/tools/edo.ts`) — balance `GET /edo/status`, `/edo/documents`, `/edo/documents/{message_id}/{entity_id}`:
скоуп `onec:read`, право `onec.view`, пользователю с зоной дилера недоступно (ящик организации — сквозной список).
Документы читаются из Диадока живьём; у входящих balance ищет их в 1С по ключу `diadoc:<message_id>:<entity_id>` или по
входящему номеру у контрагента с тем же ИНН. Тайм-аут — 150 с (Диадок + 1С по каждому входящему). Документы поставщиков
в 1С (`create_onec_supplier_document`, `create_onec_supplier`, `create_onec_nomenclature`, `update_onec_document` — PUT) —
право `onec.write`, те же два шага; у поступления каждой строке нужна номенклатура 1С, у счёта от поставщика — нет.
Счёт-фактура налогового агента (`create_onec_tax_agent_invoice`) — balance `POST /onec/{org}/tax-agent-invoices`, право
`onec.write`: заполняет 1С (вид, код операции 06, НДС сверху по проводкам оплаты), превью — настоящий `dry_run` 1С с
проводками; нужен ресурс `POST /v1/tax-agent-invoices` в расширении 1С (старое расширение — `onec_extension_outdated`).

Новые скоупы получает только переподключённый коннектор (миграции balance 156 и 157 добавляют `onec:read` и
`onec:write` зарегистрированным клиентам). Проект — `docs/onec-api-design.md` (ветка `onec-api-design`).

ЕГРЮЛ/ЕГРИП для `lookup_company_by_inn` и `find_or_create_customer` — через сервис 1С:Контрагент баз 1С
(`src/registry.ts`, balance `GET /onec/registry/{inn}`, кэш 24 ч; нужен скоуп `onec:read`). DaData — только запасной
вариант, если реестр 1С недоступен и задан `DADATA_TOKEN`.

Тесты: `npm test` (node:test, без зависимостей: подменный balance и перехват обработчиков тулзов).

### Файлы отдаются ссылкой, а не байтами

`get_document_pdf`, `get_customer_file`, `get_my_file` возвращают **временную ссылку**
`https://balance.99p.ru/mcp/file/<token>/<имя>` (по умолчанию 30 минут): её можно открыть
в браузере, отдать человеку или скачать агентом. Байты лежат в памяти контейнера
(`src/downloadStore.ts`), ключ доступа — сам токен (192 бита); рестарт контейнера
обнуляет все ссылки. Текстовые файлы ≤ 32 КБ дублируются содержимым в тексте ответа.

Так сделано вынужденно: embedded-ресурс с `blob` до клиента **не доезжает** — blob по
дороге вырезается, и клиент отбраковывает весь результат тулза
(`-32602 Invalid tools/call result … invalid_union … content[1]`), то есть инлайном файл
не приходил вообще. Ограничения: `MCP_LINK_TTL_MIN` (30), `MCP_LINK_MAX_BYTES` (64 МБ на файл),
`MCP_LINK_STORE_MAX_BYTES` (256 МБ на все живые ссылки).

## Архитектура развёртывания (важно)

balance-mcp **не разворачивается сам по себе** — он поднимается как сервис в составе
стека **balance** (`balance/docker-compose.yml`, сервис `balance-mcp`, `build: ../balance-mcp`).
Маршрут `/mcp` и `/.well-known/oauth-protected-resource` проксирует **Apache самого
balance-web** (см. `balance/Dockerfile`) во внутренний `balance-mcp:8080`. Поэтому:

- **Отдельный Proxy Host / location в NPM НЕ нужны** — `/mcp` идёт через уже существующий
  маршрут `NPM → balance.99p.ru → balance-web`, а Apache форвардит его в контейнер MCP.
- **Introspection-клиент создаётся сам** (DCR) при первом старте и кэшируется в volume
  `balance_mcp_data`. Ручных кред не требуется.
- **Миграции** OAuth (035/036) применяются авто-раннером balance при старте `balance-web`.

## Деплой на прод (одной командой)

Положить репозиторий рядом с balance (один раз): `git clone … ../balance-mcp`.
В `balance/.env` задать прод-URL:
```
BALANCE_OAUTH_PUBLIC=https://balance.99p.ru
MCP_PUBLIC_URL=https://balance.99p.ru/mcp
MCP_RESOURCE=https://balance.99p.ru/mcp
```
Деплой (в каталоге balance):
```
git pull && git -C ../balance-mcp pull
docker compose up -d --build
```
Поднимется весь стек, включая balance-mcp; Apache начнёт отдавать `/mcp`. Проверка:
```
curl -s https://balance.99p.ru/.well-known/oauth-protected-resource/mcp   # → JSON
curl -s -i -X POST https://balance.99p.ru/mcp -d '{}' | head -1           # → HTTP/1.1 401
```

## Подключение в Claude

**Add custom connector** → URL `https://balance.99p.ru/mcp`, OAuth-поля пустыми (DCR).
Claude сам откроет вход в balance + экран согласия → инструменты появятся.

## Локальная отладка

В dev стек поднимается так же (`docker compose up -d --build` в balance). MCP доступен
через Apache на `http://localhost:8080/mcp`. Полноценный OAuth-поток из Claude Desktop
требует **https** (localhost не подойдёт) — для протокольной отладки используйте MCP Inspector.

## Конфигурация (env, задаёт balance-compose)

| Переменная | dev | prod |
|---|---|---|
| `BALANCE_API_BASE` | `http://web/api/v1` | `http://web/api/v1` |
| `BALANCE_OAUTH_PUBLIC` | `http://localhost:8080` | `https://balance.99p.ru` |
| `BALANCE_OAUTH_INTERNAL` | `http://web` | `http://web` |
| `PUBLIC_URL` | `http://localhost:8080/mcp` | `https://balance.99p.ru/mcp` |
| `MCP_INTROSPECTION_CLIENT_ID/SECRET` | пусто (само-регистрация) | пусто (само-регистрация) |
