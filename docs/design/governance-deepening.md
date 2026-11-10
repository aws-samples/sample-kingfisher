# Design — Governance Deepening (Sensitive-Data Detection Scanner + Governance Health Score / Workbench)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Revision: 1.0 | Date: 2026-07-04 | Status: design → implementation → live verification
> - Addresses the roadmap's section 2 first-priority item **governance deepening** (capability groups: governance health score / workbench, automatic sensitive-data detection, row-level security). **This round's first phase**: automatic sensitive-data detection + governance health score / workbench.
> - **Row-level security (RLS) is scheduled for the second phase** (direction decided: both the application layer and the database layer, see section 9).

---

## 0. Goals and positioning

Fill two gaps of a leading cloud data-development suite in the existing governance system; the two close a natural loop — the "sensitive-detection coverage" produced by the scanner feeds the health score directly:

1. **Automatic sensitive-data detection (scanner)**: choose a database / schema and scan the Redshift columns with one click → **pluggable detectors** (column-name hints + value regex / checksum) identify PII / sensitive types (e-mail / credit card / IP / IBAN / international phone / credentials / names …; **general-purpose detectors first + optional regional extensions**) → produce **classification suggestions with a confidence score** (suggested level + category + maskStrategy) → only when the user **adopts them one by one or in batch with one click in the UI** are they written into the existing `bgp-data-classification`.
   - **The scanner only produces suggestions and never changes a classification on its own** (red line: AI / automation only detects and suggests; it does not replace human decisions).
   - **Built for global users: detectors are an SPI, and no single-country specialization is ever hard-coded** (see section 1).
   - Closes the TODO explicitly left in the [classification and masking design](./classification-masking.md), section 9.4: "automatic classification (PII detection) not done".
2. **Governance health score / workbench**: aggregate the scattered governance signals (classification coverage, quality score / SLA, lineage completeness, sensitive-detection coverage) **into one overall governance health score** (0–100, weighted) + per-dimension cards + an asset ranking + a **to-do workbench** (unclassified sensitive tables, tables below the quality bar, tables in SLA breach, tables with sensitive suggestions awaiting adoption). This is the "overview entry + action list" of governance.

**Reuse rather than build** (the same foundation as the [classification and masking](./classification-masking.md) and [quality rules](./quality-rules-scoring-sla.md) designs):
- Redshift execution: copy the `ExecuteStatement → poll → GetStatementResult` paradigm of `lib/quality/service.ts` ([quality rules design](./quality-rules-scoring-sla.md)) + the unified admin identity `getRedshiftSecretArn()`.
- Column metadata entry point: `introspectSchema(workgroup, database)` of `lib/genbi/schema.ts` ([AgentCore GenBI design](./agentcore-genbi.md)), which already pulls `schema/table/column/type` for the whole database.
- SQL injection protection: copy `safeIdent()` of `lib/quality/templates.ts` (identifier allow-list `^[A-Za-z_][A-Za-z0-9_]*$` + double quotes). Sample values are read from result sets; user input is never concatenated.
- Classification writes: reuse `upsertClassification()` of `lib/governance/classification.ts` + the classification / masking enumerations (L1–L4 / none|full|partial|email|hash).
- Health score data sources: reuse `getResults()` of `lib/quality/service.ts`, `listAllClassifications()`, and the lineage of `lib/governance/lineage-service.ts`.
- API / guards / audit: `apiOk/apiError`, `resolveIdentity` (`isPlatformAdmin`), `recordAudit`, fully isomorphic with `classification/route.ts` of the [classification and masking design](./classification-masking.md).

**1 new DynamoDB table** (scan run records / suggestions); the health score adds **zero new tables** (pure aggregated reads). **No OM changes.**

---

## 1. Sensitive-detection engine (detector SPI + globalization)

