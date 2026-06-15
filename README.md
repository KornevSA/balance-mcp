# balance-mcp

Remote **MCP-сервер** (Model Context Protocol) поверх REST API биллинга **Balance**.
Подключается к Claude через диалог **«Add custom connector»**. Является OAuth 2.1
**Resource Server**: пользователь логинится в Balance (Balance = Authorization Server),
а MCP действует **от его имени**, пробрасывая пользовательский токен в `/api/v1`.

TypeScript + `@modelcontextprotocol/sdk`, транспорт **streamable HTTP**.

## Что умеет (tools)

| Tool | Назначение |
|---|---|
| `find_or_create_customer`, `search_customers`, `get_customer` | контрагенты (идемпотентно по ИНН) |
| `create_invoice` | выставить счёт (+PDF через `get_document_pdf`) |
| `list_customer_documents`, `get_document`, `get_document_pdf` | документы и их PDF |
| `search_documents`, `documents_summary` | **кросс-КА поиск за период** (стр./полностью) и сводка |
| `get_customer_settlement` | **взаиморасчёты** (сальдо/обороты, дебет/кредит) |
| `find_missing_acts` | **детектор забытых актов** на конец месяца |
| `list_customer_files`, `get_customer_file` | файлы контрагента |
| `list_my_files`, `get_my_file`, `upload_my_file` | личные «Мои файлы» |

Файлы ≤ 5 МБ возвращаются инлайном (base64-resource); крупнее — только метаданными.

## Предусловия (на стороне Balance) — всё автоматически

1. **Миграции** `035_oauth_server.sql` / `036_oauth_rbac_events.sql` применяются
   САМИ при старте `balance-web` (docker-entrypoint → docker-deploy-tasks.sh).
2. **MCP_RESOURCE** (audience-binding, RFC 8707) — опционально; в balance `.env`:
   `MCP_RESOURCE=https://balance.99p.ru/mcp`. Без него audience не форсится
   (токен всё равно несёт resource от клиента). Пробрасывается в web из compose.
3. **Introspection-клиент** создаётся САМ при первом старте balance-mcp (DCR,
   кэшируется в volume `balance_mcp_data`). Вручную ничего не нужно; при желании
   можно зафиксировать через `MCP_INTROSPECTION_CLIENT_ID/SECRET`.

## Запуск (dev)

Сервис в `balance/docker-compose.yml` под profile `mcp` (порт **8088**):
```
cd D:\code\balance
docker compose --profile mcp up -d --build balance-mcp
curl http://localhost:8088/.well-known/oauth-protected-resource/mcp
```
> ⚠️ Claude Desktop требует **https** для remote-коннектора → `http://localhost`
> из Desktop не подключить. Локально протокол удобно гонять MCP Inspector'ом;
> полноценный OAuth-поток — на проде за NPM (https).

## Деплой на прод (само развернётся)

balance и balance-mcp — соседние каталоги на сервере:
```
# 1) balance: код + АВТО-миграции 035/036 (entrypoint)
cd /path/to/balance && git pull && docker compose up -d --build web cron

# 2) MCP: сборка + само-регистрация introspection-клиента (volume-кэш)
cd /path/to/balance-mcp && git pull && docker compose -f docker-compose.prod.yml up -d --build
```
`.env` для balance-mcp на проде НЕ обязателен. Сеть balance — `balance_default`
(уже прописана в prod-compose). Единственный ручной шаг — **NPM** (его конфиг
живёт в UI, не в git):

### Nginx Proxy Manager (балансовый proxy-host `balance.99p.ru`)

Добавить Custom Locations (Advanced):
- `/mcp` → `http://balance-mcp:8080` (сохранять `Authorization`, `proxy_buffering off`,
  `proxy_read_timeout 3600s` — для SSE)
- `/.well-known/oauth-protected-resource` (и `…/mcp`) → `http://balance-mcp:8080`
- остальное (`/`, `/api/v1`, `/oauth`, `/.well-known/oauth-authorization-server`) →
  `balance-web:80` (как сейчас)

```nginx
location /mcp {
    proxy_pass http://balance-mcp:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding on;
}
location ~ ^/\.well-known/oauth-protected-resource(/mcp)?$ {
    proxy_pass http://balance-mcp:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Подключение коннектора в Claude

1. **Add custom connector** → **Remote MCP server URL:** `https://balance.99p.ru/mcp`
2. **OAuth Client ID/Secret — оставить пустыми** (Claude саморегистрируется через DCR).
3. Claude: `/mcp` → 401 → discovery → `/oauth/authorize` (логин + согласие в Balance) →
   токен → инструменты доступны. Дальше Claude работает от имени вошедшего пользователя.

Права ограничены RBAC пользователя и выданными scope; личные «Мои файлы» — строго его.
