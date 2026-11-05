# Special Topic — End-to-End Verification of S3 Tables Access from Three Engines (Flink / Glue / EMR Serverless) and Catalog Version Unification

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place, execution scope, per-region scheduling and the like — is described in the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the module index; a path mentioned in this document that no longer exists means that idea was not implemented as described or has since been superseded.

> Revision: 1.0 **✅ Completed (the EMR / Flink catalog JARs have been unified on 0.1.8)** (documentation audit calibration of 2026-08-26: the original status header was out of date; it originally read "design · pending decision") | Date: 2026-07-27 | Trigger: the requirement that "the Glue / Flink / EMR Serverless compute engines must all work end to end" — the real run of the connector modularization covered only Flink; the real-run status of S3 Tables from Glue / EMR was unknown.
> Relationship: independent of the connector-runtime modularization (the connector-runtime module of Stream Compute) and of MSK source support (part of the data-source ecosystem). Dedicated to establishing that all three engines really read and write the same S3 Tables table bucket, and to eliminating catalog JAR version drift.
> 🔴 **Design only; nothing moves until the decision is made; real runs follow the real-time red line (stop / delete after verification to cap cost).**

---

## 1. Current-state fact list (code-level evidence, 2026-07-27)

All three engines have S3 Tables integration code, but **the integration method and the catalog JAR version differ for each**, and only Flink was verified by a real run in this round:

| Dimension | Flink (MSAF) | EMR Serverless | Glue |
|---|---|---|---|
| Catalog implementation | `software.amazon.s3tables.iceberg.S3TablesCatalog` direct connection | The same `S3TablesCatalog` direct connection (`emr/spec.ts:112`) | `s3tablescatalog` (Glue's built-in federated catalog, `glue-script-generator.ts:77,148`) |
| Catalog JAR | `s3-tables-catalog-for-iceberg` **0.1.8** (flink-sql-runner-s3t/pom) | `s3-tables-catalog-for-iceberg-runtime` **0.1.3** (`emr/provider.ts:36`) | Built into the Glue runtime; no JAR of its own |
| Integration | Flink SQL `CREATE CATALOG type=iceberg` (registered by reflection in user code) | `--jars` + `spark.sql.catalog.s3tablescatalog.*` conf | Spark SQL `s3tablescatalog.<ns>.<tbl>` |
| Write pattern | INSERT INTO (streaming append) | spark.table / spark.sql | `CREATE TABLE ... USING iceberg AS SELECT` / `INSERT INTO` / idempotent row-level DELETE |
| Real-run status | ✅ Really run this round (Kinesis → S3 Tables) | ⚠️ A code comment claims "verified SUCCESS" but **there is no supporting record**; it uses the old 0.1.3 JAR; the current state is unknown | ⚠️ Complete read / write code exists; but the OpenMetadata ingestion side once recorded "0 tables in the bgp-glue service" (see the [OpenMetadata ingestion design](./openmetadata-ingestion.md)); a real read / write run has not been confirmed |

## 2. 🔴 Real hazards found (what this topic must resolve)

1. **The catalog JAR version drifts across three places**: Flink 0.1.8 / EMR **0.1.3** / Glue built-in. 0.1.3 is an old version and may behave differently from 0.1.8; the three engines read and write **the same table bucket**, so inconsistent versions carry a compatibility risk (metadata format / API).
2. **The EMR "verified SUCCESS" is unsubstantiated**: the note that the code comment cites (`emr-serverless-s3tables-recipe`) **does not actually exist**; the current EMR → S3 Tables state needs to be re-confirmed by a real run.
3. **Glue S3 Tables read / write is unconfirmed**: the code is complete (create table / INSERT / idempotent DELETE), but the only record is the "0 tables" entry on the OpenMetadata ingestion side; the write side (Glue sync → S3 Tables) has not been verified by a real run.
4. **Cross-engine interoperability is unverified**: after the three engines write to the same table bucket, can each read the tables the others wrote (Iceberg metadata compatibility) — this is the core promise of a "data lake", and it has never been verified end to end.

## 3. Verification goals (end to end, headless browser / real jobs)

Against **one and the same S3 Tables table bucket** (`bgp-table-bucket`):
- **T1 Flink → S3 Tables**: ✅ already verified this round (Kinesis → S3 Tables produced data); the conclusion is reused.
- **T2 EMR Serverless → S3 Tables**: really run a Spark job `CREATE TABLE ... USING iceberg AS SELECT` that writes a table → verify with Athena that data is present.
- **T3 Glue → S3 Tables**: really run a sync job that writes to S3 Tables (the script generated by glue-script-generator) → verify with Athena.
- **T4 Cross-engine interoperability**: a table written by one engine can be read by another engine / Athena (Iceberg metadata compatibility).

## 4. Catalog JAR version unification (eliminating the drift)

- The latest `s3-tables-catalog-for-iceberg[-runtime]` today = **0.1.8** (confirmed on Maven).
- Unification strategy: raise EMR's `EMR_S3TABLES_JAR` from 0.1.3 to 0.1.8 (aligned with Flink); Glue keeps the built-in catalog untouched (AWS-managed; the version is guaranteed by the Glue runtime).
- 🔴 **Before upgrading, confirm by a real run that 0.1.8 is compatible on EMR** (no blind upgrade; if 0.1.3 is in use, the upgrade is a breaking change and needs a parity check).

## 5. Verification plan (each engine independently verifiable; stop as soon as verified)

| Step | Content | Nature | Anchor |
|---|---|---|---|
| **V1** | EMR Serverless → S3 Tables real run (verify the baseline with the existing 0.1.3 first, then verify 0.1.8) | 🟠 Real job + possible JAR upgrade | Spark creates the table and writes data → found by Athena |
| **V2** | Glue → S3 Tables real run (a sync job writing a table) | 🟠 Real job | Glue job succeeded → found by Athena |
| **V3** | Cross-engine interoperability (a table written by Flink read by EMR / Glue / Athena, and vice versa) | 🟡 Interoperability | Each reads the other's table |
| **V4** | Unify the JAR version (EMR 0.1.3 → 0.1.8, parity verification) + update the CDK injection | 🔴 Infrastructure (authorized deployment) | After the upgrade, EMR → S3 Tables still succeeded |

**Recommended order: V1 first** (the EMR real run, establishing whether "verified SUCCESS" is true and whether the current state is usable), then V2 (Glue), then V3 (interoperability), and finally V4 (version unification).

## 6. Honest boundaries
- This round of connector modularization verified Flink only; the S3 Tables real runs for Glue / EMR are covered **only by this topic**; before it they were **unverified, and "all three engines work" must not be claimed**.
- The EMR / Glue real runs require deploying to a temporary test account and starting real jobs (which costs money); follow the real-time red line: stop the jobs / delete the temporary tables after verification to cap cost.
- Cross-engine Iceberg metadata compatibility depends on each engine's catalog JAR version; a strong guarantee exists only after V4 unifies them.
