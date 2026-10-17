import { describe, expect, it } from "vitest";
import { keys } from "@/lib/keys";
import type { JobRecord, NoteMeta } from "@/lib/pipeline";
import { giveBackSpaceKeep, listJobs, listNotes, memoryDue, pumpMemory, readMemory, resumePaused, takeSpaceKeep } from "@/lib/space-ops";
import { ANON_DAYS, daysLeft, feedKeyMatches, hashesMatch, newId, newRecoveryKey, newSpace, parseFeedKey, recoveryHash, recoveryUid, safeTimeZone, signSpace, verifySpace } from "@/lib/space";
import { MemoryStore } from "@/lib/store";
import { must, seedNote, seedSpace, UID } from "./helpers";

const ID = (n: number) => n.toString(16).padStart(8, "0");

describe("space identity", () => {
  it("signs and verifies cookies, rejecting every malformed or forged shape", () => {
    const c = signSpace("s", UID);
    expect(verifySpace("s", c)).toBe(UID);
    expect(verifySpace("other", c)).toBeNull();
    for (const bad of [undefined, null, "", UID, `${UID}.`, `.sig`, `short.sig`, `${UID}.x`, `${UID.toUpperCase()}.${c.split(".")[1]}`]) expect(verifySpace("s", bad)).toBeNull();
  });
  it("newId is hex of the requested length; newSpace falls back to UTC for a bad zone", () => {
    expect(newId()).toMatch(/^[a-f0-9]{32}$/);
    expect(newId(4)).toMatch(/^[a-f0-9]{8}$/);
    expect(newSpace("Nope/Zone").timeZone).toBe("UTC");
    const d = newSpace("Asia/Kolkata", new Date("2026-10-15T00:00:00Z"));
    expect(d).toMatchObject({ version: 1, created: "2026-10-15T00:00:00.000Z", kept: false, timeZone: "Asia/Kolkata" });
    expect(safeTimeZone(undefined)).toBe("UTC");
    expect(safeTimeZone(null)).toBe("UTC");
    expect(safeTimeZone("")).toBe("UTC");
  });
  it("feed keys parse and compare in constant shape", () => {
    const d = newSpace("UTC");
    expect(parseFeedKey(`${UID}.${d.feedKey}`)).toEqual({ uid: UID, feedKey: d.feedKey });
    for (const bad of [null, "", "x.y", `${UID}.zz`]) expect(parseFeedKey(bad)).toBeNull();
    expect(feedKeyMatches(d, d.feedKey)).toBe(true);
    expect(feedKeyMatches(d, newId(16))).toBe(false);
    expect(feedKeyMatches(d, "short")).toBe(false);
  });
  it("recovery keys carry their uid; only the hash is comparable", () => {
    const k = newRecoveryKey(UID);
    expect(recoveryUid(k)).toBe(UID);
    expect(recoveryUid(` ${k.toUpperCase()} `)).toBe(UID);
    expect(recoveryUid("nope")).toBeNull();
    const h = recoveryHash("s", k);
    expect(recoveryHash("s", ` ${k.toUpperCase()}`)).toBe(h);
    expect(hashesMatch(h, h)).toBe(true);
    expect(hashesMatch(h, recoveryHash("s", newRecoveryKey(UID)))).toBe(false);
    expect(hashesMatch("", "")).toBe(false);
    expect(hashesMatch(h, "ab")).toBe(false);
  });
  it("daysLeft counts down, never below 0, null once kept", () => {
    const d = newSpace("UTC", new Date("2026-10-01T00:00:00Z"));
    expect(daysLeft(d, new Date("2026-10-01T00:00:00Z"))).toBe(ANON_DAYS);
    expect(daysLeft(d, new Date("2026-10-04T12:00:00Z"))).toBe(4);
    expect(daysLeft(d, new Date("2026-11-01T00:00:00Z"))).toBe(0);
    expect(daysLeft(d)).toBe(0);
    expect(daysLeft({ ...d, kept: true })).toBeNull();
  });
});

