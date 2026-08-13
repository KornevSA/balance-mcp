# balance-mcp

Remote **MCP-сервер** (Model Context Protocol) поверх REST API биллинга **Balance**.
Подключается к Claude через диалог **«Add custom connector»**. Является OAuth 2.1
**Resource Server**: пользователь логинится в Balance (Balance = Authorization Server),
а MCP действует **от его имени**, пробрасывая пользовательский токен в `/api/v1`.

TypeScript + `@modelcontextprotocol/sdk`, транспорт **streamable HTTP**.

## Что умеет (tools)

| Tool | Назначение |
|---|---|
| `find_or_create_customer`, `search_customers`, `get_customer` | контрагенты (идемпотентно по ИНН; `name` необязателен — тянется из ЕГРЮЛ по ИНН) |
| `lookup_company_by_inn` | реквизиты юрлица/ИП по ИНН из ЕГРЮЛ (DaData), без создания КА |
| `create_invoice` | выставить счёт (+PDF через `get_document_pdf`) |
| `list_customer_documents`, `get_document`, `get_document_pdf` | документы и их PDF |
| `search_documents`, `documents_summary` | **кросс-КА поиск за период** (стр./полностью) и сводка |
| `get_customer_settlement` | **взаиморасчёты** (сальдо/обороты, поступления/реализации) |
| `find_missing_acts` | **детектор забытых актов** на конец месяца |
| `list_customer_files`, `get_customer_file` | файлы контрагента |
| `list_my_files`, `get_my_file`, `upload_my_file` | личные «Мои файлы» |

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
