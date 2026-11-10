# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.
The full engineering guide is [`docs/development.md`](docs/development.md); AI coding tools start from [`AGENTS.md`](AGENTS.md).

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

- A reproducible test case or series of steps, including what the console page shows
- The version of our code being used (shown in the login page footer and by `GET /api/public/version`)
- The deployment mode and the regions involved
- Any modifications you've made relevant to the bug
- Anything unusual about your environment or deployment

Never include AWS account ids, ARNs, passwords, tokens or customer data in an issue.

## Contributing via Pull Requests

Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass (see [Gates](#gates) below).
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

### Set up

1. Install Node.js 20 and npm. Every pinned tool and runtime version is listed in [`docs/supported-versions.md`](docs/supported-versions.md).
2. Clone the repository and install both workspaces, then enable the versioned git hooks:

   ```bash
   (cd platform && npm ci) && (cd infra && npm ci)
   bash scripts/install-hooks.sh   # pre-commit hook: red-line scan of staged changes
   ```

3. The console reads and writes AWS resources on every page, so there is no meaningful local mock mode.
   The verification path is a deployment into your own test account followed by headless-browser acceptance
   (`docs/development.md`, sections 3 and 11).

### Gates

Run all of them before you push. They work offline unless noted.

| Gate | Command |
|---|---|
| Platform types | `cd platform && npx tsc --noEmit -p tsconfig.json` |
| Platform unit tests | `cd platform && npx vitest run` (always from `platform/`, never from the repository root) |
| Naming parity | `cd platform && node scripts/naming-parity.mjs` |
| Infra types and synth gate | `cd infra && npx tsc --noEmit && npm run synth-gate` |
| Red-line scan | `bash scripts/redline-scan.sh` |
| Build gate | `cd platform && npm run build` |
| Delivery archive | `bash infra/test/package-release/test_package_release.sh` (packages `HEAD`, checks exclusions, determinism and build facts) |

Every new AWS SDK call is registered in `infra/iam/platform-taskrole-calls.json` in the same commit.
CI (`.github/workflows/ci.yml`) re-runs the scan, the tests, the build and the CDK synthesis on every pull request; it never deploys.

### Branches, commits and releases

- `main` is the trunk. Work on short-lived `feat/<topic>` or `fix/<topic>` branches and open a pull request against `main`.
- Commit messages follow Conventional Commits in English: `feat(scope): summary`, `fix(scope): summary`,
  `docs(scope): summary`, `chore(scope): summary`. The first line must stand on its own.
- A commit changes either product code or documentation, not both. Files that the code gates read travel with the code (the IAM call manifest, ratchet ledgers, fixtures, `.env.example`);
  prose documentation, `CHANGELOG.md` and `docs/supported-versions.md` follow in a `docs(scope)` commit of the same pull request, so the pull request as a whole leaves code and documentation consistent.
- Releases follow Semantic Versioning and are tagged `vX.Y.Z`. The tag, the `VERSION` file and the CHANGELOG heading must agree.
- `scripts/cut-release.sh <version>` performs the cut: it bumps `VERSION`, closes the `[Unreleased]` section of `CHANGELOG.md`,
  creates the `release/X.Y.Z` branch and the annotated tag, and pushes them. Without `--yes` it only prints the plan.
- `--github-release` additionally packages the tag with `scripts/package-release.sh` and creates the GitHub Release: title `Kingfisher vX.Y.Z`,
  body taken verbatim from the CHANGELOG section plus the archive SHA-256, assets `kingfisher-vX.Y.Z.tar.gz` and `.sha256`. It needs an authenticated `gh`.
- Release branches receive documentation and hotfixes only. A hotfix bumps the patch number, is fixed on the release branch
  and cherry-picked back to `main`.
- Deployments always use a tag, never a branch head.

### Pull request checklist

- Fill in every section of the pull-request template: one-sentence what/why, change type, blast radius, gates run,
  evidence, docs updated, and the no-secrets checklist.
- Keep a pull request to one concern. A change to a shared module names the callers that were checked.
- Write documentation in English. Source comments, test titles and deployment-script output are written in Chinese, matching the surrounding code; do not mix languages within one file.
- Changes to page behaviour are accepted by driving the real page in a headless browser against a deployed test account.
  API responses, logs or database rows are supporting detail, not acceptance evidence.
- Add a line under `[Unreleased]` in `CHANGELOG.md`. If a runtime, engine, driver or tool version changed,
  update `docs/supported-versions.md` in the same pull request.
- Never include AWS account ids, ARNs, passwords, tokens or customer data. Documentation uses placeholders;
  fixture identifiers contain at least one letter in their last twelve characters so the red-line scan does not read them as account ids.

The repository standards in [`docs/development.md`](docs/development.md) section 14 apply to every change. Review items listed there are part of the pull request checklist.

## Finding contributions to work on

Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels
(enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.
[`SECURITY.md`](SECURITY.md) describes the project's security posture and dependency policy.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
