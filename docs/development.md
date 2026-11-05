# Developing Kingfisher

This guide is for engineers who change the platform code, the infrastructure code or the deployment scripts.
It covers the repository layout, the local gates, the engineering rules, the branch model and continuous integration.

Architecture and core concepts are in [`architecture.md`](architecture.md). Pinned tool and runtime versions are in [`supported-versions.md`](supported-versions.md).

## Contents

1. Repository layout
2. Prerequisites
3. Getting started
4. Local gates
5. Engineering rules
6. Testing rules
7. Change recipes
8. Branch model and commits
9. Pull requests
10. Continuous integration
11. Headless acceptance
12. Working in parallel
13. Documentation and diagrams
14. Repository standards

## 1. Repository layout

| Path | Contents |
|---|---|
| `platform/` | Next.js application: pages under `src/app/<route>/page.tsx`, API routes under `src/app/api/<group>/.../route.ts`, libraries under `src/lib/`, shared types under `src/types/` |
| `platform/src/middleware.ts` | Authentication gate for every `/api/*` request |
| `platform/naming.json`, `platform/ai-model.json` | Single sources of truth for regional resource names and for model candidates; both sides of the build read them |
| `platform/scripts/` | Node gates: naming parity, mutation check, writer gate, i18n helpers |
| `infra/` | AWS CDK application: control-plane stacks in `lib/`, execution-region stacks in `lib/exec-env/`, entry `bin/app.ts` |
| `infra/buildspec/` | CodeBuild buildspec used to deploy execution regions |
| `infra/iam/platform-taskrole-calls.json` | Manifest of every AWS SDK call the platform makes, used by the IAM simulation gate |
| `infra/lambda/` | Deployment broker, action dispatcher, Cognito bootstrap, agent skills, cross-region peering |
| `infra/agent/` | Container sources for the three AI agents |
| `infra/scripts/`, `infra/test/` | Offline synth gate and script-level checks |
| `scripts/` | Install, redeploy, post-deploy truth checks, red-line scan, release cut, acceptance orchestration |
| `flink-sql-runner*/`, `flink-connector-modules/` | Maven modules for the Flink SQL runners and connectors |
| `docs/` | Public documentation, design contracts under `docs/design/`, figures under `docs/diagrams/` |
| `.github/`, `.githooks/` | CI workflow, pull-request and issue templates, versioned pre-commit hook |

## 2. Prerequisites

Install the following on your workstation. Exact versions are pinned in [`supported-versions.md`](supported-versions.md).

- git, Node.js and npm.
- AWS CLI with named profiles. Every AWS command in this project takes an explicit `--profile`.
- Docker with buildx, needed to build the platform image and the agent images.
- `python3`, needed by several scripts and by the headless acceptance tooling.
- A JDK and Maven, needed only to build the Flink runner modules.

## 3. Getting started

```bash
git clone <repository-url> kingfisher
cd kingfisher
(cd platform && npm ci)
(cd infra && npm ci)
bash scripts/install-hooks.sh
```

`scripts/install-hooks.sh` sets `core.hooksPath` to `.githooks`, so the red-line scan runs on every commit.

### 3.1 Running the web application locally

`npm run dev` inside `platform/` starts the Next.js development server. Every page reads and writes AWS services, so the server needs:

- AWS credentials for an environment where the platform is already deployed.
- The platform container's environment variables. Copy `platform/.env.example` to `platform/.env.local` and fill the values from that environment.

`.env.example` lists keys only. A guard test keeps the key list identical to the container definition in `infra/lib/platform-stack.ts`.
The team's verification path is a deployment to a test account followed by headless acceptance, not the local dev server.

## 4. Local gates

Run these before every commit. All of them work offline except where noted.

| Gate | Command | What it checks |
|---|---|---|
| Platform types | `cd platform && npx tsc --noEmit -p tsconfig.json` | Zero type errors |
| Platform unit tests | `cd platform && npx vitest run` | Unit, assembly and static-gate tests under `src/**/__tests__/` |
| Naming parity | `cd platform && node scripts/naming-parity.mjs` | Runtime and CDK sides derive identical resource names |
| Infra types | `cd infra && npx tsc --noEmit` | Zero type errors |
| Execution-region synth gate | `cd infra && npm run synth-gate` | The execution-region stack group synthesizes with zero credentials and respects its invariants |
| Red-line scan | `bash scripts/redline-scan.sh` | No account ids, access keys, private keys, tokens or passwords in tracked files |
| Build gate | `cd platform && npm run build` | `next build` including lint and type checking |

Notes:

