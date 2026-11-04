## What / Why

<!-- One sentence that stands on its own: what changed and why. It becomes the first line of the squash commit. -->

## Change type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor or internal cleanup (no behaviour change)
- [ ] Documentation only (no product code in this PR)
- [ ] Breaking change (migration note added to `CHANGELOG.md`)
- [ ] Dependency, runtime or engine version change (row updated in `docs/supported-versions.md`)

## Blast radius

<!-- Which callers, consumers and contracts did you check? List the modules, API routes, pages, CDK stacks or scripts that import or call what you changed, and how you confirmed they still work. "None" is acceptable only for documentation-only changes. -->

## Gates run

All gates are documented in [`docs/development.md`](../docs/development.md), section 4. Tick only what you ran locally on this exact change.

- [ ] `cd platform && npx tsc --noEmit -p tsconfig.json` (zero errors)
- [ ] `cd platform && npx vitest run` (run from `platform/`, all green)
- [ ] `cd platform && node scripts/naming-parity.mjs`
- [ ] `cd infra && npx tsc --noEmit && npm run synth-gate`
- [ ] `bash scripts/redline-scan.sh`
- [ ] `cd platform && npm run build` (`next build`, includes lint and type checking)
- [ ] Every new AWS SDK call is registered in `infra/iam/platform-taskrole-calls.json` in this same PR

## Evidence

<!-- For any change to page behaviour: the change was deployed to your own test account and accepted by driving
     the real page in a headless browser. Attach or link the screenshots / DOM evidence. API responses, logs or
     database rows are supporting detail, not the acceptance itself. See docs/development.md, section 11. -->

- [ ] UI change: headless page-driven acceptance done against a deployed test account (evidence attached)
- [ ] No UI change

## Docs updated

- [ ] `CHANGELOG.md` has a line under `[Unreleased]`
- [ ] `docs/supported-versions.md` updated (only if a runtime, engine, driver or tool version changed)
- [ ] Other affected documents under `docs/` updated in the same PR (or "not affected")

## No secrets, no identifiers

- [ ] No AWS account ids, ARNs, access keys, passwords, tokens or customer data anywhere in the diff
- [ ] No deployment-specific values (bucket names, hostnames, URLs of real environments); placeholders only
- [ ] Test fixtures use identifiers whose last twelve characters contain at least one letter
