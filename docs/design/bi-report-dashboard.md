# BI Report / Dashboard Builder (the final piece of the data-consumption capability group)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Status: **v1 delivered and verified online (2026-07-06, ECS task definition :11→:13, headless acceptance 16/16 green)**. The scope has been decided (see §9). Phase-2 candidates are listed in §10.
> 🔴 **Correction of 2026-09-05**: the `dataapi` data source (a reference to a DataApi) was retired together with the Data Service feature — the type is kept for compatibility with existing records, the editor no longer offers it, and executing it returns 410 "Data service retired"; `renderSql` / `coerceParams` moved to `lib/sql/param-render.ts` (BI filter injection still reuses them; behavior is byte-for-byte unchanged). Basis: the multi-region execution [specification](./multi-region-execution-spec.md), revision 3.23, section 3.9c, and the first work package of the multi-region program.
> Implementation locations: `lib/bi/{types,query,reports,dashboards}.ts` · `app/api/bi/{reports,dashboards,query,export}/**` · `app/bi/page.tsx` · `components/bi/WidgetRenderer.tsx` · `components/dashboard/charts.tsx` (new BarChart/MetricCard) · two tables `bgp-bi-{reports,dashboards}`.
> **One real bug fixed during acceptance**: the first version of filter injection mistakenly used the DataService enum type (bare identifier substitution), so `WHERE region = East` reported "column not exist" → changed to validate against the allow-list and then escape as a string literal (§5.1 already contains the correct approach).

## 0. In one sentence

Let users combine "one query" + "one chart type" into a reusable **report (widget)**, assemble several reports into a **dashboard** and persist it, so that it can be reopened repeatedly, refreshed in sync with filters, and exported to CSV — reusing the platform's existing query / chart / storage / RBAC foundation with almost zero privilege expansion. It is the last piece of the data-consumption capability group in the benchmark against a leading cloud data-development suite, completing the consumption loop "modeling → ask-your-data → reports → dashboards".

## 1. Background and positioning

- The product roadmap (phase "differentiating capabilities") marked this builder as the "★ next candidate", reserved a design-module slot for it, and stated "reuse Data Service + GenBI" as the key dependency.
- The platform already has: data warehouse modeling ([data modeling](./data-modeling.md)), the metrics hub ([metrics store](./metrics-store.md)), Ask-Your-Data GenBI ([AgentCore GenBI](./agentcore-genbi.md) / [asynchronous execution](./genbi-async-execution.md)), the Data Service (DataService), and alerting / the ops dashboard ([intelligent ops alerting](./intelligent-ops-alerting.md), which already composes panels from the antd grid + hand-drawn SVG charts). **The report builder is not built from scratch; it turns these capabilities into a "visual consumption front end".**
- Current gap (confirmed by exploration): the platform has **no** persistence model or page at all for report/dashboard/widget; `components/dashboard/charts.tsx` is only a **pure UI component** library reused by the home page / ops / observability and has no concept of a "report the user can save".

## 2. Design goals and constraints (red lines)

### 2.1 Goals

1. Users can create a **report widget**: choose a data source → obtain a result set → choose (or auto-recommend) a chart type → name and save.
2. Users can create a **dashboard**: arrange several widgets in a grid layout → save → on open, fetch data concurrently and render.
3. Dashboards support **filters** (date / dropdown); changing a filter refreshes every widget on the dashboard in sync (parameter injection).
4. **CSV export** is supported (the result of a single widget).
5. Reports / dashboards are **workspace-level shared assets**, isolated by project + role (viewer reads / editor writes).

### 2.2 Constraints (mandatory; violating any of them is a failure)

