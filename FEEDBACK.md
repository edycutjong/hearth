# Feedback for Nebius and NVIDIA — from building Hearth

Hearth runs two NVIDIA open speech models (`nemotron-3.5-asr-streaming-0.6b` and
`nemo-nano-codec-22khz-1.78kbps-12.5fps`) on **Nebius Serverless AI Jobs, CPU only**, and calls
`nvidia/nemotron-3-super-120b-a12b` on **Token Factory**. Everything below was measured while building it, with the
job ID or file that shows it. Where we did something wrong first, we say so.

## 1. NeMo speech models on a CPU Serverless Job — what a cold start costs

Measured on `cpu-d3` / `4vcpu-16gb` in eu-west1 with the stock `python:3.11` image, worker injected (five harness
Jobs, `bench/results/d0-*-raw.json`; the benchmark of record is `aijob-e01y33r8hyfcn7np5v`):

| Phase | Time | Where it shows |
|---|---|---|
| create → container running (PROVISIONING → STARTING → IMAGE_PULLING → RUNNING) | 158–169 s | `create_to_container_s` in each report |
| `uv pip install` of NeMo 3.0.0 `[asr]` + torch 2.13.0+cpu + deps | 15–21 s | `install_s` |
| both model files (≈ 2.8 GB): from Hugging Face · from an in-region bucket | 153–154 s · 70 s | `load.download_s` |
| `import nemo.collections.asr` | 13–24 s | `load.asr_import_s` |
| ASR `restore_from`: the `.nemo` (unpacking 2.37 GB takes 28–33 s of it) · a pre-extracted folder | 46–51 s · 20 s | `load.asr_restore_s` |
| NanoCodec `restore_from`: as published · without its training-only parts (§2) | 45–50 s · 26 s | `load.codec_restore_s` |

A keep through the deployed app therefore spends most of its time before the first audio sample: on a 60-second
note, about 160 s of start-up, 17 s of install and 150 s of model loading against about 60 s of work (`/proof`
shows the split for each run). **Ask:** the time from `POST /ai/v1/jobs` to a running container is the largest
single cost for short batch work. A documented way to keep model weights near the VM (a regional model cache, or a
volume type that does not need a bucket mount with credentials) would remove most of the rest.

## 2. NanoCodec's checkpoint downloads two training-only models at load

`AudioCodecModel.restore_from` on `nemo-nano-codec-22khz-1.78kbps-12.5fps` builds the training discriminators —
including an `SLMDiscriminator` that downloads `microsoft/wavlm-base-plus` — and, because the config has
`use_scl_loss: true`, a speaker encoder downloaded from Hugging Face. Neither is used to encode or decode. Restoring
with `discriminator: null` and `use_scl_loss: false` (`worker/worker.py`, `load_codec_trimmed`) takes **26 s instead
of 45–50 s** in a fresh process (D0 run 2 against runs 1 and the smokes), and about 1 s once the full model has
been loaded in the same process. On the same VM the codes and the decoded audio are **bit-identical** to the full
load (`load_options.codec_trimmed_codes_equal: true`, `codec_trimmed_decode_max_abs_diff: 0.0`,
`bench/results/d0-20261014T222337Z-4vcpu-16gb.json`). **Ask:** an inference-only config in the model repo, or a line
on the card.

## 3. The prompt-conditioned ASR rejects file paths in `transcribe()`

With NeMo 3.0.0, `EncDecRNNTBPEModelWithPrompt.transcribe(paths, target_lang="hi-IN")` fails with
`Unknown prompt key: 'None'`: the file-path route builds Lhotse cuts whose supervision carries no language, so
`target_lang` never reaches them (first smoke job, `aijob-e01fyczjpp8acq1pp2`). Passing **numpy arrays** works,
because the tensor route uses `trcfg.target_lang`. **Ask:** fill the cut language from `target_lang`, or document
the array route on the card.

## 4. Runtime versions across the two speech cards

