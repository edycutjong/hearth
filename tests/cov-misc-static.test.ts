/* eslint-disable @typescript-eslint/no-non-null-assertion -- test fixtures: indexes are known to exist */
import { afterEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { MemoryStore } from "@/lib/store";
import { isDeleting } from "@/lib/fence";
import { keys } from "@/lib/keys";
import { injectedFiles, injectedBase64Total } from "@/lib/injected";
import { REQUIREMENTS_SOURCE, RUN_SOURCE, WORKER_SOURCE, WORKER_SHA256, RUN_SHA256 } from "@/lib/worker-source";
import * as copy from "@/lib/copy";
import * as og from "@/lib/og";
import { getSample, sampleDocs, memoryAllowsTf } from "@/lib/sample";
import { newSpace } from "@/lib/space";
import { UID } from "./helpers";

describe("fence", () => {
  it("is deleting exactly when the reap tombstone exists", async () => {
    const st = new MemoryStore();
    expect(await isDeleting(st, UID)).toBe(false);
    await st.put(keys.reap(UID), "x");
    expect(await isDeleting(st, UID)).toBe(true);
  });
});

describe("injected files", () => {
  it("ships run.sh plain and worker + requirements gzipped, within the 64 KiB budget", () => {
    const f = injectedFiles();
    expect(f[0]).toMatchObject({ containerPath: "/opt/hearth/run.sh", content: RUN_SOURCE });
    const unz = (c: string) => gunzipSync(Buffer.from(c, "base64")).toString("utf8");
    expect(unz(f[1]!.content)).toBe(WORKER_SOURCE);
    expect(unz(f[2]!.content)).toBe(REQUIREMENTS_SOURCE);
    expect(injectedBase64Total(f)).toBe(f[1]!.content.length + f[2]!.content.length + Buffer.from(RUN_SOURCE).toString("base64").length);
    expect(injectedBase64Total()).toBeLessThanOrEqual(65536);
  });
  it("embedded sources match their recorded hashes", () => {
    expect(createHash("sha256").update(WORKER_SOURCE).digest("hex")).toBe(WORKER_SHA256);
    expect(createHash("sha256").update(RUN_SOURCE).digest("hex")).toBe(RUN_SHA256);
  });
});

describe("copy and og", () => {
  it("retention wording follows the ZDR confirmation", () => {
    expect(copy.tfRetentionSentence(true)).toMatch(/Zero Data Retention/);
    expect(copy.tfRetentionSentence(false)).toMatch(/Speculative Decoding/);
    expect(copy.processorsParagraph(true).join(" ")).toMatch(/Zero Data Retention/);
    expect(copy.processorsParagraph(false).join(" ")).not.toMatch(/Zero Data Retention/);
    expect(copy.TF_OPTIN.body(true)).toMatch(/Zero Data Retention/);
    expect(copy.TF_OPTIN.body(false)).toMatch(/Speculative Decoding/);
  });
  it("og card is versioned", () => {
    expect(og.OG_IMAGE).toMatch(/\?v=[0-9a-f]{8}$/);
    expect(og.OG_TITLE && og.OG_DESC && og.OG_ALT).toBeTruthy();
  });
});

describe("sample", () => {
  it("derives search docs from every segment of every note", async () => {
    const s = getSample();
    const docs = await sampleDocs();
    expect(docs.length).toBe(s.notes.reduce((n, x) => n + x.transcript.segments.length, 0));
    expect(docs[0]).toMatchObject({ note: s.notes[0]!.id, segment: s.notes[0]!.transcript.segments[0]!.i });
    for (const d of docs) expect(Array.isArray(d.amounts)).toBe(true);
  });
  it("handles a sample without memory and ties amounts to segments", async () => {
    vi.resetModules();
    vi.doMock("../public/sample/sample.json", () => ({
      default: {
        memory: { items: [{ note: "n1", segments: [0], amount: 5000 }, { note: "n1", segments: [1], amount: null }, { note: "other", segments: [0], amount: 9 }] },
        notes: [{ id: "n1", label: "Maa", anchor: "2026-10-12", glosses: { "0": "g" }, transcript: { segments: [{ i: 0, t0: 0, t1: 1, text: "a" }, { i: 1, t0: 1, t1: 2, text: "b" }] } }],
      },
    }));
    const m = await import("@/lib/sample");
    expect((await m.sampleDocs()).map((d) => [d.gloss, d.amounts])).toEqual([["g", [5000]], [undefined, []]]);
    vi.doMock("../public/sample/sample.json", () => ({ default: { memory: null, notes: [{ id: "n", label: "", anchor: "", glosses: {}, transcript: { segments: [{ i: 0, t0: 0, t1: 1, text: "a" }] } }] } }));
    vi.resetModules();
    const m2 = await import("@/lib/sample");
    expect((await m2.sampleDocs())[0]!.amounts).toEqual([]);
  });
  it("memoryAllowsTf (not a sample): needs ZDR on or the space's own opt-in", () => {
    vi.stubEnv("TF_ZDR_ON", "false");
    expect(memoryAllowsTf(null)).toBe(false);
    expect(memoryAllowsTf(newSpace("UTC"))).toBe(false);
    expect(memoryAllowsTf({ ...newSpace("UTC"), tfOptIn: { at: "x", textVersion: "v1" } })).toBe(true);
    vi.stubEnv("TF_ZDR_ON", "true");
    expect(memoryAllowsTf(null)).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("bench", () => {
  afterEach(() => {
    vi.doUnmock("../bench/results/latest.json");
    vi.doUnmock("../bench/results/live-latest.json");
    vi.resetModules();
  });
  const load = async (latest: unknown, live: unknown) => {
    vi.resetModules();
    vi.doMock("../bench/results/latest.json", () => ({ default: latest }));
    vi.doMock("../bench/results/live-latest.json", () => ({ default: live }));
    return import("@/lib/bench");
  };
  it("liveWait needs p50, p95 and runs", async () => {
    expect((await load({}, { of: 5, time_to_kept_s: { p50: 10, p95: 20 }, source: "s" })).liveWait()).toEqual({ p50: 10, p95: 20, runs: 5, source: "s" });
    expect((await load({}, { of: 5, time_to_kept_s: { p50: 10, p95: 20 } })).liveWait()?.source).toBe("");
    for (const bad of [{}, { of: 5, time_to_kept_s: { p50: 10 } }, { of: 5, time_to_kept_s: { p50: null, p95: 2 } }, { time_to_kept_s: { p50: 1, p95: 2 } }]) {
      expect((await load({}, bad)).liveWait()).toBeNull();
    }
  });
  it("benchSummary: full, defaults, and each missing prerequisite", async () => {
    const full = { run: "r", nebius_job_id: "j", bytes: { bytes_per_audio_hour: 100 }, wer: { fleurs20: { wer_orig: 0.1, wer_rt: 0.2, clips: 20 } }, rtf: { all: { asr_s: 0.5, codec: 0.1 } }, usd_per_audio_hour: 0.3, cold_start: { create_to_first_audio_s: 40 } };
    expect((await load(full, {})).benchSummary()).toEqual({ bytesPerHour: 100, werOrig: 0.1, werRt: 0.2, clips: 20, asrRtf: 0.5, codecRtf: 0.1, usdPerAudioHour: 0.3, coldStart: 40, run: "r", jobId: "j" });
    const min = { run: "r", bytes: { bytes_per_audio_hour: 100 }, wer: { fleurs20: { wer_orig: 0, wer_rt: 0 } } };
    expect((await load(min, {})).benchSummary()).toMatchObject({ clips: 0, asrRtf: 0, codecRtf: 0, usdPerAudioHour: 0, coldStart: null, jobId: "" });
    for (const bad of [{ ...full, run: undefined }, { ...full, bytes: {} }, { ...full, wer: {} }, { ...full, wer: { fleurs20: { wer_orig: null, wer_rt: 1 } } }, { ...full, wer: { fleurs20: { wer_orig: 1, wer_rt: null } } }]) {
      expect((await load(bad, {})).benchSummary()).toBeNull();
    }
  });
});