- **Reuse the query path, do not rebuild it**: every query goes through the existing pure functions `runSelect` (Redshift) / `runSelectAthena` (Athena), under the unified contract `SqlRunResult`.
- **Masking cannot be bypassed**: any direct-query result **must pass through `maskRows`** before it is returned to the front end (otherwise sensitive columns are exposed). This is the only price of bypassing DataService for direct queries, and it must be paid. See the approach in `data-service/execute.ts:64`.
- **Read-only**: all queries must be read-only (SELECT/WITH); the underlying `sanitizeSelect`/`sanitizeReadOnly` already enforce this, and no new write surface is added.
- **Zero new third-party chart / layout / drag-and-drop libraries**: continue the repository culture (the comments in `charts.tsx`/`MiniChart.tsx` state explicitly that this avoids conflicts with antd v6). Charts are entirely hand-drawn SVG + `--bgp-*` CSS variables; layout uses antd `Row/Col`. **No D3/echarts/recharts/react-grid-layout.** (Rationale and fallback path in §7.)
- **Consistent theming**: colors of new chart components are always `var(--bgp-*, fallback)`, categorical colors use `--bgp-s1..s4` (already checked for color-blindness / contrast); hard-coded colors are forbidden.
- **Network red line**: **no login-free public sharing links**; dashboards are shared only within the logged-in session according to RBAC. Public sharing is left to a dedicated phase-2 security design (signed token + row cap + no sensitive columns + rate limiting).
- **i18n**: all Chinese UI copy goes through `t()`; `en.ts` is completed to 0 missing entries; business data (table names / column names / query results) is not translated.
- **No hard-coding**: engine targets (workgroup/database/catalog) come from the `GENBI` configuration (env) and are not written into code.

## 3. Option selection (three decisions already made)

| Decision point | Chosen | Alternative (not chosen) | Rationale |
|---|---|---|---|
| **Data source** | Free SQL + DataService reference + GenBI ask-your-data materialization (the three unified) | Free SQL only / add metric-system queries | All three sources reduce to "query spec → SqlRunResult" and share one rendering + masking pipeline, maximizing reuse. Metric-system queries are left to phase 2. |
| **Layout** | Configuration-style grid (antd Row/Col, span 6/8/12/24) | Real drag-and-drop with react-grid-layout | Zero new dependencies, consistent with the ops dashboard, short schedule and low risk. The layout JSON is stored as `{i,x,y,w,h}`, so phase 2 can upgrade smoothly to drag-and-drop. |
| **Sharing** | Not built; RBAC sharing inside the platform only | Public read-only links | Keeps the network-privacy red line; zero extra attack surface. |

## 4. Core concepts and data model

### 4.1 Three data sources (unified into one `QuerySpec`)

A widget does not store a result snapshot but **the spec of how to fetch the data** (so it can be refreshed). The three `source` kinds converge on one execution entry point:

```ts
type WidgetSource =
  | { kind: "sql";      engine: "redshift" | "athena"; sql: string }       // 自由 SQL
  | { kind: "dataapi";  apiId: string; params?: Record<string,string> }    // 引用已发布 DataApi
  | { kind: "genbi";    engine: "redshift" | "athena"; sql: string };      // GenBI 问数固化(存生成的 SQL)
```

- The `sql` / `genbi` kinds are **essentially the same** (both are "engine + read-only SQL"); only the origin marker differs (genbi records "generated by AI", which helps display and re-editing). Both execute through `executeBiQuery` (§5.1).
- The `dataapi` kind goes through the existing `executeDataApi` (getting parameter validation + injection-safe rendering + masking + rate limiting for free); the widget stores only `apiId + default parameters`.
- **GenBI materialization does not store a rows snapshot**: `GenBiResult` is volatile, and the history table does not store full rows either; materialization takes only its `sql` (+ engine) and reruns on refresh. This avoids "opening a report and seeing numbers from three months ago".

### 4.2 Widget (report) = query spec + visualization spec

```ts
interface BiReport {
  projectId: string;      // pk —— RBAC 隔离
  reportId: string;       // sk —— ULID
  name: string;
  description?: string;
  source: WidgetSource;   // 取数 spec(见上)
  viz: {
    chart: ChartType;     // "table"|"metric"|"bar"|"line"|"pie"|"barh"|"gauge"  (在 genbi ChartType 上扩展)
    xField?: string;      // 维度列
    yField?: string;      // 度量列
    auto?: boolean;       // true=用 suggestChart 自动选图
  };
  createdBy?: string; createdAt: string; updatedAt: string;
  version: number;        // 乐观锁
}
```

