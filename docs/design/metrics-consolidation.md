# Metrics Consolidation: Retire the "Metrics Hub" and Unify on "Data Modeling · Metric System"

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ delivered** (audit calibration of 2026-08-26: the original status header was outdated; it read "design → in implementation 2026-07-08")
> - Trigger: the "Metrics Hub (`/metrics`, the [metrics store](./metrics-store.md))" and "Data Modeling → Metric system ([data modeling](./data-modeling.md))" were found to be highly redundant, and it was decided to "take the modeling metric system as the authority and retire the Metrics Hub".
> - Red lines: **top-level design** (this platform is for users worldwide who freely fresh-clone, install and use it); **never affect other existing features**; pure consolidation without breakage; rollback possible.

## 1. Why it is redundant (factual comparison)

| Dimension | Metrics Hub `/metrics` (metrics store: `lib/metrics/service.ts`, tables `bgp-metrics`/`bgp-metric-values`) | Modeling · Metric system (data modeling: `lib/modeling/model-metrics.ts`, table `bgp-model-metrics`) |
|---|---|---|
| Metric definition | Atomic: table fqn + aggregation agg + measure column | Atomic (same) **+ derived** (references an atomic metric + modifier filters + time window) |
| Computation | Current value + dimension distribution + time trend + **value snapshot history** | Safe aggregate computation of atomic / derived metrics (value snapshot lastValue/lastComputedAt) |
| Governance attributes | format (number/currency/percent) | **Owning data domain + business definition** + unit (attached to warehouse layers / domains) |
| Positioning | An independent "metric store" + visualization | One step of warehouse modeling (layer → domain → dimension → **metric**); a definition written once and reused everywhere |

The core CRUD + value-computation capabilities **overlap heavily**; the modeling version is a superset (more: derived metrics / domains / business definitions), while the Metrics Hub adds "dimension / trend / snapshot visualization". This is a case of "the metrics store built a simple version first, then a more complete set was built during data modeling, and the two were never connected". It was ruled that the **modeling metric system** is the single center of metric definitions.

## 2. Top-level design principles (for free installation worldwide)

1. **Consolidate the entry point, do not delete the back end**: remove the `/metrics` entry from the left menu + the "More" link on the home page; **keep** the `/metrics` page file, `/api/metrics*`, `lib/metrics/service.ts` and the two tables — existing installations lose none of their historical metric data, rollback is possible, and no import dependency breaks. Consistent with how the legacy report library of the [BI report / dashboard builder](./bi-report-dashboard.md) was handled ("removed from the UI but retained").
2. **Change the data source of the home-page "Core business metrics" card**: from `/api/metrics` → `/api/modeling/model-metrics` (field-compatible: `name`/`unit`/`lastValue`). On a fresh install, the home-page metrics board of a new user from now on reflects only the **single** metric source and no longer points at the retired hub. The empty-state copy changes from "Create in Metrics Hub" to "Create in Data Modeling → Metric system".
3. **No leftover confusion on a fresh install**: after a new user clones and deploys, the left menu has only one place — "Data Modeling" — that manages metrics; the `/metrics` URL is still reachable directly (no 404, compatible with old bookmarks) but is not exposed in navigation.
4. **Zero migration-script burden**: `bgp-metrics` is not migrated automatically to `bgp-model-metrics` (different schemas, possible duplicates); existing users recreate metrics in modeling as needed. If it becomes necessary later, a separate migration tool is built (not in this phase, to avoid "guessing data").

## 3. Change list (minimal surface, revertible)

- `components/layout/routes.tsx`: delete the one line `{ key: "/metrics", label: … }` (label "Metrics Hub"). (The only navigation entry, closed off.)
- `app/page.tsx`: the Core business metrics card's `fetch("/api/metrics")` → `/api/modeling/model-metrics` (taking `d.success?d.data:d`); "More" `href="/metrics"` → `/modeling`; empty-state copy changed.
- i18n: new / changed copy added to `en.ts`.
- **Untouched**: `app/metrics/page.tsx`, `app/api/metrics/**`, `lib/metrics/service.ts`, the table definitions → all kept.

## 4. Verification (real operation of the web page, headless)

1. The left menu **no longer shows** "Metrics Hub".
2. The home-page "Core business metrics" card shows the metrics of the **modeling metric system** (total impressions / total clicks … + lastValue), and "More" goes to `/modeling`.
3. Visiting the `/metrics` URL directly still opens the page (not broken; old links remain compatible).
4. Regression: Data Modeling → Metric system create / delete / read / update / compute all work normally (unaffected).

## 5. Rollback

A `git revert` of this commit restores the menu entry and the home-page data source; the back end was never changed, so there is no data risk.
