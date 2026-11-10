# GenBI Semantic Table Retrieval (LLM Re-ranking)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Design revision: 1.15.0 | Status: implemented
> - Related designs: [GenBI](./genbi.md), [OpenMetadata ingestion](./openmetadata-ingestion.md), [requirement pipeline](./genbi-requirement-pipeline.md) (finalized result tables)

## 1. Background

Previously GenBI put the **entire table catalog** into the prompt and let the model pick tables implicitly. Problems: not scalable (many tables → overlong prompt / wrong picks), thin table descriptions (table name + fields only), table selection not explainable, non-deterministic. The requirement: "on every question, first retrieve tables + descriptions → the best tables matching the question → grounded SQL generation", semantic rather than a hard-coded mapping.

## 2. Design: an explicit two-stage process

```
question → [stage 1: semantic table retrieval] → Top-K candidate tables (with descriptions) → [stage 2: grounded SQL generation] → result + matched tables & reasons (explainable)
```

### Stage 1: semantic table retrieval (`lib/genbi/retrieval.ts`)
1. **Semantic catalog**: every table = name + fields + **OpenMetadata business description** (best-effort; OM is the catalog's single source of truth) + **the source question / calculation rule of finalized result tables** (from the [requirement pipeline](./genbi-requirement-pipeline.md)).
2. **Keyword pre-filter**: when the table count is > 40, first coarse-filter by the overlap between the question tokens and table name / fields / description / finalized question, with a +2 weight for finalized tables, to control the candidate count fed to the model (scalable).
3. **LLM re-ranking**: Claude picks the Top-K (≤6) by relevance to the question; **a finalized table is preferred when its calculation rule matches**; strict JSON output `{tables:[{schema,table,reason,preferred}],note}`.
4. **Robust fallback**: JSON parse failure / nothing selected / exception → always fall back to "all tables"; a question is never interrupted (`usedFallback`).

### Stage 2: grounded generation (`lib/genbi/agent.ts`)
- Builds the catalog text only from the retrieved candidate tables (with descriptions + finalized annotations) and injects it into the system prompt; for finalized tables it appends "if the calculation rule matches, query the result table directly".
- Reuses the original `run_sql` tool loop; produces `matchedTables` (matched tables + reasons + whether finalized) + `retrievalNote` and returns them together.

### Explainability
The front-end GenBI result area shows "Data tables matched this time (semantic retrieval)": table-name tags + a gold `Finalized` badge + the selection reason + the overall note.

## 3. Why this is not hard-coded

Table selection is the LLM's semantic judgment from "question + table descriptions / finalized calculation rules"; there is no "question → table" dictionary anywhere. The preference for finalized tables comes from the source question they carry and the `preferred` signal, not from a hard-wired mapping.

## 4. Scalability path

The current LLM re-ranking suits small and medium scales (with the keyword pre-filter as a safety net). As the table count grows, the semantic catalog can be embedded into the **already-running OpenSearch (k-NN)**, using vector recall to replace or precede the LLM re-ranking; the retrieval interface (`selectRelevantTables`) keeps its signature.

## 5. Live verification (a test account)

- "Sales amount by product category" → matched `public.etl_category_sales` (preferred, finalized); the SQL queries the finalized table directly and the answer says "according to the finalized result table".
- "How many customers" → matched `public.customers` (not finalized), reason "the user explicitly named customers"; the model considered etl_customer_count but respected the original intent.
- The explainability area on the front end and the fallback path were both verified.