describe("listing", () => {
  it("listNotes sorts by anchor then upload time and ignores non-meta objects", async () => {
    const st = new MemoryStore();
    await seedNote(st, ID(1));
    await seedNote(st, ID(2));
    await seedNote(st, ID(3));
    const patch = async (id: string, p: Partial<NoteMeta>) => {
      const m = must((await st.getJson<NoteMeta>(keys.meta(UID, id)))?.value);
      await st.putJson(keys.meta(UID, id), { ...m, ...p });
    };
    await patch(ID(1), { anchor: "2026-10-13" });
    await patch(ID(2), { anchor: "2026-10-12", uploaded: "2026-10-15T02:00:00Z" });
    await patch(ID(3), { anchor: "2026-10-12", uploaded: "2026-10-15T01:00:00Z" });
    await st.put(keys.hct(UID, ID(1)), "x"); // not a .meta.json
    expect((await listNotes(st, UID)).map((n) => n.id)).toEqual([ID(3), ID(2), ID(1)]);
    expect(await listNotes(st, "f".repeat(32))).toEqual([]);
  });
  it("listJobs returns only job records, newest first", async () => {
    const st = new MemoryStore();
    const rec = (job: string, created: string) => ({ version: 1, job, kind: "keep", notes: [], state: "done", created, attempts: 1, backoffs: 0 }) as unknown as JobRecord;
    await st.putJson(keys.job(UID, "a"), rec("a", "2026-10-15T01:00:00Z"));
    await st.putJson(keys.job(UID, "b"), rec("b", "2026-10-15T02:00:00Z"));
    await st.putJson(keys.jobManifest(UID, "a"), {});
    await st.putJson(keys.jobResult(UID, "a"), {});
    await st.putJson(keys.jobStatus(UID, "a"), {});
    await st.putJson(keys.noteResult(UID, "a", "n"), {});
    expect((await listJobs(st, UID)).map((j) => j.job)).toEqual(["b", "a"]);
  });
  it("readMemory returns the doc or null", async () => {
    const st = new MemoryStore();
    expect(await readMemory(st, UID)).toBeNull();
    await st.putJson(keys.memory(UID), { items: [] });
    expect(await readMemory(st, UID)).toEqual({ items: [] });
  });
});

describe("per-space keep cap", () => {
  const NOW = new Date("2026-10-20T10:00:00Z"); // build phase: 3 per space
  it("counts up to the limit, bypass overrides, give-back restores", async () => {
    const st = new MemoryStore();
    for (let i = 0; i < 3; i += 1) expect(await takeSpaceKeep(st, UID, false, false, NOW)).toBe(true);
    expect(await takeSpaceKeep(st, UID, false, false, NOW)).toBe(false);
    expect(await takeSpaceKeep(st, UID, true, true, NOW)).toBe(true);
    expect(await st.getJson(keys.spaceCaps(UID))).toMatchObject({ value: { "2026-10-20": 4 } });
    expect(await st.getTags(keys.spaceCaps(UID))).toEqual({ space: "kept" });
    await giveBackSpaceKeep(st, UID, false, NOW);
    expect((await st.getJson(keys.spaceCaps(UID)))?.value).toEqual({ "2026-10-20": 3 });
    expect(await st.getTags(keys.spaceCaps(UID))).toEqual({ space: "anon" });
  });
  it("give-back at zero (or with no record) writes nothing", async () => {
    const st = new MemoryStore();
    await giveBackSpaceKeep(st, UID, false, NOW);
    expect(await st.head(keys.spaceCaps(UID))).toMatchObject({ status: 404 });
    await st.putJson(keys.spaceCaps(UID), { "2026-10-20": 0 });
    await giveBackSpaceKeep(st, UID, false, NOW);
    expect((await st.getJson(keys.spaceCaps(UID)))?.value).toEqual({ "2026-10-20": 0 });
    await giveBackSpaceKeep(st, UID, false); // default clock
  });
  it("a new day starts at zero", async () => {
    const st = new MemoryStore();
    await st.putJson(keys.spaceCaps(UID), { "2026-10-19": 3 });
    expect(await takeSpaceKeep(st, UID, false, false, NOW)).toBe(true);
    expect((await st.getJson(keys.spaceCaps(UID)))?.value).toEqual({ "2026-10-20": 1 });
    expect(await takeSpaceKeep(new MemoryStore(), UID, false, false)).toBe(true); // default clock
  });
});

