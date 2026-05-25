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
time (footer, `/health`, `/api/v1/stats`). Between releases the working tree
carries a `-develop` pre-release suffix so a dev build is never mistaken for a
shipped one — `0.3.0-develop` sorts _below_ `0.3.0` per SemVer, meaning "heading
toward 0.3.0, not yet released".

To cut a release `X.Y.Z`:

```bash
npm version X.Y.Z --no-git-tag-version   # drop the -develop suffix
# commit, tag vX.Y.Z, push, deploy (npm run deploy)
npm version X.Y+1.0-develop --no-git-tag-version   # reopen the next cycle
```

So `main` should always read `*-develop`; only a tagged release commit carries a
bare `X.Y.Z`.

## Reporting bugs and requesting features

Open an issue at
[github.com/juherr/kill-the-news/issues](https://github.com/juherr/kill-the-news/issues).
For bugs, include reproduction steps, expected vs. actual behavior, and your
environment (ingestion method, relevant config). For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
