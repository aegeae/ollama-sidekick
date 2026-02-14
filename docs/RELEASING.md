# Releasing (protected `main`)

This repo treats `main` as the protected **release branch**.

On every push/merge to `main`, GitHub Actions will:

1) Determine the next SemVer version from commit messages (Conventional Commits)
2) Bump versions in `package.json` and `manifest.json`
3) Create an annotated tag `vX.Y.Z`
4) The tag push triggers the existing workflow in `.github/workflows/release.yml` which builds and uploads `ollama-sidekick.zip` to a GitHub Release

## Conventional Commit → version rules

The workflow looks at commit messages since the latest `v*` tag:

- **MAJOR** if any commit contains `BREAKING CHANGE:` (in the body/footer) or uses a bang after the type, e.g. `feat!:` / `fix!:`
- **MINOR** if any commit subject starts with `feat:` (or `feat(scope):`)
- **PATCH** if any commit subject starts with `fix:` (or `fix(scope):`)
- **NONE** if none of the above match → no bump and no tag

### Bootstrap (first tag)

If there are **no** existing `v*` tags yet, automation will create an initial tag `v<package.json version>` (for example `v0.1.0`) so that tags align with the extension’s current version.

Only **one** new tag is created per push to `main` (based on all commits in that push).

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

- `scripts/next-version.mjs` computes bump + next version from git history
- `scripts/apply-version.mjs` applies the version to `package.json` + `manifest.json`
- `.github/workflows/auto-release.yml` runs on push to `main` and performs bump+tag
- `.github/workflows/release.yml` creates the GitHub Release + zip

### Note: why GitHub Releases might be missing

If tags are created/pushed by GitHub Actions using the default `GITHUB_TOKEN`, GitHub often does **not** trigger other workflows from that tag push.

To make releases reliable, `auto-release.yml` explicitly dispatches `release.yml` via `workflow_dispatch` after it creates/pushes the tag.

## Verifying tags / releases

- Tags: GitHub → **Releases** / **Tags**
- Actions: GitHub → **Actions**
  - `Auto Release (main)` should run on pushes to `main`
  - `Release` should run right after tagging (dispatched by Auto Release)

You can also run `Release` manually:

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

If automation fails, you can still create a release tag manually:

- Ensure versions are correct (optional):
  - `node scripts/apply-version.mjs 0.1.1 --manifest manifest.json`
- Commit the version bump:
  - `git add package.json manifest.json package-lock.json`
  - `git commit -m "chore(release): v0.1.1"`
- Tag + push:
  - `git tag -a v0.1.1 -m v0.1.1`
  - `git push origin main --follow-tags`

Pushing `v0.1.1` will trigger the GitHub Release workflow.
