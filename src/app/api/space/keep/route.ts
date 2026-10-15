import { keys } from "@/lib/keys";
import { json, loadSpace, notConfigured, ready, saveSpace, secret, setSpaceCookie } from "@/lib/server";
import { newRecoveryKey, recoveryHash } from "@/lib/space";
import { listJobs } from "@/lib/space-ops";
import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Keep my space: re-tag every object `space=kept` (the 7-day anonymous rule no longer matches) and show a
 * recovery key ONCE. Only an HMAC of the key is stored.
 */
export async function POST() {
  const r = ready();
  if (!r.ok) return notConfigured(r.missing);
  const space = await loadSpace(r.store);
  if (!space) return json({ error: "no space" }, 404);
  const inflight = (await listJobs(r.store, space.uid)).some((j) => ["queued", "dispatched", "running", "finalizing"].includes(j.state));
  if (inflight) return json({ error: "Wait until the notes in progress are kept, then keep your space." }, 409);
  let retagged = 0;
  for (const prefix of keys.spacePrefixes(space.uid)) {
    for (const obj of await r.store.list(prefix)) {
      await r.store.setTags(obj.key, { space: "kept" });
      retagged += 1;
    }
  }
  const key = newRecoveryKey(space.uid);
  space.doc.kept = true;
  await saveSpace(r.store, space.uid, space.doc);
  await r.store.putJson(keys.recovery(space.uid), { hash: recoveryHash(secret(), key), at: new Date().toISOString() }, { tagging: "space=kept" });
  setSpaceCookie(await cookies(), space.uid, true);
  return json({ kept: true, retagged, recoveryKey: key, note: "Shown once. Write it down to open this space on another device." });
}