### 4.3 Dashboard = layout + widget references + filters

```ts
interface BiDashboard {
  projectId: string;      // pk
  dashboardId: string;    // sk —— ULID
  name: string;
  description?: string;
  layout: Array<{ i: string /*reportId*/; x: number; y: number; w: number; h: number }>; // 兼容 react-grid-layout 结构,便于二期升级
  filters?: Array<{        // 仪表盘级筛选器
    key: string;           // 注入 SQL 的占位名 {{key}}
    label: string;
    type: "date" | "select";
    options?: string[];    // select 白名单(防注入:命中即代入,同 DataService enum)
    default?: string;
  }>;
  createdBy?: string; createdAt: string; updatedAt: string;
  version: number;
}
```

- **Widgets are referenced, not copied**: `layout[].i` stores the reportId; the dashboard stores only layout + references, and widget definitions live independently in `bgp-bi-reports`. One widget can be reused by several dashboards.
- **Filter linkage**: filter values are injected into widget SQL as `{{key}}` (effective only for widgets that declare the corresponding placeholder). Injection uses the same safe rendering as DataService (escaping in value position / allow-list for select); no raw concatenation.

### 4.4 Two DynamoDB tables

| Table | pk | sk | Description |
|---|---|---|---|
| `bgp-bi-reports` | `projectId` | `reportId` (ULID) | Definition of a single report widget. `Query(pk=projectId)` naturally yields the per-project list. |
| `bgp-bi-dashboards` | `projectId` | `dashboardId` (ULID) | Dashboard (layout + widget references + embedded filter array). |

- **Key-based isolation** (`pk=projectId`) rather than a fixed partition: reports are expected to be numerous and strongly read per project, so `Query(pk=projectId)` is efficient and avoids "Query the whole table and then filter in memory" (unlike low-volume configuration such as alert rules).
- Inherits `hardened`: PAY_PER_REQUEST + CMK encryption + PITR 35d + RETAIN. **No TTL** (long-lived assets).
- IAM needs no change: the taskRole in `platform-stack.ts` already covers full CRUD with the `arn:...:table/bgp-*` wildcard.
- **Not wired to version-service**: that service hard-codes its primary key `userId="default-user"` (single tenant), which is incompatible with `pk=projectId`; the first release uses an embedded `version` optimistic lock (copied from `alerting/rules.ts`). If "report version history" is wanted in phase 2, the version-service partition key is parameterized then.

## 5. Detailed design

### 5.1 Query pure function `executeBiQuery` (lib/bi/query.ts)

The unified execution entry point and the query core of the whole module. **It copies the pipeline of `data-service/execute.ts`, but its inputs are the widget's `WidgetSource` + the run-time filter values**:

```
executeBiQuery(source, filterValues, identity, correlationId) -> { columns, columnTypes?, rows, rowCount, elapsedMs, maskedColumns }
  1. source.kind === "dataapi":  load DataApi -> executeDataApi(api, filterValues, identity, cid)  // already includes the full security set
  2. source.kind in ("sql","genbi"):
     a. if the SQL has filter placeholders {{key}} and filterValues are provided -> render with the same safe renderSql as DataService (value position / allow-list)
     b. engine branch: athena -> runSelectAthena(sql);  redshift -> runSelect(sql, GENBI.workgroup, GENBI.database)
     c. **must pass maskRows** (the masking constraint): columns.map(name=>({name})) + rows + sql + database + identity
     d. return the unified contract
```

Key points:
- **The masking constraint is absolute**: the `sql`/`genbi` direct-query kinds **must** add `maskRows` in step c (the `dataapi` kind is already masked inside `executeDataApi`). This is the only place in the module that "bypasses DataService", so masking must be done here.
- Row cap: `runSelect`/`runSelectAthena` already cap at `GENBI.maxRows` internally, so a widget cannot blow up memory.
- The 60-second wall is irrelevant: widget queries are **a single SQL statement** (seconds), not an agentic multi-turn run, so they never trigger the CloudFront 60-second timeout that GenBI hits. Asynchrony is involved only at edit time for "AI-generated widgets" (see 5.5).

