# Contributing

Thanks for contributing to **Ollama Sidekick**.

## Ground rules

- Keep changes focused and minimal.
- Prefer small PRs with a clear purpose.
- Do not add remote network dependencies or telemetry.
- This is a Manifest V3 extension; keep it Chrome/Brave compatible.

## Development setup

Prereqs:

- Node.js (recommended: latest LTS)

Install:

- `npm install`

Build:

- `npm run build`

Typecheck:

- `npm run typecheck`

Watch build (debug):

- `npm run dev`

Packaging (for releases / CWS upload):

- `npm run package:zip`

## Commit message format (Conventional Commits)

We use Conventional Commits because the release workflow derives SemVer bumps from commit messages.

Use one of these (optionally with a scope):

- `feat: ...` / `feat(scope): ...`  → **MINOR** bump
- `fix: ...` / `fix(scope): ...`    → **PATCH** bump

Breaking changes:

- `feat!: ...` / `fix!: ...` → **MAJOR** bump
- Or include `BREAKING CHANGE:` in the commit body/footer → **MAJOR** bump

Other types (`chore:`, `docs:`, `refactor:`, etc.) do **not** trigger a version bump.

## Pull requests

- Open a PR targeting `main`.
- Ensure CI passes.
- Describe what changed and how you tested it.

If `main` is protected, PRs are required for merging.

## Releases

`main` is treated as the protected release branch.

- On push/merge to `main`, GitHub Actions may automatically bump versions, commit a release bump, and create a tag `vX.Y.Z`.
- Tag pushes trigger the GitHub Release workflow which uploads `ollama-sidekick.zip`.

See [RELEASING.md](RELEASING.md) for required GitHub settings and details.

## Security / privacy

- The extension is intended to talk to a **local** Ollama instance.
- Avoid changes that widen permissions or allow remote base URLs without explicit review.

If you believe you’ve found a security issue, please open a GitHub issue with details (avoid posting sensitive data).
