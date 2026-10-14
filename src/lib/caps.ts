/**
 * Cost protection for a $25 AI Cloud top-up shared by three entries (Hearth's share is at most $17.50).
 *
 * The judge path that needs no Job — the sample, its A/B, search over it, the coupons and /proof — is never
 * capped. Caps apply only to NEW uploads and to decode-only Jobs:
 *   - a daily count (uid-free) and a per-space count, by phase;
 *   - a spend meter (uid-free, `sys/caps/spend.json`): every Job create reserves the worst case (its explicit
 *     1 h timeout x the preset's price) and is settled from its real duration when it ends. Delete-all and
 *     anonymous expiry never touch the meter, so it cannot be reset by a user. Failed or hung Jobs count.
 * Phases (UTC dates): build to 2026-10-30 (ceiling $10 in total); 2026-10-31..11-30 a $0.10 daily slice;
 * judging 2026-12-01..12-15 a $0.50 daily slice, so a judge on Dec 14 finds the same allowance as one on Dec 1;
 * after that uploads pause. Whatever the phase, the meter never passes $17.50.
 */

import type { Store } from "./store";
import { keys } from "./keys";

export const PRICE_PER_HOUR: Record<string, number> = {
  // cpu-d3 at $0.015 per vCPU-hour + $0.0045 per GiB-hour (the higher of the two published figures).
  "4vcpu-16gb": 4 * 0.015 + 16 * 0.0045,
  "8vcpu-32gb": 8 * 0.015 + 32 * 0.0045,
};
export const JOB_TIMEOUT_HOURS = 1;
export const HEARTH_CEILING_USD = 17.5;

export interface Phase {
  name: "build" | "between" | "judging" | "closed";
  jobsPerDay: number;
  jobsPerSpace: number;
  decodeJobsPerDay: number;
  /** Total ceiling for the build phase; daily slice afterwards. */
  budget: { kind: "total"; usd: number } | { kind: "daily"; usd: number } | { kind: "none" };
}

export function phaseOf(day: string): Phase {
  if (day <= "2026-10-30") return { name: "build", jobsPerDay: 20, jobsPerSpace: 3, decodeJobsPerDay: 20, budget: { kind: "total", usd: 10 } };
  if (day <= "2026-11-30") return { name: "between", jobsPerDay: 10, jobsPerSpace: 3, decodeJobsPerDay: 10, budget: { kind: "daily", usd: 0.1 } };
  if (day <= "2026-12-15") return { name: "judging", jobsPerDay: 40, jobsPerSpace: 5, decodeJobsPerDay: 20, budget: { kind: "daily", usd: 0.5 } };
  return { name: "closed", jobsPerDay: 0, jobsPerSpace: 0, decodeJobsPerDay: 0, budget: { kind: "none" } };
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface SpendDoc {
  version: 1;
  /** Settled spend by UTC day. */
  byDay: Record<string, number>;
  /** Open reservations: hearth job id -> { usd, day }. */
  reserved: Record<string, { usd: number; day: string; preset: string; created: string }>;
  /** Settled jobs (so a settle is applied once). */
  settled: Record<string, { usd: number; day: string; hours: number }>;
}

export function emptySpend(): SpendDoc {
  return { version: 1, byDay: {}, reserved: {}, settled: {} };
}

export function totalSpend(doc: SpendDoc): number {
  return Object.values(doc.byDay).reduce((a, b) => a + b, 0) + Object.values(doc.reserved).reduce((a, r) => a + r.usd, 0);
}

export function daySpend(doc: SpendDoc, day: string): number {
  return (doc.byDay[day] ?? 0) + Object.values(doc.reserved).filter((r) => r.day === day).reduce((a, r) => a + r.usd, 0);
}

export type BudgetCheck = { ok: true } | { ok: false; reason: "closed" | "budget_total" | "budget_day" | "ceiling" };

export function canSpend(doc: SpendDoc, usd: number, day: string): BudgetCheck {
  const phase = phaseOf(day);
  if (phase.budget.kind === "none") return { ok: false, reason: "closed" };
  if (totalSpend(doc) + usd > HEARTH_CEILING_USD) return { ok: false, reason: "ceiling" };
  if (phase.budget.kind === "total") {
    const buildSpend = Object.entries(doc.byDay).filter(([d]) => phaseOf(d).name === "build").reduce((a, [, v]) => a + v, 0)
      + Object.values(doc.reserved).filter((r) => phaseOf(r.day).name === "build").reduce((a, r) => a + r.usd, 0);
    return buildSpend + usd > phase.budget.usd ? { ok: false, reason: "budget_total" } : { ok: true };
  }
  return daySpend(doc, day) + usd > phase.budget.usd ? { ok: false, reason: "budget_day" } : { ok: true };
}

async function updateSpend(store: Store, mutate: (doc: SpendDoc) => SpendDoc | null): Promise<SpendDoc | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cur = await store.getJson<SpendDoc>(keys.spend());
    const next = mutate(cur ? structuredClone(cur.value) : emptySpend());
    if (!next) return null;
    const w = await store.putJson(keys.spend(), next, { condition: cur?.etag ? { ifMatch: cur.etag } : { ifNoneMatch: "*" } });
    if (w.ok) return next;
  }
  throw new Error("spend meter is busy; try again");
}

