// Резолв кред confidential-клиента для /oauth/introspect, делающий прод-деплой
// самоустанавливающимся:
//   1) ENV (MCP_INTROSPECTION_CLIENT_ID/SECRET) — если заданы;
//   2) кэш-файл на volume (CFG.introspectStore) — если уже регистрировались;
//   3) саморегистрация через DCR (/oauth/register) с сохранением в кэш-файл.
// Ставишь контейнер — он сам заводит introspection-клиента в balance.
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.js";

export type IntrospectCreds = { id: string; secret: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resolveIntrospectCreds(): Promise<IntrospectCreds> {
  // 1) ENV
  if (CFG.introspectClientId && CFG.introspectClientSecret) {
    return { id: CFG.introspectClientId, secret: CFG.introspectClientSecret };
  }
  // 2) кэш-файл (volume)
  const store = CFG.introspectStore;
  try {
    if (fs.existsSync(store)) {
      const j = JSON.parse(fs.readFileSync(store, "utf8"));
      if (j?.id && j?.secret) return { id: String(j.id), secret: String(j.secret) };
    }
  } catch { /* битый кэш — перерегистрируемся */ }

  // 3) DCR-саморегистрация (ждём пока balance AS поднимется).
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${CFG.oauthInternal}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "balance-mcp introspector (auto)",
          redirect_uris: [`${CFG.publicUrl}/introspect-noop`],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: any = await r.json();
      if (!d?.client_id || !d?.client_secret) throw new Error("DCR-ответ без client_secret");
      const creds: IntrospectCreds = { id: String(d.client_id), secret: String(d.client_secret) };
      try {
        fs.mkdirSync(path.dirname(store), { recursive: true });
        fs.writeFileSync(store, JSON.stringify(creds), { mode: 0o600 });
      } catch { /* нет volume — переживём, зарегистрируемся снова при рестарте */ }
      return creds;
    } catch (e) {
      lastErr = e;
      await sleep(2000);
    }
  }
  throw new Error(`само-регистрация introspection-клиента не удалась: ${String(lastErr)}`);
}
