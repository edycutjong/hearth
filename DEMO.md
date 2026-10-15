# Hearth — demo and reproduce

Every path below runs the shipped system. The first two need nothing from you: no account, no credentials, no
install. The last one spends cents on your own Nebius project.

## 1. In a browser, no account (two minutes)

1. Open **https://hearth-alpha-six.vercel.app/judge**.
   - One note kept by Hearth's real pipeline. Until the consented, actor-voiced family sample is recorded, it is
     **FLEURS read speech** (Google FLEURS `hi_in` test split, CC BY 4.0), and the page says so.
   - **▶ Original** plays the recording. **▶ Kept** plays NanoCodec's reconstruction of it, decoded from the codec
     tokens drawn under the player (13 rows = 13 codebooks, 12.5 columns per second of voice). That strip, packed at
     11 bits per code, is all Hearth stores.
   - Beside them: the Hindi transcript, and how many of its words the ASR still reads the same after the round trip.
   - **Find** jumps to the segment that holds a word you search for, in Hindi or English.
2. Open **/proof**: the Nebius Job IDs that produced the sample and the benchmark, preset, region, timings, the
   sha256 of the stored tokens, and the `HEAD … 404` that proves the pipeline's copy of the raw audio is gone.
3. Your own note: **Open an empty space** on `/judge`, tick the agreement, upload up to 60 seconds. A real Nebius
   Job keeps it: on this deployment that took <!--n:ttk_p50_min-->7.6<!--/n--> min at the median from upload to
   kept (<!--n:ttk_p95_min-->7.8<!--/n--> min at p95, <!--n:live_runs-->3<!--/n--> runs), cold start included —
   most of it is the Job starting and loading two models on CPU (`/proof` shows the split for your run).
   Reminders are Hindi-only; any transcription-ready language except Japanese and Korean is kept and searchable.

## 2. From a fresh clone, no cloud account

```bash
git clone https://github.com/edycutjong/hearth && cd hearth
npm ci
npm test                                   # vitest: 148 tests
python3 -m venv .venv && .venv/bin/pip install numpy jiwer pytest
.venv/bin/python -m pytest -q worker scripts   # 22 tests
```

What the tests pin down: the quote gate and field gate (amounts from a full 0–99 Hindi number table, weekdays and
their qualifiers), the date resolver, the queue (one Job at a time, requeue on a full region, never a failure), the
drift gate, verified deletion (raw and originals both `HEAD 404`), the spend meter and caps, the `.hct` format
(11-bit packing, header, sha256), SigV4 presigning against AWS's published vectors, the calendar feed, the chat-export
parser (only audio, timestamps and a label leave the browser), and that the worker the app injects is byte-for-byte
the worker in `worker/`.

**Recompute the benchmark from the Jobs' own reports** (committed, no cloud needed):

```bash
.venv/bin/python scripts/d0_report.py bench/results/d0-20261014T231930Z-4vcpu-16gb-raw.json
```

Expected (D0 run 2, Nebius job <!--n:d0_job-->aijob-e01y33r8hyfcn7np5v<!--/n-->, cpu-d3 <!--n:preset-->4vcpu-16gb<!--/n-->):

| Gate | Measured | Limit |
|---|---|---|
| ASR real-time factor | <!--n:asr_rtf-->0.16<!--/n--> | ≤ 0.5 |
| WER, original (FLEURS hi_in, <!--n:clips-->20<!--/n--> clips) | <!--n:wer_orig-->8.74<!--/n--> % | ≤ 15 % |
| WER after the codec round trip | <!--n:wer_rt-->12.83<!--/n--> % (<!--n:wer_delta-->+4.09<!--/n--> pts) | ≤ original + 5 pts |
| Peak memory | <!--n:peak_rss_gb-->6.9<!--/n--> GB | ≤ 12 GB |
| Cost per hour of voice | $<!--n:usd_per_audio_hour-->0.135<!--/n--> | ≤ $0.60 |

Stored size: <!--n:bytes_per_hour-->815,423<!--/n--> bytes per hour of voice, <!--n:x_smaller_pcm-->195<!--/n-->× smaller
than 22.05 kHz 16-bit PCM. On the disjoint `fleurs20b` set, never used for any decision: <!--n:wer_orig_b-->12.42<!--/n--> % →
<!--n:wer_rt_b-->14.46<!--/n--> %. The earlier run that **failed** the round-trip gate (+5.94 pts, before the codec input was
normalised) is committed beside it: `bench/results/d0-20261014T222337Z-4vcpu-16gb.json`.

**Play a kept note without Hearth** — the stored `.hct` decodes with the open model alone:

```bash
python3 -m venv venv && . venv/bin/activate
pip install "nemo_toolkit[asr]==3.0.0" soundfile einops
python3 export/decode.py public/sample/*.hct        # writes a .wav next to each .hct
```

## 3. On your own Nebius project (cents)

Needs a service-account key and an S3 key for a bucket in `eu-west1` (see `scripts/d0.py` for the variable names),
and an authenticated `nebius` CLI for the harness.

```bash
.venv/bin/python scripts/d0.py --preset 4vcpu-16gb --trimmed --bucket-weights --no-model-copy   # the D0 harness: one Job
.venv/bin/python scripts/bench.py --corpus fleurs20 --from bench/results/d0-<run>-raw.json     # its numbers
.venv/bin/python scripts/bench.py --calibrate                                                   # the drift gate on fleurs20b
.venv/bin/python scripts/bench.py --live 3 --base https://<your deployment>                     # upload -> kept, as a browser does
```

## What these numbers are, and are not

- **FLEURS is read speech** recorded for ASR research, and it is in the ASR's training mix (model card), so the WER here
  is in-domain. Phone voice notes are harder: the 60-second Opus note used for the live runs drifts
  14.7 % in the round trip, so the drift gate (≤ 5 % of words) **keeps its original** instead of deleting it. That is
  the gate doing its job, and the app says so on the note.
- **The gates prove a quote is in the transcript**, not that the ASR heard it right. Every reminder is marked "as
  transcribed" and plays its source segment.
- **Token Factory** receives transcript text only, never audio. It may keep prompts and outputs for Speculative
  Decoding (stored in Finland, never used for training); a space sends text to it only after its owner opts in.
- **No offline claim.** Keeping a note needs Nebius; playing your export does not.
