# Data Source Ecosystem (DataSource SPI Foundation + Multi-Paradigm Extension): Top-Level and Detailed Design

> 📌 **Scope (reconciled on 2026-10-13)**: this document was written in the single-region stage and records the design of that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the behavior of places / execution scope / per-region scheduling under multi-region operation, see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of the module is recorded in the design index. A path mentioned in the text that no longer exists means that the idea was not implemented in that form or has been superseded.

> Revision: **0.7** (2026-10-30: section 14 — the three gaps in the data-source deletion path (platform-created security groups left orphaned after deleting a source, deletion of a source still referenced by sync / realtime tasks, ghost rows written back by in-flight probes) plus the drift model for external network objects, verified and merged into the development branch on 2026-10-30; revision 0.6 = 2026-10-25, section 13 — a page entry for S3 external tables plus the fix for external tables always landing in the home-region catalog; revision 0.2 = 2026-07-24, scope decided; revisions 0.3–0.5 see sections 10–12) | Date: 2026-10-30 | Status: **design decided, in implementation**
>
> 🟢 **Decided on 2026-07-24**: ① scope of this round = **phase 1 → phase 3** (the SPI foundation + all four JDBC siblings mysql/postgresql/oracle/sqlserver genuinely running end to end); ② priority of the new paradigms that follow = **S3 → MSK → DynamoDB** (all three are wanted; phases 4 / 5 / 6 in that order).
> ③ Implementation discipline: before touching the core data-source chain, create a pre-change git tag + a contract-guard snapshot; in every phase, prove driver availability empirically first and only then write the provider (the native library of Oracle's oracledb is the biggest uncertainty).
>
> Benchmark: the data-integration module of a leading cloud data-development suite (50+ data sources) | Capability group: data source ecosystem | Master plan: the platform roadmap of 2026-08 (historical, single-region stage), section 1 (the capability group) and section 3 (this module)
>
> 🔴 Project red lines: ① use only `--profile temp-account-1`; ② no hard-coded secrets / account ids / ARNs anywhere (everything through Secrets Manager / IAM roles / env); ③ every new capability must be verified with headless Playwright; ④ no pushing without permission; ⑤ design first — this document is design only; code is touched only after sign-off, and the core chain is touched only after tag + contract-guard.
>
> This document contains no real account ids / ARNs; placeholders are used.

---

## 0. One-Sentence Goal and Scope of This Round

**Goal**: upgrade "data sources" from the current state — "only MySQL genuinely runs end to end, type-specific behavior is scattered across 8 hard-coded spots, the model hard-wires the five-part host/port/database form" — to a **pluggable SPI foundation + multi-paradigm support**, so that a new data source becomes "a self-contained directory, purely additive + one line in the registry", matching the template already established on the engine side (`lib/engines/`).

**The 5 explicitly requested new source types** (+ the existing MySQL/SQLServer) span **4 completely different paradigms**, which is exactly the stress test of this design:

| Paradigm | Source type | Connection identifier | Credential form | What a "dataset" is | Natural channel |
|---|---|---|---|---|---|
| **JDBC relational** | MySQL✅ / PostgreSQL / Oracle / SQLServer | host:port/db | username + password | database tables | Glue (batch) / DMS (CDC) |
| **Object storage** | **S3** | bucket + prefix | IAM role | the files under a prefix (CSV/Parquet/JSON) | Athena (query) / Glue (read) |
| **NoSQL** | **DynamoDB** | table name / ARN | IAM role | a DDB table (attributes inferred by sampling) | Glue DynamoDB connector (batch) |
| **Streaming messages** | **MSK/Kafka** | bootstrap.servers | SASL-SCRAM / mTLS / IAM | topic | Flink (stream consumption) |

> **Why the foundation must come first**: the existing `DataSource` model (`types/datasource.ts:1-31`) hard-wires the four fields `host/port/database/username`. S3 (no host/port, IAM authentication, bucket/prefix), DynamoDB (no database, no port, IAM) and MSK (bootstrap + SASL, where a "table" is a topic) **do not even fit at the field level**. Merely adding enum values is bound to collapse, which confirms that "option B · an SPI foundation" is the only correct path.

**Scope of this round (phase 1, the foundation + the first batch of paradigms)** — see the phasing in section 7. **This document delivers only up to "top-level design + detailed design + phasing", for sign-off**; after sign-off, implementation proceeds phase by phase, each step verified headlessly.

---

## 1. Current State Proven at Code Level (evidence, not opinion)

> Everything below was confirmed by read-only inspection, with file:line. It is the factual basis of the design.

### 1.1 The Disease: Type Behavior Scattered Across 8 Spots, Zero Abstraction

| # | Scattered spot | Evidence file:line | Problem |
|---|---|---|---|
| 1 | Type enum hard-wired as a 4-value union | `types/datasource.ts:5` | `type: "mysql"\|"postgresql"\|"oracle"\|"sqlserver"`; adding a type means editing the union type |
| 2 | Dropdown options for creating a source | `types/datasource.ts:35-40` `DS_TYPE_OPTIONS` | the same 4 items hard-coded + defaultPort |
| 3 | **JDBC_URL table, copy 1** | `lib/aws/datasource-service.ts:14-19` | |
| 4 | **JDBC_URL table, copy 2** | `lib/sync/glue-script-generator.ts:4-9` | adding a source means changing 3 places in step |
| 5 | **JDBC_URL table, copy 3** | `app/api/datasources/test/route.ts:10-15` | |
| 6 | DB_PORT table (duplicating DS_TYPE_OPTIONS.defaultPort yet again) | `lib/aws/datasource-service.ts:21` | ports scattered across 2 places |
| 7 | introspect is hard-wired MySQL-only | `lib/datasource/schema-reader.ts:31` `if (ds.type !== "mysql") return []` | introspection of every other type returns an empty result outright |
| 8 | Heartbeat is hard-wired MySQL-only | `lib/datasource/heartbeat.ts:27` `if (ds.type !== "mysql")` | every other type returns reachable=null |
| 9 | Glue script driver hard-wired to mysql | `lib/sync/glue-script-generator.ts:105` `driver="com.mysql.cj.jdbc.Driver"` | **a PG/Oracle full load through Glue is bound to fail** |
| 10 | recommendChannel is a pile of isMySQL/isPG | `lib/sync/sync-service.ts:3-4,10,46` | channel recommendation is hard-coded branching |
| 11 | Credentials only accept `{username,password}` | `datasource-service.ts:28` `JSON.stringify({username,password})` | cannot hold IAM/SASL/mTLS |
| 12 | The connection test is a fake test (it queries Glue Connection metadata) | `datasource-service.ts:256-276` + `test/route.ts:62-92` | never actually connects to the database; the create-source test only validates string formats |

**Conclusion**: the only source that genuinely runs end to end is **MySQL**; PG/Oracle/SQLServer can merely "be created and have a secret stored" — the moment a sync runs, they use the wrong MySQL driver (#9).

### 1.2 Existing Reusable Assets (the design must build on them, not rebuild them)

| Asset | Evidence | Value to this design |
|---|---|---|
| **The engine SPI, a textbook template** | `lib/engines/{spi,registry,types}.ts` | copy the pattern directly: interface + `Record<type,provider>` registry + `isEngineType` guard + "method semantics map one-to-one onto existing implementations; nothing invented from thin air" |
| **MSK network resolution already works** | `network-advisor/config.ts:58`, `target-resolver.ts:177-181` | MSK ports refined by auth (iam 9098 / sasl-scram 9096 / tls 9094), in-VPC resolution done; **the hardest part, the network-connectivity chain, already exists** |
| **Flink connector upload mechanism** | `lib/realtime/flink-connectors.ts:42` `uploadConnectorJar` | reusable for MSK as a Flink source (upload the kafka connector jar) |
| **Flink multi-connector foundation** | `realtime-compute/page.tsx` kinesis/jdbc/mysql-cdc/filesystem/opensearch | the streaming paradigm has a mature runtime foundation |
| **The platform stack already has kafka permissions** | `infra/lib/platform-stack.ts:366` `kafka:DescribeClusterV2/ListClustersV2` | MSK discovery needs no additional permissions |
| **Secrets Manager wrapper** | `datasource-service.ts:25-49` create/get/update/delete | the credential-storage foundation (only the "content form" needs extending) |
| **Athena query capability** | `app/athena` + `lib/genbi/athena.ts` introspectS3Tables | reusable for S3/DynamoDB federated queries |
| **Automatic network detection** | `datasource-service.ts:62-127` detectNetwork | reused by VPC-bound sources (S3/DDB are AWS services and need no VPC; MSK/JDBC do) |

---

## 2. Core Design Challenge and Decision

### The challenge: the 4 paradigms differ enormously — how do we avoid degenerating into an if/else hodgepodge?

**Candidate approaches**:

- **Option A: fat interface + capability flags**. A single `DataSourceProvider` interface; methods that do not apply return `null` / throw `NotSupported`; each provider declares `capabilities` (canIntrospect/canPing/isVpcBound/credentialKind/channels…). **Fully isomorphic with the engine SPI** (`EngineProvider` is exactly "interface + `EngineCapabilities` flags + empty `ensureResource` implementations for the legacy engines").
- **Option B: per-paradigm sub-interfaces**. `JdbcSourceProvider`/`ObjectStoreProvider`/`StreamProvider`/`NoSqlProvider`, each extending `BaseProvider`. More precise types, but the registry has to be grouped by paradigm and callers have to determine the paradigm first — more roundabout, and it departs from the established engine-SPI convention.

**Decision: option A (fat interface + capability flags)**. Rationale: ① **fully isomorphic** with the engine SPI already established in the repository (consistency = maintainability; the team already knows this pattern); ② callers always face a single `getProvider(type)` and never have to determine the paradigm first; ③ capability flags are a pattern the engine SPI has already validated (`capabilities.canStop` decides whether the UI shows the Stop button). Paradigm differences are expressed through **capability flags + value objects**, not through type branching.

> Key design creed (copied from the spirit of the comment in the engine SPI `spi.ts:1-10`): **every provider method semantically corresponds to some existing piece of implementation; nothing is invented from thin air**. The phase-1 foundation is "folding the scattered MySQL implementation into the mysql provider", with behavior unchanged to the letter.

---

## 3. Top-Level Architecture

```text
                                  ┌──────────────────────────────────────────────────────────────┐
   create-source / sync wizard ──► │  Single entry point: getProvider(type) → DataSourceProvider │
   introspect / heartbeat / test   │  (callers see only this one facade and no longer branch on type) │
                                  └───────────────────────────┬──────────────────────────────────┘
                                                              │ registry.ts: Record<DataSourceType, Provider> (adding a source = adding one line)
        ┌──────────────┬───────────────┬──────────────────────┴───────┬──────────────────┐
        ▼              ▼               ▼                              ▼                  ▼
   jdbc/ (paradigm)  object-store/   nosql/                         stream/          (future: saas/…)
   ├ mysql           └ s3            └ dynamodb                     └ msk
   ├ postgresql
   ├ oracle          each provider implements a subset of the fat interface; a paradigm shares one base (e.g. jdbc-base folds JDBC_URL/driver together)
   └ sqlserver
        │
        ▼ each provider declares its capabilities:
          { paradigm, credentialKind, isVpcBound, canIntrospect, canPing,
            syncChannels[], analysisChannels[], connectionSchema }
        │
        ▼ capability-driven: create-source form fields / channel recommendation / introspect dispatch / credential reading / network detection
```

**Three layers of consolidation** (the scattered spots this design eliminates, mapped to section 1.1):
1. **Connection-model layer**: the 3 JDBC_URL copies (#3/#4/#5) + DB_PORT (#6) → folded into the `buildConnection()` of each jdbc provider; callers no longer assemble URLs.
2. **Introspection / liveness layer**: the MySQL-only branches of schema-reader (#7) + heartbeat (#8) → folded into the provider's `introspect()`/`ping()`; callers do `getProvider(ds.type).introspect(ds)`.
3. **Channel-recommendation layer**: the isMySQL/isPG of recommendChannel (#10) → reads `provider.capabilities.syncChannels`; data-driven, a new source takes effect automatically.

> - 🟢 **Implementation decision (SPI foundation phase, 2026-07-24)**: phase 1 has eliminated 5 of the 6 scattered spots and delegated them to the providers — ① schema-reader.introspect, ② heartbeat.ping, ③ glue-script-generator (JDBC URL + driver resolved dynamically), ④ test/route (validateConfig + buildConnection), ⑤ datasource-service (JDBC_URL/DB_PORT tables deleted; getSecret extracted into `datasource-spi/secrets.ts` to break the circular dependency).
> - **The 6th spot, `recommendChannel` (#10), is deliberately left to phase 2**: what it encodes is "a channel-compatibility matrix + the realtime/incremental/full branches + rich Chinese copy", which a bare `syncChannels` cannot replace;
>   moreover, changing it carries regression risk for MySQL, while the iron rule of phase 1 is "MySQL behavior unchanged to the letter".
>   When phase 2 makes PG genuinely run, recommendChannel naturally has to let PG appear among the dms options — that is the most sensible moment to change it and verify it in a real scenario (avoiding an empty change with no scenario to verify it).
>   The path MySQL currently takes through recommendChannel is **completely untouched**.
> - **Handling of the circular dependency**: `registry→provider→jdbc-base→datasource-service(getSecret)→registry` would form a cycle.
>   Solution = extract the Secrets Manager credential read/write (create/get/update/deleteSecret) into an independent low-level module `lib/datasource-spi/secrets.ts` (type-agnostic; it never belonged in datasource-service in the first place), on which jdbc-base depends;
>   datasource-service re-exports it so that every other consumer stays untouched.
>   This also incidentally removes the code smell of "credential read/write and the JDBC_URL table crammed into one file".

---

## 3b. 🔴 Driver JAR Management (requirement added on 2026-07-24 — the roadblock to genuinely running this module end to end)

### 3b.0 The Crucial Distinction Between Two Layers of "Driver" (do not confuse them)

"Driver" in the platform has **two completely different layers**, and this design has to cover both:

| Layer | Purpose | Carrier | Current state |
|---|---|---|---|
| **① Platform Node-side driver** | introspect to read table structures / heartbeat SELECT 1 (direct database connection inside the platform process) | Node libraries (`mysql2`/`pg`/`oracledb`/`tedious`) | ✅ the preliminary phase proved they install and work on alpine; installed in this round |
| **② Engine-side JDBC .jar for Glue/DMS** | the sync jobs that **actually move data** (the Spark/DMS classpath needs the JDBC driver jar) | `.jar` placed on Spark `--extra-jars` / the Glue Connection | ❌ **extremely weak today: `glue-script-generator.ts:105` hard-wires a single line `driver="com.mysql.cj.jdbc.Driver"`, and there is not even an `--extra-jars`** |

**Evidence of the disease**: the existing Glue sync script **depends entirely on the Glue runtime classpath happening to contain the MySQL driver** — MySQL works purely because Glue 5.1 ships it built in. Switch to Oracle/SQLServer (which Glue may not ship, or **ships in a version that does not match the user's database version**, e.g. an old Oracle 11g vs. a new driver) → **a `ClassNotFoundException` or a version incompatibility is inevitable**. This is precisely the roadblock to "genuinely running" phases 2/3, and it is also why the benchmark suite offers "custom data-source driver upload".

### 3b.1 Design: Built-in Version Matrix + User Upload, Two Sources

Following the benchmark suite (built-in common drivers + permission to upload custom versions), driver jars have **two sources**:

- **A. Common versions built into the platform** (covering what AWS Glue does not ship by default): the platform pre-stages the JDBC jars of each database's "common versions" in the code bucket and selects by `type + version`. **The mainstream versions on AWS must be covered** (explicitly requested). Preliminary version matrix (to be finalized after section 3b.3 empirically establishes what Glue 5.1 ships):
  | Source | Common JDBC driver & version (preliminary, finalized after verification) | Built into Glue 5.1? |
  |---|---|---|
  | MySQL | mysql-connector-j 8.0.x / 8.3.x | to be verified (currently works = built in) |
  | PostgreSQL | postgresql 42.7.x (covers PG 12-16) | to be verified |
  | Oracle | ojdbc11 21.x (covers 19c/21c), ojdbc8 19.x (covers old 11g/12c databases) | to be verified |
  | SQL Server | mssql-jdbc 12.x (covers 2016-2022) | to be verified |
- **B. User-uploaded custom drivers** (for any version): reuse one of the **two existing, mature upload mechanisms** —
  - Template 1, `lib/realtime/flink-connectors.ts`: the JAR is stored in the code bucket under the `flink/connectors/` prefix + metadata in DynamoDB (`bgp-flink-connectors`) + CRUD + uploads ≤ 250 MB.
  - Template 2, the ETL dependency upload (`etl-jobs/page.tsx:432`): upload a JAR → `--extra-jars`.
  - **This design copies template 1**: a new `bgp-datasource-drivers` table (or reuse of an existing one), driver jars stored in the code bucket under the `datasource/drivers/` prefix, metadata `{type, version, s3Key, driverClass, uploadedBy}`.

### 3b.2 Impact on the SPI Abstraction (adding a "driver source" layer)

`ConnectionModel` currently has only `driverClass` (the class name) and lacks "where the jar comes from". Additions:
- `DataSourceCapabilities` gains `requiresJdbcDriverJar: boolean` (JDBC=true; S3/DDB/MSK=false) + `builtinDriverVersions?: string[]` (the list of built-in versions).
- `DataSource.connection` may optionally carry `driverVersion?` (the user picked a built-in version) or `driverJarS3Key?` (a custom jar the user uploaded).
- When `glue-script-generator` generates a script: for JDBC-class sources it resolves the jar's S3 URI from `driverVersion`/`driverJarS3Key` → injects it into the Glue jobDef's `--extra-jars` + the script's `driver=<driverClass>` (replacing the hard-wired mysql). **This is the complete root fix of #9** (not just "pick driverClass by type" but also "put the matching jar on the classpath").

### 3b.3 ✅ Empirically Established (driver check during the SPI foundation phase, 2026-07-24) — Major Good News: the Drivers of All Four JDBC Siblings Are Built into Glue 5.0/5.1

**Method** (following the red line "verify empirically before judging"): ① inspected the MySQL sync jobs `bgp-sync-*` that already run in this account → GlueVersion=5.1, `--extra-jars=None` (the MySQL driver is indeed built in; it runs without any jar being passed); ② consulted the official AWS documentation `aws-glue-programming-etl-connect`, the table "built-in JDBC drivers for Spark DataFrame JDBC in Glue 5.0".

**Conclusion: the drivers of all four JDBC siblings used by `spark.read.format("jdbc").option("driver", ...)` are built into Glue 5.0/5.1; PG/Oracle/SQLServer syncs do not need an uploaded jar** (the presumed "roadblock" is ruled out by the official documentation):

| Source | Glue built-in driver ClassName (official, authoritative) | Platform provider driverClass |
|---|---|---|
| PostgreSQL | `org.postgresql.Driver` | ✅ identical |
| Oracle | `oracle.jdbc.driver.OracleDriver` | ✅ corrected and aligned (previously written as oracle.jdbc.OracleDriver) |
| SQLServer | `com.microsoft.sqlserver.jdbc.SQLServerDriver` | ✅ identical |
| MySQL | `com.mysql.jdbc.Driver` (the official legacy class name; the new class name `com.mysql.cj.jdbc.Driver` is also built in and is in production use) | ✅ uses the new class name (verified to run) |

**Impact on the phasing**:
- **The Glue syncs of phases 2/3 are not blocked by drivers** — the four siblings genuinely run with the built-in drivers directly. The former section 3b "driver JAR management" is **downgraded from "prerequisite blocker for phase 2" to an enhancement item (the driver-upload enhancement, scheduled alongside phase 4)**.
- **The user-upload driver capability (the driver-upload enhancement) still has value but is not blocking**: the built-in drivers suffice for everyday use; the upload capability serves ① version mismatches (old Oracle 11g / special versions) and ② sources Glue does not ship (e.g. SAP/Teradata through marketplace.jdbc).
- **The Oracle OTN license concern is resolved**: the platform does not need to pre-stage the ojdbc jar (Glue ships it), which sidesteps the OTN redistribution restriction; a jar is uploaded only when the user needs a special version (the user's own compliance responsibility).
- Addendum: Glue also offers the `marketplace.jdbc`/`custom.jdbc` connectionType + `className` parameter for uploaded custom JDBC drivers — the AWS-side landing point of the driver-upload enhancement.

---

## 4. Detailed Design: the SPI Contract

> Location `platform/src/lib/datasource-spi/` (a **new directory**, distinct from the legacy utility functions scattered in `lib/datasource/`; after phase 1 folds the legacy utilities into the providers, they become thin delegations or are deleted). Naming aligned with `lib/engines/`.

### 4.1 Types and Capability Flags (`datasource-spi/types.ts`)

```ts
// 范式（决定 UI 分组 + 通道类别 + 值对象形态）
export type SourceParadigm = "jdbc" | "object-store" | "nosql" | "stream";

// 全部支持的源类型（加源 = 这里加一个字面量 + registry 加一行）
export type DataSourceType =
  | "mysql" | "postgresql" | "oracle" | "sqlserver"   // jdbc
  | "s3"                                              // object-store
  | "dynamodb"                                        // nosql
  | "msk";                                            // stream

// 凭证形态（决定 Secret 内容结构 + 建源表单认证区 + provider 如何读凭证）
export type CredentialKind =
  | "userpass"      // {username,password}  —— JDBC
  | "iam-role"      // 用平台/Glue 角色，无需存密钥 —— S3/DynamoDB
  | "sasl-scram"    // {username,password}（Kafka SASL/SCRAM，独立 secret 语义）
  | "mtls"          // {truststore,keystore,...}（Kafka mTLS）
  | "none";         // 匿名/公开

// 同步通道 & 分析通道（数据驱动 recommendChannel）
export type SyncChannel = "glue" | "dms" | "zero-etl" | "flink-cdc";
export type AnalysisChannel = "athena" | "redshift-federated" | "glue-catalog";

export interface DataSourceCapabilities {
  paradigm: SourceParadigm;
  credentialKind: CredentialKind;
  isVpcBound: boolean;            // JDBC/MSK=true(要子网/SG)；S3/DynamoDB=false(AWS 服务)
  canIntrospect: boolean;        // 能否列"数据集"+推断 schema
  canPing: boolean;              // 能否轻量探活
  supportsCdc: boolean;          // 能否做增量/CDC（决定同步模式可选项）
  syncChannels: SyncChannel[];    // 该源能喂哪些同步通道（推荐引擎读这个）
  analysisChannels: AnalysisChannel[]; // 该源能被哪些引擎直查
  // 建源表单的连接字段 schema（driver UI 动态渲染，取代写死 host/port/database）
  connectionSchema: ConnectionField[];
}

// 连接字段描述（UI 用它动态渲染表单——JDBC 出 host/port/db，S3 出 bucket/prefix，MSK 出 bootstrap/auth）
export interface ConnectionField {
  key: string;                   // 存进 DataSource.connection 的键
  label: string;                 // i18n key（"中文即 key"，遵 [[i18n-module]]）
  type: "text" | "number" | "select" | "secret" | "toggle";
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[]; // select 用
  defaultValue?: string | number | boolean;
}

// introspect 归一产物（4 范式统一形状）
export interface SourceDataset {
  name: string;                  // 表名 / topic / prefix
  kind: "table" | "topic" | "prefix" | "collection";
  columns: SourceColumn[];       // 关系型=列；S3=推断字段；DDB=采样属性；MSK=消息字段(best-effort)
  meta?: Record<string, any>;    // 范式专属（S3 format/压缩、DDB pk/sk、MSK 分区数…）
}
export interface SourceColumn { name: string; type?: string; nullable?: boolean; key?: string; comment?: string; }
```text

### 4.2 The Provider Interface (`datasource-spi/spi.ts`)

```ts
// 数据源适配器。registry 按 DataSourceType 分派；provider 内部把 DataSource.connection 收窄到自己的形态。
// 【信条】每个方法语义对应现有某段实现，不凭空发明（照抄 lib/engines/spi.ts 精神）。
export interface DataSourceProvider {
  type: DataSourceType;
  capabilities: DataSourceCapabilities;

  // 校验建源表单的连接配置（取代 test/route.ts 里散落的字符串校验）。
  validateConfig(conn: Record<string, any>): { ok: boolean; errors: string[] };

  // 由 DataSource 产出"连接模型"：JDBC→jdbcUrl+driver；S3→s3Uri；DDB→tableArn；MSK→bootstrap+authProps。
  // 取代 3 份 JDBC_URL 副本 + Glue 脚本写死 driver。返回值供同步脚本/查询/测试统一消费。
  buildConnection(ds: DataSource): ConnectionModel;

  // 真连通性测试（取代"查 Glue Connection 元数据"的假测试）。范式各异：
  // JDBC=SELECT 1；S3=HeadBucket/ListObjects；DDB=DescribeTable；MSK=DescribeCluster+(可选)metadata。
  testConnection(ds: DataSource): Promise<TestResult>;

  // 轻量探活（心跳）。canPing=false 的返回 {reachable:null}。
  ping(ds: DataSource): Promise<PingResult>;

  // 列数据集 + schema。canIntrospect=false 返回 []。JDBC=INFORMATION_SCHEMA；
  // S3=列 prefix+采样推断格式；DDB=ListTables+scan 采样；MSK=ListTopics+(schema registry 或采样)。
  introspect(ds: DataSource): Promise<SourceDataset[]>;

  // 凭证读写：按 credentialKind 决定 secret 内容形态（userpass/sasl/mtls）。iam-role/none 为空实现。
  // 复用 datasource-service 的 Secrets Manager 封装，只是"内容结构"由 provider 决定。
  buildSecretPayload?(input: Record<string, any>): string;  // 建源时把表单凭证 → secret 字符串
}
```

> **How the fat interface avoids becoming a "hodgepodge"**: a method that does not apply is either switched off by a `capabilities` flag (callers look at the flag before calling) or given a base implementation shared across the paradigm (e.g. `jdbc/jdbc-base.ts` provides the `buildConnection`/`testConnection`/`introspect` shared by the four JDBC siblings, and each provider only declares its own JDBC_URL template + driver + introspection dialect). **The genuinely per-type differences are squeezed down to the smallest possible surface**.

### 4.3 The Registry (`datasource-spi/registry.ts`, copied from `engines/registry.ts`)

```ts
const PROVIDERS: Record<DataSourceType, DataSourceProvider> = {
  mysql: mysqlProvider,
  postgresql: postgresProvider,
  oracle: oracleProvider,
  sqlserver: sqlserverProvider,
  s3: s3Provider,
  dynamodb: dynamodbProvider,
  msk: mskProvider,        // ← 加源只加一行
};
export function isDataSourceType(v: unknown): v is DataSourceType { return typeof v === "string" && v in PROVIDERS; }
export function getProvider(type: DataSourceType): DataSourceProvider { return PROVIDERS[type]; }
export function listSourceTypes(): DataSourceType[] { return Object.keys(PROVIDERS) as DataSourceType[]; }
// UI 建源下拉：由 provider.capabilities 派生（取代 DS_TYPE_OPTIONS 硬编码）
export function sourceTypeCatalog() { return listSourceTypes().map(t => ({ type: t, ...getProvider(t).capabilities })); }
```text

---

## 5. Data Model Evolution (key point: backward compatible, zero migration risk)

### 5.1 `DataSource` from the "Five-Part Form" to a "Property Bag + Credential Reference"

```ts
export interface DataSource {
  userId: string;
  datasourceId: string;
  name: string;
  type: DataSourceType;         // 扩为 SPI 的联合类型
  paradigm?: SourceParadigm;    // 冗余存一份便于列表分组（provider.capabilities.paradigm）
  // 【新】连接属性袋：JDBC={host,port,database}；S3={bucket,prefix,region,format}；
  //        DDB={tableName,region}；MSK={bootstrapServers,auth,securityProtocol}
  connection?: Record<string, any>;
  status: "active" | "inactive" | "unreachable" | "error" | "testing";
  env?: string; tags?: string[];
  secretArn?: string;           // 凭证引用（userpass/sasl/mtls 存这里；iam-role/none 为空）
  glueConnectionName?: string;  // JDBC/需要 Glue Connection 的源才有
  networkConfig?: {...};        // isVpcBound 的源才有（S3/DDB 无）
  testResult?: {...};
  createdAt: string; updatedAt: string;
  // ↓ 旧字段保留（向后兼容，见 5.2），标记 @deprecated，读经归一层
  host?: string; port?: number; database?: string; username?: string;
}
```

### 5.2 Backward-Compatibility Strategy (🔴 no destructive migration)

The MySQL data-source items already in the production DynamoDB table are **flat host/port/database/username**. **No data migration is performed** (migration is risky and violates the "zero migration" steady state); instead, a **normalizing read layer** is used:

```ts
// datasource-spi/normalize.ts：把任意 item 归一成"provider 能读的 connection 袋"。
export function readConnection(ds: DataSource): Record<string, any> {
  if (ds.connection) return ds.connection;                         // 新格式直接用
  return { host: ds.host, port: ds.port, database: ds.database };  // 旧 MySQL item 兜底映射
}
```text

- Creating a source: write the `connection` bag (the flat fields are no longer written).
- Reading an old source: the normalizing layer maps the flat fields into the bag; the provider is unaware of the difference.
- **Result: old MySQL sources keep running with zero changes, new sources use the new model** — consistent with the lesson of the "wired but not persisted" class of defects (a new field must round-trip end to end: the POST item and the GET response must both carry connection).

---

## 6. Landing Essentials of Each of the 4 Paradigms (provider implementation outline)

### 6.1 JDBC Relational (mysql✅ / postgresql / oracle / sqlserver) — make the 3 types that are "in the enum but do not run" genuinely run

- Shared `jdbc/jdbc-base.ts`: `buildConnection` reads the JDBC_URL template + **selects the driver by type** (root fix of #9, the hard-wired mysql); `testConnection`/`introspect`/`ping` use the corresponding JDBC driver.
- Each provider declares only: its JDBC_URL template, driver class, default port and introspection dialect (PG = `information_schema` case handling / the schema concept, Oracle = `ALL_TAB_COLUMNS`, SQLServer = `sys.columns`).
- **Driver dependencies**: Node-side introspect/ping need the pg/oracledb/mssql drivers (`mysql2` is already present); Glue-side syncs need the corresponding JDBC jar (Glue 5.1 ships some of them; the missing ones go through the existing dependency-upload mechanism). **This is the key item that must be verified by really running it** (see the honest boundaries in section 8).
- capabilities: `{paradigm:"jdbc", credentialKind:"userpass", isVpcBound:true, canIntrospect:true, canPing:true, supportsCdc:true, syncChannels:["glue","dms",(mysql only)"zero-etl"], analysisChannels:["glue-catalog"]}`.

### 6.2 Object Storage S3 (new paradigm)

- Connection bag: `{bucket, prefix, region, format?: "auto"|"csv"|"parquet"|"json", hasHeader?}`. Credential = iam-role (uses the platform/Glue role, **no secret**).
- `introspect`: `ListObjectsV2` lists the "logical datasets" under the prefix (grouped by first-level sub-prefix) + samples files to infer the schema (reusing the Glue Crawler approach or lightweight header sampling). Produces `kind:"prefix"`.
- Natural channels: **analysisChannels=["athena"]** (create an Athena external table over S3 for direct query, reusing the existing Athena capability) + syncChannels=["glue"] (Glue reads S3 into the lakehouse).
- capabilities: `{paradigm:"object-store", credentialKind:"iam-role", isVpcBound:false, canIntrospect:true, canPing:true(HeadBucket), supportsCdc:false}`.

### 6.3 NoSQL DynamoDB (new paradigm)

- Connection bag: `{tableName, region}` (or tableArn). Credential = iam-role.
- `introspect`: `DescribeTable` (to get pk/sk/GSIs) + `Scan Limit=N` sampling to infer attributes (DDB has no fixed schema; take the union of the sample). Produces `kind:"table"` + meta marking pk/sk.
- Natural channels: syncChannels=["glue"] (the Glue DynamoDB connector batch-reads into the lakehouse); analysisChannels optionally redshift-federated / athena federated (**second stage**, requires federated-query configuration).
- capabilities: `{paradigm:"nosql", credentialKind:"iam-role", isVpcBound:false, canIntrospect:true, canPing:true(DescribeTable), supportsCdc:false(first stage; DDB Streams in the second stage)}`.

### 6.4 Streaming Messages MSK/Kafka (new paradigm, building on the existing network assets)

- Connection bag: `{bootstrapServers, auth:"iam"|"sasl-scram"|"tls"|"plaintext", securityProtocol, clusterArn?}`. Credential = by auth: iam → no secret, sasl-scram → a secret with userpass semantics, mtls → a certificate secret.
- `introspect`: list topics (AdminClient ListTopics) + schema (read from the Glue Schema Registry if present, otherwise sample messages best-effort). Produces `kind:"topic"`.
- Natural channels: **syncChannels=["flink-cdc"]** (Flink consumes Kafka → S3 Tables/Redshift, reusing the Flink connector upload + multi-connector foundation of section 1.2); MSK network resolution reuses the existing MSK support of network-advisor.
- capabilities: `{paradigm:"stream", credentialKind:(by auth), isVpcBound:true, canIntrospect:true, canPing:true(DescribeCluster), supportsCdc:true}`.

---

## 7. Phased Delivery (each phase independently verifiable and approvable)

> Principle: **the phase-1 foundation is a "behavior-preserving refactor"** (fold the existing MySQL implementation into the SPI, unchanged to the letter, zero regressions under contract-guard); every subsequent phase that adds one provider / one class of provider is purely additive. **First get the foundation running with zero MySQL regressions, then add paradigm by paradigm** — avoid touching too much at once.

| Phase | Content | Nature | Acceptance anchor |
|---|---|---|---|
| **Phase 1** | the SPI foundation (types/spi/registry/normalize) + **the mysql provider folding in the existing implementation** + the 3 JDBC_URL copies / introspect / heartbeat / recommendChannel changed to delegate to the provider | 🟡 behavior-preserving refactor (touches the core chain; tag + contract-guard first) | existing MySQL create / test / introspect / sync **zero regression item by item** (contract-guard verify); scattered copies eliminated (grep JDBC_URL finds it only inside the provider) |
| **Phase 2** | **the postgresql provider genuinely running** (Node introspect/ping + correct Glue sync driver) | 🟢 purely additive | headless: create a PG source → the test genuinely connects → introspect lists tables → Glue sync succeeded into Redshift (real data) |
| **Phase 3** | oracle + sqlserver providers (completing the four JDBC siblings) | 🟢 purely additive | same as phase 2 (subject to driver availability, see the honest boundaries) |
| **Phase 4** | **the s3 provider** (object-storage paradigm) + Athena direct query over an external table | 🟠 new paradigm (connection bag + iam-role + new UI fields) | headless: create an S3 source → introspect lists prefixes → Athena returns data |
| **Phase 5** | **the dynamodb provider** (NoSQL paradigm) + Glue DDB connector sync | 🟠 new paradigm | headless: create a DDB source → introspect samples attributes → Glue sync into the lakehouse |
| **Phase 6** | **the msk provider** (streaming paradigm) + Flink consuming a topic | 🔴 new paradigm (wires the Flink connector + MSK network) | headless: create an MSK source → introspect lists topics → a Flink job consumes → lands in S3 Tables (run for real, stop after verification, following the realtime red line) |

**Recommendation for this round: phase 1 + phase 2 first** (the foundation + the first new JDBC source genuinely running) — the value of the foundation is immediately proven by "PG really works", and PG is the closest to MySQL, has the most mature driver and the lowest risk, making it the best litmus test of whether the SPI abstraction is right. The three new paradigms S3/DDB/MSK are advanced phase by phase once the foundation is stable (each needs new UI fields + new channel verification).

---

## 8. Risk Register and Honest Boundaries

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 touches the core data-source chain | breaks the existing MySQL create / sync | 🔴 a pre-change git tag + contract-guard snapshot first; behavior-preserving refactor compared line by line; full headless MySQL regression |
| **JDBC driver availability** (Node drivers + Glue jars for PG/Oracle/SQLServer) | the provider is written but does not actually run | **from phase 2 on, every phase first proves empirically that the driver installs and connects** before the provider is written (avoiding "premature solution judgment", per the red line); the Oracle driver (oracledb) may need a native library and is the biggest uncertainty; the scope of phase 3 is set after verification |
| Weakly typed connection property bag | lost fields / wrong types (the "wired but not persisted" class of defects) | normalizing layer + provider.validateConfig + end-to-end round-trip verification (create → reopen, confirm the values are filled back in) |
| Secret forms of the new paradigms | IAM/SASL/mTLS credentials read wrongly | credentialKind-driven; a unit test + a real connection test per form |
| S3/DDB/MSK need new analysis / sync channels | it is not "add a provider and it works"; Athena / Glue-DDB / Flink must be wired | each phase states explicitly which channel it wires, no vagueness; MSK follows the realtime red line (must stop after verification) |
| i18n | new UI fields missing from the EN dictionary | follow the rule that every UI change is scanned for missing i18n entries: run `platform/scripts/i18n-check-missing.mjs` before any frontend change |

**Honest boundaries (no overstatement)**:
- This design **does not promise** to finish all 5 source types in one go; the 5 named types span 4 paradigms and differ enormously in implementation effort (PG ≈ a copy of MySQL; MSK/DDB/S3 are each a brand-new chain).
- For some sources, "genuinely running" depends on **external driver / AWS service availability** (the Oracle driver, DDB federated query, an MSK cluster), subject to the limits of the temporary-account environment; a commitment is made only after each phase has been verified empirically.
- Phase 1 is a pure abstraction refactor; **users will not immediately see a new feature** — the value appears only once "the foundation stands + PG really works in phase 2". This is stated up front to avoid the expectation gap of "refactored but nothing new".

---

## 9. Positioning Against the Benchmark Suite

The 50+ sources of the benchmark suite rest on exactly this kind of "Reader/Writer plug-in SPI". This module **does not try to match that number in one go**; it **first establishes a pluggable foundation isomorphic to it**, turning "add a source" from "change 8 hard-coded spots" into "add one directory + register one line" — which is the only sustainable way to keep closing in on 50+, and it matches the platform's standing red lines of high abstraction, elimination of scattered duplicates and global-grade self-installation.

---

## Appendix: Change Surface of This Design (for review, phase 1)

- **New**: `lib/datasource-spi/{types,spi,registry,normalize}.ts` + `jdbc/{jdbc-base,mysql,postgresql,oracle,sqlserver}.ts` + `object-store/s3.ts` + `nosql/dynamodb.ts` + `stream/msk.ts` (added phase by phase)
- **Refactored (delegating to the provider, behavior unchanged)**: `types/datasource.ts` (model evolution + compatibility), `lib/aws/datasource-service.ts` (JDBC_URL/DB_PORT deleted, the provider used instead), `lib/datasource/{schema-reader,heartbeat}.ts` (turned into delegations or deleted), `lib/sync/sync-service.ts` (recommendChannel reads capabilities), `lib/sync/glue-script-generator.ts` (driver by type), `app/api/datasources/test/route.ts` (uses provider.validateConfig/testConnection)
- **UI**: `app/datasources/DataSourceModal.tsx` (connection fields rendered dynamically from connectionSchema, replacing the hard-wired host/port/database) + i18n entries

---

## 10. Design Addendum (revision 0.3, 2026-07-26) — Folding Flink Sources into the SPI + the Two-Layer Selection Model + the "Create a Source on Demand" Capability

> - Revision: 0.3 (addendum · pending sign-off) | Date: 2026-07-26 | Trigger: the requirement that Stream Compute support **multiple data sources** (currently Kinesis + MySQL CDC, MSK later), with **two-layer selection + the ability to create a source and then select it**.
> - Relationship: this chapter is the **root-fix design** for the "Kinesis source dead end" defect, and it is inserted ahead of the phasing table of section 7. **Design only; code is touched only after sign-off.**

### 10.1 The Real Shape of the Problem (deeper than "put the stream back")

Surface symptom of the defect: the Stream Compute page defaults to `sourceType="kinesis"`, but the stream `bgp-flink-source` was deleted in the cost rework of 2026-07-07 and `bgp-flink-role` has no kinesis data-stream permission at all → a default job created by the user **is bound to fail on start**.

But the real requirement is not "put that stream back"; it is that **Stream Compute should support multiple kinds of data sources, select them in two layers the way Data Sources does, and allow creating a source on demand**. This exposes an architectural crack:

- **This module has already built the two-layer data-source SPI model** (layer 1 `DataSourceType`/`SourceParadigm` + `sourceTypeCatalog()`; layer 2 the concrete connections in the `bgp-datasources` table), and MSK is already planned in section 6.4 / phase 6.
- **But Flink's source selection does not go through this SPI at all**: in `realtime-compute/page.tsx`, `kinesis`/`mysql-cdc` are **two hard-coded Select options + backend if branches**, coexisting with the SPI as a second system.
- Hence the capabilities "add an MSK source", "create a Kinesis stream" and "several concrete connections under one source type" have **nowhere to live** in the current Flink source wiring — the Flink sources must first be folded into the SPI.

**Conclusion**: the root fix of the defect = fold the Flink source wiring into the data-source SPI and land the two-layer model that was asked for; along the way, add the **write (provision) semantics** that the SPI currently lacks for "create a source". This is of the same nature as phase 1 "folding MySQL into the SPI" — an architecture-alignment effort, not a small patch.

### 10.2 The Two-Layer Selection Model → Mapped onto the Existing SPI (no new concepts invented)

The two layers as described, aligned layer by layer with existing building blocks, **zero new top-level concepts**:

| In the user's words | Existing SPI building block it lands on | Current state |
|---|---|---|
| Layer 1: the broad category (MySQL / Kinesis / MSK…) | `DataSourceType` + `capabilities.paradigm`; the UI is derived from `sourceTypeCatalog()` | the four JDBC types exist; the kinesis/msk providers are still to be added |
| Layer 2: the concrete connections under a category | the records of that `type` in the `bgp-datasources` table (`GET /api/datasources?type=kinesis`) | the table / API already support filtering by type |
| "Create a new source and then select it" | **a new capability**: provider.provision + the create-source wizard (see section 10.4) | no precedent (the SPI currently has read semantics only) |

On the Flink job side, only `sourceType` (hard-coded) needs to be replaced by `sourceDatasourceId` (pointing at a layer-2 record) — **mysql-cdc already works this way** (`startFlinkJob` uses `sourceDatasourceId` to inject `${SRC_*}`). In other words, the direction of the fold is "make the kinesis source go through datasourceId just like mysql-cdc", which is **alignment with a correct pattern that already exists**, not the invention of a new one.

### 10.3 Kinesis / MSK as stream Providers (the Kinesis sibling item of section 6.4)

Section 6.4 already designs the MSK provider; Kinesis is its sibling in the same paradigm (`stream`) and is included together with it:

- **DataSourceType** gains `"kinesis"` (MSK's `"msk"` is already listed in section 6.4).
- **Connection bag**: Kinesis = `{streamName, region}`; credential = `iam-role` (uses the FlinkRole, no secret stored).
- **capabilities**: `{paradigm:"stream", credentialKind:"iam-role", isVpcBound:false, canIntrospect:true(ListShards/DescribeStreamSummary), canPing:true(DescribeStreamSummary), supportsCdc:false, syncChannels:["flink-cdc"], analysisChannels:[]}`.
- **introspect**: `DescribeStreamSummary` + `ListShards` → produces `kind:"topic"` (or a newly added `"stream"` kind), meta marking the shard count / retention period.
- **buildConnection**: produces `{paradigm:"stream", props:{streamArn, region}}` for Flink SQL to inject as `${SOURCE_STREAM_ARN}` (replacing the single hard-wired `bgp-flink-source`).

**Flink SQL template rework**: the four current SQL constants hard-wire `stream.arn` to `${SOURCE_STREAM_ARN}` (one global stream). After the fold they **inject the streamArn of the selected Kinesis data source** — the same logic as mysql-cdc injecting `${SRC_*}`.

### 10.4 "Create a Source on Demand" = a New provision Capability in the SPI (the new proposition of this design)

The desired flow — "choose New Kinesis stream → the platform says what it will create → the user agrees → it is really created → it is selected automatically" — is **write semantics the SPI does not have today**. It is designed as an **optional capability** that does not break the existing providers:

```ts
// spi.ts 增(可选方法,JDBC 类不实现→UI 不显示"新建"):
interface DataSourceProvider {
  // …现有 introspect/ping/testConnection/buildConnection…
  /** 该源类型是否支持平台侧“新建底层资源”(如建 Kinesis 流/建 MSK topic)。
   *  JDBC 类=false(库表是用户既有的,平台不建库);Kinesis=true(可建流)。 */
  canProvision?: boolean;
  /** 新建底层资源(写操作)。返回新资源的连接标识,供随后落 bgp-datasources。
   *  🔴 幂等 + 明确告知成本 + 必须用户在页面显式确认后才调用(见交互链路)。 */
  provision?(input: Record<string, any>): Promise<{ connection: Record<string, any>; note?: string }>;
}
```

**capabilities gains** `canProvision: boolean` (data-driven UI: only when true does the layer-2 dropdown show "➕ New").

**Interaction chain (entirely on the page, following the red line "major actions require user confirmation")**:
```text
The user picks layer 1 = Kinesis → the layer-2 dropdown lists the existing streams (GET /api/datasources?type=kinesis)
  + a final item "➕ New Kinesis stream"
Pick "New" → a confirmation dialog (states clearly: 1 Kinesis stream will be created, with a note on its standing cost) → the user confirms
  → POST /api/datasources { type:"kinesis", provision:true, streamName, shards }
  → the backend calls provider.provision() to create the stream (idempotent) → creates the bgp-datasources record → returns the datasourceId
  → the frontend automatically selects the newly created datasourceId → continue creating the Flink job
```

**Permissions**: provisioning a stream requires the platform TaskRole to have `kinesis:CreateStream/DescribeStreamSummary` and so on; consuming requires `bgp-flink-role` to have `kinesis:GetRecords/GetShardIterator/ListShards/DescribeStreamSummary` (both are missing today — see the infrastructure in section 10.6).

### 10.5 De-JDBC-ing the Create-Source API (prerequisite of provision)

The current `POST /api/datasources` (`route.ts:59-67`) **forces JDBC semantics**: host/port/database are required, a Glue Connection is created unconditionally, `DataSource.type` is hard-wired to the four JDBC types. Kinesis/MSK do not fit. Rework (phase 4 has already triggered the same need for S3/DDB; aligned here):

- The create-source entry branches by `paradigm`: only `isVpcBound && needsGlueConnection` (JDBC) goes through host/port/db + Glue Connection; stream/object-store go through their own connection bags and skip the Glue Connection.
- `DataSource.type` becomes the `DataSourceType` union instead of the hard-wired four types; connection information goes into the `connection` bag (designed in section 5); the flat fields are kept only for JDBC compatibility.

### 10.6 Infrastructure (CDK; requires authorization to deploy to `temp-account-1`)

- **Recreate the Kinesis stream**: in `flink-stack.ts` (where the stream was deleted on 2026-07-07) restore `bgp-flink-source` (or switch to on-demand provision, see the trade-off).
- **Complete the permissions as a group**:
  - `bgp-flink-role` (flink-stack.ts) gains kinesis consumption: `GetRecords/GetShardIterator/ListShards/DescribeStreamSummary/DescribeStream/SubscribeToShard` (scoped to stream resources).
  - The platform TaskRole (platform-stack.ts), if provision is implemented, gains `kinesis:CreateStream/DescribeStreamSummary/AddTagsToStream`.
- **🔴 Trade-off**: "recreate a fixed single stream", or "only grant the permissions and have every stream created on demand through provision"? The latter fits the two-layer model better (layer 2 may hold several streams), but provision is a new write chain with higher risk. **Recommendation**: grant the consumption permissions + support on-demand provision (do not restore the fixed single stream), so that "create a source" becomes the single entry point and multiple sources follow naturally. Pending sign-off. → **Decided on 2026-07-26: option B — no fixed stream; only add the permissions + create on demand through provision.**

- **🔴 IAM pitfall found in practice (2026-07-27)**: `kinesis:ListStreams` is an **account-level operation** (not tied to a specific stream ARN) and must use `resources:["*"]`;
  if it is placed in the same statement as `CreateStream/GetRecords` etc. with `resources:stream/*`, IAM **permanently denies** it
  (AccessDenied: no identity-based policy allows), even though the action is listed in the policy. It must be a **separate statement with `resources:["*"]`**
  (which may be narrowed with an `aws:RequestedRegion` condition). The "Use existing stream" dropdown relies on ListStreams, so this pitfall directly left that dropdown empty.
  **Lesson**: AWS actions come in two kinds, "resource-level" and "account-level"; account-level ones (List*, Describe*Limits, etc.) cannot be restricted by resource ARN.
  **Acceptance lesson**: the first acceptance of the provisioning phase only tested "New stream" (CreateStream works under stream/*) and missed "Use existing stream" (ListStreams),
  so the bug escaped and only surfaced during the Flink-selector phase. → **every branch path** of a new capability must have a headless assertion; testing only the main path is not enough.

### 10.7 Blast-Radius Self-Check (ensuring nothing existing breaks)

| Affected surface | Change | Note |
|---|---|---|
| mysql-cdc source jobs | **none** | already go through sourceDatasourceId; the fold aligns with them; untouched to the letter |
| existing Flink jobs (2 CDC) | **none** | the sourceType field is kept for compatibility; the new logic goes by datasource |
| the data-source SPI (the four JDBC siblings) | **additive only** | add the kinesis provider + the optional provision method; one line in the registry |
| `POST /api/datasources` | **reworked (branching by paradigm)** | the JDBC path kept to the letter; a stream path added |
| create-source UI (DataSourceModal) | **additive** | dynamic fields are already the direction of phase 4; stream reuses them |
| contract-guard | snapshot before the change + verify after | the red line for touching the core chain |

### 10.8 Phasing (inserted ahead of the section 7 table)

| Phase | Content | Nature | Acceptance anchor (headless) |
|---|---|---|---|
| **Phase 7a** | kinesis provider (introspect/ping/buildConnection) + registry registration + the stream branch of the create-source API | 🟠 new paradigm (the first stream one) | create a Kinesis source (pick an existing stream) → introspect lists shards → lands in bgp-datasources |
| **Phase 7b** | the provision capability + the "New Kinesis stream" wizard + CDK permission additions (authorized deployment) | 🔴 new write semantics + infrastructure | page "New stream" → confirm → the stream is really created → auto-selected → create a Flink job → start consuming → lands in S3 Tables (run for real, stop after verification) |
| **Phase 7c** | fold the Flink source selector into the two SPI layers (remove the hard-coded options from page.tsx) | 🟡 touches the core of the realtime page | the source-type dropdown is derived from the catalog; kinesis/mysql-cdc/future msk are isomorphic; zero regression |
| Phase 6 (existing) | msk provider | 🔴 see section 6.4 | after the fold, adding msk = one line in the registry + a provider file |

**Recommendation: phase 7a first** (purely additive, zero risk, immediately validates the stream-paradigm abstraction), then phase 7b (includes infrastructure, needs authorization), finally phase 7c (touches the realtime page; snapshot first).

### 10.9 Honest Boundaries

- **"Genuinely running" Kinesis → S3 Tables end to end depends on**: creating the stream + sending data + MSAF consuming. The HTTP 412 issue has been root-fixed (low risk), but the first real run of a Kinesis-source job still needs empirical verification.
- **provision is the platform's first data-source write operation that "creates an AWS resource"** — idempotency and least privilege need extra care; whether deleting a source cascades to deleting the stream (irreversible) needs a separate policy; this round only creates + selects and does not cascade stream deletion.
- This design **does not promise** to finish Kinesis + MSK in one go; MSK stays with section 6.4 / phase 6; only after the fold (phase 7c) is complete does adding msk become "one line".
- **No new standing cost**: the SPI is pure code; the resources of the new-paradigm sources (Glue Connection / Flink jobs) keep the existing on-demand creation

---

## 11. Design addendum (revision 0.4, 2026-07-27) — MSK/Kafka stream source: detailed landing design

> - Revision: 0.4 (addendum · decided) | Date: 2026-07-27 | Trigger: the request to "carry on with the MSK source", with the requirement that the top-level design be thought through (for production users worldwide).
> - Relationship: this chapter is the **detailed landing design** of §6.4 (the MSK provider outline) + §10.3 (the sister item of the stream paradigm), and is the final text of the MSK/Kafka stream-source phase.
> - **Decisions (2026-07-27)**: ① authentication = **both IAM and SASL/SCRAM**; ② verification = **authorized to create a temporary cluster and really run it** (in production, users enter their own cluster); ③ topic = **hybrid mode** (the value entered on the page is injected as the
>   `${KAFKA_TOPIC}` default + the SQL may change it / add tables); ④ reach = **managed MSK and self-hosted Kafka together** (one provider, two flavors).

### 11.0 Clearing up a misconception first: no ZooKeeper address is collected

Modern Kafka (2.8+) and the Flink Kafka connector **only recognize `bootstrap.servers`**; ZooKeeper is used only by legacy administration tools. Although MSK still exposes `ZookeeperConnectString`, consumption by Amazon Managed Service for Apache Flink (MSAF) / Flink goes through the brokers. **The data source does not collect a ZooKeeper address** — collecting one would only mislead users. This is the first point to clarify when evaluating the parameters.

### 11.1 Key layering: connection + authentication = data-source level; topic = job level

The key to untangling the awkward question "once the page is configured, how is the Flink SQL written?" is to attribute the parameters correctly to two layers. **Analogy: a Kafka cluster ≈ the "database" of JDBC, a topic ≈ a "table" in that database** — you would not create one data source per table; likewise one Kafka data source = one cluster, and the topic is chosen when the job is created (the `kind:"topic"` of `introspect` was designed for exactly this).

**Data-source-level parameters (configured once when the source is created, reused by many jobs)**:

| Parameter | Managed MSK flavor | Self-hosted Kafka flavor (production) | Notes |
|---|---|---|---|
| `mskFlavor` | `"msk"` | `"self"` | First field of the connection bag; decides where bootstrap comes from |
| Cluster | Drop-down selection (`ListClustersV2`) → stores `clusterArn` | — | Managed |
| `bootstrapServers` | **Fetched automatically** by the platform via `GetBootstrapBrokers` (the port string matching the authentication method) | **Entered manually by the user** | Production = entered manually |
| `auth` | `iam` / `scram` | `scram` / (`tls`/`plaintext` later) | Decides the secret + the SQL properties + the port |
| username/password | (for scram) stored in Secrets Manager | (for scram) stored in Secrets Manager | 🔴 **Never stored in the database** |
| `region` | ✓ | ✓ | |

**Job-level parameters (configured when the job is created)**: `topic` (hybrid mode, see §11.4), VPC subnets + SG (§11.5), format/scan.startup.mode (inside the SQL; business semantics).

### 11.2 Connection bag and capability flags

- **Connection bag**: `{ mskFlavor: "msk"|"self", clusterArn?, bootstrapServers?, auth: "iam"|"scram", region }`. Credentials follow auth: `iam` → no secret (iam-role semantics); `scram` → a secret with userpass semantics.
- **capabilities**: `{ paradigm:"stream", credentialKind:("iam-role" for iam / "sasl-scram" for scram), isVpcBound:true, canIntrospect:true, canPing:true, supportsCdc:false, needsGlueConnection:false, canProvision:false, syncChannels:["flink-cdc"], analysisChannels:[], icon:"📨", label:"MSK / Kafka" }`.
- **The three places where the capability flags are the opposite of Kinesis** (fully data-driven UI, no scattered if/else):
  - `isVpcBound: true` (Kinesis=false) → the source-creation form + the Stream Compute page show the VPC subnet / SG selection block (reusing the existing CDC block).
  - `canProvision: false` (Kinesis=true) → the second layer only "selects an existing cluster"; **the "➕ New" entry is not shown** (the platform does not create clusters on the user's behalf — a heavy operations decision).
  - `credentialKind` in two forms → IAM has no secret; SASL/SCRAM creates a secret. The `CredentialKind` union therefore already contains `"sasl-scram"` (present in types.ts today); this phase is the first to really use it.

> - 🔴 **CredentialKind is a static data-source-level flag, but the single MSK provider supports two authentication methods.**
>   Trade-off: `credentialKind` is used for the coarse-grained dispatch of "the authentication area of the source-creation form + whether to create a secret";
>   inside the provider, the SQL properties are refined according to the `auth` field of the connection bag.
>   That is, giving provider.capabilities.credentialKind a **dynamic value** does not fit the SPI (capabilities are static).
> - **Solution**: capabilities.credentialKind is fixed to `"sasl-scram"` (the widest superset: "may need a secret"), and the source-creation API is changed to **decide whether to really create a secret according to the connection bag's auth** (iam → skip) rather than looking only at capabilities.
>   Details in §11.6.

### 11.3 Authentication → Flink SQL property mapping (what `${KAFKA_AUTH_PROPS}` expands to)

| auth | MSK port | security.protocol | sasl.mechanism | Extras |
|---|---|---|---|---|
| iam | 9098 | SASL_SSL | AWS_MSK_IAM | IAMLoginModule + IAMClientCallbackHandler, no secret |
| scram | 9096 | SASL_SSL | SCRAM-SHA-512 | ScramLoginModule, username/password injected at start |
| (tls, later) | 9094 | SSL | — | certificate secret |
| (plaintext, later) | 9092 | PLAINTEXT | — | none |

**IAM expansion**:
```text
'properties.security.protocol'='SASL_SSL', 'properties.sasl.mechanism'='AWS_MSK_IAM',
'properties.sasl.jaas.config'='software.amazon.msk.auth.iam.IAMLoginModule required;',
'properties.sasl.client.callback.handler.class'='software.amazon.msk.auth.iam.IAMClientCallbackHandler'
```
**SCRAM expansion** (the credentials are injected from Secrets Manager; the SQL stored in the database keeps the placeholders and the secret never lands in the database — the same red line as `${MYSQL_PASSWORD}` of mysqlSink):
```text
'properties.security.protocol'='SASL_SSL', 'properties.sasl.mechanism'='SCRAM-SHA-512',
'properties.sasl.jaas.config'='org.apache.kafka.common.security.scram.ScramLoginModule required username="<injected>" password="<injected>";'
```

#### 11.3.1 🔴 Security review conclusion (2026-07-27, compared with the official Apache Kafka security example)

The Apache Kafka Streams security configuration from the official Apache website (mTLS: `security.protocol=SSL` + keystore/truststore) was provided for comparison. The robustness of our two authentication methods, evaluated item by item:

| Dimension | Apache example (mTLS) | Our IAM | Our SCRAM |
|---|---|---|---|
| Transport encryption | SSL | SASL_**SSL** | SASL_**SSL** |
| Where the secret lands | 🔴 plaintext `test1234` written into properties | **No long-lived secret** (SigV4 temporary role credentials) | Secrets Manager, **never in the database** |
| Authentication + authorization | Authentication only; explicitly states that authorization is not included | IAM policy **unifies authentication and authorization** (topic-level `kafka-cluster:*`) | SCRAM authentication + Kafka ACL authorization |
| Rotation | Manually replace the .jks | Automatic (role) | Change the secret |

**Conclusion**: for the IAM/SCRAM methods already supported, security is **no weaker than, and on most dimensions stronger than,** that example — `SASL_SSL` transport encryption throughout; the IAM path has no long-lived secret at all and unifies authentication and authorization, which precisely avoids the biggest anti-pattern of that example (a plaintext password written into the configuration). SCRAM credentials go through Secrets Manager and never land in the database.

**Hardening derived from this (landed)**:
1. **Transport-encryption invariant**: `security.protocol` in `buildKafkaAuthProps` is **hard-coded to always be `SASL_SSL`** and never produces `PLAINTEXT`/`SASL_PLAINTEXT`. Locked down exhaustively by the "transport-encryption invariant" test cases in flink-service.test.ts (including empty / abnormal / injected inputs). The plaintext (9092) row in the table above is **downgraded to "explicitly unsupported"** (not "later") — plaintext Kafka must not appear in production.
2. **Future boundary of mTLS (tls, 9094) (recorded honestly; not done in this phase)**: if mTLS is ever done, ① the three keystore/truststore passwords **must live in Secrets Manager** (never copy the Apache example's plaintext properties); ② 🔴 **managed MSAF has no local file system**, so `.jks` certificate files cannot be "locally accessible" the way they are on a self-hosted cluster — certificate distribution (pull from S3 / artifact mount / startup script writing to disk) is the real complexity of mTLS on MSAF and can only be promised after a dedicated design. Hence tls is not opened lightly.

### 11.4 Interaction, finalized: three-layer separation that cures the "awkwardness" at its root (the core issue raised)

**Counter-example** (if the user hand-wrote connection + authentication in the SQL): bootstrap is only known after a cluster has been chosen, and the SCRAM jaas.config would write a plaintext password into the SQL stored in the database → long, error-prone, leaky: three violations at once.

**Approach: connection + authentication are entirely injected through placeholders; the user writes only business logic.** When the source type MSK is selected, the platform automatically fills a clean template into the editor:
```sql
CREATE TABLE orders_src (
  region STRING, amount DOUBLE, ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = '${KAFKA_TOPIC}',          -- entered on the page (hybrid mode: injected default, changeable in SQL)
  'format' = 'json',
  'scan.startup.mode' = 'earliest-offset'
  ${KAFKA_AUTH_PROPS}                    -- the platform injects bootstrap + authentication; the user never sees the secret
);
INSERT INTO sink SELECT ... FROM orders_src ...;
```
At start, `resolveMskSource` (**fully isomorphic** with `resolveKinesisSource`/`resolveMysqlCdcSource`) expands the two placeholders: `${KAFKA_TOPIC}` ← the main topic entered on the page; `${KAFKA_AUTH_PROPS}` ← the bootstrap + authentication block assembled according to the auth of the selected data source (for scram, the credentials are read from Secrets Manager). **The user only ever writes schema + format + startup and never touches a single character of the authentication details.**

**Hybrid mode**: the main topic from the page is injected as the default for `${KAFKA_TOPIC}`; advanced users may override `'topic'='xxx'` in the SQL or add a second source table that reads another topic (that table then also needs `${KAFKA_AUTH_PROPS}`; the connection of the same data source is reused).

> 🔴 **Compatibility of the bare placeholder with the guard has been proven (2026-07-27)**: `${KAFKA_AUTH_PROPS}` is a bare placeholder **outside quotes** (the Kinesis/CDC placeholders are all inside quotes and protected lexically by the guard's masking). A real test (a vitest probe) confirmed that the candidate MSK template passes `guard("flink")` **without being blocked** (`blocked=false`) and that both placeholders are **preserved as-is** after `guardCode`. The injection model is therefore feasible; both guard validations, before and after persistence, let it through. This is a new situation the stream paradigm had not covered before; it is now pinned down.

### 11.5 Network: MSK is the platform's first VPC-bound stream source — 🟢 the network is chosen at the job level (decided 2026-07-27)

MSK brokers live in a private VPC (9098/9096), and the MSAF application must be attached to that VPC to consume. **Flink cannot "blindly connect" to any MSK in the account** — it must explicitly attach to the subnets + security groups of the VPC where the brokers are (with the SG allowing the corresponding ports); MSAF's default managed network cannot reach private brokers. This is exactly the same mechanism as CDC reading a private RDS binlog.

**🔴 The network configuration lives at the Flink job level, not at the data-source level (decided)**:
- **Data-source level** (MSK phase 1): stores only the "connection identity" — cluster ARN / bootstrap + authentication. **The source-creation form contains no network settings** (so it is correct that MSK source creation in phase 1 has no VPC field).
- **Job level** (MSK phase 3): when creating a Flink job the user selects VPC subnets + SG, reusing CDC's existing `/api/flink/network` scan-and-discover (lists the VPCs / subnets / SGs in the account) + the `cdcSubnets/cdcSgs` selection block of `realtime-compute/page.tsx`. At start they are passed through to the MSAF VpcConfiguration.
- **Why the job level**: the network is "how this job connects to the source", not "what the source is"; different jobs on the same MSK cluster may attach from different subnets. Clean responsibilities, and isomorphic with CDC (zero new concepts).
- **The platform only offers the choice; it does not take over reachability**: the platform scans and discovers candidate subnets / SGs for the drop-downs, but whether the choice is right (can it route to the brokers, does the SG allow 9098/9096) is the user's own responsibility. Users should plan the network when they create MSK/RDS; if they have not, they adjust the Flink job's network configuration. Consistent with the network-advisor red line "advise only, never act on the user's behalf". The network advisor can already recommend the port by authentication method (`target-resolver.ts:178`: `{iam:9098,sasl-scram:9096,tls:9094,plaintext:9092}`) as an auxiliary suggestion.

### 11.6 Change surfaces (provider implementation outline + consolidation surfaces)

- **`stream/msk.ts` (new; read capabilities)**:
  - `validateConfig`: managed requires clusterArn; self-hosted requires bootstrapServers (validated as comma-separated `host:port`); auth ∈ {iam,scram}.
  - `buildConnection`: produces `{paradigm:"stream", bootstrapServers, props:{auth, securityProtocol, ...}}`; for managed, `GetBootstrapBrokers` fetches the brokers (the SaslIam/SaslScram string according to auth).
  - `testConnection`/`ping`: managed = `DescribeClusterV2` (getting the status = reachable + permitted); self-hosted = parse the bootstrap format (the brokers cannot be reached from outside the VPC; no TCP probe; labeled honestly).
  - `introspect`: **honest degradation** — the platform backend, being outside the VPC, cannot reach the brokers and `ListTopics` does not work → degrades to returning an empty topic list (the user types the topic at the job level); managed can still obtain bootstrap/status via `DescribeClusterV2`. Never pretend that topics can be listed automatically.
  - **No provision** (canProvision=false).
- **`CredentialKind`**: already contains `"sasl-scram"`; no type change needed; this phase is the first to really create the secret (the trade-off in §11.2).
- **`registry.ts`**: add one line, `msk: mskProvider`.
- **Source-creation API (`route.ts`)**: the non-JDBC path **gains a SASL secret branch** — today `createNonJdbcSource` hard-codes "iam-role: no secret" (`route.ts:237`). Changed to: when the connection bag has `auth==="scram"`, `createSecret(username,password)` and store `secretArn`+`credentialKind:"sasl-scram"`; for iam, keep no secret. **The JDBC and Kinesis paths stay byte-for-byte unchanged (zero regression)**.
- **`flink-config.ts` + `flink-service.ts`**:
  - ⚠️ **The runner packaging approach has changed (2026-07-27)**: no more "add mskCodeKey / select the package by source / build a separate msk package" (that is the dead end of fat packages). Instead, **connector modularization with on-demand assembly** — kafka + msk-iam-auth become **two modules in the connector library**, and `resolveModules` assembles them according to the tokens in finalSql. Details in the [connector-runtime modularization design](./realtime-compute-connector-runtime-modular.md). MSK (MSK phase 2) lands on top of that foundation.
  - New MSK source template constant + `resolveMskSource(sql, sourceDatasourceId, jobId)` (isomorphic with `resolveKinesisSource`).
  - The injection chain of `startFlinkJob` gains one line, `resolveMskSource`; VPC decision: a kafka source attaches to the VPC the same way a CDC source does.
- **kafka + msk-iam-auth connector modules** (not a separate runner package): two pre-built modules in the connector library, assembled on demand by `resolveModules` (the Kafka→S3Tables combination = kafka module + iceberg-s3tables module). **🔴 Neither of the two existing runners packages the kafka connector (verified in the pom)**, so these two modules must be built — but on top of the modularization foundation, landing them is "one more jar in the library + one registry row". See the [connector-runtime modularization design](./realtime-compute-connector-runtime-modular.md).
- **UI**: `types/datasource.ts` DS_TYPE_OPTIONS adds msk (paradigm:"stream"); in `DataSourceModal.tsx` the stream branch is refined for msk (flavor selection + cluster drop-down + auth + VPC) while the Kinesis branch is untouched; `realtime-compute/page.tsx` adds MSK to the source-type drop-down + cluster / topic / VPC selectors.
- **CDK**: `bgp-flink-role` gains `kafka-cluster:Connect/DescribeCluster/ReadData/DescribeTopic` + `kafka:GetBootstrapBrokers` (restricted to the cluster ARN prefix);
  - the platform TaskRole already has `kafka:DescribeClusterV2/ListClustersV2` (**no extra permission needed**, see platform-stack.ts:389).
  - **🔴 The CDK side configures no fixed network**: the MSAF application's VpcConfiguration is passed through dynamically at start according to the subnets / SG chosen for the job (the same as CDC's `vpcSubnets/vpcSecurityGroups`, see §11.5); CDK only has to guarantee that `bgp-flink-role` has ENI management permissions (CDC already has them; reused).
  - **Changing flink-stack.ts requires a separate `cdk deploy BgpFlinkStack`** (a lesson recorded during the Kinesis phases).

### 11.7 Phasing (each phase independently verifiable, mirroring the three Kinesis phases)

| Phase | Content | Nature | Acceptance anchor (headless) |
|---|---|---|---|
| **MSK phase 1** | `stream/msk.ts` provider (two flavors + two authentication methods, read capabilities) + one registry line + SASL secret branch in the source-creation API + DS_TYPE_OPTIONS / Modal stream-branch refinement | 🟠 New paradigm subtype (pure increment, zero regression) | Create an MSK source (IAM / select cluster) → `DescribeClusterV2` fetches the status and persists it; create a self-hosted source (SASL / manual entry) → the secret is created and persisted |
| **Connector-runtime modularization** (prerequisite foundation) | Modular on-demand assembly of the connector runtime (thin base + module library + registry + assembly cache), eliminating the three packaging mechanisms | 🔴 Touches the core start path; strangler-pattern rollout | See the [connector-runtime modularization design](./realtime-compute-connector-runtime-modular.md), section 5: parity per combination (kinesis→s3t equivalence verified first), then switch the default |
| **MSK phase 2** | MSK landing (**on top of the modularization foundation**): kafka + msk-iam-auth modules + two registry lines + `resolveMskSource` source template + CDK kafka consumption permissions (**authorized to really create a cluster**); network at the job level (§11.5; CDK configures no fixed network) | 🟢 "One more line" on top of the foundation | Really create a cluster → create a topic → send data → Flink consumes → lands in S3Tables (run once each for IAM and SASL; delete the cluster after verification to stop the cost, per the Stream Compute red line) |
| **MSK phase 3** | Add MSK to the source-type drop-down of the Stream Compute page + cluster / topic / VPC selectors (remove the hard-coded option) | 🟡 Touches the core of the Stream Compute page (snapshot first) | On the page: select MSK → select cluster → select topic → select VPC → create job → start consuming |

**Do MSK phase 1 first** (pure increment, zero risk; immediately verifies whether the stream paradigm's abstraction holds for VPC / dual authentication / dual flavor), then phase 2 (includes a real cluster; the heaviest), and finally phase 3 (touches the Stream Compute page; take a contract-guard snapshot first).

### 11.7bis Landing progress (2026-07-27/28)

**✅ MSK phase 1 + MSK phase 2 path 1 (Kafka → raw S3 files) + MSK phase 3 are complete and confirmed by a real run (merged to the main branch on 2026-07-28)**:
- Headless page flow: create an MSK source (managed IAM + select cluster) → create a Flink job (source = MSK + topic + VPC) → start → real consumption → **windowed aggregates landed on S3 with east=300/west=50/north=70 matching the source data value by value** (all three data batches correct).
- Three hard constraints that cannot be derived on paper and only surface in a real run were overcome: ① Jackson conflict (msk-iam-auth relocates its private jackson);
  - ② Java bytecode version (aws-msk-iam-auth 2.3.7 is Java 17 > MSAF's Java 11; rolled back to 2.2.0);
  - ③ shaded vs. unshaded AuthenticateCallbackHandler (relocate org.apache.kafka→org.apache.flink.kafka.shaded so that IAMClientCallbackHandler matches the connector's shaded version).
- The phase 3 front end was merged in (MSK added to the page's source-type drop-down + source data source / topic / VPC selectors, reusing the CDC network block). Quality gates: tsc 0 errors / 117 unit tests, all green.

**🟡 MSK phase 2 path 2 (Kafka → S3Tables) — only the build-time verification is complete; the detailed-design / code-change threshold has not been reached (red line: sufficient verification → detailed design → code change)**:
- **Option D was chosen**: a new standalone `flink-sql-runner-s3t-kafka` combination package (= the current s3t + kafka + msk-iam-auth + relocation); the assembly router selects it for "kafka source + iceberg sink"; **the existing s3t package is not changed by a single character** → zero blast radius and zero regression for Kinesis/CDC→S3Tables (consistent with the divide-and-conquer rule of §2.0: "combinations containing iceberg go through a pre-built package"). **Option A rejected** (changing the s3t core package would radiate into every existing S3 Tables job).
- **Really built / really dissected and verified (experimental package `/tmp/s3t-kafka-exp`; the mainline untouched)**: the standalone package builds with mvn (148 MB); Jackson shaded once and unified at 2.13.2, no conflict; bytecode entirely ≤ Java 11; after relocation, IAMClientCallbackHandler correctly implements the flink.kafka.shaded version; relocation causes no collateral damage (iceberg: 0 impact; the S3TablesCatalog main class intact and not referencing kafka; cdc's shaded kafka preserved as-is). Two independent reviewers confirmed the namespace layout.
- **🔴 Not verified (lesson from the real run: a passing build ≠ a working run — all three pitfalls of path 1 surfaced only in real runs)**: ① whether Kafka→S3Tables really lands data when run on MSAF (can s3-tables-catalog really register the catalog under relocation); ② the assembly-routing approach (how runnerFor/assembleModularUberJar selects the new package); ③ parity of the existing S3 Tables jobs. **These need an MSK cluster + an account for a real run; the detailed design comes only after the real run passes, and production code changes only after the detailed design is confirmed.**

### 11.8 Honest boundaries (no overstatement)

- **MSK ≠ "one registry row"** (correcting an earlier optimistic note): four Flink SQL templates hard-code `connector='kinesis'`; MSK needs `connector='kafka'` + entirely new authentication / network + **the runners do not package the kafka connector, so a new build is mandatory**. It is a genuinely new chain.
- **introspect listing topics will most likely degrade to manual entry**: the platform backend cannot reach the brokers from outside the VPC. Honest design; no in-VPC probing proxy (far more work; not in this phase).
- **MSK is the first VPC-bound stream source**: a real end-to-end run depends on a real cluster + VPC reachability, limited by the temporary environment; only after the phase 2 real run can it be called "working".
- **No promise of provisioning clusters** (a heavy operations decision: 20–30 minutes, always-on high cost; not done on the user's behalf). In production users enter their own cluster (covered by the self-hosted flavor).
- This phase does the iam + scram authentication methods; tls/plaintext are added later following the same structure.

---

## 12. Design addendum (revision 0.5, 2026-07-29) — DynamoDB (NoSQL) + S3 (object store): two new paradigms landed

> - Revision: 0.5 (addendum · code landed, real-run verification pending deployment) | Date: 2026-07-29 | Trigger: the question "how far are we from feature parity with a leading cloud data-development suite? DynamoDB is still not connected as a data source, is it?" → confirmed that DynamoDB + S3
>   are the only two paradigms not yet connected (kinesis/msk of the stream paradigm are complete).
> - **Decisions (2026-07-29)**: ① reach = **DDB + S3 in parallel**; ② IAM = **fully open with Resource=\*** (read any table / bucket of the user); ③ DDB sync targets = **verify both Redshift and S3Tables**.

### 12.1 Why these two are the best proof of "one registry row + one provider file"

The foundation (the SPI abstraction of the first phase) is thoroughly validated here — the **setup-level** changes for the two new paradigms are tiny, because:
- `registry.ts` gains two lines (dynamodb/s3) + `types.ts` DataSourceType gains two literals;
- the `createNonJdbcSource` path of the source-creation POST API (iam-role / no secret / no Glue Connection / connection bag persisted) is reused **with zero changes** — DDB/S3 are both `iam-role` + `needsGlueConnection=false`, and POST routes them onto this path automatically according to capabilities;
- `normalize.readConnection` **zero changes** — new sources that have a connection bag are passed through as-is;
- the `tables` endpoint is already fully SPI-based and consumes only `{name,columns}`; DDB's `kind:"table"` is naturally compatible.

### 12.2 Two "heavy downstreams" — each paradigm's application-level core (not just the setup level)

Each new paradigm has one heavy downstream that cannot be seen on paper and must really be built; that is where the "real landing" lies:

| Paradigm | Heavy downstream | Where it lands | Reuse |
|---|---|---|---|
| **NoSQL (DDB)** | The Glue script generator gains a **DynamoDB read branch** | `lib/sync/glue-script-generator.ts`: `create_dynamic_frame.from_options(connection_type="dynamodb")` → toDF() | Downstream writes to Redshift (COPY) / S3Tables (Iceberg) **are all reused** (after the df, the paradigm no longer matters) |
| **Object store (S3)** | Athena **external-table DDL for direct query** (brand-new greenfield) | `lib/datasource-spi/object-store/athena-external.ts`: CREATE DATABASE bgp_s3_ext + CREATE EXTERNAL TABLE (three SerDes: csv/parquet/json) | The Athena execution foundation (`lib/athena/client.ts`) is reused; DDL generation / format inference are brand new |

**Key insight**: all existing Athena code is bound to the managed federated catalog `s3tablescatalog` (Iceberg / S3 Tables); there was no code to "create an external table over an arbitrary user bucket" — the S3 analysis channel is a DDL generator built from scratch, landing in the dedicated database `bgp_s3_ext` (physically isolated from the managed namespaces).

### 12.3 Shared refactor: data-driven recommendChannel (honoring the comment at types.ts:34)

`lib/sync/sync-service.ts:recommendChannel` was previously hard-coded string matching (isMySQL/isPG) and never read `capabilities.syncChannels`. This phase changes it to: **non-JDBC paradigms** (nosql/object-store/stream) are data-driven by `getProvider(type).capabilities` (DDB/S3 recommend Glue only; stream points to Stream Compute); **the four JDBC siblings are byte-for-byte zero-regression** (the early-return branch does not touch the original logic; locked by 6 regression assertions).

### 12.4 Honest boundaries of opening IAM to Resource=* (🔴 an explicit trade-off against the least-privilege red line)

- **Decision**: Resource=\* was chosen (not tag- or region-only narrowing). Rationale: DDB/S3 sources connect to **any existing table / bucket of the user** (unlike bgp-\*, which the platform creates itself); introspect / ping / external-table creation / batch sync reads must be able to read any resource.
- **Narrowing measures** (pressing the blast radius to the minimum): ① everything is **read-only** (DDB DescribeTable/Scan/Query; S3 GetObject/ListBucket; no write to user resources whatsoever); ② the `aws:RequestedRegion` condition restricts to this region (except S3 ListBucket, since buckets are global resources); ③ a separate ManagedPolicy `DataSourceReadOnly` attached to the TaskRole (avoiding the 10 KB inline-policy limit; easier to audit / revoke); ④ the Glue sync identity `bgp-glue-role` additionally receives DDB/S3 read-only (writes remain restricted to bgp-\*/Redshift).
- **Relationship to the existing red line**: the platform-stack comment at :123-127 deliberately narrows to bgp-\*; this phase is an **explicit exception** to that principle, recorded both in a code comment and in this document — not an oversight.

### 12.5 UI (the reality of hard-coded branches in the source-creation form)

The `ConnectionField[]` dynamic-rendering contract (types.ts:42) is defined but has zero consumers — the UI is still one hard-coded block of JSX per paradigm. This phase follows the Kinesis/MSK pattern and adds two blocks, `isDynamo`/`isS3` (tableName+region / bucket+prefix+format+hasHeader), and **tightens the JDBC guard from `!isStream` to `isJdbc`** (otherwise DDB/S3 would wrongly fall into the JDBC host/port/db form). The real "provider-derived form" refactor is left for later (a much larger undertaking; not this phase).

### 12.6 Phase landing status (this phase = all code landed + unit tests; real run pending deployment)

| Phase | Content | Status | Acceptance anchor (headless) |
|---|---|---|---|
| **DynamoDB, phase 1** | dynamodb provider + registry + UI form + test-endpoint routing | ✅ Code + unit tests (64/64) | Create a DDB source → test connection active → introspect lists the sampled attributes as columns |
| **DynamoDB, phase 2** | DynamoDB read branch in the Glue generator + CDK permissions | ✅ Code (generator probe passed) | Create a sync task → Glue SUCCEEDED → row counts in Redshift + S3Tables match the source |
| **S3, phase 1** | s3 provider + registry + UI form | ✅ Code + unit tests | Create an S3 source → test connection (HeadBucket) → introspect lists prefixes + CSV-inferred columns |
| **S3, phase 2** | Athena external-table DDL direct query + API endpoint + CDK permissions | ✅ Code (DDL unit tests 8/8) | Create an external table → Athena SELECT returns a row count matching the source |
| **Shared** | Data-driven recommendChannel + SyncTaskModal compatibility | ✅ Code (regression assertions) | JDBC zero regression + DDB/S3 drop-downs render correctly |

### 12.7 Honest boundaries (no overstatement)

- **This phase: all code landed + tsc 0 + 629 unit tests green, but the "real run" has not been done** — DDB introspect / sync and S3 external-table creation / query all need a real run in the test account **after deployment** (once the CDK permissions are in effect). Red line: never report "complete" before the real run confirms it.
- **DDB has no fixed schema**: the introspect columns are inferred as the union of attributes over a Scan sample of 50 items and are not authoritative (labeled meta.sampled=true); when item attributes are heterogeneous, the columns may be incomplete, and sync to Redshift relies on the VARCHAR fallback of the type mapping + a SYNC_UNMAPPED_TYPE warning.
- **DDB phase one has no incremental / CDC** (full Scan); DDB Streams incremental is phase two.
- **S3 introspect infers columns only from CSV samples**; the exact schema for Parquet/JSON is provided by the user when creating the external table, or Athena reads the schema embedded in Parquet — in the introspect stage the columns may be empty (format labeled honestly).
- **The real behavior of DDB→Glue connector reads** (nested Map/List attributes → Spark struct/array → Redshift mapping) needs confirmation by a real run; the pragmatic phase-one expectation is that complex types land as VARCHAR.

### 12.8 Large-data real-run verification results (2026-07-29, test account, requirement: "generate 1 million rows for a load test")

**🔴 Core lesson: a few rows of data cannot expose problems — a real run with large data is a necessary means of flushing out boundary bugs.** Load-testing both paradigms with 1,000,000 generated rows flushed out and fixed 5 real bugs that neither paper analysis nor small data could reveal:

| # | Bug | Stage where it surfaced | Fixed |
|---|---|---|---|
| ① | The "Test connection" of source creation sent flat values, while the backend's non-JDBC routing read body.connection → "table name missing" | Setup-level UI | 2026-07-29 |
| ② | A target table name containing a hyphen went straight into the Redshift DDL → "syntax error at '-'" | Small data (6 rows), Glue real run | 2026-07-29 |
| ③ | The Spark temporary view name temp_{source table name} (containing -) → "Invalid view name" | 1,000,000 rows DDB→S3Table, large data | 2026-07-29 |
| ④ | The S3→Glue ingestion path was not implemented; the S3 source wrongly fell into the JDBC read with an empty secret → "SecretId length 0" | S3 1,000,000 rows→S3Table, large data | 2026-07-29 |
| ⑤ | S3TablesCatalog's CREATE TABLE **does not create the namespace automatically**; a new namespace → 404 NotFoundException (the job fails within seconds) | EMR DDB→S3Table, first use of a new namespace | (this phase's EMR channel) |

**②③④ are "identifier / path" bugs: a JDBC source table name is already a valid SQL identifier and comes with a secret, so the four JDBC siblings never exposed them; DDB/S3 resource names allow hyphens and iam-role has no secret — a real boundary introduced by the new paradigms.** ③④ in particular surfaced only when large data triggered the S3Table write path / the whole S3 ingestion path (small data only wrote to Redshift and never got there).
- **⑤ is a "hidden prerequisite" bug**: S3TablesCatalog's `CREATE TABLE` does not fall back to creating the namespace the way GlueCatalog does.
- The namespaces previously used by the Glue channel (ddb_bench/gamedata and so on) were all historical leftovers that already existed, so it never surfaced;
- it surfaced the first time the EMR channel used a brand-new namespace.
- **Root fix = `spark.sql("CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.<ns>")` before creating the table (standard Iceberg syntax, idempotent)**, applied to every write path that goes through S3TablesCatalog in Glue / EMR / Flink.

**Final large-data end-to-end, all green (Athena reconciliation value by value):**
- **DynamoDB 1,000,000 → Glue DDB connector Scan (splits=8, throughput 0.5) → S3Table**: total rows 1,000,000; region east/west/north/south 250,000 each (the split reads lost no rows and duplicated none).
- **S3 1,000,000 (4 files × 250,000 CSV) → Glue spark.read.csv → S3Table**: total rows 1,000,000; 250,000 per region, and sum(amount) matches the source exactly value by value (east=249000000/north=250000000/south=250500000/west=249500000).
- **🆕 DynamoDB 1,000,000 → EMR Serverless (boto3, 32-shard parallel Scan) → S3Table**: total rows 1,000,000; 250,000 per region; distinct player_id=50,000 (50,000 players in the source); sum(score)=4,999,500,000 (exact match with the source value by value). Landed on 2026-07-29; verified by a dedicated headless acceptance script.

- **🔴 Full coverage of the DDB→S3Table multi-engine channels (the requirement "every method must work end to end"): Glue (connector) ✅ + EMR Serverless (boto3 sharded Scan) ✅.**
- **Flink, after verification, is not done** — the official DDB connector has only a streaming DDB-Streams source and no full-table batch-scan source;
- the platform's Flink = MSAF is stream-oriented, and a home-grown batch source would violate the red line "do not create bugs while changing";
- DDB has no CDC = batch only, and the two engines Glue + EMR already cover it fully;
- Flink stays reserved for the Kinesis / MSK / CDC streaming sources.
- On the EMR side, GlueContext is not used (EMR has none) and no bet is placed on the emr-dynamodb jar (there is no official proof of whether it is bundled) → boto3 Scan: zero jars, zero build.

**General lesson (written into the recipe / notes):** every (source × target × engine) combination of a new paradigm must be really run — the S3 analysis channel (Athena external table) working ≠ S3 sync ingestion (Glue) working; Glue reading DDB working ≠ EMR reading DDB working (GlueContext vs. boto3 are two different read methods); identifier sanitization + namespace pre-creation must cover every place that goes through SQL identifiers / S3TablesCatalog (grep the whole codebase). The data-generation scripts for the DDB and S3 million-row sets are kept with the acceptance tooling.

---

## 13. Design addendum (revision 0.6, 2026-10-25) — S3 external table page entry + place follows the region of the data source

> Decided on 2026-10-25: "do it". The multi-region place semantics follow the [multi-region execution specification](./multi-region-execution-spec.md); this section writes only how this module hooks into them.

### 13.1 Problems (two, fixed together)

- **No page entry**: the S3 analysis channel of §12.2 (`POST /api/datasources/[id]/s3-external`, landed 2026-07, moved into the [long-running-operation framework](./long-running-operations.md) in its second batch) existed only as an API. After creating an S3 source on the Data Sources page, there was no button anywhere on the page that could turn it into a directly queryable table (the table tree of the Athena Query page lists only the S3 Tables catalogs).
- **Wrong place**: the three DDL statements of `lib/datasource-spi/object-store/athena-external.ts#ensureExternalTable` called `startQuery(sql, { database })` without a place, and `getExecution(id)` without a region ⇒ they always landed in the **home region's** Athena workgroup / Glue catalog;
  - a table created from an S3 source in a second region ended up in the home region's catalog, and querying it meant the home region's Athena reading the bucket across regions.
  - The executor `lib/datasource/long-ops.ts` recorded `noteDatasourceRowPlace(ds)` (the observation ledger was correct) but never handed the place to the table creation.
  - The Glue catalog permission the platform TaskRole grants for `bgp_s3_ext` was also authorized for the home region only (`axis: "home"`) — even if the table creation had gone to the right region, it would have been AccessDenied.

### 13.2 Design

| Layer | Change | Single author |
|---|---|---|
| Table builder | `ensureExternalTable(spec, place: AthenaPlace)` — the place is **mandatory** (no default in the type; at run time a missing / incomplete place also throws "place missing" and never falls back to the home region); the three DDL statements go through `startQuery(sql, ctx, place)`, and the status query `getExecution(id, place.region)` hits the region that started it; the return value additionally carries `targetId / region` | `lib/datasource-spi/object-store/athena-external.ts` |
| Executor | After reading the source row, `resolveAthenaPlace(datasourceOwnerTarget(ds))`: the place = the stamp on the row (the single way to read it; legacy rows without a stamp = home region); for a non-home place, take that region's descriptor `athenaWorkgroup / datalakeBucket`; if that region is not ready / has no workgroup ⇒ reject on the spot; the response `data` additionally returns `targetId / region`; the audit detail records the same | `lib/datasource/long-ops.ts` (kind `datasource-s3-external`; long-running operation / object lease / error semantics unchanged) |
| IAM | In `DataSourceReadOnly`, the Glue catalog statement changes `axis: "home"` → `"execution"`: the resources remain restricted to `catalog` / `database/bgp_s3_ext` / `table/bgp_s3_ext/*`, and the authorized list = home region ∪ execution regions (the `aws:RequestedRegion` condition is attached in pairs by `regionalStatement`);<br>the Athena actions were already on the execution-region axis | `infra/lib/platform-stack.ts` |
| Page entry | The action column of the Data Sources page gains an "External table" button **for S3 sources only**<br>⇒ the dialog `app/datasources/S3ExternalTableModal.tsx`: the title carries a Tag with the place region; a dataset drop-down (`fetchSourceTables`, the same path as "Browse tables"; when there is exactly one it is selected directly, when there are several the user must name one — the first is never taken silently); a dataset with no inferred columns is warned about first; the button text reads "Create external table in <region>" (guardrail 2: a write operation restates its target on the button)<br>⇒ POST `…/s3-external { dataset }` (beyond 45 s the global fetch interceptor polls according to the long-running-operation protocol; the component is unaware)<br>⇒ success block: `bgp_s3_ext.<table>` + place region + column count / format / location + "Show CREATE TABLE statement" + **"Open in Lake Query"** (`/athena?scope=<targetId>&sql=<sample query>`) | `app/datasources/page.tsx` (the place is computed from the stamp on the row, `datasourceOwnerTarget`; an invalid stamp is reported as an error and never defaults to the home region) |
| Athena Query page | On entry, reads `?sql=` and pre-fills the editor (only when the editor is empty — the same "never overwrite what the user has already written" rule as the sample SQL of the table tree); the place is still decided by `?scope=` through the top-bar view | `app/athena/page.tsx` |
| Dictionary | The 17 Chinese keys of the dialog and button enter the English dictionary (`en-coverage-guard` watches every literal `t()` key) | `lib/i18n/messages/en.ts` |

### 13.3 Acceptance criteria

- **Assembly level** `lib/datasource/__tests__/s3-external-place.test.ts` (mocks only the Athena / S3 SDK, DynamoDB and the registry; all sibling modules real): a second-region source ⇒ the three DDL statements and all status queries go to us-west-2, that region's workgroup, that region's lake bucket as the result location, zero calls to the home region, the response returns `targetId / region`, and the audit records the real place;
  - a legacy source without a stamp ⇒ byte-for-byte equivalent to before the fix (home-region workgroup, no ResultConfiguration, `targetId = tgt_home`);
  - a bare call to `ensureExternalTable` ⇒ throws with zero Athena calls;
  - the source-code call site is pinned: `resolveAthenaPlace(datasourceOwnerTarget(ds))`, and every `startQuery` / `getExecution` carries the place / region.
- **Page** `app/datasources/__tests__/s3-external-entry.test.ts`: the success block is really server-rendered (table name / region / column count / "Open in Lake Query" link = scope + sql); seams: the page renders the button only for S3 sources, computes the place from the stamp on the row, really renders the dialog; the dialog's POST path and body; the Athena Query page reads `?sql=` and does not overwrite existing content.
- **Real environment** (a new page-driven headless-browser acceptance segment): in a demo account, from the second region's view ⇒ create an S3 source on the page (pointing at a fixture CSV prefix under that region's lake bucket) ⇒ the row's "External table" ⇒ pick the dataset in the dialog ⇒ the success block shows the table name ⇒ "Open in Lake Query" ⇒ the Athena Query page with `?scope=<second region>` pre-fills the SQL ⇒ running it returns the fixture row count; cross-checked truth: that region's Glue `get-table bgp_s3_ext.<table>` exists and **the home region's catalog has no such table** (the negative check for the place defect); teardown: delete the source on the page + delete that region's external table + delete the fixture objects.

### 13.4 Boundaries (as they are)

- Under the `enforce` data-plane credential mode (the switch to `enforce` has not yet been made), the "platform data-plane role" of each execution region does not yet have Glue catalog / Athena permissions; this addendum only opens the TaskRole's axis (production and the test accounts are all taskrole / observe); the rest is added together with the `enforce` switch.
- The external-table database `bgp_s3_ext` exists once per region (same name, physically isolated); deleting a data source does **not** cascade to the external table (an external table is metadata only; DROP does not delete S3 data; whether it should be deleted with the source is a separate, undecided question).
- Parquet / JSON columns remain empty in phase one ⇒ the page warns first that "table creation will be rejected" (consistent with the boundary in §12.7); the table tree of the Athena Query page still lists only the S3 Tables catalogs, and tables under `bgp_s3_ext` can only be queried through the SQL pre-filled by "Open in Lake Query" or a hand-written table name (folding them into the table tree is a separate decision).

## 14. Design addendum (revision 0.7, 2026-10-30) — three gaps in the delete-source path + drift model for data-source external network objects

> - Decided on 2026-10-28: "in the next release; root fix, not a patch".
> - Product code: three commits (the last being the second fix), **merged into the development mainline on 2026-10-30 at 00:3xZ**.
> - Real-environment acceptance: a two-region demo test account upgraded to the fixed build (product bytes plus the showcase script following the 202 long-operation protocol), page-driven: the delete-source segment **7/7 ✅** ·
>   the drift-model segment **8/8 ✅** (the first run scored 7/8 and caught the second fix; check 7 passed on the rerun) ·
>   the new stream-sample-ordering segment **4/4 ✅** (150 generated events ⇒ the two latest windows 00:05 / 00:06 in the page's "Aggregated result" each hold exactly 5 regions and agree with a full read on the read side; baseline 69 → 84 rows) · the new engine-run segment **4/4 ✅** ("Run now" returns 200 synchronously / the ledger gains exactly +1 succeeded / two concurrent clicks in the same millisecond ⇒ 200 + 409 LONG_OP_IN_PROGRESS "Run engine job is in progress") ·
>   showcase `--stage run --only realtime,emr` all green in both regions (49 aggregate rows in the home region, 24 in the execution region; the execution region's EMR run returned 200 synchronously ⇒ succeeded).

### 14.1 Problems (four, one path in two directions)

- **Platform security group left behind permanently after deleting a source**: the source was deleted while the network interface of the post-creation connectivity probe (the Glue discovery job) was still attached; the in-process retry from an earlier fix (10 × 30 s) hit DependencyViolation every time, gave up and left no record; the interface was released minutes later, but nobody deleted the group again (CloudTrail confirmed 11 attempts).
- **Deleting a source does not check references**: "Delete data source" checked only the workspace permission and the long-running-operation lease of this one source; the source row / Glue connection / secret / security group were deleted regardless, the sync / stream jobs referencing it became orphans, and only the next trigger reported "connection does not exist".
- **Ghost rows**: after a source was deleted, the in-flight probe wrote its conclusion back to the deleted key with an unconditional UpdateItem ⇒ the list gained a row out of nowhere with no name and the status "Unreachable".
- **Platform-created objects deleted from outside the platform**: the `bgp-ds-*` group has a network interface only while a job is running, so any person / tool cleaning up by "no interface = orphan" deletes it; afterwards every sync of that source fails with only the AWS message, the source still shows "Connected", and the product has no self-healing and no repair entry. The engineering rule "deletes leave no orphans" had so far covered only the direction "the platform deletes", not "what if someone else deleted the platform's objects".

### 14.2 Design

| Layer | Change | Single author |
|---|---|---|
| Reference list | Before deleting a source, read its references by `datasourceId` (sync tasks on the Glue / DMS / Zero-ETL channels, stream jobs); if non-empty ⇒ 409 `DATASOURCE_IN_USE` with detail `{ syncTasks, flinkJobs }` naming each one; the page dialog shows the message verbatim and points the way; nothing at all is deleted | `lib/datasource/references.ts` |
| Persisted pending-cleanup groups | If the group is still referenced by a network interface when the source is deleted ⇒ a persistent record is written (pump kind `sg-cleanup`) and settled on the **interface facts**: Delete only when `DescribeNetworkInterfaces` returns 0; budget 30 minutes + full jitter; on expiry, honestly failed "needs manual action"; after a process restart the pump takes over; the delete-source response `data.pendingCleanup` and the audit record both states; visible in the "Background cleanup jobs" card in Settings | pump kind `sg-cleanup` (persistent task table of the data-plane jobs) |
| Conditional write | `patchDataSourceRow` gains `ConditionExpression: attribute_exists(datasourceId)`; ConditionalCheckFailed is treated as "source already deleted, conclusion discarded"; the bare UpdateCommand of the non-JDBC source-creation path now goes through the same single writer | `lib/datasource/ds-patch.ts` |
| Drift model | The external objects a data source depends on are classified by **ownership**: **platform-owned** (self-created group / Glue connection / the subnet chosen by the platform's probe) are rebuilt from the source row + secret and reattached **at the moment of use** (sync "Start" / scheduled run / the pump's 10-minute patrol), writing the audit event `datasource.network.healed` + a P2 Alerting Center event + `healCount / lastHealedAt` on the source row, and the page shows a green badge "Self-healed n time(s)";<br>**user-owned** (user-specified groups / subnets, VPC) are never touched: the source status is set to abnormal, runs are refused with 409 `DATASOURCE_NETWORK_BROKEN`, audit `.broken` + a P1 alert, the page shows a red badge "Network object missing" + a Tooltip with the message, and the "Network configuration" drawer restores by switching groups.<br>The result closes over `intact / healed / broken`.<br>**Second fix** (caught by check 7 of the first drift-model acceptance run): a rebuilt / reattached Glue connection had no Availability Zone ⇒ the job failed with "Unable to resolve any valid connection" — the root cause is that source creation never stored the AZ in `networkConfig`;<br>the fix = both authors that write connections (`createGlueConnection` / `updateGlueConnectionNetwork`) always take the AZ from the subnet facts via `resolveConnectionAvailabilityZone` and `describeSubnetFact` (if the caller supplies one it is checked, and a contradiction throws; a subnet that does not exist ⇒ the write is refused), source creation persists the AZ, and `userSpecifiedNetwork` no longer falls back to another subnet's AZ | `lib/datasource/network-reconcile.ts` · `lib/aws/datasource-service.ts` |
| Machine-readable ownership | Groups and Glue connections carry the tags `bgp:managed=datasource` / `bgp:datasourceId` / `bgp:targetId`; the Glue connection name has a single author, `platformGlueConnectionName` (`bgp-conn-<last 12 characters of the id>`) | `lib/aws/datasource-service.ts` |
| Inventory | Settings gains a "Data source network objects" card: per group, ownership / status (`in-use / orphan / pending-cleanup / needs-manual`) / referencing source; one-click cleanup of orphans goes through the same pump | `app/api/admin/datasource-network-objects/*` · Settings page |

### 14.3 Acceptance criteria

- **Unit / assembly level**: `network-reconcile.test.ts` (the fixture rows have the same shape as what is really persisted — no AZ; the DescribeSubnets fake returns the AZ per subnet; AZ assertions on Update / Create; a contradiction / a missing subnet refuses the write) · `create-network-assembly.test.ts` (DescribeSubnets added to the call sequence; the persisted row toStrictEqual with the AZ; AZ contradiction ⇒ 500 with zero writes) · the reference list returns 409 naming each task with zero deletions · removing the conditional write as a mutation turns the test red · the pump settles on the interface facts.
  - 🔴 Lesson: the first version's fixtures carried an AZ of their own ⇒ unit tests all green while the real environment was red (a fixture's shape must mirror the persisted row).
- **Real environment (new page-driven headless-browser acceptance segments)**: the delete-source segment (7 checks: two for reference checking, three for pending security-group cleanup, one for ghost rows, plus teardown) and the drift-model segment (8 checks: seven drift-model checks plus teardown); on 2026-10-30 at 00:3xZ in the test account: delete-source 7/7 ✅ · drift-model 8/8 ✅ (first run 7/8 ⇒ second fix ⇒ rerun 8/8). 🔴 In the demo account the source database shares the VPC with the control plane ⇒ "Detect" and "Browse tables" connect directly from the control plane without going through the Glue connection ⇒ they do not trigger the check; the page entries that do go through the check = sync "Start" and the pump's patrol.

### 14.4 Boundaries (as they are)

- Self-healing rebuilds only **platform-owned** objects; if a user's own group / subnet is deleted, the product only reports it and points the way (the product does not make network decisions for the user).
- Workarounds for existing deployments (the 2026-10-29 release and earlier): an orphaned group can be deleted manually once its interface count is 0; before deleting a source, filter "Data Sync" by data source once; a ghost row can be deleted directly on the page with "Delete"; when a sync reports "Security Group Not Found", the only recourse is to delete and recreate the source and point the tasks at it again — **before deleting any `bgp-*` cloud object, first check whether a data source row still references it**.
- "Check the product's row references before deleting any `bgp-*` cloud object" has also been written into the engineering rules in `AGENTS.md`.
