// HTTP entrypoint: streamable-HTTP MCP-сервер + OAuth Resource Server.
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { CFG } from "./config.js";
import { SCOPES_SUPPORTED } from "./auth/metadata.js";
import { makeTokenVerifier, setIntrospectCreds } from "./auth/tokenVerifier.js";
import { resolveIntrospectCreds } from "./auth/introspectClient.js";
import { createMcpServer } from "./server.js";
import { getDownload } from "./downloadStore.js";

const app = express();

app.use(cors({
  origin: true,
  exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
  allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Last-Event-ID"],
}));

// Health (без авторизации) — для docker healthcheck.
app.get("/healthz", (_req, res) => { res.json({ ok: true, service: "balance-mcp" }); });

// Временная ссылка на файл: `/mcp/file/<token>[/<имя>]`. Авторизации нет —
// ключ доступа сам токен (192 бита, TTL, только в памяти; см. downloadStore.ts).
// Имя в хвосте пути косметическое, файл резолвится только по токену.
//
// Инлайн в браузере разрешаем ТОЛЬКО безопасным типам: этот путь живёт на
// origin самого balance (Apache проксирует /mcp), поэтому html/svg инлайном
// были бы stored-XSS с доступом к сессии приложения. Всё остальное — attachment
// и octet-stream.
const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain|text\/csv)/i;

app.get("/mcp/file/:token/:name?", (req: Request, res: Response) => {
  const entry = getDownload(String(req.params.token || ""));
  if (!entry) { res.status(404).type("text/plain; charset=utf-8").send("Ссылка не найдена или истекла"); return; }

  const inline = INLINE_TYPES.test(entry.ctype);
  const ascii = entry.name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
  res.setHeader("Content-Type", inline ? entry.ctype : "application/octet-stream");
  res.setHeader("Content-Length", String(entry.buf.length));
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(entry.buf);
});

// Канонический публичный базовый URL вычисляем ИЗ ЗАПРОСА (как PHP-AS balance),
// а не из ENV — тогда коннектор работает на любом домене без прод-конфига и не
// «залипает» на localhost, если прод-.env не задан. Apache balance-web проксирует
// /mcp с `ProxyPreserveHost On` и пробрасывает X-Forwarded-Proto, выставленный NPM,
// поэтому здесь видно реальный `https://balance.99p.ru`. X-Forwarded-* может прийти
// списком — берём первый элемент.
function reqBase(req: Request): string {
  const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const host = xfHost || String(req.headers["host"] || "localhost");
  const proto = xfProto || (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

// RFC 9728: Protected Resource Metadata. Отдаём оба пути — «голый» (некоторые
// клиенты пробуют без суффикса) и path-суффиксный `…/mcp`, на который указывает
// WWW-Authenticate. authorization_servers = тот же origin (там же живёт balance-AS).
function prmBody(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: SCOPES_SUPPORTED,
    resource_name: "Balance Billing MCP",
  };
}
app.get("/.well-known/oauth-protected-resource", (req, res) => { res.json(prmBody(reqBase(req))); });
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => { res.json(prmBody(reqBase(req))); });

// Bearer-auth: resource_metadata в WWW-Authenticate и ожидаемый audience —
// оба привязаны к домену запроса (см. reqBase). Конструируем middleware
// по-запросно: это дёшево (замыкание), а URL/аудиенс получаются корректными
// для любого хоста, через который пришёл запрос.
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const base = reqBase(req);
  const mw = requireBearerAuth({
    verifier: makeTokenVerifier(`${base}/mcp`),
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`,
  });
  void mw(req, res, next);
}

app.use(express.json({ limit: "32mb" }));

// Stateful streamable HTTP: по одному транспорту на сессию (Mcp-Session-Id).
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", authMiddleware, async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    const server = createMcpServer();
    await server.connect(transport);
  } else if (sid) {
    // Сессия не найдена (рестарт контейнера — транспорты живут в памяти). Спека
    // Streamable HTTP: на запрос с неизвестным Mcp-Session-Id сервер отвечает 404,
    // и тогда клиент ОБЯЗАН начать новую сессию новым initialize. Раньше отдавали
    // 400 — клиент этого сигнала не понимал и продолжал слать мёртвый session-id,
    // поэтому после каждого деплоя коннектор Claude умирал целиком до ручного
    // переподключения.
    res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found: начните новую сессию (initialize)" }, id: null });
    return;
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: нет валидной сессии" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid) { res.status(400).send("Missing session ID"); return; }
  // См. выше: неизвестная сессия — 404, чтобы клиент переинициализировался сам.
  if (!transports[sid]) { res.status(404).send("Session not found"); return; }
  await transports[sid].handleRequest(req, res);
};

app.get("/mcp", authMiddleware, sessionRequest);
app.delete("/mcp", authMiddleware, sessionRequest);

app.listen(CFG.port, () => {
  console.log(`[balance-mcp] listening on :${CFG.port}  resource=<из запроса: X-Forwarded-Host/Proto>  api=${CFG.balanceApiBase}`);
});

// Резолвим introspection-креды (ENV → volume-кэш → DCR-саморегистрация) в фоне,
// чтобы /healthz отвечал сразу. До готовности кред introspection отдаёт 401.
resolveIntrospectCreds()
  .then((c) => { setIntrospectCreds(c); console.log(`[balance-mcp] introspection client ready: ${c.id}`); })
  .catch((e) => console.error("[balance-mcp] WARN: introspection creds not resolved:", e?.message || e));
