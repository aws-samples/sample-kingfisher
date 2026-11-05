# Design — Metrics Hub / Metrics Store (Governance Depth, First-Priority Track)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 1.11.0 | Date: 2026-06-14 | Status: design → implementation → live verification
> Addresses the **metrics hub** half of the gap-analysis item "Metrics hub + data map" under the "re-check / first-priority track · governance depth" heading. The sixth item of the first-priority track.

---

## 0. Goals and positioning

One of the core capabilities of a data platform: **defining business metrics in one place** (one definition of the calculation rule, reused everywhere), so that teams stop computing "total customers", "total order amount" and the like each in their own way.

This module provides:
- **Metric definition**: abstract a business metric as "table + aggregation + measure column + optional time dimension + unit / format", stored centrally with a single calculation rule.
- **Metric computation**: execute the aggregation SQL safely on Redshift to obtain the **current value**; if a time dimension column is configured, also return the **trend along the time dimension**.
- **Value snapshots**: every computation writes one (time, value) snapshot, accumulating the historical trend of **how the metric changes over time**.
- **Metrics dashboard**: the front-end "Metrics Hub" page shows every metric as a card with its current value + a mini trend, and supports create / refresh / details.

Reused existing capabilities: identifier allow-list + literal escaping (the security practice of the quality engine, see the [quality rules design](./quality-rules-scoring-sla.md)); the unified Redshift admin execution identity (revision 1.6.1); table selection by catalog FQN.

---

## 1. Metric model

`bgp-metrics` (DynamoDB, pk constant `"metric"`, sk = metricId):

