# Backups and restoring them

Both demo sites share one D1 database, `dagens-menu`. There are three copies of its content:

| copy | holds | how far back | restores |
|---|---|---|---|
| **D1 Time Travel** | the whole database, photos and owners included | any minute in the last 7 days (Free plan) | both sites at once, in place |
| **Weekly export** to the private `kwagyei/dagens-menu-data` repo | the content tables only, as SQL (`.github/workflows/backup.yml`) | every week since it started, as git history | a lost table or a lost site, by hand |
| **"Export my content"** in each site's admin | one site's content as JSON | whenever the owner downloaded it | one demo site (`npm run seed -- --from`) |

The weekly export leaves out photo bytes (`image_variants`, ADR-012), the change history and
every auth table: the list and the reasons are in `scripts/backup-tables.ts`. Uploaded photos
are therefore backed up only by Time Travel and by the owners' own downloads.

Run every command below from the repo, signed in with `npx wrangler login` on Kwabena's
Cloudflare account.

## Restore with Time Travel

Use this when content is damaged or deleted: a bad hand-written query, a broken import, a
migration that went wrong. **It rolls back both sites**, and every edit either owner made after
the chosen moment is lost, so pick the latest moment that's still good and tell the owners.

1. **Find the moment.** The audit history in each site's admin (`/admin/` → History), the
   Actions run that deployed, or the owner's report. Write it as UTC, RFC 3339:
   `2026-10-17T14:14:39Z`.

2. **Record where the database is now**, so the restore can be undone and the content version
   moved forward afterwards:

   ```sh
   npx wrangler d1 time-travel info dagens-menu --config wrangler.bistro.jsonc
   npx wrangler d1 execute dagens-menu --remote --config wrangler.bistro.jsonc \
     --command "SELECT id, content_version FROM sites"
   ```

   Keep the bookmark and both version numbers.

3. **Check the target.** This prints the bookmark for that moment and changes nothing:

   ```sh
   npx wrangler d1 time-travel info dagens-menu --timestamp 2026-10-17T14:14:39Z --config wrangler.bistro.jsonc
   ```

4. **Restore.** Queries in flight are cancelled, and the sites serve their cached content for
   the few seconds it takes. Wrangler asks to confirm, **but answers yes by itself when it
   isn't run in a terminal**, so never put this line in a script:

   ```sh
   npx wrangler d1 time-travel restore dagens-menu --timestamp 2026-10-17T14:14:39Z --config wrangler.bistro.jsonc
   ```

   It prints a bookmark "to undo this operation". Keep that too.

5. **Move each site's content version past where it was in step 2.** The restore also rewinds
   `sites.content_version`. Without this, the next owner edits would count up through version
   numbers that a running Worker (and a visitor's ETag) still links to the discarded content,
   and that content could be served again. Use the numbers from step 2, plus one:

   ```sh
   npx wrangler d1 execute dagens-menu --remote --config wrangler.bistro.jsonc --command \
     "UPDATE sites SET content_version = CASE id WHEN 'bistro' THEN <bistro + 1> WHEN 'westafrican' THEN <westafrican + 1> END"
   ```

   This is the one place `content_version` is written by hand: the triggers only ever count up
   from what's there.

6. **Check both sites**, with the build each one serves (its ETag starts with it, see
   `docs/deploy-runbook.md`):

   ```sh
   node scripts/smoke.mjs --url https://dagens-menu-bistro.kwabenasasuboakye.workers.dev --title "Bistro Norden" --build <short sha>
   node scripts/smoke.mjs --url https://dagens-menu-westafrican.kwabenasasuboakye.workers.dev --title "Chez Abena" --build <short sha>
   ```

   Then open the menu of each and look for the change that was undone.

**Undo the restore** by restoring to a bookmark instead of a timestamp, either the one from step 2
or the one the restore printed, then repeat step 5 with the current versions:

```sh
npx wrangler d1 time-travel restore dagens-menu --bookmark <bookmark> --config wrangler.bistro.jsonc
```

**Migrations and Time Travel:** a restore to a moment before a migration also undoes the
migration, while the Workers keep running the newer code. Migrations are expand only, so the code
usually copes, but re-apply them straight away
(`npx wrangler d1 migrations apply dagens-menu --remote --config wrangler.bistro.jsonc`).

### Rehearsed

2026-10-17, on a scratch database (`dagens-menu-tt-scratch`, created for the test and deleted
afterwards; production was never touched): migrations applied, Bistro Norden seeded (14 dishes,
2,034 kr in total), restore point noted, then every price set to 1 öre and three dishes deleted
(11 dishes, 0.11 kr). `time-travel restore --timestamp` brought back 14 dishes and 2,034 kr in
about 4 seconds; restoring to the printed undo bookmark brought back the damaged state, so undo
works as well.

## Restore from the weekly export

Use this when Time Travel can't help: the damage is older than 7 days, or the database is gone.

Each export in `kwagyei/dagens-menu-data` is one data-only SQL file per content table plus
`manifest.json`, which lists the migrations the data was taken under and each table's row count.
Pick a commit (`git log` in that repo) and check it out.

1. **Check it loads**, into a throwaway local database (needs a checkout of this repo at least as
   new as the manifest's last migration):

   ```sh
   npm run backup -- verify --dir ../dagens-menu-data
   ```

2. **Into a new, empty D1 database** (a lost database): create it, apply the migrations, then run
   the files in the manifest's table order, which loads parents before the rows that reference
   them:

   ```sh
   npx wrangler d1 execute <database> --remote --config <config> --file ../dagens-menu-data/sites.sql -y
   # then images, settings, menu_categories, menu_items, home_highlights, weekly_hours,
   # hours_exceptions, page_content, gallery_images
   ```

   Point the Workers' `database_id` at it and deploy. Owners have to be invited again
   (`npm run admin -- invite`), since no auth table is in the export, and uploaded photos are
   missing (their `images` rows come back, the bytes don't).

3. **Into the live database** (one site's content damaged long ago): the files insert rows and
   would clash with what's there. Delete the site's rows first and load the files in a
   transaction, or, for a demo site, turn them into an export file and use
   `npm run seed -- --site <site> --from <file> --remote --reset`. Rehearse on a scratch database
   first; this path hasn't been needed yet.

## The weekly export

`.github/workflows/backup.yml`, Mondays at 01:30 UTC (02:30 or 03:30 in Stockholm):

1. `npm run backup -- export --remote` runs one `wrangler d1 export --table` per content table.
   D1 fails other queries while an export runs (M0.5), a second or two per table at this size;
   the Workers serve their cached content meanwhile.
2. `npm run backup -- verify` loads the files into a fresh local database with the migrations
   applied and checks every row count against the manifest. A backup that doesn't load fails the
   run the week it's made.
3. The files are committed to `kwagyei/dagens-menu-data` as `github-actions[bot]`, only when
   something changed, with a deploy key that can write to that repo only.

It needs, in the `production` environment, `CLOUDFLARE_API_TOKEN` (already there, D1 edit) and
`DATA_REPO_DEPLOY_KEY` (the private half of the data repo's deploy key). A failed run emails the
person who last changed the schedule. Run it by hand from the Actions tab (Content backup → Run
workflow) after creating the key, and after any restore.

On a PR that changes the export scripts, the schema or the workflow, the same export and check
run against a seeded local database, so a migration that breaks the backup fails its PR.
