# Feedback for Nebius and NVIDIA — from building Hearth

Hearth runs two NVIDIA open speech models (`nemotron-3.5-asr-streaming-0.6b` and
`nemo-nano-codec-22khz-1.78kbps-12.5fps`) on **Nebius Serverless AI Jobs, CPU only**, and calls
`nvidia/nemotron-3-super-120b-a12b` on **Token Factory**. Everything below was measured while building it, with the
job ID or file that shows it. Where we did something wrong first, we say so.

## 1. NeMo speech models on a CPU Serverless Job — what a cold start costs

Measured on `cpu-d3` / `4vcpu-16gb` in eu-west1 with the stock `python:3.11` image, worker injected:

| Phase | Time | Where it shows |
|---|---|---|
| create → container running (PROVISIONING → STARTING → IMAGE_PULLING → RUNNING) | 158–169 s | `bench/results/d0-*-smoke-raw.json` (`create_to_container_s`) |
| `uv pip install` of NeMo 3.0.0 `[asr]` + torch 2.13.0+cpu + deps | 18–21 s | same files (`install_s`) |
| both models from Hugging Face (≈ 2.8 GB) | 153–154 s | `load.download_s` |
| `import nemo.collections.asr` | 13–14 s | `load.asr_import_s` |
| ASR `restore_from` (of which unpacking the 2.37 GB `.nemo`: 28 s) | 46–51 s | `load.asr_restore_s`, `load_options.asr_nemo_unpack_s` |
| NanoCodec `restore_from` | 45–50 s → **1.07 s** (see §2) | `load.codec_restore_s`, `load_options.codec_trimmed_restore_s` |

**Ask:** the time from `POST /ai/v1/jobs` to a running container is the largest single cost for short batch work
(a 60-second voice note). A documented way to keep model weights near the VM (a regional model cache, or a volume
type that does not need a bucket mount with credentials) would remove most of the rest.

## 2. NanoCodec's checkpoint downloads two training-only models at load

`AudioCodecModel.restore_from` on `nemo-nano-codec-22khz-1.78kbps-12.5fps` builds the training discriminators —
including an `SLMDiscriminator` that downloads `microsoft/wavlm-base-plus` — and, because the config has
`use_scl_loss: true`, a speaker encoder downloaded from Hugging Face. Neither is used to encode or decode. Restoring
with `discriminator: null` and `use_scl_loss: false` (`worker/worker.py`, `load_codec_trimmed`) loads in **1.07 s
instead of ~47 s**, and we checked on the same VM that the codes and the decoded audio are **bit-identical** to the
full load (`load_options.codec_trimmed_codes_equal: true`, `codec_trimmed_decode_max_abs_diff: 0.0`).
**Ask:** an inference-only config in the model repo, or a line on the card.

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

In the first benchmark run (`aijob-e01ww8sspej92ztqys`), two FLEURS hi_in recordings whose speech peaks near
−46 dBFS came back from the codec nearly unintelligible to the ASR (one lost its whole first sentence), while
normal-level clips round-tripped cleanly. Raising quiet input before encoding (the gain is stored with the codes and
removed on decode) fixed the worst case. **Ask:** a note on the card about the input level the codec expects.