- Run vitest from `platform/`. From the repository root it would pick up CDK output directories as tests.
- `npm run synth-gate -- --fast` skips the slowest sections for iteration. Run the full gate before committing.
- The synth gate writes to a fixed directory under the system temp directory. Do not run two synth gates at the same time, even from different worktrees.
- Documentation-to-code drift gates (contract tables, scope grammar, page coverage) live in the internal engineering repository next to the Chinese design ledgers. They are not part of this repository's test suite.
- The red-line scan treats documented placeholders as safe. Fixture identifiers must contain at least one letter in their last twelve characters, or they are flagged as account ids.

### 4.1 IAM call manifest

Every new AWS SDK call must be registered in `infra/iam/platform-taskrole-calls.json` in the same commit, and the task role must grant that action.
`scripts/redeploy-platform.sh` simulates the manifest against the task role with `SimulatePrincipalPolicy`; `scripts/iam-simulate-gate.py` runs the same check on demand.

### 4.2 Optional checks

- `cd platform && npm run lint` runs the Next.js lint rules on their own.
- `cd platform && npm run test:coverage` writes a coverage report for `src/lib/**` to `platform/coverage/`.
- `cd platform && npm run test:mutation` runs the mutation harness in `platform/scripts/mutation-check.mjs` to confirm that guard tests fail when the guarded code is changed.
- Shell and Python checks under `infra/test/<name>/test_*.sh` and `test_*.py` cover the pure logic of the deployment scripts. `scripts/mr-gate.sh` runs them, and several are also driven from platform harness tests.

## 5. Engineering rules

These rules exist because each of them was once violated and cost a release. They apply to every change.

1. **Place is explicit.** Any route or service that needs a target id reads it through `requestedTargetId(...)` in `platform/src/lib/place/resolve.ts`. A missing id is HTTP 400. Nothing defaults to the home region.
2. **Read routes filter by scope.** Read APIs take the URL parameter `?scope=` through `requireScope`. Write APIs never read scope. Every unscoped page read is listed in `platform/src/lib/scope/api-read-ledger.ts`, and that list may only shrink.
3. **No silent legal defaults.** Enumerated parameters are required, validated against a closed list, and rejected otherwise. A new mode, version or type is added to its list before it is wired.
4. **Single author.** A fact such as a table name, role name, JDBC URL, error code or UI string is defined in one place and imported elsewhere. Search for an existing definition before writing one.
5. **Seams need call-site evidence.** Writing a function is not the same as wiring it. A new function needs a test that proves the call site exists, not only an import.
6. **Async work needs a settled-state assertion.** After starting a job or sending a request, verify the terminal state: success, failure or an explicit unknown after the budget. Calls that can exceed the load balancer timeout go through the long-operation framework.
7. **Deletes leave no orphans.** Deleting a data source, task or execution target also removes the Glue connections, jobs, scripts, roles and security groups it created. If something cannot be removed, answer HTTP 502 and leave the record unchanged.
8. **No secrets in the repository.** Commits must not contain account ids, ARNs, keys or passwords. The pre-commit hook and CI enforce it.
9. **UI claims need a carrier.** A page may only show a capability that exists end to end, and a status may only come from a real conclusion. "Still running" is not "failed"; "configured" is not "connected".
10. **Contracts first.** Before changing a feature, read its design contract under `docs/design/<module>/` and the multi-region contract `docs/design/50-multi-region-execution/SPEC.md`.

## 6. Testing rules

- Mock only true externals: DynamoDB, AWS SDK client factories, OpenMetadata and the model. Sibling modules are not mocked.
- Every directory with mocked collaborators has an assembly test (`*-assembly.test.ts`) that proves the real modules fit together.
- Assertions pin facts such as stored values and call arguments, not shapes such as class names or field order.
- Fixtures mirror what the product actually persists. Copy the real key set of a stored row before writing a fixture.
- Component tests may render React components; the test JSX transform is configured in `platform/vitest.config.ts`.
- Static-gate tests under `__tests__` enforce the ratchets: unscoped reads, place decisions, writer coverage and naming coverage may only improve.
- Mock return values come from recorded real responses, never from values invented to make the test pass.

## 7. Change recipes

Each recipe lists the places that must change together. Missing one of them produces a failure that only shows up in a deployed environment.

| Change | Edit together |
|---|---|
| New AWS SDK call | The call site, `infra/iam/platform-taskrole-calls.json`, and the task-role statement in the stack |
| New DynamoDB table | `infra/lib/database-stack.ts` and the `TABLES` constant in `platform/src/lib/aws/dynamodb.ts`; the upgrade script deploys the database stack so the table appears on upgrade |
| New regional resource name | A kind in `platform/naming.json` with home and target templates; both sides read it, naming parity proves they agree |
| New execution-region probe item | `platform/src/lib/exec-env/probe-runner.ts` and the item-to-component map in `platform/src/lib/exec-env/component-contract.ts`; a unit test pins both |
| New long-operation kind | The closed list in `platform/src/lib/long-ops/kinds.ts` with its label and lease resources, and an executor registered in `platform/src/lib/long-ops/registry.ts` |
| New platform environment variable | The container definition in `infra/lib/platform-stack.ts` and `platform/.env.example`; the guard test keeps them identical |
| New execution-region component | `infra/lib/exec-env/stack-group.ts`, the implemented-component lists on both sides, and the probe |
| New scheduler node type or data-source provider | Its closed list first, then the implementation, then the page |

