// HTTP entrypoint: streamable-HTTP MCP-сервер + OAuth Resource Server.
import express, { type Request, type Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { CFG } from "./config.js";
import { buildOAuthMetadata, SCOPES_SUPPORTED } from "./auth/metadata.js";
import { tokenVerifier, setIntrospectCreds } from "./auth/tokenVerifier.js";
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

const resourceUrl = new URL(CFG.publicUrl);

// Алиас «голого» пути PRM — некоторые клиенты пробуют его без суффикса /mcp.
// (SDK-router отдаёт path-суффиксный …/oauth-protected-resource/mcp, на который и
//  указывает WWW-Authenticate; этот алиас — для совместимости.)
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: CFG.publicUrl,
    authorization_servers: [CFG.oauthPublic],
    scopes_supported: SCOPES_SUPPORTED,
    resource_name: "Balance Billing MCP",
  });
});

// RFC 9728: /.well-known/oauth-protected-resource(/mcp) → указывает на AS (balance).
app.use(mcpAuthMetadataRouter({
  oauthMetadata: buildOAuthMetadata(),
  resourceServerUrl: resourceUrl,
  scopesSupported: SCOPES_SUPPORTED,
  resourceName: "Balance Billing MCP",
}));

// На 401 отдаём WWW-Authenticate с resource_metadata.
const authMiddleware = requireBearerAuth({
  verifier: tokenVerifier,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
});

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
  console.log(`[balance-mcp] listening on :${CFG.port}  resource=${CFG.publicUrl}  api=${CFG.balanceApiBase}`);
});

// Резолвим introspection-креды (ENV → volume-кэш → DCR-саморегистрация) в фоне,
// чтобы /healthz отвечал сразу. До готовности кред introspection отдаёт 401.
resolveIntrospectCreds()
  .then((c) => { setIntrospectCreds(c); console.log(`[balance-mcp] introspection client ready: ${c.id}`); })
  .catch((e) => console.error("[balance-mcp] WARN: introspection creds not resolved:", e?.message || e));
