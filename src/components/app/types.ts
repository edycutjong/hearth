import type { MemoryDoc } from "@/lib/memory";
import type { JobRecord, NoteMeta } from "@/lib/pipeline";

export interface SpaceInfo {
  uid: string;
  kept: boolean;
  daysLeft: number | null;
  consent: { at: string; textVersion: string; deleteOriginals: boolean } | null;
  tfOptIn: boolean;
  judge?: boolean;
  timeZone?: string;
  feedUrl?: string;
}

export interface Status {
  space: SpaceInfo | null;
  notes: NoteMeta[];
  jobs: JobRecord[];
  queue: Record<string, number | null>;
  memory: MemoryDoc | null;
  caps: { jobs: number; limit: number; decodeJobs: number; decodeLimit: number; day: string; phase: string };
  flags: { zdrOn: boolean; zdrConfirmed: boolean; tf: boolean };
  errors: string[];
  prefixes: string[];
}

export async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}
