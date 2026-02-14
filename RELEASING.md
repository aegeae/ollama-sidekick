# Releasing (protected `main`)

This repo treats `main` as the protected **release branch**.

On every push/merge to `main`, GitHub Actions runs **semantic-release** to:

1) Determine the next SemVer version from commit messages (Conventional Commits)
2) Update `CHANGELOG.md`
3) Bump versions in `package.json` and `manifest.json` (kept in sync)
4) Create an annotated tag `vX.Y.Z`
5) Build `ollama-sidekick.zip` and attach it to the GitHub Release

## Conventional Commit → version rules

The workflow looks at commit messages since the latest `v*` tag:

- **MAJOR** if any commit contains `BREAKING CHANGE:` (in the body/footer) or uses a bang after the type, e.g. `feat!:` / `fix!:`
- **MINOR** if any commit subject starts with `feat:` (or `feat(scope):`)
- **PATCH** if any commit subject starts with `fix:` (or `fix(scope):`)
- **NONE** if none of the above match → no bump and no tag

## Required GitHub settings (branch protection)

Branch protection cannot be enforced by code alone.

In GitHub UI:

1) **Settings → Branches → Branch protection rules → Add rule**
2) Branch name pattern: `main`
3) Enable:
   - **Require a pull request before merging**
   - **Require status checks to pass before merging**
     - select the CI workflow checks you want to require
4) To allow the automation to push the release bump commit + tag back to `main`, enable one of:
   - **Allow GitHub Actions to bypass branch protection rules** (preferred; simplest)
   - OR allow the `github-actions[bot]` actor to push (if using rulesets/allow-lists)

Also ensure:

- **Settings → Actions → General → Workflow permissions**
  - choose **Read and write permissions**

If you do not allow Actions to push to `main`, switch to a PR-based release flow (not implemented here).

### Optional: using `gh` CLI

Branch protection setup payloads vary (especially with rulesets), so the most reliable approach is still the GitHub UI.

If you want a quick CLI jump into the right place:

- `gh repo view --web` (opens the repo)
- Then go to **Settings → Branches** and **Settings → Actions → General**

## How it works (repo files)

- `.releaserc.json` configures `semantic-release` (bump rules, changelog, tagging, GitHub Release)
- `scripts/sync-manifest-version.mjs` keeps `manifest.json` version aligned with `package.json`
- `.github/workflows/auto-release.yml` runs on push to `main` and runs `semantic-release`

### Note: why `release.yml` no longer triggers on tags

`semantic-release` now creates the GitHub Release and uploads `ollama-sidekick.zip` itself, so we avoid relying on tag-triggered workflows.

## Verifying tags / releases

- Tags: GitHub → **Releases** / **Tags**
- Actions: GitHub → **Actions**
  - `Auto Release (main)` should run on pushes to `main`
  - The `Release` workflow is optional/manual only

You can still run `Release` manually (optional):

- GitHub → **Actions** → **Release** → **Run workflow** → set `tag` to e.g. `v0.4.0`

## Chrome Web Store upload (`.zip`)

Chrome Web Store (Developer Dashboard) expects a **ZIP** containing the extension files with `manifest.json` at the **root** of the zip.

This repo already produces the correct upload file:

- `ollama-sidekick.zip` (created by `npm run package:zip`)
  - It zips the contents of `dist/` so `manifest.json` is at the zip root (not nested under a `dist/` folder).
  - It excludes sourcemaps (`*.map`) for a store-friendly build.

Where to download it:

- Preferred: GitHub → **Releases** → download the `ollama-sidekick.zip` asset from the latest `v*` release.
- Alternative: GitHub → **Actions** → open the workflow run → download the artifact (it downloads as a zip).
  - Important: GitHub artifacts are wrapped in an extra zip. Extract the downloaded artifact first, then upload the inner `ollama-sidekick.zip` to the Chrome dashboard.

Quick sanity check (optional):

- `unzip -l ollama-sidekick.zip | head`
- Confirm you see `manifest.json` at the top level (no `dist/manifest.json`).

## Manual fallback

If automation fails, you can run a release from your machine:

- Dry-run:
  - `npm run release:dry`
- Real release (requires a GitHub token and push access):
  - `npm run release`
