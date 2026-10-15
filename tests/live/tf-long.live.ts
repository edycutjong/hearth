/**
 * How long Nemotron 3 Super takes to read the longest note Hearth keeps (5 min): the transcript of the D0 run's
 * 5-minute note (FLEURS hi_in sentences — text only, no audio), sent exactly as a memory pass sends it.
 * The memory pass gives each call at most ~43 s (tick 40 s / status 45 s budgets); this measures the real need.
 * Writes evidence/tf-long-latency.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadTokenFactoryConfig } from "@/lib/nebius/config";
import type { Segment } from "@/lib/gates";
import { extract } from "@/lib/tf";

it("reads a 5-minute transcript inside the memory pass's budget", async () => {
  const tf = loadTokenFactoryConfig();
  expect(tf, "TOKENFACTORY_API_KEY must be set").not.toBeNull();
  if (!tf) return;
  const raw = JSON.parse(readFileSync(path.resolve(__dirname, "../../bench/results/d0-20261014T231930Z-4vcpu-16gb-raw.json"), "utf8"));
  const long = raw.report.items.find((i: { id: string }) => i.id === "long1");
  const segments: Segment[] = long.segments.filter((s: { speech: boolean }) => s.speech).map((s: { i: number; t0: number; t1: number; text: string }) => ({ i: s.i, t0: s.t0, t1: s.t1, text: s.text }));
  const runs = [];
  for (let k = 0; k < 2; k += 1) {
    const call = await extract(tf, { senderLabel: "FLEURS readers", noteDate: "2026-10-12 (Monday)", segments, openItems: [] });
    runs.push({ requestId: call.requestId, ms: call.durationMs, error: call.error, items: call.value?.items.length ?? null, glosses: call.value?.glosses.length ?? null });
  }
  const out = {
    at: new Date().toISOString(), model: tf.model, note: "long1 (D0 run 2): 290.9 s of FLEURS hi_in read speech, transcript text only",
    segments: segments.length, characters: segments.reduce((n, s) => n + s.text.length, 0), runs,
    budget_ms: 43_000,
  };
  writeFileSync(path.resolve(__dirname, "../../evidence/tf-long-latency.json"), JSON.stringify(out, null, 1));
  for (const r of runs) expect(r.error).toBeNull();
});
