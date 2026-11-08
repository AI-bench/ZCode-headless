#!/usr/bin/env sh
# Refresh this fork onto the latest upstream ZCode release, rebuild, and
# run the targeted tests for the patch. See patch_docs/README.md.
set -eu
cd "$(dirname "$0")/.."

echo "== fetching upstream =="
git fetch origin

BASE_BEFORE=$(git merge-base HEAD origin/main)
echo "== rebasing onto origin/main ($(git rev-parse --short origin/main)) =="
if ! git rebase origin/main; then
  echo
  echo "REBASE CONFLICT: resolve the conflicts, 'git add' the files, then"
  echo "'git rebase --continue' — afterwards re-run this script; it will"
  echo "skip the rebase (already up to date) and continue with the build."
  exit 1
fi
BASE_AFTER=$(git merge-base HEAD origin/main)
[ "$BASE_BEFORE" = "$BASE_AFTER" ] && echo "(no upstream change)" || echo "rebased OK"

echo "== install =="
pnpm install

echo "== build =="
pnpm --filter @zcode-cli... build

echo "== targeted tests =="
(
  cd apps/zcode-cli/packages/adapters
  pnpm exec vitest run \
    tests/zai-business-token-cache.test.ts \
    tests/zai-business-token-persistence.test.ts \
    tests/zai-business-token-store.test.ts
)
(
  cd apps/zcode-cli/packages/bootstrap
  pnpm exec vitest run \
    tests/auth-login.test.ts \
    tests/standalone-account-runtime-options.test.ts
)
(
  cd packages/services
  pnpm exec vitest run test/oauthCredentialRepo.test.ts
)

echo
echo "DONE. dist/zcode.cjs rebuilt at:"
ls -l apps/zcode-cli/packages/cli/dist/zcode.cjs
echo "Smoke test before daily use: one 'zcode login --no-browser', then a"
echo "headless account-model turn >15 min later with no re-login."