The ASR card names runtime "NeMo 26.06" and says to install NeMo from git `main`; the codec card names "NeMo 2.0.0".
The PyPI release `nemo_toolkit==3.0.0` (2026-08-07) loads **both** in one environment with torch 2.13.0+cpu, so no
git install and no second virtualenv was needed. A line saying which PyPI release first supports each model would
have saved a day of reading. The `[tts]` extra pulls `pyopenjtalk`, which has no wheel and compiles at every cold
start; Hearth installs the pure-Python half of `[tts]` instead (`worker/requirements.txt`).

## 5. The 64 KiB injected-file limit is a limit on ALL injected files together

Both `serverless/jobs/manage.md` (lines 160 and 306) and the endpoints page say each injected file is "limited to
64 KiB". In practice the Jobs API encrypts all injected files together, and their **base64 total** may not pass
64 KiB: three files of 44.9 KB, 3.5 KB and 1 KB (65,804 B of base64 together, each far under 64 KiB) were refused
with `InvalidArgument: plaintext must not exceed 65536 bytes` from `kms-dpl`, while the same files had been accepted
at 57,584 B (`evidence/injected-files-limit.json`, request `966dd6c8-bd5b-4324-b3a2-1f7bc180448c`). Hearth now
injects `worker.py` and its pinned `requirements.txt` gzipped (21 KB of base64 in all) and `run.sh` unpacks them;
the app and the harness both check the total before calling the API (`src/lib/injected.ts`,
`scripts/nebius_jobs.py`). **Ask:** state the total limit in the docs, and name it in the error.

With that understood, a stock image + injected files + a fast installer is a workable alternative to building and
pushing a custom image — which matters when the builder has no Docker daemon or CI minutes to spare.

## 6. Jobs expose no logs or exit code over REST

A job's state says only whether the container ran. Hearth's worker therefore reports for itself: it PUTs a status
document and its result to presigned URLs (it holds no credential), and a failed dependency install is still
reported because the worker imports only the standard library at the top. **Ask:** a REST endpoint for a job's
last log lines.

## 7. Quota under concurrent load

`compute.instance.count` is 2 per region on this tenant, shared by every app in the project; a third job is
**created and then ends with `QuotaExceeded`** rather than being refused at create. Hearth counts the region's live
jobs before each create and treats `QuotaExceeded` (and HTTP 429) as a requeue with backoff, never a failure
(`src/lib/pipeline.ts`, tests in `tests/pipeline.test.ts`). **Ask:** refuse at create with a clear status, so a
client does not pay a provisioning attempt to learn the region is full.

## 8. Nemotron 3 Super with `json_schema`, on Hindi

`response_format: {type: "json_schema"}` with `strict: true` works on `nvidia/nemotron-3-super-120b-a12b`
(`evidence/tf-extract-smoke.json`, request `chatcmpl-86b6920b56793fdf`, 5.8 s). Two observations:

- With a free-text `qualifier` field, Super wrote the Hindi marker («से पहले») instead of the English value; making
  the field an enum fixed it. Enums for every closed vocabulary are worth stating in the docs' examples.
- Super's card does not list Hindi. Hearth never displays what it proposes without a code check: the quote must be
  verbatim in the transcript, and amounts and dates are re-derived by code from the quote.

## 9. NanoCodec on quiet recordings

In the first benchmark run (`aijob-e01ww8sspej92ztqys`), the two FLEURS hi_in clips whose loudest frames sit near
−46 and −47 dBFS (95th percentile of 25 ms frame level) came back from the codec much harder for the ASR: word error
rate after the round trip 8.3 % → 62.5 % and 38.9 % → 72.2 %, while normal-level clips round-tripped cleanly. Hearth
now brings every input to −20 dBFS of speech-active level before encoding (the gain is stored with the codes and
removed on decode; chosen on FLEURS dev clips, not the reported ones). In the benchmark of record the first clip
round-trips unchanged (8.3 % → 8.3 %) and the second improves (→ 55.6 %), and across 20 clips the round trip adds
4.1 points instead of 5.9 — though one normal-level clip got worse (30.4 % → 47.8 %), so this is a better average,
not a fix for every recording. **Ask:** a note on the card about the input level the codec expects.
