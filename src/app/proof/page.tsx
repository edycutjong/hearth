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
  versions?: Record<string, string | number | null>;
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

/** What actually ran — the sample's Job, the measured benchmark, and the visitor's own last run. */
export default function Proof() {
  const sample = getSample();
  const b = latest as Latest;
  return (
    <>
      <TopBar current="proof" />
      <main className="page stack">
        <h1>What actually ran.</h1>
        <p className="lead">Job IDs, presets, timings, bytes and hashes — read from the Jobs&apos; own reports and the bucket, never typed in.</p>
        <h3>Benchmark of record</h3>
        {b.run ? (
          <div className="stack">
            <table className="plain">
              <tbody>
                <tr><th>Run</th><td className="num">{b.run} · Nebius job {b.nebius_job_id} · cpu-d3 {b.preset}</td></tr>
                <tr><th>Stored size</th><td className="num">{b.bytes?.bytes_per_audio_hour ? `${kb(b.bytes.bytes_per_audio_hour)} per hour of voice · ${b.bytes.x_smaller_than_pcm_22k16}× smaller than 22.05 kHz PCM` : "—"}</td></tr>
                <tr><th>WER, FLEURS hi_in</th><td className="num">{b.wer?.fleurs20 ? `${pct(b.wer.fleurs20.wer_orig ?? 0)} original → ${pct(b.wer.fleurs20.wer_rt ?? 0)} after the codec round trip (${b.wer.fleurs20.clips} clips; strict normaliser ${pct(b.wer.fleurs20.wer_orig_strict ?? 0)} → ${pct(b.wer.fleurs20.wer_rt_strict ?? 0)})` : "—"}</td></tr>
                <tr><th>Real-time factor</th><td className="num">{b.rtf?.all ? `ASR ${b.rtf.all.asr_s?.toFixed(3)} · codec encode+decode ${b.rtf.all.codec?.toFixed(3)} · whole pipeline ${b.rtf.all.total?.toFixed(3)}` : "—"}</td></tr>
                <tr><th>Cost</th><td className="num">{b.usd_per_audio_hour !== undefined ? `$${b.usd_per_audio_hour.toFixed(4)} per hour of voice at the cpu-d3 list price` : "—"}</td></tr>
                <tr><th>Runtime</th><td className="num">{JSON.stringify(b.runtime ?? {})}</td></tr>
                <tr><th>Versions</th><td className="num">{Object.entries(b.versions ?? {}).filter(([k]) => !k.startsWith("freeze")).map(([k, v]) => `${k} ${v}`).join(" · ")}</td></tr>
                <tr><th>Codec on CPU</th><td className="num">{JSON.stringify(b.determinism ?? {})}</td></tr>
              </tbody>
            </table>
            <p className="note-hint">{b.honesty}</p>
          </div>
        ) : (
          <p className="muted">The benchmark has not been published yet.</p>
        )}
        <h3>The judge sample</h3>
        {sample.notes.length ? (
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
                  <td className="num">{n.kept.sha256.slice(0, 16)}…</td>
                  <td className="num">{pct(1 - n.kept.driftNote)}</td>
                  <td className="num">{n.raw.rawHead ? `HEAD ${n.raw.rawHead} at ${n.raw.checkedAt}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Being produced by a real Nebius Job.</p>
        )}
        <h3>Your last run</h3>
        <VisitorProof />
      </main>
    </>
  );
}
