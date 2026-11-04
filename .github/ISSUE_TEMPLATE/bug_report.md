---
name: Bug report
about: Report a defect you observed in the Kingfisher console or a deployment
title: '[BUG] '
labels: bug
---

## Symptom

<!-- What does the page show? Quote the exact text the user sees. A screenshot is welcome. -->

## Steps to reproduce

<!-- Page path -> action -> result. One step per line. -->

1. Open `/...`
2. Click `...`
3. See `...`

## Expected behaviour

<!-- What should have happened instead? -->

## Environment

- Platform version (shown in the login page footer, or `GET /api/public/version`):
- Deployment mode (`production` / `demo`):
- Home region and the execution regions involved (region names only, e.g. `eu-central-1`):
- Data-plane credential mode (`taskrole` is the default; `observe` / `enforce` are acceptance-only):
- Browser and version (for console issues):

## Additional context

<!-- Related log excerpts with identifiers removed, timing, whether the problem is reproducible. -->

---

**Red line.** Never paste AWS account ids, ARNs, passwords, tokens, secret values or customer data into an issue.
Replace them with placeholders such as `<account-id>` or `<bucket>`.
If the report concerns a security vulnerability, do not open an issue; follow [`SECURITY.md`](../../SECURITY.md) instead.
