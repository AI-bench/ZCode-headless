# ZCode fork: standalone account patches

Unofficial fork of [zai-org/ZCode](https://github.com/zai-org/ZCode) — not
affiliated with or endorsed by z.ai. Licensed Apache 2.0 like the upstream;
upstream `LICENSE` and `NOTICE.md` are preserved unchanged. All changes are
confined to **one commit** on top of upstream `main` (`git log origin/main..HEAD`).

Licensing convention: every file this fork modifies carries a leading
`// Modified in this fork …` marker, and every file it adds carries
`// Added in this fork …` (Apache-2.0 §4(b)). Keep that convention when
extending the patch.

## What the patch changes

Makes `zcode app-server` usable **headless with a z.ai coding-plan login** —
e.g. driven by an external orchestrator instead of the desktop app:

| Area | Change |
|---|---|
| Standalone account runtime | `ZCODE_STANDALONE_ACCOUNT=1` makes `zcode app-server` own its account credentials (CLI `zcode login`, shared credential store) instead of delegating account auth to a desktop host |
| Login window | `ZCODE_LOGIN_TIMEOUT_MS` env override for the headless login window (default 5 min; a human clicking the OAuth URL often needs longer) |
| Token persistence | the ~180-day zai business JWT was memory-only, so every new app-server re-exchanged it from a short-lived (~15 min) credential. It is now written to the shared encrypted credential store (`oauth:zai:business_token`, scoped to the account identity) and adopted by fresh processes; 401s reject and remove it so the retry loop self-heals |
| Logout hygiene | desktop sign-out/switch also clears the persisted business token; the 401 removal is a single locked transaction |

Net effect: one `zcode login` lasts roughly the lifetime of the business
token (~180 days) for headless app-server use, instead of ~15 minutes.

Without these patches, headless app-servers work only with API-key personal
providers; account/plan models never register. See
`apps/zcode-cli/docs/design/v2/auth-login.md` (updated by `3af990f7`) for the
login flow.

## Build

```sh
pnpm install
pnpm --filter @zcode/cli... build
# binary: apps/zcode-cli/packages/cli/dist/zcode.cjs (run with node)
```

## Update to a new upstream release

Run `patch_docs/update-fork.sh` (or follow it manually):

1. `git fetch origin` — new upstream releases land as `chore: sync ZCode source` commits on `origin/main`
2. `git rebase origin/main` — the patch is additive; if the rebase conflicts, resolve in the touched files (auth / login / registry runtime), then continue
3. `pnpm install` (dependency syncs may change the lockfile)
4. `pnpm --filter @zcode/cli... build`
5. Run the targeted tests:

```sh
cd apps/zcode-cli/packages/adapters && pnpm exec vitest run \
  tests/zai-business-token-cache.test.ts \
  tests/zai-business-token-persistence.test.ts \
  tests/zai-business-token-store.test.ts
cd ../bootstrap && pnpm exec vitest run \
  tests/auth-login.test.ts \
  tests/standalone-account-runtime-options.test.ts
cd ../../../packages/services && pnpm exec vitest run test/oauthCredentialRepo.test.ts
```

6. Smoke: `zcode login --no-browser` once, then run one headless app-server
   turn on an `account:` model more than 15 minutes later with no re-login —
   if it answers, persistence still works.

Notes:

- Re-check this after any z.ai server-side auth change (token lifetimes,
  login flow). The patches only cache what the existing login exchange
  already returns; they add no new endpoints or credentials.
- Publishing binaries from this fork: keep the Apache 2.0 obligations
  (LICENSE + NOTICE.md preserved, changes stated) and do not present them as
  official z.ai releases.
