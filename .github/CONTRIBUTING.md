# Contributing

Thanks for your interest in Hearth.

## Getting started

```bash
make install                    # npm ci + a .venv with the Python dev dependencies
cp .env.example .env.local      # optional: the app runs without any of it
npm run dev
```

`/judge` and `/proof` work with **no credentials**: they render the recorded benchmark and the sample kept
by the real pipeline. Only keeping a *new* note needs Nebius credentials (it dispatches a real Serverless AI Job).
The whole test suite runs with none.

## Before opening a PR

```bash
make ci          # eslint, tsc, vitest (coverage), npm audit (production), ruff, pytest
make e2e         # production build + Playwright, desktop and 375 px phone
```

- Add or update tests for any behaviour change. Name a regression test after the defect it pins.
- Commit messages follow Angular convention: `feat:`, `fix:`, `perf:`, `docs:`, `chore:`, `test:`,
  `refactor:`, `ci:`. They drive the automatic version tag (`release.yml`).
- `worker/worker.py` is embedded into the app (`npm run embed-worker`) and `tests/worker-source.test.ts`
  fails if the two drift apart. Changing the worker changes the measured pipeline: re-run the benchmark.

## The one rule that matters most here

**Never put an unmeasured number on a judged surface.** No byte count, WER, latency or cost enters the README,
the UI, `DEMO.md` or the submission until it has come out of a real run recorded in `bench/results/` or
`evidence/`. Where a number is not measured it is absent or labelled "estimate". Please keep it that way.

## Privacy rule

Never commit audio, transcripts or names of real people. The only audio in the repo is the FLEURS sample under
`public/sample/` (CC BY 4.0, attributed on the page).

## Reporting bugs and requesting features

Use the issue templates.
