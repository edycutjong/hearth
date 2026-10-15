# Sources for the facts we did not measure

Everything Hearth reports as *measured* comes from `bench/results/` and `evidence/`. These are the outside facts the README,
the story page and the deck rely on, with where they come from and when they were read.

| Fact | Source | Read |
|---|---|---|
| `cpu-d3` list price: $0.015 per vCPU-hour and $0.0045 per GiB-hour (so $0.132 an hour for `4vcpu-16gb`; the same page lists $0.012 / $0.0032 *before* 2026-10-01) | <https://docs.nebius.com/compute/resources/pricing>, "Non-GPU AMD Epyc Genoa" (`cpu-d3` is that platform: <https://docs.nebius.com/compute/virtual-machines/types>) | 2026-10-15 |
| The ASR model: 600 M parameters, `hi-IN` among its transcription locales, the 1.12 s chunk setting, no statement of CPU support (its card says it is optimised for NVIDIA GPU systems) | <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b> | 2026-10-14 |
| The codec model: 22,050 Hz mono, 13 codebooks, 12.5 frames per second, 1.78 kbps nominal; no Hindi result and no statement of CPU support on its card | <https://huggingface.co/nvidia/nemo-nano-codec-22khz-1.78kbps-12.5fps> | 2026-10-14 |
| Nemotron 3 Super's card lists English, French, German, Italian, Japanese, Spanish and Chinese; Hindi is not among them (why the quote gate and field gate exist) | <https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16> | 2026-10-14 |
| Token Factory may keep prompts and outputs for Speculative Decoding (stored in Finland), never uses them for training, and offers Zero Data Retention as an organisation-level setting | <https://docs.tokenfactory.nebius.com/legal/legal-quick-guide>, sections 3.3 and 4 | 2026-10-14 |
| Jobs: injected files are limited to 64 KiB (we measured that the limit applies to all of them together: `evidence/injected-files-limit.json`) | <https://docs.nebius.com/serverless/jobs/manage> | 2026-10-14 |
| Object Storage price per GiB-month (storage cost is not part of the per-hour figure) | <https://docs.nebius.com/object-storage/resources/pricing> | 2026-10-14 |
| FLEURS `hi_in` is CC BY 4.0 (dataset card revision `70bb2e84`) | <https://huggingface.co/datasets/google/fleurs> | 2026-10-15 |

## What the bucket itself reports

`evidence/bucket-lifecycle.json` is the bucket's own answer (`scripts/lifecycle_check.py`, read-only, 2026-10-15): three enabled
expiry rules — `raw/` after 7 days, `cache/` after 1 day, and any object tagged `space=anon` after 7 days — and a CORS rule for the app.
Versioning is off (`evidence/storage-preflight.json`), so a delete is final and `HEAD … 404` means the bytes are gone.
