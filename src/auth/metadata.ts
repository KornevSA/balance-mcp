import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CFG } from "../config.js";

export const SCOPES_SUPPORTED = [
  "customers:read",
  "customers:write",
  "invoices:write",
  "documents:read",
  "files:read",
  "files:write",
  "me:files:read",
  "me:files:write",
  "organizations:read",
  "kb:read",
  "positions:read",
  "tasks:read",
  "tasks:write",
];

// Метаданные Authorization Server (balance). Публикуем ТОЛЬКО публичные URL —
// introspection_endpoint снаружи указываем публичный (а сам RS ходит по
// внутреннему CFG.oauthInternal, см. tokenVerifier).
export function buildOAuthMetadata(): OAuthMetadata {
  const pub = CFG.oauthPublic;
  return {
    issuer: pub,
    authorization_endpoint: `${pub}/oauth/authorize`,
    token_endpoint: `${pub}/oauth/token`,
    registration_endpoint: `${pub}/oauth/register`,
    introspection_endpoint: `${pub}/oauth/introspect`,
    revocation_endpoint: `${pub}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: SCOPES_SUPPORTED,
  };
}
