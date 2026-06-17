// OAuth Resource Server: проверка пользовательского access-токена через
// balance /oauth/introspect (RFC 7662) + сверка audience (RFC 8707) + кэш.
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CFG } from "../config.js";

type CacheEntry = { info: AuthInfo; expEpoch: number };
const cache = new Map<string, CacheEntry>();

// Креды confidential-клиента для introspection. Изначально из ENV (если есть),
// иначе подставляются на старте через setIntrospectCreds() (см. introspectClient).
let introspectCreds: { id: string; secret: string } | null =
  CFG.introspectClientId && CFG.introspectClientSecret
    ? { id: CFG.introspectClientId, secret: CFG.introspectClientSecret }
    : null;

export function setIntrospectCreds(c: { id: string; secret: string }): void {
  introspectCreds = c;
}

// Verifier привязан к ОЖИДАЕМОМУ audience (каноническому URL этого MCP-ресурса).
// Раньше он брался из CFG.publicUrl (ENV, на проде дефолтился в localhost и ломал
// сверку) — теперь вычисляется ИЗ ЗАПРОСА в index.ts и пробрасывается сюда, поэтому
// коннектор работает на любом домене без прод-ENV. Кэш ключуется (resource+token),
// чтобы один токен не «протёк» между разными audience.
export function makeTokenVerifier(expectedResource: string) {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const now = Math.floor(Date.now() / 1000);
      const cacheKey = expectedResource + "|" + token;
      const hit = cache.get(cacheKey);
      if (hit && hit.expEpoch > now) return hit.info;

      const body = new URLSearchParams({ token });
      if (introspectCreds) {
        body.set("client_id", introspectCreds.id);
        body.set("client_secret", introspectCreds.secret);
      }

      const r = await fetch(`${CFG.oauthInternal}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!r.ok) throw new Error(`introspection failed: HTTP ${r.status}`);
      const d: any = await r.json();
      if (!d || d.active !== true) throw new Error("inactive token");

      // audience: aud токена должен включать ожидаемый ресурс (если aud задан).
      const auds: string[] = Array.isArray(d.aud) ? d.aud : d.aud ? [d.aud] : [];
      if (auds.length) {
        const allowed = auds.some((a: string) => {
          try { return checkResourceAllowed({ requestedResource: a, configuredResource: expectedResource }); }
          catch { return a === expectedResource; }
        });
        if (!allowed) throw new Error("audience mismatch");
      }

      const scopes = typeof d.scope === "string" && d.scope ? d.scope.split(/\s+/) : [];
      const info: AuthInfo = {
        token,
        clientId: String(d.client_id || ""),
        scopes,
        expiresAt: typeof d.exp === "number" ? d.exp : undefined,
        extra: { sub: d.sub != null ? String(d.sub) : undefined },
      };
      const ttl = info.expiresAt ? Math.min(info.expiresAt - now, 60) : 60;
      cache.set(cacheKey, { info, expEpoch: now + Math.max(5, ttl) });
      return info;
    },
  };
}
