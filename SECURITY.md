# Security Policy

## Supported versions

Security fixes are released as patch versions of the latest release line and are announced in [`CHANGELOG.md`](CHANGELOG.md).
The runtimes, engines, drivers and tools that a release pins are listed in [`docs/supported-versions.md`](docs/supported-versions.md).
Deployments should run the latest tagged release; branch heads are not supported.

## Reporting a vulnerability

- Report suspected vulnerabilities privately through a **GitHub security advisory** on this repository
  (Security tab, "Report a vulnerability"). Do not open a public issue or pull request.
- Include the affected component or page, a reproduction or proof of concept, the impact you expect and any suggested fix.
- Maintainers acknowledge the report, triage it, and fix confirmed defects in a patch release.
  Reporters are credited in the changelog unless they prefer otherwise.
- Vulnerabilities in AWS services themselves should be reported to AWS Security, not here.

## What not to include

Never include AWS account ids, ARNs, access keys, passwords, tokens, secret values or customer data in a report.
Use placeholders such as `<account-id>` and `<bucket>`, and remove identifiers from log excerpts before sharing them.

## Dependencies

- Production dependencies are checked with `npm audit --omit=dev --audit-level=high` in continuous integration for both `platform/` and `infra/`. A high or critical advisory fails the job.
- Transitive dependencies with a published fix that the direct dependency has not yet adopted are pinned with the `overrides` field of the affected `package.json`.
- Advisories without a published fix are tracked until a fix is available and are assessed for exploitability in the deployed form of the platform.
- Lock files are committed and installs use `npm ci`, so builds are reproducible.

## Security model

The trust boundary, identity and access design, network isolation, encryption, auditing and the secure development process
are described in [`docs/security.md`](docs/security.md), together with an operational hardening checklist for deployments.