> - **Design red line (decided)**: the platform serves **global users**; detectors **never hard-code a single-country specialization**. The detection engine must be
> - **ignorant of "which detectors exist"** — it is only responsible for "running every detector in the registry against each column, computing the confidence, and picking the best suggestion".
> - **Adding a PII type = adding one configuration entry to the registry, with zero engine changes.** Copies the project's existing `lib/engines/{spi,registry}`
>   (engine SPI plug-ins) + `lib/versions/version-service.ts` (table-driven registry) templates.

### 1.1 Detector SPI (highly abstract; `lib/governance/sensitive/types.ts`, isomorphic pure TS)

A detector = an object that implements one unified interface; the engine depends only on this interface and knows no concrete type:

```ts
export type PiiCategory =
  | "pii" | "financial" | "credential" | "network" | "location" | "health" | "other";

export interface DetectorContext {
  columnName: string;    // 原始列名(检测器内部自行归一:小写/去分隔符)
  columnType: string;    // Redshift 数据类型(供数值/文本类判定)
  sampleValues: string[];// 抽样非空值 —— 仅存在于内存,绝不落库/出日志(见 §1.4)
}

export interface DetectorMatch {
  confidence: number;    // 0–1
  hitRate?: number;      // 值命中率(有值正则/校验的检测器)
  evidence: { nameMatched?: boolean; valueHitRate?: number; method: "name" | "value" | "name+value" | "checksum" };
}

export interface SensitiveDetector {
  id: string;            // 稳定 id:通用用裸名(email/credit_card),地区化用命名空间(national_id.us_ssn)
  label: string;        // 展示名(i18n key)
  category: PiiCategory;
  region: string;        // "global" | "US" | "CN" | "EU" | "IN" ... 默认 "global";仅作展示/过滤,引擎不据此特化
  suggestedLevel: SensitivityLevel; // 建议默认值(采纳时用户可改)
  suggestedMask: MaskStrategy;
  detect(ctx: DetectorContext): DetectorMatch | null; // 命中返回打分,不命中返回 null
}
```

**Declarative factories** cover most scenarios (column-name hints + value regex); complex logic (Luhn checksum, date parsing) uses a custom `detect`:

```ts
// 90% 的检测器用它一行声明;引擎/打分逻辑完全复用(见 §1.3)
regexDetector({ id, label, category, region, level, mask, nameHints[], valueRegex?, valueThreshold? }): SensitiveDetector
checksumDetector({ id, ..., nameHints[], validate(v: string): boolean }): SensitiveDetector // 如信用卡 Luhn
```

### 1.2 Built-in detector registry (`lib/governance/sensitive/registry.ts` — single source of truth)

The first phase ships a set of detectors that is **mainly general-purpose (global)**, keeping the scope controllable; regional detectors are included only as a few representative samples that prove "it is extensible".
`DETECTORS: SensitiveDetector[]` is the only registration point; adding a detector means adding one line here.

**General-purpose (region="global", applicable worldwide, the core of the first phase)**

| id | category | level | mask | Column-name hints | Value check |
|----|----------|-------|------|---------|--------|
| `email` | pii | L3 | email | email, mail, plus the Chinese word for e-mail address | simplified RFC regex |
| `credit_card` | financial | **L4** | full | card, credit, pan, plus the Chinese word for card number | 13–19 digits **+ Luhn checksum** (checksumDetector; valid for every card network worldwide, not "16 digits") |
| `ip_address` | network | L2 | full | ip, ipaddr, host | IPv4 **+ IPv6** regex |
| `iban` | financial | **L4** | partial | iban, account, plus the Chinese word for account number | IBAN structure (2-letter country code + check digits + BBAN) |
| `phone` | pii | L3 | partial | phone, mobile, tel, plus the Chinese words for mobile phone and telephone | **E.164**, loose (`^\+?[1-9]\d{6,14}$`) — international, not single-country |
| `credential` | credential | **L4** | full | password, passwd, secret, token, apikey, ak, sk, private_key | column-name heuristic (values are usually already hashed; no regex dependency) |
| `full_name` | pii | L3 | partial | name, fullname, contact, plus the Chinese word for full name | mainly a column-name heuristic (names have no stable cross-culture regex) |
| `postal_address` | location | L2 | partial | addr, address, street, plus the Chinese word for address | mainly a column-name heuristic |
| `dob` | pii | L3 | partial | birth, dob, birthday, plus the Chinese word for birthday | date parsing (custom detect) |

