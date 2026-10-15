import { TopBar } from "@/components/Brand";
import { VisitorProof } from "@/components/VisitorProof";
import { kb, mmss, pct } from "@/components/format";
import latest from "../../../bench/results/latest.json";
import { getSample } from "@/lib/sample";

export const metadata = { title: "Hearth — proof" };
export const dynamic = "force-dynamic";

interface Latest {
  run?: string;
  preset?: string;
  nebius_job_id?: string;
  versions?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  cold_start?: Record<string, unknown>;
  determinism?: Record<string, unknown>;
  bytes?: Record<string, number | null>;
  wer?: Record<string, Record<string, number | null> | null>;
  rtf?: { all?: Record<string, number> };
  usd_per_audio_hour?: number;
  gates?: Record<string, { value: number | null; max: number; pass: boolean }>;
  honesty?: string;
}

function runtimeText(rt: Record<string, unknown> | undefined): string {
  if (!rt) return "—";
  const ctx = Array.isArray(rt.att_context_size) ? `[${(rt.att_context_size as number[]).join(", ")}]` : "?";
  const weights = rt.weights_source === "bucket" ? "the in-region bucket" : String(rt.weights_source ?? "?");
  return [
    `${String(rt.asr_class ?? "?")} on NeMo`,
    `att_context_size ${ctx} = ${String(rt.chunk_s ?? "?")} s chunks`,
    `ASR input ${String(rt.asr_sample_rate ?? "?")} Hz`,
    `codec ${String(rt.codec_sample_rate ?? "?")} Hz, ${String(rt.codec_samples_per_frame ?? "?")} samples per frame`,
    `${String(rt.torch_threads ?? "?")} torch threads`,
    `weights from ${weights}`,
  ].join(" · ");
}

function coldText(c: Record<string, unknown> | undefined): string {
  const n = (v: unknown) => (typeof v === "number" ? `${Math.round(v)} s` : "—");
  if (!c) return "—";
  return [
    `job created → container running ${n(c.create_to_container_s)}`,
    `install ${n(c.install_s)}`,
    `both models loaded ${n(c.load_s)}`,
    `first note processed ${n(c.create_to_first_audio_s)} after create`,
  ].join(" · ");
}

function determinismText(d: Record<string, unknown> | undefined): string {
  if (!d) return "—";
  const yes = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "—");
  return [
    `encoding the same input twice gives identical codes: ${yes(d.encode_twice_equal)}`,
    `the stored .hct equals a fresh encode: ${yes(d.hct_roundtrip_equals_fresh_encode)}`,
    `decoding twice, largest sample difference: ${String(d.decode_twice_max_abs_diff ?? "—")}`,
  ].join(" · ");
}

/** What actually ran — the sample's Job, the measured benchmark, and the visitor's own last run. */
export default function Proof() {
  const sample = getSample();
  const b = latest as unknown as Latest;
  return (
    <>
      <TopBar current="proof" />
      <main className="page stack">
        <h1>What actually ran.</h1>
        <p className="lead">Job IDs, presets, timings, bytes and hashes — read from the Jobs&apos; own reports and the bucket, never typed in.</p>
        <h2 className="label">Benchmark of record</h2>
        {b.run ? (
          <div className="stack">
            <table className="plain kv">
              <tbody>
                <tr><th>Run</th><td className="num">{b.run} · Nebius job {b.nebius_job_id} · cpu-d3 {b.preset}</td></tr>
                <tr><th>Stored size</th><td className="num">{b.bytes?.bytes_per_audio_hour ? `${kb(b.bytes.bytes_per_audio_hour)} per hour of voice · ${b.bytes.x_smaller_than_pcm_22k16}× smaller than 22.05 kHz PCM` : "—"}</td></tr>
                <tr><th>WER, FLEURS hi_in</th><td className="num">{b.wer?.fleurs20 ? `${pct(b.wer.fleurs20.wer_orig ?? 0)} original → ${pct(b.wer.fleurs20.wer_rt ?? 0)} after the codec round trip (${b.wer.fleurs20.clips} clips; strict normaliser ${pct(b.wer.fleurs20.wer_orig_strict ?? 0)} → ${pct(b.wer.fleurs20.wer_rt_strict ?? 0)})` : "—"}</td></tr>
                <tr><th>Real-time factor</th><td className="num">{b.rtf?.all ? `ASR ${b.rtf.all.asr_s?.toFixed(3)} · codec encode+decode ${b.rtf.all.codec?.toFixed(3)} · whole pipeline ${b.rtf.all.total?.toFixed(3)}` : "—"}</td></tr>
                <tr><th>Cold start</th><td className="num">{coldText(b.cold_start)}</td></tr>
                <tr><th>Cost</th><td className="num">{b.usd_per_audio_hour !== undefined ? `$${b.usd_per_audio_hour.toFixed(3)} per hour of voice at the cpu-d3 list price` : "—"}</td></tr>
                <tr><th>Runtime</th><td className="num">{runtimeText(b.runtime)}</td></tr>
                <tr><th>Versions</th><td className="num">{Object.entries(b.versions ?? {}).filter(([k]) => !k.startsWith("freeze")).map(([k, v]) => `${k} ${v}`).join(" · ")}</td></tr>
                <tr><th>Codec on CPU</th><td className="num">{determinismText(b.determinism)}</td></tr>
              </tbody>
            </table>
            <p className="note-hint">{b.honesty}</p>
          </div>
        ) : (
          <p className="muted">The benchmark has not been published yet.</p>
        )}
        <h2 className="label">The judge sample</h2>
        {sample.notes.length ? (
          <div className="tablewrap">
          <table className="plain">
            <thead>
              <tr><th>Note</th><th>Nebius job</th><th>Audio</th><th>Tokens</th><th>sha256</th><th>Agreement</th><th>Pipeline raw copy</th></tr>
            </thead>
            <tbody>
              {sample.notes.map((n) => (
                <tr key={n.id}>
                  <td>{n.title}</td>
                  <td className="num">{n.job.nebiusId}</td>
                  <td className="num">{mmss(n.kept.audioS)}</td>
                  <td className="num">{kb(n.kept.bytesHct)}</td>
                  <td className="num">{n.kept.sha256.slice(0, 12)}…</td>
                  <td className="num">{pct(1 - n.kept.driftNote)}</td>
                  <td className="num">
                    {n.raw.rawHead ? (
                      <>
                        raw HEAD {n.raw.rawHead}
                        {n.raw.originalHead ? ` · originals HEAD ${n.raw.originalHead}` : ""}
                        <br />
                        <span className="data-hint">{n.raw.checkedAt}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <p className="muted">Being produced by a real Nebius Job.</p>
        )}
        {sample.memory?.calls.length ? (
          <p className="note-hint">
            Memory for the sample: {sample.memory.calls[0]?.model} on Nebius Token Factory proposed {sample.memory.stats.proposed} item(s), kept{" "}
            {sample.memory.stats.kept}. Requests:{" "}
            {sample.memory.calls.map((c) => `${c.requestId ?? "—"} (${(c.ms / 1000).toFixed(1)} s${c.error ? `, ${c.error}` : ""})`).join(" · ")}.
          </p>
        ) : null}
        <h2 className="label">Your last run</h2>
        <VisitorProof />
        {process.env.VERCEL_GIT_COMMIT_SHA ? (
          <p className="note-hint">
            Served by commit{" "}
            <a className="num" href={`https://github.com/edycutjong/hearth/commit/${process.env.VERCEL_GIT_COMMIT_SHA}`}>
              {process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)}
            </a>
            .
          </p>
        ) : null}
      </main>
    </>
  );
}