### 5.2 CRUD service layer (lib/bi/reports.ts + dashboards.ts)

Copies the skeleton of `alerting/rules.ts`; the difference is key-based isolation with `pk=projectId`:

- `listReports(projectId)` = `Query(pk=projectId, ScanIndexForward=false)` (newest first)
- `getReport(projectId, reportId)` = `Get(pk,sk)`, O(1)
- `createReport(input, {projectId, createdBy})` = validate source/viz → `Put`, version=1, reportId=ulid()
- `updateReport(projectId, reportId, patch, expectedVersion)` = `Update` + `ConditionExpression: "version = :curV"`; on conflict throws `OptimisticLockError`
- `deleteReport(projectId, reportId)` = `Delete`
- dashboards.ts is isomorphic. **Check whether a report is referenced by a dashboard** before deleting it? First release: deletion is allowed; when rendering, the dashboard shows a "Report deleted" placeholder for a stale reportId (weak reference, no foreign-key constraint, avoiding cross-table transactions).

Validation: source.kind allow-list, engine allow-list, sql must start with SELECT/WITH (a lightweight pre-check; the deep guard is at execution time); viz.chart allow-list.

### 5.3 API routes (app/api/bi/**)

| Route | Method | Guard | Description |
|---|---|---|---|
| `/api/bi/reports` | GET | requireProject viewer | List |
| `/api/bi/reports` | POST | requireProject editor | Create, 201, recordAudit |
| `/api/bi/reports/[id]` | GET | guardResourceAccess viewer | Get one |
| `/api/bi/reports/[id]` | PUT | guardResourceAccess editor | Update, optimistic lock 409 |
| `/api/bi/reports/[id]` | DELETE | guardResourceAccess editor | Delete |
| `/api/bi/dashboards` (+/[id]) | as above | as above | Dashboard CRUD |
| `/api/bi/query` | POST | requireProject viewer | **Query / preview**: body={source, filterValues?} → executeBiQuery → {columns,rows,...}. Used by both edit-time preview and dashboard rendering |
| `/api/bi/export` | POST | requireProject viewer | CSV export: same as query but returns text/csv (CSV assembled server-side, reusing executeBiQuery) |

- All routes `export const dynamic = "force-dynamic"`; `apiOk/apiError`; write operations call `recordAudit(req, "bi.report.create", {...}).catch(()=>{})`.
- **`/api/bi/query` uses the viewer permission**: querying is a read operation, and a viewer who can see the dashboard can fetch its data; but if the query's source contains raw SQL, the caller must be a member of this project (guaranteed by requireProject) and the result must pass maskRows (guaranteed by executeBiQuery).

### 5.4 Front end (app/bi/page.tsx)

One page with three views (switched with antd Tabs or Segmented): **Reports / Dashboards / Editor**.

**Report editor** (Drawer or a dedicated area):
1. Data source Segmented: Free SQL / Data Service / AI ask
   - Free SQL: engine Segmented (Redshift/Athena) + Monaco SQL editor (`@monaco-editor/react` is already installed)
   - Data Service: dropdown of published DataApis + default parameters
   - AI ask: type a question → call GenBI (compatible with GENBI_ASYNC polling) → get back sql + chart suggestion → store as source.genbi
2. "Preview" button → POST `/api/bi/query` → result table + chart auto-selected by `suggestChart`
3. Chart type Segmented (table / metric card / bar / horizontal bar / line / pie / gauge) + dimension / measure column pickers (or auto)
4. Name and save → POST `/api/bi/reports`

**Dashboard editor**:
1. Tick widgets from the report library to add them
2. Set the column span of each widget (span 6/8/12/24) + reorder (antd move up / move down; no drag-and-drop library)
3. Define filters (date / dropdown + the placeholder name to inject)
4. Save → POST `/api/bi/dashboards`