**Regional (region≠"global", optional extensions; the first phase includes only a few as samples)**

| id | region | category | level | mask | Description |
|----|--------|----------|-------|------|------|
| `national_id.us_ssn` | US | pii | **L4** | full | US SSN `^\d{3}-?\d{2}-?\d{4}$` |
| `national_id.cn_resident` | CN | pii | **L4** | full | Chinese resident identity card, 18 characters `^\d{17}[\dXx]$` |
| `national_id.in_aadhaar` | IN | pii | **L4** | full | Indian Aadhaar, 12 digits (a sample proving that regional detectors are pluggable) |

> Regional detectors and general-purpose detectors share **the same interface and the same registry**; `region` is only used for UI display / filtering and the suggestion explanation, and **the engine runs all of them alike** (no separate code path per region). Supporting any further country later = adding one line `national_id.<xx>` without touching the engine. Using **Luhn** rather than digit count for credit cards and **E.164** rather than a single-country format for phones is the concrete expression of "globalization before localization".

### 1.3 Scoring (confidence) — unified logic on the engine side; detectors do not reimplement it

For each column the engine iterates over `DETECTORS` and collects every hit with `detect()!=null`; the score is produced uniformly by the `regexDetector` / `checksumDetector` factories:

- **Column-name match** (a normalized nameHints substring hit): contributes 0.5.
- **Value hit rate** (hit rate `hitRate` over the sampled non-null values): contributes `0.5 × hitRate` (threshold `valueThreshold`, default 0.8).
- Detectors that use **column-name heuristics only** (credential/full_name/postal_address): `confidence` is capped at 0.6 ("suspected, needs human confirmation").
- **Checksum detectors** (credit_card): the Luhn pass rate is the `hitRate`, `method="checksum"`; a high pass rate gives high confidence.
- A column hit by several detectors → the one with the highest `confidence` becomes the primary suggestion; the others are recorded in `evidence.alternatives`.
- Bands: `≥0.8` = **high** (adoption recommended); `0.5–0.8` = **medium** (review recommended); `<0.5` is not emitted (noise reduction).

### 1.3 Sampling SQL (`lib/governance/sensitive-scan.ts`)

**One** sampling `SELECT` per table (instead of one per column), to reduce the number of queries:

```sql
SELECT "col1","col2",... FROM "schema"."table"
WHERE (至少一列非空的松散条件可省略) LIMIT :sampleN   -- sampleN 默认 200
```

- Column names and table names all go through the `safeIdent()` allow-list + double quotes; `sampleN` is a server-side constant (no user concatenation accepted).
- Only explicit columns are `SELECT`ed (taken from the column list of `introspectSchema`); **`SELECT *` is not used** (controllable, mappable column order).
- After reading back, the detectors run **in memory** column by column to compute the hit rate — **sample values are used only to compute hit rate and confidence; they are never persisted and never leave memory** (so that sensitive values themselves never end up in DynamoDB; a suggestion record stores only column name + type + hit rate + confidence, **never sample values**).
- Execution is **read-only** (SELECT + LIMIT); the unified admin identity is used only for stable read permission; a failure on one table (table missing / no permission) is recorded as `status:"error"` without affecting the other tables (error isolation, copied from the quality engine).
- Very large tables: only `LIMIT` sampling, no full-table scan (controllable cost); sampling bias is recorded as a known limitation.

### 1.4 Scan flow