/** Reserve the worst case for a Job about to be created. Returns false (nothing reserved) when over budget. */
export async function reserve(store: Store, job: string, preset: string, now = new Date()): Promise<BudgetCheck> {
  const usd = (PRICE_PER_HOUR[preset] ?? PRICE_PER_HOUR["4vcpu-16gb"] ?? 0.132) * JOB_TIMEOUT_HOURS;
  const day = utcDay(now);
  let verdict: BudgetCheck = { ok: true };
  await updateSpend(store, (doc) => {
    if (doc.reserved[job] || doc.settled[job]) return null;
    verdict = canSpend(doc, usd, day);
    if (!verdict.ok) return null;
    doc.reserved[job] = { usd, day, preset, created: now.toISOString() };
    return doc;
  });
  return verdict;
}

/** Settle a Job from its real duration (created -> finished, which bounds the billed VM time). */
export async function settle(store: Store, job: string, hours: number): Promise<void> {
  await updateSpend(store, (doc) => {
    const r = doc.reserved[job];
    if (!r || doc.settled[job]) return null;
    const usd = Math.min(r.usd, Math.max(0, hours) * (PRICE_PER_HOUR[r.preset] ?? 0.132));
    delete doc.reserved[job];
    doc.settled[job] = { usd: Math.round(usd * 1e5) / 1e5, day: r.day, hours: Math.round(hours * 1e4) / 1e4 };
    doc.byDay[r.day] = Math.round(((doc.byDay[r.day] ?? 0) + usd) * 1e5) / 1e5;
    return doc;
  });
}

/** Release a reservation for a Job that was never created (QuotaExceeded on create, budget refusal...). */
export async function release(store: Store, job: string): Promise<void> {
  await updateSpend(store, (doc) => {
    if (!doc.reserved[job]) return null;
    delete doc.reserved[job];
    return doc;
  });
}

export interface DailyCounts {
  jobs: number;
  decodeJobs: number;
}

/** Increment a uid-free daily counter if it stays within the phase's limit. Returns false when the cap is reached. */
export async function takeDaily(store: Store, kind: keyof DailyCounts, now = new Date(), bypass = false): Promise<boolean> {
  const day = utcDay(now);
  const phase = phaseOf(day);
  const limit = kind === "jobs" ? phase.jobsPerDay : phase.decodeJobsPerDay;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cur = await store.getJson<DailyCounts>(keys.dailyCaps(day));
    const doc: DailyCounts = cur?.value ?? { jobs: 0, decodeJobs: 0 };
    if (!bypass && doc[kind] >= limit) return false;
    doc[kind] += 1;
    const w = await store.putJson(keys.dailyCaps(day), doc, { condition: cur?.etag ? { ifMatch: cur.etag } : { ifNoneMatch: "*" } });
    if (w.ok) return true;
  }
  return false;
}

export async function readDaily(store: Store, now = new Date()): Promise<DailyCounts & { limit: number; decodeLimit: number; day: string }> {
  const day = utcDay(now);
  const phase = phaseOf(day);
  const cur = await store.getJson<DailyCounts>(keys.dailyCaps(day));
  return { ...(cur?.value ?? { jobs: 0, decodeJobs: 0 }), limit: phase.jobsPerDay, decodeLimit: phase.decodeJobsPerDay, day };
}