**Dashboard view**:
- `Row gutter=[16,16]` + one `Col span` + `Card` per widget
- Filter bar at the top; changing a value → call `/api/bi/query` (with filterValues) concurrently for each widget to refresh
- Top-right of each widget card: CSV export / refresh / edit

**WidgetRenderer** (components/bi/WidgetRenderer.tsx): dispatches by `viz.chart`:
- `table` → antd Table (themed automatically)
- `metric` → new MetricCard
- `bar` → new themed BarChart (vertical bars)
- `barh` → reuse BarList (horizontal bars)
- `line` → reuse TrendArea
- `pie` → reuse Donut
- `gauge` → reuse Gauge

### 5.5 Chart additions (components/dashboard/charts.tsx)

Follows the charts.tsx paradigm (`var(--bgp-*, fallback)` + ChartTooltip hover + zero-dependency SVG):

1. **`BarChart` (themed vertical bar chart)**: move the vertical bars of `MiniChart.tsx` into charts.tsx, change the hard-coded `#1677ff` color to `var(--bgp-primary)` / categories to `--bgp-s1..s4`, and add ChartTooltip hover (bar highlight + floating value). Single series in the first release; grouped / stacked left to phase 2.
2. **`MetricCard` (numeric metric card)**: big number + title + optional subtitle / trend arrow. Unifies the hand-rolled `Card+Statistic` currently used on various pages. Uses `--bgp-*`.

`suggestChart` (genbi/chart.ts) is reused directly for "auto chart selection". Pie / line / horizontal bar / gauge are already in place.

### 5.6 Materializing a GenBI answer into a widget

- The editor's "AI ask" branch calls `/api/genbi/ask` (with GENBI_ASYNC=1 it returns a taskId within seconds → poll `/api/genbi/tasks/[id]`, the same logic as the genbi page).
- With the `GenBiResult` in hand: `source = { kind:"genbi", engine, sql: result.sql }`, and `viz` uses `result.chart` (type/xField/yField).
- Store the SQL, not a rows snapshot (refreshable); when `columnTypes` is missing on the Redshift path, the chart infers from values (chart.ts already has the fallback).

## 6. Impact inventory (proving no effect on other features)

- **Pure additions**: 2 new tables, `lib/bi/**`, `app/api/bi/**`, `app/bi/page.tsx`, `components/bi/**`.
- **charts.tsx**: only **adds** the two exports BarChart/MetricCard, without changing existing component signatures → zero impact on the home page / ops / observability.
- **routes.tsx**: the `g-analytics` group of menuTree gains one leaf `{ key:"/bi", label: … }` (label "Report Builder").
- **Read-only reuse**: runSelect/runSelectAthena/executeDataApi/maskRows/suggestChart/renderSql are all called read-only; their behavior is not changed.
- **Not touched**: the GenBI execution chain (only called through its existing API as a widget data source), DataService (read-only reference), alerting / modeling / governance and so on.
- IAM: no change (the bgp-* wildcard). Standing cost: none added (queries on demand, DynamoDB on-demand).

## 7. Why not D3 / echarts (the full argument for the no-chart-library constraint, plus the fallback path)

Conclusions after reviewing the complete d3js.org gallery:

1. **The charts BI reports need are fully covered by hand-drawing**: bar / stacked bar / line / area / pie / donut / horizontal bar / scatter / heat map / KPI / table — all can be drawn with SVG rectangles + scales. Where D3 really saves effort is **force-directed graphs / Sankey / chord / geographic projections and maps / sunburst / treemaps**, and those are **almost never used in operational BI** (they belong to data journalism / research visualization).
2. **D3 manipulates the DOM imperatively** (the official site says "without the overhead of a virtual DOM"), which conflicts with React's declarative model and requires a useRef+useEffect bridge.
3. **It breaks theming**: D3 sets colors imperatively and cannot recognize the `--bgp-*` variables of the 12 skins, so every skin change needs a redraw (= amplifying the hard-coded-color pitfall of MiniChart).
4. **It violates the repository's zero-chart-library culture** (avoiding antd v6 conflicts / bundle size).

