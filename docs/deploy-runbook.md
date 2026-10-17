# Deploy runbook: a half-finished deploy

Every merge to `main` runs one deploy job (`.github/workflows/ci.yml`), in this order:

1. apply new D1 migrations to the shared production database,
2. deploy Bistro Norden, smoke-test it,
3. deploy Chez Abena, smoke-test it.

Both Workers ship the builds the `build` job already served and crawled in the same run.
The job stops at the first failure, so it can leave the sites out of step: the database
migrated but no Worker changed, or Bistro Norden on the new build and Chez Abena on the old
one, or both deployed and Chez Abena failing its smoke test.

## How to tell

- The **Deploy to production** job is red. The failed step names the stage: migrations,
  `Deploy …` (wrangler refused or the API failed) or `Smoke-test …` (the live site is wrong).
  The smoke test's log lists every route and header that failed.
- Which build each site serves: the ETag starts with the commit it was built from.

  ```sh
  curl -sI https://dagens-menu-bistro.kwabenasasuboakye.workers.dev/ | grep -i etag
  curl -sI https://dagens-menu-westafrican.kwabenasasuboakye.workers.dev/ | grep -i etag
  ```

- Which versions Cloudflare holds: each deploy is tagged with the short SHA and its message
  is the full SHA plus the run id.

  ```sh
  npx wrangler deployments list --name dagens-menu-bistro
  npx wrangler deployments list --name dagens-menu-westafrican
  ```

Run wrangler from the repo, signed in with `npx wrangler login` on Kwabena's Cloudflare
account. The CI token lives only in the `production` environment and isn't needed here.

## What to do

**A transient failure** (Cloudflare API error, the edge slow to pick up the new version):
re-run the failed job from the Actions page. It downloads the same tested builds (kept for
7 days), the migrations step applies nothing new, and both sites are deployed again.

**A real fault in the new build:** fix it in a PR and merge. The next deploy brings both
sites forward together. Meanwhile, put the broken site back on its last good version:

```sh
npx wrangler rollback <version-id> --name dagens-menu-westafrican -m "Smoke test failed on <sha>"
```

Take `<version-id>` from `deployments list`: the newest entry whose message is an older,
working commit. Without an id, `wrangler rollback` goes back one version. Roll back only the
site that's broken; the other may stay on the new build, as long as the database check below
passes for both.

## What to check in D1

Migrations run before any Worker changes, so after a half-deploy the database is already on
the new schema while at least one site runs older code.

1. See what was applied, and when:

   ```sh
   npx wrangler d1 migrations list dagens-menu --remote --config wrangler.bistro.jsonc
   npx wrangler d1 execute dagens-menu --remote --config wrangler.bistro.jsonc \
     --command "SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5"
   ```

2. Read the migrations this deploy applied. Each one must be **expand only** (new tables,
   new nullable columns, new indexes), as `0004_session_passkey.sql` states. Then the old
   code keeps working against the new schema, and rolling a Worker back is safe.
3. If a migration removed or renamed something the old code reads, a Worker rollback will
   break that site. Roll forward instead: fix the code and merge. Never edit or delete a
   shipped migration; undo it with a new one.
4. Only if the data itself is damaged: D1 Time Travel restores the database to a moment
   before the deploy (the run's start time is on the Actions page). It also discards every
   owner edit made since, on both sites, so it's the last resort.

   ```sh
   npx wrangler d1 time-travel restore dagens-menu --timestamp <RFC3339 time before the deploy>
   ```

After any rollback or restore, re-run the smoke test against each site with the build it
now serves, e.g.
`node scripts/smoke.mjs --url https://dagens-menu-westafrican.kwabenasasuboakye.workers.dev --title "Chez Abena" --build <short sha>`.