`runSensitiveScan({ database, schema?, tables? })`:
1. `introspectSchema(WORKGROUP, database)` pulls the column metadata (optionally filtered by `schema` / `tables`; system schemas are already excluded inside the SQL).
2. For every table concurrently (`Promise.all`; the number of tables is bounded): run the sampling SQL → run the detectors column by column → collect `ColumnFinding[]`.
3. Compare every finding with the table's **existing classifications** (`getClassificationsForTable`) and set the `alreadyClassified` flag (suggestions for already classified columns are not repeated by default, but the "current vs suggested" difference is still shown).
4. Write one `scan` record (summary) + one row per finding into the new table `bgp-sensitive-findings` (see section 2), and return the structured result.

---

## 2. Data model (DynamoDB, 1 new table)

| Table | pk | sk | Key attributes |
|----|----|----|----------|
| `bgp-sensitive-findings` | `scanId` (ulid, time-ordered) | `sk` = `finding#<fqn>#<column>`; summary row `__summary__` | finding rows: `fqn`, `column`, `detectorId`, `detectorRegion`, `category`, `suggestedLevel`, `suggestedMask`, `confidence`, `band` (high/med), `hitRate`, `evidence` (map: nameMatched/valueHitRate/method/alternatives), `alreadyClassified` (bool), `adopted` (bool, default false), `ts`;<br>summary row: `database`, `schema`, `tablesScanned`, `columnsScanned`, `findingsHigh`, `findingsMed`, `scannedBy`, `ts`, `ttl` (90d) |

- **Only metadata and statistics are stored; the sampled sensitive values themselves are never stored** (section 1.3).
- `Query(pk=scanId)` fetches all findings of one scan; listing the "most recent scan" across scans uses `Scan` + in-memory sorting (low frequency, low volume, consistent with the approvals / alert conventions).
- A 90-day TTL cleans up old scans automatically (`ttl` in epoch seconds), copied from `bgp-alert-events`.
- The **adopt action** does not change the semantics of this table: adopting = calling `upsertClassification()` to write into `bgp-data-classification`, and setting `adopted=true` on that finding row (so the UI can mark it "Adopted" and avoid repeats).

CDK: created separately outside the `tables` loop of `infra/lib/database-stack.ts` (TTL required; copy the `bgp-alert-events` block). The `TABLES` constant gains `SENSITIVE_FINDINGS: "bgp-sensitive-findings"`.

> **The health score adds zero tables**: it aggregates the existing tables (classification / quality-results / lineage / sensitive-findings) in real time, with no materialized storage (the data volume is small, so a single aggregation is acceptable; materialization / trends are left for later).

---

## 3. API

### Sensitive scan (`app/api/governance/sensitive-scan/`)
- `POST /api/governance/sensitive-scan {database?, schema?, tables?}` → runs a scan (**platform administrators only**; a governance management action) → writes the findings → returns this run's result. `recordAudit("sensitive.scan")`.
- `GET /api/governance/sensitive-scan?scanId=` → fetches the result of one scan; `GET` (no parameters) → the summary + findings of the most recent scan. Reads are open to every logged-in user.
- `POST /api/governance/sensitive-scan/adopt {scanId, items:[{fqn,column,level,category,maskStrategy}]}` → **batch adoption**: `upsertClassification(classifiedBy=identity.username)` for each item + mark the finding `adopted=true` (**platform administrators only**, the same permission as setting a classification). `recordAudit("sensitive.adopt")`.

### Governance health (`app/api/governance/health/`)
- `GET /api/governance/health` → returns: overall score, per-dimension scores, asset ranking (the worst N tables), and the **to-do list** (categories: unclassified sensitive tables / tables below the quality bar / tables in SLA breach / tables with high-confidence sensitive suggestions awaiting adoption). Reads are open to every logged-in user (governance overview). Optional `?refresh=1` bypasses the in-process cache.

The authorization paradigm is identical to `classification/route.ts` of the [classification and masking design](./classification-masking.md): `resolveIdentity` → 401 unauthenticated / 403 non-administrator on writes → `apiOk/apiError` → `recordAudit` (fire-and-forget).

---

## 4. Health score definition

`lib/governance/health-service.ts` `computeHealth()` aggregates 4 dimensions (each 0–100, then weighted into the overall score):

