# Third-Party Attribution — Network Connectivity Advisor

This module's network-connectivity **rules** (`rules.ts`) and **advisor system prompt**
(`prompt.ts`) adapt knowledge (MUST rules, the network→credentials→driver→SSL
troubleshooting order, and the error→cause catalog) from AWS's open-source agent skills.

## Source

- **Project:** AWS Agent Toolkit for AWS — Agent Skills
- **Repository:** https://github.com/aws/agent-toolkit-for-aws
- **License:** Apache License 2.0
- **Pinned commit:** `9cec2ef98ba0f81a60cccef1e5ea1cfa720a6ff1` (2026-06-29)

### Specific skills referenced

- `plugins/aws-data-analytics/skills/connecting-to-data-source/`
  - `references/network-setup.md` — VPC/subnet/SG/AZ-match/S3-endpoint/NAT rules
  - `references/troubleshooting.md` — error→cause→fix decision tree, ordering
  - `references/discovery.md` — RDS/Redshift/connection discovery heuristics
- `skills/specialized-skills/networking-and-content-delivery-skills/`
  - `configuring-vpc-endpoints-for-private-aws-service-access/` — gateway vs interface
    endpoint rules, :443 SG + private-DNS requirements

## Nature of the adaptation ("changed files" notice, per Apache-2.0 §4(b))

The content has been **adapted, not copied verbatim**:

- The original skills are written for an AWS-CLI / `call_aws` MCP execution model. We
  **kept the decision logic and MUST rules** but **discarded the CLI command shells**,
  re-implementing detection against the AWS TypeScript SDK in
  `environment-probe.ts` / `target-resolver.ts`.
- Each rule in `rules.ts` carries an `awsCitation` field pointing back to the source
  document.
- Rules are expressed in Simplified Chinese to match this platform's audience.

## License text

A full copy of the Apache License 2.0 is available at:
https://github.com/aws/agent-toolkit-for-aws/blob/main/LICENSE

This platform itself is MIT-licensed (see repository root `LICENSE`). Apache-2.0 permits
incorporation into MIT-licensed projects provided this attribution is retained.
