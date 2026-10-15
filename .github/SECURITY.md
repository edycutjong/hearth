# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| latest (`main`) | ✅ |

## Reporting a vulnerability

Please **do not** open a public issue. Report privately:

- Email **edy.cu@live.com**, or
- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability).

You will get an acknowledgment within 48 hours and a timeline after triage.

## Known advisories

`npm audit --omit=dev --audit-level=high` reports **none** (checked 2026-10-15 on `next@15.5.27`).
`npm audit` without `--omit=dev` reports one high advisory in development-only tooling (`braces`, reached through
`eslint-config-next`) whose only offered fix is a breaking change (`npm audit fix --force` would install
`eslint-config-next@14.2.35`, a different major version). None of that code ships in the deployed app.

This project must stay live and working for judges through **2026-12-15**. A major framework bump applied
unattended to a submitted project is a realistic way to take the demo down, so the audit step in CI is
**advisory rather than blocking**, and its reason is written here instead of hidden behind a green check.
Dependabot ignores major bumps for the same reason while security alerts stay enabled; patch and minor fixes
are applied once the test suites pass. `worker/requirements.txt` is pinned to the environment the benchmark of
record ran in and is never bumped by a bot (a new torch or NeMo changes the measured numbers).

## How user data and secrets are handled

- Credentials live in the deploy platform's environment and in `~/.config/` on the maintainer's machine. Nothing
  secret is written into this tree: `.gitignore` covers `.env` and `.env.*`, and `.env.example` carries
  placeholders only.
- **Two scanners run on every push:** TruffleHog (verified secrets, full history) in the CI pipeline and gitleaks
  with `fetch-depth: 0` in its own workflow. gitleaks is there because GitHub's built-in scanning only matches
  known provider patterns and would not flag a project-shaped name like `NEBIUS_AUTH_PRIVATE_KEY`.
- **Spaces are keyed, not accounted.** A space is addressed by a key derived with an HMAC secret; the key is
  never stored in clear, and "delete all" writes a tombstone before it removes objects so a late write cannot
  resurrect a space (`src/lib/fence.ts`, `tests/fence.test.ts`).
- **Raw audio is deleted by the app only after a drift-gated round trip**, then verified with `HEAD … 404`
  (README, "How it works"; `/proof` shows the 404). The Nebius bucket has lifecycle rules as a backstop.
- **Token Factory retention is stated, not hidden.** Unless Zero Data Retention is confirmed for the organisation
  (`TF_ZDR_CONFIRMED`, off), non-sample spaces see the default-retention sentence and must opt in before any
  transcript text is sent. See README limit 7.
- Uploads are validated server-side (size, type, request-body limits; `tests/read-body.test.ts`), and presigned
  URLs are scoped to one object key.