| Dimension | Definition | Data source | Weight |
|------|------|--------|------|
| **Security / classification coverage** | classified columns / total columns of interest; bonus for the share of adopted sensitive suggestions | `listAllClassifications()` + findings of the most recent scan | 0.30 |
| **Quality health** | average quality score of the tables that have quality results (mean of `RunSummary.score`); important tables without rules pull it down | `getResults()` per table (the latest summary of each table) | 0.30 |
| **SLA compliance** | 100 − (tables in SLA breach / tables with a freshness rule × 100) | quality summary `slaBreached` | 0.20 |
| **Lineage coverage** | tables with upstream / downstream lineage / total tables | `bgp-lineage` (preferred) / OM | 0.20 |

- **Overall score** = `round(Σ dimension score × weight)`; when a dimension has no data, that dimension counts as "not covered" in the denominator (the more complete governance is, the higher the score — an incentive to fill the gaps).
- The **to-do workbench** is a by-product of the same aggregation:
  - 🔴 **Unclassified suspected-sensitive tables**: the most recent scan has a high-confidence finding but the column is not classified → "go adopt / go classify".
  - 🟠 **Tables below the quality bar**: latest `score < threshold` (default 80) → "view quality".
  - 🔴 **Tables in SLA breach**: `slaBreached=true` → "view SLA".
  - ⚪ **Tables without any governance action**: neither classification nor quality rules → "start governing".
- Every to-do item carries a `link` (to the matching tab or detail of `/governance`).
- In-process cache of ~60s (so that every screen refresh does not aggregate everything; invalidated by `?refresh=1` or after an adoption).

---

## 5. Front end

### Sensitive detection: a new "Sensitive Scan" tab on `/governance` (the sixth tab, key=`sensitive`)
- Top: database selector (default dev) + optional schema / table filter + a **"Start Scan"** button (administrators; for non-administrators the button is disabled with a hint). Loading state while scanning (staged: pulling metadata → sampling → detecting).
- **Suggestion list**: columns = table / column / detected type (with a category tag) / confidence (high green · medium orange, with an evidence tooltip: column-name hit + value hit rate) / current classification / **suggestion** (level + mask, editable in place) / action (adopt checkbox).
- **Batch adoption**: select several rows → "Adopt selected (write classifications)" → on success the rows are marked "Adopted" and the "Data Classification" tab is updated accordingly.
- Interplay with the "Data Classification" tab: after adopting, switching to the classification tab shows the classifications just written.

### Governance health: a standalone page `/governance-workbench` (in the `g-governance` group, menu entry after "Data Governance")
- Top: the **governance health score** as a big number (gauge / ring, reusing Donut/Gauge of `charts.tsx`) + 4 small cards with the dimension scores.
- **Asset ranking**: the N tables most in need of governance (ordered by the worst composite).
- **To-do workbench**: grouped cards (unclassified sensitive / below the quality bar / SLA breach / ungoverned), each item clickable.
- Reuses the existing theming CSS variables `--bgp-*` + `ChartTooltip`; consistent in light and dark mode.

Menu (`components/layout/routes.tsx`, `g-governance` children): after `/governance`, insert `{ key: "/governance-workbench", icon: <SafetyCertificateOutlined/>, label: <menu label> }`, where the label is the Chinese menu text (rendered as "Governance Workbench" in English). i18n: the new label is the menu key; add the entry to en.ts.

---

## 6. Security / red lines

- **Scanning is read-only** (SELECT+LIMIT); the unified admin identity only reads; identifier allow-list + double quotes against injection (copied from the quality engine).
- **Sampled sensitive values are never persisted, never leave memory, and never enter logs** — only metadata such as column name / type / hit rate / confidence is stored.
- Scanning / adopting is **restricted to platform administrators**; reads (results / health score) are open to logged-in users. `recordAudit` throughout.
- **The scanner never changes classifications automatically** — it only produces suggestions, and only human adoption writes `bgp-data-classification` (consistent with the red lines "advisors are permanently read-only" and "AI only detects / suggests and does not replace decisions").
- Only 1 new DynamoDB table (BgpDatabaseStack, CMK+PITR+RETAIN through the unified `hardened` option); no new standing charges (scans are triggered on demand; no timer).
- No hard-coded secrets / account values; real values live only in local `*.local.md` files that are not checked in.

