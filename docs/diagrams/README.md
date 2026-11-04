# Diagrams

This folder holds every figure used by the Kingfisher documentation, together with the sources needed to
regenerate it. Figures are committed as static PNG files so that they render everywhere, including offline
and in viewers without Mermaid support.

- `*.png` in this folder: the rendered figures referenced from `README.md`, `docs/*.md` and `docs/design/*.md`.
- `src/*.mmd`: Mermaid sources for flow, sequence and structure diagrams.
- `src/render_aws_arch.py` and `src/aws-icons/`: the Python renderer and the AWS Architecture Icons used by
  the service-view figures.

## Figures used by the documentation

| File | What it shows | Source |
|---|---|---|
| `aws-overview.png` | AWS service view: entry chain, one control plane in the home region, one data plane per execution region | `src/render_aws_arch.py` |
| `aws-control-plane.png` | Control-plane stacks in the home region, grouped into layers | `src/render_aws_arch.py` |
| `aws-execution-region.png` | Execution-region data plane (`BgpExecEnv-<slug>-*` stacks) and the single write-back channel to the home region | `src/render_aws_arch.py` |
| `aws-multi-region.png` | Multi-region mechanics: execution scope, explicit place, no cross-region reads, autonomous scheduling per region | `src/render_aws_arch.py` |
| `mr-overview.png` | Deployment shape: home region, execution regions and the private link back | `src/mr-overview.mmd` |
| `mr-control-plane.png` | Control-plane component layering | `src/mr-control-plane.mmd` |
| `mr-exec-env-stacks.png` | Execution-region stack group and its dependencies | `src/mr-exec-env-stacks.mmd` |
| `mr-request-chain.png` | Request chain from the browser through CloudFront, ALB, middleware, route and guards to a regional AWS client | `src/mr-request-chain.mmd` |
| `mr-flow-add-exec-env.png` | Sequence for adding an execution region through the web wizard | `src/mr-flow-add-exec-env.mmd` |
| `mr-flow-sync-run.png` | Sequence of a synchronization run through Glue in the target region | `src/mr-flow-sync-run.mmd` |
| `mr-flow-scheduling.png` | Publishing a workflow to the regional MWAA Serverless and dispatching platform actions | `src/mr-flow-scheduling.mmd` |
| `mr-flow-genbi.png` | Natural-language question answered against the target region's warehouse or lake | `src/mr-flow-genbi.mmd` |
| `mr-data-flow.png` | Data flow from sources through integration and storage to metadata and consumption | `src/mr-data-flow.mmd` |
| `mr-module-exec-env-lifecycle.png` | Execution environment lifecycle state machine | `src/mr-module-exec-env-lifecycle.mmd` |
| `lake-binding-current-vs-target.png` | Lake bucket routing: current one-bucket binding versus the target route table per region | `src/lake-binding-current-vs-target.mmd` |
| `lake-data-model.png` | Lake bucket routing data model: route records and the declaring fields on jobs, syncs and Flink jobs | `src/lake-data-model.mmd` |
| `lake-route-resolution.png` | Lake route resolution: alias, bucket or namespace to a hit, a miss or an ambiguity, never a silent fallback | `src/lake-route-resolution.mmd` |
| `lake-job-submit-sequence.png` | Job save and submit: route selection, conflict check, per-bucket preflight, one Spark catalog per bucket | `src/lake-job-submit-sequence.mmd` |

Where each figure is embedded: `README.md` (overview), `docs/architecture.md` (service views and flows),
`docs/design/multi-region-execution.md` (multi-region figures) and `docs/design/lake-bucket-routing.md`
(lake figures).

## Rendering

Mermaid sources render with mermaid-cli, from this folder:

```bash
cd docs/diagrams
mmdc -i src/<name>.mmd -o <name>.png -b white -w 1000 -s 3
```

The AWS service-view figures render with the Python script, which writes the four `aws-*.png` files into this
folder regardless of the working directory:

```bash
python3 docs/diagrams/src/render_aws_arch.py
```

Tooling (mermaid-cli with a Chromium, Pillow and a CJK-capable font) is listed in
[`../supported-versions.md`](../supported-versions.md). Mermaid labels must not contain `;`, which Mermaid
treats as a statement separator.

## Rules

1. Diagrams carry no version numbers. Write the service or product name (Managed Flink, RDS MySQL,
   OpenMetadata, AWS Glue) and nothing else; versions live only in `docs/supported-versions.md`.
2. Static PNG only. Markdown never embeds live Mermaid; change the `.mmd` source, re-render, and commit both.
3. No real account IDs, resource identifiers, ARNs or URLs in any figure; use placeholders or service-level names.

## Housekeeping

Every figure in this folder is referenced by at least one Markdown document, and every `.mmd` source has a rendered PNG.
When the last reference to a figure is removed, delete the PNG and its source in the same commit.
The repository guard test checks both rules.
