import { keys } from "@/lib/keys";
import { clientKey, json, notConfigured, ready, secret, setSpaceCookie } from "@/lib/server";
import { hashesMatch, recoveryHash, recoveryUid } from "@/lib/space";
import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open a kept space on a new device with its recovery key (constant-time HMAC compare; 10 tries per day per network). */
export async function POST(req: Request) {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const day = new Date().toISOString().slice(0, 10);
  const who = await clientKey();
  const triesKey = `sys/caps/recover-${day}.json`;
  const tries = (await r.store.getJson<Record<string, number>>(triesKey))?.value ?? {};
  if ((tries[who] ?? 0) >= 10) return json({ error: "Too many tries today." }, 429);
  tries[who] = (tries[who] ?? 0) + 1;
  await r.store.putJson(triesKey, tries);
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  const key = String(body.key ?? "");
  const uid = recoveryUid(key);
  const stored = uid ? (await r.store.getJson<{ hash: string }>(keys.recovery(uid)))?.value : null;
  if (!uid || !stored || !hashesMatch(recoveryHash(secret(), key), stored.hash)) return json({ error: "That key does not open a space." }, 403);
  setSpaceCookie(await cookies(), uid, true);
  return json({ ok: true });
}
