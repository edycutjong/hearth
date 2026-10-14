/**
 * The measured numbers every surface shows, read from the committed bench result (bench/results/latest.json,
 * written by scripts/d0_report.py / bench.py). Nothing is typed in by hand; no file means no number.
 */
import type { BenchSummary } from "@/components/JudgeSample";
import latest from "../../bench/results/latest.json";

interface Latest {
  run?: string;
  nebius_job_id?: string;
  bytes?: { bytes_per_audio_hour?: number };
  wer?: { fleurs20?: { wer_orig?: number | null; wer_rt?: number | null; clips?: number } };
  rtf?: { all?: { asr_s?: number; codec?: number } };
  usd_per_audio_hour?: number;
  cold_start?: { create_to_first_audio_s?: number | null };
}

export function benchSummary(): BenchSummary | null {
  const l = latest as Latest;
  if (!l.run || !l.bytes?.bytes_per_audio_hour || l.wer?.fleurs20?.wer_orig == null || l.wer.fleurs20.wer_rt == null) return null;
  return {
    bytesPerHour: l.bytes.bytes_per_audio_hour,
    werOrig: l.wer.fleurs20.wer_orig,
    werRt: l.wer.fleurs20.wer_rt,
    clips: l.wer.fleurs20.clips ?? 0,
    asrRtf: l.rtf?.all?.asr_s ?? 0,
    codecRtf: l.rtf?.all?.codec ?? 0,
    usdPerAudioHour: l.usd_per_audio_hour ?? 0,
    coldStart: l.cold_start?.create_to_first_audio_s ?? null,
    run: l.run,
    jobId: l.nebius_job_id ?? "",
  };
}