describe("memoryDue", () => {
  const base = { status: "kept" } as NoteMeta;
  const NOW = Date.parse("2026-10-20T10:00:00Z");
  it.each([
    ["not kept", { status: "uploaded", memory: "pending" }, false],
    ["pending, no retry time", { memory: "pending" }, true],
    ["pending, retry passed", { memory: "pending", memoryNextTry: "2026-10-20T09:00:00Z" }, true],
    ["pending, retry in future", { memory: "pending", memoryNextTry: "2026-10-20T11:00:00Z" }, false],
    ["running, no claim time", { memory: "running" }, true],
    ["running, stale claim", { memory: "running", memoryClaimedAt: "2026-10-20T09:00:00Z" }, true],
    ["running, fresh claim", { memory: "running", memoryClaimedAt: "2026-10-20T09:59:00Z" }, false],
    ["done", { memory: "done" }, false],
    ["no memory state", {}, false],
  ] as Array<[string, Partial<NoteMeta>, boolean]>)("%s", (_n, p, want) => {
    expect(memoryDue({ ...base, ...p } as NoteMeta, NOW)).toBe(want);
  });
  it("uses the real clock by default", () => {
    expect(memoryDue({ ...base, memory: "pending" } as NoteMeta)).toBe(true);
  });
});

async function keptNote(st: MemoryStore, id: string, memory: NoteMeta["memory"], extra: Partial<NoteMeta> = {}) {
  await seedNote(st, id);
  const m = must((await st.getJson<NoteMeta>(keys.meta(UID, id)))?.value);
  await st.putJson(keys.meta(UID, id), { ...m, status: "kept", memory, ...extra });
}

describe("pumpMemory", () => {
  it("remembers only due notes (paused without an opt-in), skipping the rest", async () => {
    const st = new MemoryStore();
    await seedSpace(st);
    await keptNote(st, ID(1), "pending");
    await keptNote(st, ID(2), "done");
    expect(await pumpMemory(st, null, UID)).toBe(1);
    expect((await st.getJson<NoteMeta>(keys.meta(UID, ID(1))))?.value.memory).toBe("paused");
    expect((await st.getJson<NoteMeta>(keys.meta(UID, ID(2))))?.value.memory).toBe("done");
  });
  it("starts no call with under 20 s of budget left", async () => {
    const st = new MemoryStore();
    await seedSpace(st);
    await keptNote(st, ID(1), "pending");
    expect(await pumpMemory(st, null, UID, { budgetMs: 10_000 })).toBe(0);
    expect((await st.getJson<NoteMeta>(keys.meta(UID, ID(1))))?.value.memory).toBe("pending");
  });
  it("the judge sample bypasses the opt-in (and reports a missing Token Factory)", async () => {
    const st = new MemoryStore();
    await seedSpace(st);
    await keptNote(st, ID(1), "pending");
    expect(await pumpMemory(st, null, UID, { isSample: true })).toBe(1);
    expect((await st.getJson<NoteMeta>(keys.meta(UID, ID(1))))?.value).toMatchObject({ memory: "failed", memoryError: expect.stringMatching(/not configured/) });
  });
});

describe("resumePaused", () => {
  it("re-queues only kept+paused notes and clears retry bookkeeping", async () => {
    const st = new MemoryStore();
    await keptNote(st, ID(1), "paused", { memoryNextTry: "x", memoryTries: 2 });
    await keptNote(st, ID(2), "done");
    await keptNote(st, ID(3), "paused", { status: "uploaded" });
    const space = { ...newSpace("UTC"), kept: true };
    expect(await resumePaused(st, UID, space)).toBe(1);
    const m = must((await st.getJson<NoteMeta>(keys.meta(UID, ID(1))))?.value);
    expect(m.memory).toBe("pending");
    expect(m).not.toHaveProperty("memoryNextTry");
    expect(m).not.toHaveProperty("memoryTries");
    expect(await st.getTags(keys.meta(UID, ID(1)))).toEqual({ space: "kept" });
    expect((await st.getJson<NoteMeta>(keys.meta(UID, ID(3))))?.value.memory).toBe("paused");
    expect(await resumePaused(st, UID, { ...space, kept: false })).toBe(0);
  });
});
