#!/usr/bin/env bash
# A westafrican Worker beside the bistro one, for the per-site isolation test in
# tests/e2e/security.spec.ts (tester F3). Both share the local D1 in .wrangler/state, as the
# two production Workers share one database, so a bistro session, invite or passkey can be
# tried against the other site. The build is copied out of dist/, because the Playwright
# config builds the bistro into dist/ afterwards.
#
#   scripts/serve-westafrican.sh [port]    # default 8792; runs in the foreground
#
# Then: WESTAFRICAN_URL=http://localhost:8792 npx playwright test --project=gate \
#         tests/e2e/security.spec.ts --grep "per-site isolation"
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8792}"
OUT="$(mktemp -d)/westafrican"

SITE=westafrican npx astro build
cp -R dist "$OUT"
npm run -s db:migrate:local
npm run -s seed -- --site westafrican --reset
exec npx wrangler dev --config "$OUT/server/wrangler.json" --port "$PORT" --persist-to "$PWD/.wrangler/state" \
  --var "SESSION_SECRET:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
