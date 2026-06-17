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

const app = express();

app.use(cors({
  origin: true,
  exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
  allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Last-Event-ID"],
}));

// Health (без авторизации) — для docker healthcheck.
app.get("/healthz", (_req, res) => { res.json({ ok: true, service: "balance-mcp" }); });

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
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: нет валидной сессии" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !transports[sid]) { res.status(400).send("Invalid or missing session ID"); return; }
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
