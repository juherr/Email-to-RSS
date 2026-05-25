# Contributing to kill-the-news

Thanks for your interest in contributing! This is a small, self-hosted
Cloudflare Worker project. Issues, bug fixes, and well-scoped features are all
welcome.

## Getting started

Requirements: Node.js (LTS) and npm. A Cloudflare account is only needed to
deploy, not to run tests locally.

```bash
git clone https://github.com/juherr/kill-the-news.git
cd kill-the-news
npm install          # installs deps and builds client scripts (prepare hook)
npm run dev          # start the local dev server (wrangler dev)
```

For full setup, deployment, and configuration details, see
[INSTALL.md](INSTALL.md).

## Development workflow

```bash
npm test             # run all tests once
npm run test:watch   # run tests in watch mode
npm run build        # dry-run deploy bundle (wrangler deploy --dry-run)
npm run format       # format with Prettier
```

Run a single test file:

```bash
npx vitest run src/routes/admin.test.ts
```

Client-side scripts live in `src/scripts/client/` and are compiled by esbuild
into `src/scripts/generated/` (gitignored). They rebuild on `npm install`; to
rebuild manually:

```bash
npm run build:client
```

The architecture, source layout, and KV schema are documented in
[CLAUDE.md](CLAUDE.md) — a good orientation before making changes.

## Before opening a pull request

- **Add or update tests** for any behavior change. Tests live in
  `src/routes/*.test.ts`, with shared mocks in `src/test/setup.ts`.
- **Run the checks**: `npm test`, `npm run build`, and `npm run format`.
  Pre-commit hooks (husky + lint-staged) run lint/format on staged files.
- **Keep docs in sync.** When you change behavior, update the relevant files
  together:
  - `README.md`
  - `INSTALL.md` (setup, deployment, configuration)
  - `setup.sh` (if setup/deploy assumptions changed)
- **Keep PRs focused.** One logical change per PR is easier to review.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/)
with a scope, matching the existing history. Examples:

```
feat(admin): collapse create-feed form into accordion
fix(attachments): render inline cid: images in emails and feeds
refactor(home): dedupe byte formatting in storage cards
docs(readme): add Continuous deployment section
```

Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.

## Releasing

The running version is read from `package.json` `version` and inlined at build
time (footer, `/health`, `/api/v1/stats`). `main` **always** carries a
`-develop` pre-release suffix (e.g. `0.4.0-develop`) so a dev build is never
mistaken for a shipped one — `0.4.0-develop` sorts _below_ `0.4.0` per SemVer,
meaning "heading toward 0.4.0, not yet released".

**Cut releases with one command — never by hand:**

```bash
npm run release X.Y.Z          # next dev cycle defaults to the next minor
npm run release X.Y.Z A.B.C    # ...or pass an explicit next dev base (e.g. a patch line)
```

`X.Y.Z` must equal `main`'s current `X.Y.Z-develop` base. The script
(`scripts/release.sh`) guards (clean tree, on `main`, in sync with `origin`,
version match, non-empty changelog), then in one shot:

1. promotes the `## [Unreleased]` section of `CHANGELOG.md` to `## [X.Y.Z]`,
2. commits the **bare** `X.Y.Z` to `main` (a real release commit) and tags it,
3. opens the next `-develop` cycle (a fresh `## [Unreleased]` + bumped version),
4. pushes `main` + the tag (after showing you the notes and asking to confirm).

The `v*` tag triggers the Release workflow (`.github/workflows/release.yml`),
which **verifies** the tagged commit's `package.json` equals the tag exactly
(catching a wrong or `-develop` commit), builds the bundle, and publishes a
GitHub Release whose notes are the `## [X.Y.Z]` section of `CHANGELOG.md` — so the
changelog you maintained in-repo is what ships. Keep `## [Unreleased]` up to date
**as part of every change**; the release notes are never hand-typed.

If you ever release manually, the tagged commit must carry the bare `X.Y.Z` in
`package.json` and the matching `## [X.Y.Z]` section must exist in
`CHANGELOG.md` — the workflow fails fast otherwise.

## Reporting bugs and requesting features

Open an issue at
[github.com/juherr/kill-the-news/issues](https://github.com/juherr/kill-the-news/issues).
For bugs, include reproduction steps, expected vs. actual behavior, and your
environment (ingestion method, relevant config). For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