| Field | Description |
|------|------|
| `metricId` | ulid |
| `name` | metric name (e.g. "Total customers") |
| `description` | description |
| `fqn` | the data table FQN (`bgp-redshift.<db>.<schema>.<table>`) |
| `agg` | aggregation: `count` / `count_distinct` / `sum` / `avg` / `min` / `max` |
| `measureColumn` | measure column (may be empty for `count`; required for the others) |
| `dimensionColumn` | optional: group-by dimension column (e.g. `region`) → the computation returns the distribution by dimension |
| `timeColumn` | optional: time column (date/timestamp) → the computation returns the daily trend |
| `unit` | unit (e.g. "units", "yuan", "%") |
| `format` | display format: `number` / `currency` / `percent` |
| `lastValue` | ⚠️ (audit addendum, 2026-08-26) the current value of the most recent computation (service.ts:45) |
| `lastComputedAt` | ⚠️ (audit addendum, 2026-08-26) the time of the most recent computation (service.ts:46; the card's "computed at" reads this) |
| `createdBy`,`createdAt`,`updatedAt` | audit |

> This release **does not support free-form filter SQL** (injection surface + rule complexity); filtering / complex rules are a follow-up (to be done with structured conditions + parameterization).

`bgp-metric-values` (pk = metricId, sk = ts ISO): every computation writes a `{ metricId, ts, value }` snapshot; `Query(pk=metricId, desc)` fetches the most recent N points for the "metric value history trend".

---

## 2. Aggregation SQL generation and security

`lib/metrics/service.ts`, reusing the style of the quality engine's security tooling:
- **Identifiers** (schema / table / column): validated against the allow-list `^[A-Za-z_][A-Za-z0-9_]*$` and then wrapped in double quotes; anything invalid is refused.
- Aggregation expressions:
  - `count` → `COUNT(*)`
  - `count_distinct` → `COUNT(DISTINCT "col")`
  - `sum|avg|min|max` → `SUM|AVG|MIN|MAX("col")`
- **Current value**: `SELECT <aggExpr> AS value FROM "schema"."table"`.
- **Dimension distribution** (with `dimensionColumn`): `SELECT "dim" AS k, <aggExpr> AS value FROM tbl GROUP BY 1 ORDER BY value DESC LIMIT 50`.
- **Time trend** (with `timeColumn`): `SELECT "tcol"::date AS d, <aggExpr> AS value FROM tbl GROUP BY 1 ORDER BY 1 DESC LIMIT 60` (the most recent 60 time points, displayed in ascending order by the front end).
- Execution: `ExecuteStatement` (`WorkgroupName` / `Database` from env, `SecretArn` = the unified admin secret, reusing `getRedshiftSecretArn`), polling for the result. **Read-only aggregation.**

---

## 3. Computation and snapshots

`computeMetric(metricId)`:
1. Read the definition → generate and execute the current-value SQL → `value`.
2. If there is a `dimensionColumn` → dimension distribution `[{k,value}]`.
3. If there is a `timeColumn` → time trend `[{d,value}]` (ascending).
4. Write one value snapshot `(ts=now, value)` to `bgp-metric-values`.
5. Read the most recent 30 snapshots → `snapshots` (metric value history).
6. Return `{ value, computedAt, dimension?, series?, snapshots }`.

`computeAll()`: for every metric compute only **the current value + a snapshot + the recent snapshot series** (no dimension / time distribution; used for the dashboard's batch refresh), returning `{ [metricId]: {value, computedAt, snapshots} }`. Error isolation: a failed computation of one metric does not affect the others (that metric returns `error`).

---

## 4. API

- `GET /api/metrics` lists definitions (readable when logged in); `POST` creates (platform administrators).
- `GET /api/metrics/[id]`; `PUT` (edit), `DELETE` (delete) — platform administrators.
- `POST /api/metrics/[id]/compute` computes one metric (including dimension / time trend + snapshot) — platform administrators (it executes on Redshift).
- `POST /api/metrics/compute-all` batch-computes current values + snapshots for the dashboard — platform administrators.

Reads are open to every logged-in user; create / delete / compute are restricted to platform administrators (consistent with quality / classification: executing on Redshift is a governance management action).

---

## 5. Front-end "Metrics Hub" page `/metrics`

- A new "Metrics Hub" entry in the left menu.
  <br>⚠️ (audit calibration, 2026-08-26) this navigation entry **has been removed**: the [metrics consolidation design](./metrics-consolidation.md) folded "Metrics Hub" into "Data Modeling → Metric system" and removed the navigation entry, keeping the page / API / data so that it can be rolled back (comment at components/layout/routes.tsx:91). The `/metrics` page still exists but is no longer reachable directly from the left menu.
- **Card dashboard**: one card per metric — name, current value (formatted by format + unit), mini trend of recent snapshots, the owning table, computed-at time; at the top "Refresh (Compute all)" and "New metric".
- **New metric** form: name / description / table (catalog FQN) / aggregation / measure column / dimension column (optional) / time column (optional) / unit / format.
- **Details drawer**: the definition details + a standalone "Compute" + dimension distribution (bars / table) + time trend + snapshot history.

Formatting: `currency` → thousands separators + unit; `percent` → value × 100? No — the metric value is the raw aggregation value; percent only appends a `%` suffix for display (the definer guarantees the rule). `number` → thousands separators.

---

## 6. Security / red lines

- Two new tables (BgpDatabaseStack); the Platform deployment **must** carry `-c openmetadata-url`.
- The aggregation SQL consists solely of allow-listed identifiers + fixed aggregation keywords, with no free-form user SQL; read-only execution.
- Create / delete / compute are restricted to platform administrators; audited end to end (best-effort).

## 7. Live verification (a test account / us-east-1, headless browser)

Based on the real tables `customers` (customer_id/name/region/city/segment/signup_date, 200 rows) and `orders`:
1. admin creates metrics: "Total customers" = `count` on customers; "Customers (by region)" = count + dimension `region`; (optionally) "Order count" = count on orders.
2. Click "Refresh" to compute all → the dashboard cards show real values (total customers 200).
3. Open the details → the dimension distribution (count per region).
4. Screenshot assertions: a card with the metric name + the value 200 appears.
5. Clean up the test metrics and snapshots.

## 8. Known limitations / follow-ups

1. This release aggregates a single table with a single aggregation; cross-table JOIN metrics, ratios (ratio=A/B) and free-form filtering are a follow-up (structured conditions + parameterization).
2. Computation is manual / on demand; scheduled refresh + threshold alerts are a follow-up.
3. The **data map** (asset panorama: catalog + lineage + classification + quality score + aggregated metric view) is the next module (revision 1.12.0).
4. Metrics apply to physical tables and are not isolated per workspace (consistent with classification / quality).