**Fallback path (written into the phase-2 extension points)**: D3 is modular. If advanced charts whose **layout algorithms are painful** — heat maps / treemaps / Sankey / maps — are really needed later, import only the corresponding **pure-math submodules** (`d3-hierarchy`/`d3-geo`/`d3-sankey`/`d3-scale`) to compute coordinates, while **rendering still uses React + `--bgp-*`** — theming follows automatically and the DOM is not touched. The only thing to avoid at all costs is `d3-selection`. In short: "use D3 as a math library, not as a rendering library".

## 8. Acceptance (headless web, mandatory)

Everything is done by really operating the web pages and really running until data is returned (the gold-standard dataset, e.g. orders=100000):

1. **Create report — free SQL**: write `SELECT region, count(*) FROM ... GROUP BY region` (Redshift/Athena) → preview returns data → choose bar chart → save → visible in the report library.
2. **Create report — Data Service reference**: choose a published DataApi → preview returns data → save.
3. **Create report — AI ask materialization**: ask "order count by region" → GenBI returns SQL + chart → materialize into a widget → save → refresh still returns data (proving that SQL is stored, not a snapshot).
4. **Assemble a dashboard**: tick 3 widgets → configure grid spans → save → open and render the 3 charts concurrently.
5. **Filter linkage**: add date / region filters → change values → the widgets on the dashboard refresh (the filter values were injected into the SQL; the executed SQL with the condition can be checked on the AWS side).
6. **CSV export**: export a widget → download a CSV with header + data.
7. **No unmasked data** (the masking constraint): build a widget on a table with sensitive columns → a user without a grant sees masked values (consistent with DataService/GenBI).
8. **RBAC isolation**: a viewer can read but not modify (modification fails with 403); reports of another project are not visible.
9. **Optimistic lock**: two concurrent edits of the same report → one succeeds, one gets 409.
10. **Consistent theming**: switch 2–3 skins; bar chart / metric card colors follow (screenshots).
11. **i18n**: switching to English leaves 0 Chinese residue; the default Chinese regression passes.
12. **No regression**: home page / ops dashboard charts work normally (the additions to charts.tsx did not break the old components).

## 9. Decisions made (2026-07-06)

1. **Next feature = the BI report / dashboard builder** (the roadmap's ★ candidate).
2. **Data sources**: free SQL + DataService reference + GenBI ask-your-data materialization (three sources; metric-system queries left to phase 2).
3. **Layout**: configuration-style grid (antd Row/Col), no react-grid-layout; the layout JSON uses the `{i,x,y,w,h}` structure so that phase 2 can upgrade to drag-and-drop.
4. **Public sharing**: not built; RBAC sharing inside the platform only (keeping the network-privacy red line).
5. **Chart layer**: keep hand-drawn SVG + `--bgp-*`, no D3/echarts (confirmed after reviewing d3js.org); the D3 fallback is only the "pure-math submodules" approach, left to phase 2.
6. **Delivery cadence**: everything, in two phases. **v1 (this phase)** = three-source querying + configuration grid + dashboard filters + CSV export + the new bar chart / metric card + CRUD/RBAC/optimistic locking on the two tables.

## 10. Phasing

**v1 (delivered this phase, one complete acceptable round)**: all of §4/§5 + all 12 acceptance items of §8 green.

**Phase 2 (candidates, not in this phase)**:
- Metric-system data source ([metrics store](./metrics-store.md)): pick atomic / derived metrics directly to draw charts.
- Real drag-and-drop with react-grid-layout (the layout JSON is already compatible; smooth upgrade).
- Scheduled snapshots / caching (reuse MWAA to run the SQL on a schedule and store the result, so opening is instant and costs no compute).
- Image export (PNG, SVG→canvas).
- Advanced charts: grouped / stacked bars, scatter, heat map; if treemaps / Sankey / maps are needed, import the d3 math submodules as per the §7 fallback.
- Public read-only sharing (with a dedicated security design; requires approval + a network red-line review).
- Report version history (wire in version-service after parameterizing its partition key).
