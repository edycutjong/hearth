.PHONY: help install lint typecheck test test-coverage test-worker lint-worker e2e lighthouse audit security-scan ci ci-full

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/ —/'

install: ## node + python dev dependencies
	npm ci
	python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt

# ── Code quality ────────────────────────────────────────────
lint: ## eslint
	npm run lint

typecheck: ## tsc --noEmit
	npm run typecheck

test: ## vitest
	npm test

test-coverage: ## vitest with v8 coverage
	npm run test:coverage

test-worker: ## pytest over worker/ and scripts/
	.venv/bin/python -m pytest -q worker scripts --cov=worker --cov=scripts --cov-fail-under=100

lint-worker: ## ruff over the Python side
	.venv/bin/ruff check worker scripts

# ── Advanced testing ────────────────────────────────────────
e2e: ## Playwright against the production build, desktop + 375 px (no credentials)
	npm run build && npm run e2e

lighthouse: ## Lighthouse CI against the production build
	npm run build && npx --yes @lhci/cli@0.14 autorun

# ── Security ────────────────────────────────────────────────
audit: ## production dependency advisories (npm + pip)
	npm audit --omit=dev --audit-level=high
	.venv/bin/pip-audit -r requirements-dev.txt || true

security-scan: audit ## audit + secrets in full history
	gitleaks detect --no-banner --redact --log-opts="--all"

ci: ## everything CI runs before the build, locally
	npm run ci && $(MAKE) lint-worker test-worker

ci-full: ci ## plus the production build and E2E
	$(MAKE) e2e