## 8. Branch model and commits

- `main` is the trunk. All work lands on `main` through pull requests from short-lived feature branches.
- Commit messages follow Conventional Commits in English: `feat(scope): summary`, `fix(scope): summary`, `docs(scope): summary`, `chore(scope): summary`. The first line must stand on its own.
- A commit changes either product code or documentation, not both.
- Releases are tagged `vX.Y.Z` following Semantic Versioning. The tag, the `VERSION` file and the CHANGELOG heading must agree.
- `scripts/cut-release.sh <version>` performs the release cut: it bumps `VERSION`, closes the `[Unreleased]` section of `CHANGELOG.md`, creates the release branch and the annotated tag, and pushes them. Without `--yes` it only prints the plan.
- `scripts/cut-release.sh <version> --yes --github-release` additionally publishes the GitHub Release for the new tag:
  - It runs `scripts/package-release.sh v<version>` first, so the Release carries the delivery archive `kingfisher-v<version>.tar.gz` and its `.sha256` file as assets.
  - The Release title is `Kingfisher v<version>`. The body is the `[<version>]` section of `CHANGELOG.md` verbatim, followed by a table with the SHA-256 of the archive and the verification command.
  - It needs an authenticated GitHub CLI (`gh auth login`). A missing or unauthenticated `gh`, an existing Release with the same tag, or an empty `[Unreleased]` section is refused before anything is changed.
  - If packaging or the Release call fails after the tag was pushed, the script says so and prints the exact command to retry; the body is kept as `kingfisher-v<version>.release-notes.md` next to the assets.
  - The first GitHub Release is `v2.2.0`. Intermediate tags get no Release.
- Release branches are named `release/X.Y.Z`. After the tag is cut they receive documentation and hotfixes only.
- `scripts/package-release.sh <tag> [--out <dir>] [--verify]` produces the customer delivery archive `kingfisher-<tag>.tar.gz` with a `.sha256` file:
  - It reads bytes only from `git archive <tag>` and removes the paths listed in `scripts/package-release.exclude`: unit tests, acceptance orchestration, developer tooling and repository configuration.
  - The archive is deterministic: the same tag always yields the same bytes.
  - The archive root carries `BUILD-INFO.json`, which the image build reads when no git metadata is present, so the release tag stays visible in the deployed footer.
  - `--verify` builds the extracted copy to prove it is complete. The engineering repository remains the source of truth; the archive is a projection of one tag.
- A hotfix increments the patch number. It is fixed on the release branch and cherry-picked back to `main`.
- Customer deployments always use a tag, never a branch head.

## 9. Pull requests

The pull-request template in `.github/pull_request_template.md` asks for the following. Fill it in completely.

1. What changed and why, in one sentence that stands on its own.
2. The type of change: bug fix, feature, documentation only, or breaking change with a migration note in `CHANGELOG.md`.
3. Confirmation that every local gate in section 4 passed on your machine.
4. Confirmation that any new AWS SDK call is registered in the IAM manifest in the same change.
5. For page behaviour: confirmation that the change was deployed to your own test account and accepted with a headless browser.
6. Documentation updated in the same change set: `CHANGELOG.md`, the deployment guide and the architecture document where they are affected.

Bug reports use `.github/ISSUE_TEMPLATE/bug_report.md`. They describe what the user saw on the page, the steps, the platform version shown in the footer, the deployment mode and the regions involved, and never contain account ids, ARNs, passwords or customer data.

## 10. Continuous integration

`.github/workflows/ci.yml` runs on pull requests to `main` and on pushes to `main`. It only validates; it never deploys and needs no AWS credentials.

| Job | Steps |
|---|---|
| Red-line scan | `bash scripts/redline-scan.sh` over tracked files |
| Platform | `npm ci`; rebuild all `core-dist` bundles with `scripts/core-prebuild.sh all` and fail if they differ from the committed ones; `npm test`; `npm run build` |
| Infra | `npm ci`; `npm run build` (TypeScript); `npx cdk synth --all` with placeholder account and region |

The `core-dist` check guards the compiled bundles that the agent containers and the skills Lambda load.
If you change a `core/*.ts` source, run `bash scripts/core-prebuild.sh all` and commit the refreshed bundles.

