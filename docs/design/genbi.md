# GenBI — Ask-Your-Data (Natural-Language Analysis of Redshift Data)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: code complete + build verification passed (`npm run build` / infra `tsc`); **not yet deployed, not yet verified online**.
> - Engine: Amazon Bedrock (Converse API + tool use) → Amazon Redshift (Redshift Data API, read-only).
> - Design reference: DataAgent (an Athena-based NL-to-SQL agent); this module ports its pattern to TypeScript / Redshift.

---

## 1. Feature Overview

Data has already landed from the source databases into S3 Tables / Redshift through Glue ETL. GenBI closes the "last mile": it lets **business and operations staff who do not know SQL** ask questions in natural language, and the platform automatically:

1. reads the Redshift database and table structure as the "data catalog";
2. uses a large language model to translate the question into **read-only SQL** (`SELECT`/`WITH` only);
3. executes it on Redshift and feeds the real results back to the model;
4. after multi-step exploration, delivers in Chinese a **conclusion + key figures + data table + recommended chart**.

Core principle (inherited from DataAgent): **every number comes from a real query result, and all computation is written into SQL and handed to the engine**; the model is not allowed to do mental arithmetic or make numbers up.

## 2. User Stories

- As an operations user, I ask "how many products on sale does each category have, from most to least" and get a conclusion, a bar chart and a data table without writing SQL.
- As an analyst, I want to see the **SQL the platform generated and its reasoning steps**, so that I can check the definitions and the credibility of the result.
- As a platform administrator, I need to be sure that GenBI is **read-only** and will never modify or delete warehouse data by mistake.

## 3. Interaction Design

The `/genbi` page (chat style, single page):

- Top: data connection selection (Workgroup / Database, reusing `/api/redshift/connections` and `/api/redshift/databases`).
- Question area: multi-line input + example-question tags (click to ask) + an "Ask" button (Enter submits, Shift+Enter inserts a line break).
- Result area: the conclusion (line breaks preserved); a Segmented display-mode control (Auto / Table / Bar chart / Line chart);
  - a single-value result → a large-number "metric card";
  - dimension + measure → MiniChart (SVG, no third-party chart library) or a data table;
  - collapsible: the **generated SQL**, the **reasoning process** (per step: SQL + success/failure + row count/error); token usage.
- Bottom: the list of recent questions (click to reuse a question).

## 4. API Design

```http
POST /api/genbi/ask
  body: { question: string, workgroupName?: string, database?: string }
  resp: { success, data: { answer, sql, columns, rows, rowCount, chart, steps, usage } }

GET  /api/genbi/history
  resp: { success, data: GenBiHistoryItem[] }   # the current user's recent questions (best-effort)
```

Both routes are authenticated by the existing Cognito middleware (`/api/*` validates the ID token).

## 5. Data Model

New DynamoDB table **`bgp-genbi-history`** (`BgpDatabaseStack`):

```text
PK: userId (String)      # "default-user" in the single-tenant demo
SK: historyId (String, ULID)   # a ULID makes reading in reverse chronological order easy
Attributes: question, answer, sql, rowCount, chartType, createdAt
```

Writes are fire-and-forget; the feature keeps working when the table is not deployed (only without history).

## 6. Backend Implementation

`platform/src/lib/genbi/`:

| File | Responsibility |
|------|------|
| `config.ts` | Every parameter comes from environment variables (`BEDROCK_MODEL_ID`/`REDSHIFT_WORKGROUP`/`REDSHIFT_DATABASE`/`GENBI_*`); defaults are neutral and contain no account information |
| `schema.ts` | Introspects Redshift (`pg_tables` + `information_schema.columns`) → compact data-catalog text |
| `prompt.ts` | System prompt (responsibilities + accuracy iron rules + read-only constraint + data catalog) |
| `sql-guard.ts` | Read-only validation: strips comments/semicolons, rejects multiple statements and write/DDL keywords, wraps the query as a subquery to enforce `LIMIT` |
| `redshift.ts` | `run_sql`: Redshift Data API `ExecuteStatement → poll DescribeStatement → GetStatementResult` |
| `agent.ts` | Bedrock `ConverseCommand` loop + the `run_sql` tool; accumulates tokens; keeps the last successful result for display |
| `chart.ts` | Heuristically recommends `metric`/`bar`/`line`/`table` from the shape of the result |
| `history.ts` | Reads and writes `bgp-genbi-history` (best-effort) |

The loop: `converse` → if `stopReason=tool_use`, execute `run_sql` and feed `{columns, rows(≤modelRows), row_count}` back as the `toolResult` → until the model produces its final text or `maxIters` is reached.

## 7. AWS Service Dependencies

- **Amazon Bedrock**: Converse API (**Claude Opus family only**; the model is set by `BEDROCK_MODEL_ID`, default `us.anthropic.claude-opus-4-6-v1` — verified usable in a temporary test account in us-east-1; 4.7/4.8 were not authorized for that account, so **access to the corresponding Opus model must be enabled in the deployment account/region**). The ECS task role gains `bedrock:InvokeModel`/`InvokeModelWithResponseStream`/`Converse`/`ConverseStream`.
- **Amazon Redshift (Serverless)**: Redshift Data API (the task role already has `AmazonRedshiftDataFullAccess`).
- **DynamoDB**: `bgp-genbi-history`.

## 8. Security Considerations

- **Read-only red line**: `sql-guard` enforces a single `SELECT`/`WITH` statement + a hard row-count cap at the application layer; the model is explicitly forbidden to write, and the platform blocks any statement that is not read-only.
- **Defense in depth (recommended)**: GenBI executes **model-generated SQL**, so it is strongly recommended to configure a **read-only Redshift user/role** for it (database-level permissions as the safety net) and not to reuse a high-privilege administrator connection.
- **Authentication**: the central middleware validates the Cognito ID token.
- **Public-repository red line**: model id / region / workgroup / database name all come from environment variables with neutral defaults, **containing no real account id / ARN / URL**.
- The history record stores no sensitive fields (only question / conclusion / SQL / row count / chart type).

## 9. Acceptance Criteria

- [x] `npm run build` (platform, strict TS + lint) passes; infra `tsc` passes.
- [x] "Ask-Your-Data" appears in the sidebar and `/genbi` renders.
- [x] Non-read-only SQL (INSERT/UPDATE/DROP/multiple statements) is rejected by `sql-guard`.
- [ ] (After deployment) asking questions such as "which tables exist / how many rows does each have" returns a conclusion + data table + chart, with numbers identical to a direct query.
- [ ] (After deployment) `bedrock:InvokeModel` is authorized and the model access is enabled.
