// Временное файловое хранилище в памяти под ссылки `/mcp/file/<token>/<имя>`.
//
// Зачем: MCP-клиент (Claude Code / коннектор claude.ai) НЕ принимает embedded
// resource с бинарным blob — по дороге blob вырезается, и клиент отбраковывает
// ВЕСЬ результат тулза (invalid_union на content[1], `_meta: null`, без blob).
// То есть инлайн-доставка файлов не работала в принципе. Поэтому байты не идут
// через модель вовсе: тулз кладёт их сюда и отдаёт ссылку, а файл забирает
// браузер (или сам клиент) обычным GET.
//
// Безопасность: ссылка неавторизованная, её единственный ключ — неугадываемый
// токен (192 бита), плюс короткий TTL и хранение ТОЛЬКО в памяти процесса
// (рестарт контейнера = все ссылки протухли). Тот же класс защиты, что у
// balance: myfiles_public.php / docstore/getdoc.php.
import { randomBytes } from "node:crypto";
import { CFG } from "./config.js";

type Entry = {
  buf: Buffer;
  name: string;
  ctype: string;
  expiresAt: number;
};

const entries = new Map<string, Entry>();
let totalBytes = 0;

function drop(token: string): void {
  const e = entries.get(token);
  if (!e) return;
  entries.delete(token);
  totalBytes -= e.buf.length;
}

/** Выкинуть протухшее; при переполнении — самое старое (Map хранит порядок вставки). */
function sweep(): void {
  const now = Date.now();
  for (const [token, e] of entries) {
    if (e.expiresAt <= now) drop(token);
  }
  while (totalBytes > CFG.linkStoreMaxBytes && entries.size) {
    drop(entries.keys().next().value as string);
  }
}

/**
 * Положить файл и получить токен ссылки.
 * @returns токен (48 hex) или null, если файл больше лимита одной ссылки.
 */
export function putDownload(buf: Buffer, name: string, ctype: string): string | null {
  if (buf.length > CFG.linkMaxBytes) return null;
  sweep();
  const token = randomBytes(24).toString("hex");
  entries.set(token, {
    buf,
    name,
    ctype: ctype || "application/octet-stream",
    expiresAt: Date.now() + CFG.linkTtlMs,
  });
  totalBytes += buf.length;
  sweep();
  return token;
}

/** Забрать файл по токену. null — неизвестен или протух. */
export function getDownload(token: string): Entry | null {
  const e = entries.get(token);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { drop(token); return null; }
  return e;
}

/** Сколько минут живёт ссылка — для текста ответа тулза. */
export function linkTtlMinutes(): number {
  return Math.round(CFG.linkTtlMs / 60000);
}