Older runs on the same branch are cancelled when a new one starts.

## 11. Headless acceptance

Acceptance is performed through the user interface, not through APIs.
A change is accepted only when a headless browser has operated the affected pages on a deployed test account and the DOM and screenshots show the expected outcome.

- The browser driver is Playwright for Python with Chromium. The per-page test suite is maintained outside this repository.
- API, CLI and DynamoDB reads are allowed as debugging truth and for cross-checks. They are never the sole basis of acceptance.
- Creating an execution region in a test is done through the web wizard, never by deploying stacks directly or writing the registry.
- `scripts/32-verify-all-regions.sh`, `scripts/33-verify-regions-headless.py` and `scripts/34-add-region-headless.py` orchestrate the in-repository parts: demo objects per region, the region wizard and the capability matrix.
- `scripts/mr-gate.sh` runs the full round on a developer test account: deploy, headless acceptance of all multi-region features, stamp. Customer environments never run it.
- The per-page acceptance suite that `scripts/mr-gate.sh` drives is maintained outside this repository. The script stops with a clear message when the suite is absent.
- `scripts/02-postdeploy-truth.sh <profile> <home-region>` checks infrastructure facts after a deployment. Passing it is necessary but not sufficient for acceptance.

Conventions for writing acceptance steps:

- Drive the page: perform the user's actions, then read the text the user sees. Do not pin internal CSS class names.
- Pin the UI locale at the start of the session so selectors stay stable regardless of where the browser runs.
- Treat HTTP 202 as "accepted, poll for the terminal state", not as failure. Long operations and streaming jobs answer this way by design.
- Assert the settled state, not the acknowledgement. A run that started is not a run that succeeded.
- Fixtures that could influence later steps delete themselves. Demonstration objects that are meant to stay are created only by the showcase scripts.
- Never bend a product rule to collect evidence. If a rule blocks the test, the test is wrong or the rule needs a product change.

## 12. Working in parallel

- Each git worktree runs its own `npm ci` in `platform/` and `infra/`. Never symlink `node_modules` between worktrees; a build in one tree would wipe the other.
- Only one synth gate at a time across all worktrees, because the gate uses a fixed temp directory.
- Use absolute paths in scripts and tool calls when several trees are open; the working directory is easy to lose.
- Static ratchet files such as the unscoped-read ledger are edited in the same commit as the fix they justify. Two branches touching them need a rebase, not a merge of counts.

## 13. Documentation and diagrams

- Documentation is English. Paths, identifiers and commands are written exactly as they appear in the code.
- Figures are static PNG files under `docs/diagrams/`. Sources are Mermaid files under `docs/diagrams/src/` or the Python renderer in the same directory. Markdown never embeds live Mermaid.
- Figures and prose never state service or library versions. Versions live only in [`supported-versions.md`](supported-versions.md); a version change edits that file and `CHANGELOG.md` in the same commit.
- Screenshots under `docs/screenshots/` are scrubbed of account ids, resource ids and URLs before they are committed.
- Design contracts under `docs/design/<module>/` are the place for rationale and acceptance criteria; this guide and `architecture.md` describe only what exists.
- Documentation has no line-length or cell-length limit (decision of 2026-11-04: GitHub wraps long lines and cells; sentences and table cells are never split or truncated to satisfy a tool). Keep tables to five columns or fewer.

## 14. Repository standards

One standard applies to every repository of this project, regardless of audience. Each rule below names the check that enforces it.

| Area | Rule | Enforced by |
|---|---|---|
| Language | Documentation in English; source comments, test titles and deployment-script output in Chinese (the engineering team's working language); UI strings in both locale files | `repo-standards-guard.test.ts` |
| Format | No line or cell length limit; complete sentences and complete table cells (never split or truncated for a tool); tables up to five columns | Review |
| Structure | One record per section; version history in its own section | Review |
| Links | Every relative link resolves to a tracked file | `repo-standards-guard.test.ts` |
| Figures | Static PNG or WebP only; every figure is referenced; every Mermaid source is rendered | `repo-standards-guard.test.ts` |
| Versions | Figures carry no version numbers; prose that names a component version links to `supported-versions.md`, the single source | Review |
| Privacy | No account ids, ARNs, secrets, customer names or customer network ranges | `scripts/redline-scan.sh`, review |
| Hygiene | No build output, local tooling, slides, archives or scratch files tracked | `.gitignore`, review |
| Security | Dependency advisories at high or critical severity are fixed before release | `npm audit` in CI |
| Commits | Conventional Commits in English; one concern per commit; product and documentation changes in separate commits | Review |
| Environment template | `platform/.env.example` lists exactly the platform container variables | `env-template-stack-guard.test.ts` |

Review items are checked in every pull request using the checklist in `CONTRIBUTING.md`.
