// Конфигурация из окружения. Все URL без хвостового слэша.
function trim(u: string): string { return u.replace(/\/+$/, ""); }

export const CFG = {
  port: parseInt(process.env.PORT || "8080", 10),

  // Внутренний (docker-сеть) базовый URL balance API — токен пользователя не уходит наружу.
  balanceApiBase: trim(process.env.BALANCE_API_BASE || "http://web/api/v1"),

  // Публичный issuer/endpoints OAuth (их видит браузер Claude).
  oauthPublic: trim(process.env.BALANCE_OAUTH_PUBLIC || "http://localhost:8080"),

  // Внутренний адрес balance для introspection (без TLS-hairpin).
  oauthInternal: trim(process.env.BALANCE_OAUTH_INTERNAL || "http://web"),

  // Канонический URL этого MCP-ресурса (audience). Должен совпадать с тем, что
  // вписывают в «Add custom connector», и с MCP_RESOURCE в balance.
  publicUrl: trim(process.env.PUBLIC_URL || "http://localhost:8088/mcp"),

  // Confidential-клиент самого MCP для аутентификации на /oauth/introspect.
  introspectClientId: process.env.MCP_INTROSPECTION_CLIENT_ID || "",
  introspectClientSecret: process.env.MCP_INTROSPECTION_CLIENT_SECRET || "",

  // Куда кэшировать само-зарегистрированного introspection-клиента (volume на проде).
  introspectStore: process.env.MCP_INTROSPECT_STORE || "/data/introspect-client.json",

  // Порог инлайна файла (base64) в ответе тулза.
  inlineMaxBytes: parseInt(process.env.MCP_INLINE_MAX_BYTES || String(5 * 1024 * 1024), 10),
};
