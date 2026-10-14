/**
 * The judge sample: committed with the app (public/sample/sample.json), so /judge, its A/B, search over it and
 * /proof work with no credentials, no Job and no cap. It is produced by a REAL Nebius Job (scripts/seed.py) and
 * labelled for what it is: FLEURS read speech until the consented actor-voiced sample has been recorded.
 */

import sample from "../../public/sample/sample.json";
import type { MemoryDoc, TranscriptDoc } from "./memory";
import type { SearchDoc } from "./search";
import { tfAllowed } from "./memory";
import type { SpaceDoc } from "./space";

export interface SampleNote {
  id: string;
  label: string;
  anchor: string;
  title: string;
  source: string;
  attribution?: string;
  audio: { original: string; kept: string };
  hct: string;
  transcript: TranscriptDoc;
  glosses: Record<string, string>;
  kept: {
    bytesHct: number;
    sha256: string;
    frames: number;
    audioS: number;
    inputBytes: number;
    driftNote: number;
    driftPass: boolean;
    langDetected: string | null;
    timings: Record<string, number>;
  };
  job: { nebiusId: string; preset: string; region: string; created: string; finished: string; image: string };
  raw: { rawHead: number | null; checkedAt: string | null };
  tokenPreview?: number[][];
}

export interface SampleDoc {
  version: 1;
  status: "pending" | "ready";
  kind: "fleurs" | "actors";
  notes: SampleNote[];
  memory: MemoryDoc | null;
  ab: { note: string; t0: number; t1: number; bytes: number; drift: number; reason: string } | null;
  proof: Record<string, unknown> | null;
}

export function getSample(): SampleDoc {
  return sample as unknown as SampleDoc;
}

export async function sampleDocs(): Promise<SearchDoc[]> {
  const s = getSample();
  const docs: SearchDoc[] = [];
  for (const n of s.notes) {
    for (const seg of n.transcript.segments) {
      docs.push({
        note: n.id, segment: seg.i, t0: seg.t0, t1: seg.t1, text: seg.text, gloss: n.glosses[String(seg.i)], label: n.label, anchor: n.anchor,
        amounts: (s.memory?.items ?? []).filter((i) => i.note === n.id && i.segments.includes(seg.i) && i.amount !== null).map((i) => i.amount as number),
      });
    }
  }
  return docs;
}

export function memoryAllowsTf(space: SpaceDoc | null): boolean {
  return tfAllowed(space, false);
}
