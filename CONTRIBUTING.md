# Contributing to Kingfisher

Thank you for taking the time to contribute. This page is the short version.
The full engineering guide is [`docs/development.md`](docs/development.md); AI coding tools start from [`AGENTS.md`](AGENTS.md).

## Set up

1. Install Node.js 20 and npm. Every pinned tool and runtime version is listed in [`docs/supported-versions.md`](docs/supported-versions.md).
2. Clone the repository and install both workspaces, then enable the versioned git hooks:

   ```bash
   (cd platform && npm ci) && (cd infra && npm ci)
   bash scripts/install-hooks.sh   # pre-commit hook: red-line scan of staged changes
   ```

3. The console reads and writes AWS resources on every page, so there is no meaningful local mock mode.
   The verification path is a deployment into your own test account followed by headless-browser acceptance
   (`docs/development.md`, sections 3 and 11).

## Gates

Run all of them before you push. They work offline unless noted.

| Gate | Command |
|---|---|
| Platform types | `cd platform && npx tsc --noEmit -p tsconfig.json` |
| Platform unit tests | `cd platform && npx vitest run` (always from `platform/`, never from the repository root) |
| Naming parity | `cd platform && node scripts/naming-parity.mjs` |
| Infra types and synth gate | `cd infra && npx tsc --noEmit && npm run synth-gate` |
| Red-line scan | `bash scripts/redline-scan.sh` |
| Build gate | `cd platform && npm run build` |

Every new AWS SDK call is registered in `infra/iam/platform-taskrole-calls.json` in the same commit.
CI (`.github/workflows/ci.yml`) re-runs the scan, the tests, the build and the CDK synthesis on every pull request; it never deploys.

## Branches, commits and releases

- `main` is the trunk. Work on short-lived `feat/<topic>` or `fix/<topic>` branches and open a pull request against `main`.
- Commit messages follow Conventional Commits in English: `feat(scope): summary`, `fix(scope): summary`,
  `docs(scope): summary`, `chore(scope): summary`. The first line must stand on its own.
- A commit changes either product code or documentation, not both.
- Releases follow Semantic Versioning and are tagged `vX.Y.Z`. The tag, the `VERSION` file and the CHANGELOG heading must agree.
- `scripts/cut-release.sh <version>` performs the cut: it bumps `VERSION`, closes the `[Unreleased]` section of `CHANGELOG.md`,
  creates the `release/X.Y.Z` branch and the annotated tag, and pushes them. Without `--yes` it only prints the plan.
- Release branches receive documentation and hotfixes only. A hotfix bumps the patch number, is fixed on the release branch
  and cherry-picked back to `main`.
- Deployments always use a tag, never a branch head.

## Pull requests

- Fill in every section of the pull-request template: one-sentence what/why, change type, blast radius, gates run,
  evidence, docs updated, and the no-secrets checklist.
- Keep a pull request to one concern. A change to a shared module names the callers that were checked.
- Changes to page behaviour are accepted by driving the real page in a headless browser against a deployed test account.
  API responses, logs or database rows are supporting detail, not acceptance evidence.
- Add a line under `[Unreleased]` in `CHANGELOG.md`. If a runtime, engine, driver or tool version changed,
  update `docs/supported-versions.md` in the same pull request.
- Never include AWS account ids, ARNs, passwords, tokens or customer data. Documentation uses placeholders;
  fixture identifiers contain at least one letter in their last twelve characters so the red-line scan does not read them as account ids.

The repository standards in [`docs/development.md`](docs/development.md) section 14 apply to every change. Review items listed there are part of the pull request checklist.

## Reporting

- Bugs and feature requests: use the issue templates. Describe what the page shows, the steps, the platform version shown in the
  login page footer, the deployment mode and the regions involved.
- Security vulnerabilities: follow [`SECURITY.md`](SECURITY.md). Never open a public issue for them.

## Code of conduct

Be respectful and constructive, review the change rather than the person, and assume good faith; maintainers may decline contributions that do not.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