---

## 7. Live verification plan (temporary account / us-east-1, headless browser)

Against the real database `dev` (which contains seeded tables such as `public.customers`):
1. As admin open `/governance` → "Sensitive Scan" → select database dev → scan → assert: the suggestion list appears, the `email` column is hit by the general-purpose `email` detector (high confidence), phone / name columns are hit by the general-purpose `phone` / `full_name` detectors; every row carries a confidence, evidence and the detector's `region` label (global/…).
2. Select several high-confidence suggestions → "Adopt selected" → switch to the "Data Classification" tab and assert: the columns just adopted have been written as classifications (level / mask equal to the suggestion).
3. Open `/governance-workbench` → assert: the governance health score is shown (number + dimension cards), the to-do workbench has entries (for example "unclassified sensitive tables" changes with steps 1 / 2), the asset ranking renders.
4. After adopting, return to the workbench with `?refresh=1` → assert: the classification-coverage dimension score rises / the matching to-do items decrease (closed-loop evidence).
5. i18n: switch to English and assert 0 residual Chinese across the 6 new UI areas + switch back to Chinese and regress; sample values never appear in any suggestion returned by the API (metadata only).
6. Cleanup: delete the classifications written by the test (restore the original state); scan records expire automatically through the TTL (harmless).

The headless script (kept locally, outside the repository) calls the API with an in-page `fetch` under the login session (= real product calls), addresses dialog inputs with `input:visible.nth()`, and logs in with a retry loop — copied from the experience of the alerting module's verification. Screenshots are kept locally alongside it.

---

## 8. Delivery order (this round's first phase)

1. **Detection engine + API + tab**: first the **detector SPI** (`sensitive/types.ts` interface + `regexDetector` / `checksumDetector` factories) → the **registry** (`sensitive/registry.ts`, mainly general-purpose + a few regional samples) → the scan service (`sensitive-scan.ts`; the engine only iterates over the registry) → API → front-end tab → adoption loop. **One of the acceptance criteria: adding a detector changes the registry in one place only, with zero changes to engine / service / front end.**
2. **Health score + workbench page** (the aggregation service reuses the scanner's output → API → standalone page).
3. i18n entries → deploy (three-way consistency: CFN COMPLETE + ECS COMPLETED + new table ACTIVE) → headless acceptance of every feature → write back to the roadmap, the session notes and memory.

---

## 9. Row-level security (RLS) — second phase; direction decided: both the application layer and the database layer

> **Not implemented in this round**; this only records the decided direction so that the second phase can start from this design.

- **Row-policy model** (new table `bgp-row-policies`, or an extension of grants): `fqn` + `role/username/project` + `predicate` (a controlled row filter such as `region = :userRegion`; the predicate uses allow-listed columns + parameters, no free-form SQL).
- **Application-layer enforcement** (first; quick to deliver + demonstrable): in the same enforcement layer as the existing `maskRows()` (three call sites: `redshift/result`, `genbi/ask`, `data-service/execute`), for a table that matches a row policy either **rewrite the SQL by appending a WHERE** or **filter the result set**. Same origin and same layer as column-level masking. Same limitation as today: connecting to Redshift directly, bypassing the platform, is not constrained.
- **Database-layer enforcement** (enhancement; true enforcement including the direct-connection case): use native Redshift `CREATE RLS POLICY` + `ATTACH RLS POLICY ON <table> TO ROLE <role>`, with the platform managing the policy lifecycle (create / attach / detach). The effect on other paths that read Redshift directly must be evaluated, and the policies must stay in a consistent mapping with the application-layer model.
- Delivery: the application layer lands first and is verified headlessly (row filtering takes effect + authorization exemptions); the database layer goes live in steps as an enhancement.
