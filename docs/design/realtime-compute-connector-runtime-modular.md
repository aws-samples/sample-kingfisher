# Stream Compute — Flink Connector Runtime: Modular On-Demand Assembly (Final Form)

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place, execution scope, per-region scheduling and the like — is described in the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the module index; a path mentioned in this document that no longer exists means that idea was not implemented as described or has since been superseded.

> - Revision: 1.0 (design · pending decision) | Date: 2026-07-27 | Trigger: while adding the MSK source it became clear that the "fat JAR" model cannot carry 50+ sources worldwide; the requirement was to think the **final form** through, eliminate the multiple mechanisms, map out the blast radius
>   clearly, and write the document before writing any code.
> - Relationship: this is the **foundation** on which MSK source support (the MSK phase of the data-source ecosystem work) stands. MSK should not be crammed into "adding a source"; it should land on top of this foundation and return to genuinely "adding one line".
> - 🔴 **Design only; code moves only after the decision. What moves is the start path of every Flink job (the core chain), so it must be a strangler-pattern rollout with zero regression.**

---

## 0. One-sentence goal

Collapse the **three** mechanisms that currently serve **one** need — "gather the connector JARs a Flink job requires" — into **one**:
**a thin base runtime + a connector module library (on S3, versioned) + a data-driven connector registry + on-demand assembly at job start + content-hash caching.**
So that "adding a source / sink = dropping in one connector module JAR + adding one registry row", with a blast radius approaching zero — isomorphic with the data-source SPI of the data-source ecosystem ("adding a source = one registry row"), architecturally consistent across the whole platform, and extensible to 50+ sources.

---

## 1. Current state, with evidence (code-level, not qualitative)

### 1.1 The lesion: one need, three mechanisms

"A Flink job must have the right connector JARs when it starts" currently has three independent implementation paths:

| # | Mechanism | Code location | Coverage |
|---|---|---|---|
| 1 | **Base pre-packaged** `flink-sql-runner.jar` | `flink-sql-runner/pom.xml` | Kinesis source + jdbc / files / json sinks, ~12 MB |
| 2 | **s3t pre-packaged** `flink-sql-runner-s3t.jar` | `flink-sql-runner-s3t/pom.xml` | Kinesis source + **mysql-cdc source** + iceberg / s3tables sink, ~115 MB |
| 3 | **Dynamic assembly at start** `assembleUberJar` | `flink-connectors.ts:111` | Base package + a user-uploaded custom sink JAR, with SPI services merged |

`runnerFor(sinkType)` (`flink-config.ts:42`) picks between #1 and #2 by **sink type**; custom sinks go through #3.

### 1.2 Why this is an architectural smell

- **One need, three mechanisms** = cognitive load + three places to maintain + a special case (custom sinks are the only thing that goes through dynamic assembly; built-in sources / sinks rely entirely on pre-packaging).
- **Pre-packaging (#1 / #2) grows as O(sources × sink families)**: to support CDC → S3 Tables and Kinesis → S3 Tables, the s3t package **stuffed both source connectors in**. Every added source (such as MSK) has to be stuffed into the package of **every** sink family. At 50+ sources → every package is huge, builds are slow, and any source / sink change forces rebuilding and re-verifying every package. **It cannot carry global scale.**
- **The truth about the split line**: the real boundary between #1 and #2 **is not sink type but "whether Iceberg is needed"** — the iceberg / s3tables / hadoop stack is heavy (~100 MB) and prone to dependency conflicts, so it must be isolated and pre-built. Everything else is a lightweight connector that could perfectly well coexist.

### 1.3 Existing reusable assets (the final form must build on them, not rebuild them)

| Asset | Location | Use in the final form |
|---|---|---|
| **JAR merge engine** `mergeJars` | `flink-connectors.ts:77-107` | The assembly core of the final form: it already handles SPI services merging, class de-duplication, and stripping of signatures / multi-release entries |
| **Dynamic assembly** `assembleUberJar` | `flink-connectors.ts:111` | The on-demand assembly of the final form, extended to built-in connectors |
| **Connector JAR upload / storage** `uploadConnectorJar` | `flink-connectors.ts:42` | User connectors and built-in modules are unified as "connector modules" in the same storage |
| **Runner build and upload** deploy-all.sh | `scripts/deploy-all.sh:310-328` | Changed to build "thin base + N module JARs" and upload them |
| **Proof of coexistence** | The base package already bundles kinesis + jdbc + files together; s3t already bundles kinesis + cdc together and really runs | Proves that `flink-sql-connector-*` relocation is clean and that the design can coexist |

---

## 2. Final-form design

### 2.0 🔴🔴 Final-form decision: the divide-and-conquer boundary (forced out by three consecutive real-run failures in phase 4 on 2026-07-27; decided)

**Real-run verification in phase 4 (switching the start path) exposed three hard constraints in a row** (invisible in paper reasoning; they only surfaced in real runs):
1. The REST endpoint approach did not work on MSAF (losses were cut).
2. The official iceberg-flink-runtime **does not contain bare Hadoop** (`org.apache.hadoop.conf.Configuration`); the catalog's reflective registration hit ClassNotFound → hadoop-common had to be added.
3. With Hadoop added, the **Iceberg module has 89,220 entries**, and merging it with lightweight modules at run time via **adm-zip hits the ZIP64 limit (65,535)** — whereas the existing s3t fat JAR with 80,524 entries runs, because maven-shade writes ZIP64 and adm-zip writes classic ZIP.

**The three problems share one root: the heavy Iceberg stack (89 thousand entries + Hadoop + conflicts) is unsuitable for "dynamic merging at run time".** The final form is therefore **divide and conquer** (the correct boundary dictated by physical constraints, not a half-finished product; the Flink project itself ships Iceberg as a pre-built runtime JAR and does not assemble it at run time):

| Connector category | Assembly method | Basis |
|---|---|---|
| **Lightweight connectors** (kinesis / kafka / jdbc / files / json, a few thousand entries each) | **On-demand `mergeJars` merging at run time** (phase 3, with content-hash caching) | Measured: zero conflicts among them, small entry counts, adm-zip workable. MSK (kafka) belongs here; landing it is just "adding a module" |
| **Combinations that include Iceberg** (→ S3 Tables) | **Maven pre-built combination package** (unified resolution + ZIP64, i.e. the existing s3t approach) | Measured: 89 thousand entries hit ZIP64, Hadoop is needed, conflict-prone; the existing s3t has been running for a long time |

**This does not overturn modularization**: the lightweight side (the vast majority of sources / sinks) still gets the zero-radius extension "adding a source = adding one module"; Iceberg, the single heavy-stack exception, goes pre-built (it was always meant to be a black box — section 2.4 already foreshadowed this, and real runs proved it should be even more thorough). **MSK's landing is unaffected** (kafka is lightweight and merges at run time; Kafka → S3 Tables goes through the pre-built combination package).

- **✅ After the split, the lightweight side passed real-run verification (2026-07-27; the phase 4 acceptance anchor was reached)**: run-time `mergeJars` merged base + kinesis + files + json (**7,204 entries, far below 65,535 — no ZIP64 collision; 0 facade conflicts**) → an 11.6 MB uber-JAR → a standalone MSAF application really ran **Kinesis → raw S3 files** → **RUNNING + genuinely produced correct windowed aggregates** (landed on S3 as `{"window_start":...,"region":"east","total_amount":23.0,"cnt":2}` and the like; window splitting and grouped sums both correct).
- Confirmed: the modular run-time merge path is **feasible and equivalent to the fat JAR**.
- The job was stopped and the resources deleted after verification to cap cost.
- Combinations that include Iceberg go pre-built (asm.prebuilt=true returns the already-proven s3t package; no re-verification needed).

> Sections 2.1–2.6 below are the complete record of the exploration (including judgments later corrected by real runs), kept for traceability; **the decision in this section 2.0 is authoritative**.

### 2.1 The four components

1. **Thin base runner** (`flink-sql-runner`, refactored): keeps only the `FlinkSqlRunner` main class + the `aws-kinesisanalytics-runtime` helper + Flink core / table as `provided`. **No connectors packaged at all.** A few MB.
2. **Connector module library** (S3 `flink/modules/<id>-<version>.jar`, pre-built): each connector = one **pre-shaded, coexistence-safe** JAR:
   - `kinesis`, `kafka`, `msk-iam-auth`, `mysql-cdc`, `jdbc` (including the MySQL driver), `files`, `json`, `avro` …
   - the **`iceberg-s3tables` bundle** (essentially today's s3t package **minus the source connectors** and minus the base; the heaviest, most conflict-prone stack isolated into one module that is built once).
3. **Connector registry** (a TypeScript data table, data-driven — in the same spirit as the SPI registry of the data-source ecosystem): SQL token → set of required module ids.
   ```text
   'connector'='kinesis'                        → ["kinesis"]
   'connector'='kafka'                          → ["kafka"]  (+ "msk-iam-auth" when the SQL contains AWS_MSK_IAM)
   'connector'='mysql-cdc'                      → ["mysql-cdc"]
   'connector'='jdbc'                           → ["jdbc"]
   'connector'='filesystem'                     → ["files"]
   catalog-impl=...S3TablesCatalog / type=iceberg → ["iceberg-s3tables"]
   'format'='avro'                              → ["avro"]   'format'='json' → ["json"]
   ```
4. **Assembly at start + content-hash cache** (`resolveModules` + reuse of `mergeJars`):
   - Parse every connector / catalog / format token in the **already-injected finalSql** → resolve the set of module ids (de-duplicated, including conditional dependencies such as msk-iam-auth).
   - Sort the set and compute a **content hash** (hash(base version + ordered list of module id-version + user connector keys)) → the uber-JAR cache key `flink/jobs/uber-<hash>.jar`.
   - Cache hit → reuse directly (zero build, zero latency); cache miss → `mergeJars` assembles + uploads + stores in the cache.
   - **User-uploaded connectors fold into the same set** — a custom sink is no longer a special case (eliminating the specialness of #3).

### 2.2 From three mechanisms to one (proof of architectural convergence)

| Original mechanism | Destination in the final form |
|---|---|
| #1 base pre-packaged | Split into the thin base + individual connector modules; the `runnerFor` logic is replaced by `resolveModules` |
| #2 s3t pre-packaged | Becomes one `iceberg-s3tables` module in the module library (the other source connectors are pulled out) |
| #3 custom-sink dynamic assembly | **Promoted to the only path**: built-in and user connectors are assembled on demand in the same way |

One mechanism. Adding a source / sink = one more JAR in the module library + one registry row + (for a source) one provider (already in place in the data-source ecosystem). **Blast radius = constant.**

### 2.3 Why it is feasible (technical facts, not optimistic assumptions)

- The semantics of `mergeJars` + `ServicesResourceTransformer` **have already been verified in real runs with custom sinks**; `flink-sql-connector-*` is designed for coexistence (clean relocation), and the base / s3t packages each running several connectors together is the empirical proof.
- Iceberg, the "heaviest and most conflict-prone" hard part, **is not assembled dynamically** — it is pre-shaded into one coexistence-safe bundle module (equivalent to the content of today's proven s3t package), freezing the risk into a one-time build artifact. **In the final form Iceberg is still "pre-built"; it merely changes from "a package dedicated to one sink" into "one module in the library", without changing its verified internal composition.**

### 2.4 🔴 Adversarial verification: the real risks of run-time merging and the two mandatory constraints (measured 2026-07-27)

**Challenge** (self-attack): run-time `mergeJars` (AdmZip "first added wins") ≠ the unified dependency resolution of a single Maven shade. If two modules carry **different versions** of the same shared library (MySQL driver / protobuf / Flink internals), the merge silently picks one → `NoClassDefFound` / `NoSuchMethodError` at run time. This could overturn the whole modularization plan.

**Measured facts** (the existing base 17 MB / s3t 136 MB JARs were unpacked; the evidence is recorded in the working session):
- The two packages share **8,577** same-named classes (93% of the base's 9,216 classes) — the conflict surface is **large**. Un-relocated shared libraries do exist: `com/mysql/cj/` (1,075), `com/google/protobuf/` (735), `org/apache/flink/` (6,735).
- **But of 200 sampled same-named classes, 199 are byte-identical** (`com/mysql/cj/jdbc/Driver.class` and `com/google/protobuf/CodedInputStream.class` have byte-for-byte identical md5 values). Root cause: all connectors **are already aligned on one version set** (the same Flink 1.20 / kinesis 5.0.0-1.20 / mysql 8.4.0) → same name means same bytes → whichever wins the merge, the result is the same.

**Conclusion (revised)**: the true shape of the merge risk is "**safe for version-aligned modules, dangerous for version-divergent modules**". The conflict count is large, but the overwhelming majority is harmless. The skeleton of the plan stands, but **two hard constraints must be added**, or a mine is buried:

1. **A unified-version parent POM**: all connector modules inherit the same parent (pinning the Flink version + a BOM for shared libraries), guaranteeing "same-named class = same bytes" **at the source**. This lifts Maven dependency resolution from "within one package" to "unified across modules". **Every new module must use this parent; bringing a divergent version of its own is forbidden.**
2. **Byte-level conflict detection in `mergeJars` (graded; refined by measurement on 2026-07-27)**: when merging, compare the content hash of same-named classes. **Measured**: the official-runtime Iceberg module ∩ kafka = **0 conflicts**; ∩ kinesis = **28 `org/apache/commons/logging` classes** (the commons-logging logging facade, embedded separately in each connector fat JAR). Conflicts are therefore graded:
   - **Core libraries (flink / iceberg / jackson / serialization and so on) with different bytes → FAIL, abort with an error** (they really do crash at run time).
   - **Known stable facades (commons-logging and the like: extremely stable API, consistent behavior across versions, and the existing base runner already embeds 30 such classes and has run for a long time) → WARN and let through** ("first added wins" is safe). Allow-list prefix: `org/apache/commons/logging`.
   This makes version divergence surface, graded, **at assembly time** rather than crashing silently at run time. Any addition to the allow-list must be backed by "existing, proven real-run evidence"; arbitrary expansion is forbidden.

3. **The heavy Iceberg stack is not split**: it is still pre-shaded by Maven into one whole module (one unified resolution); at run time it is assembled in as **one black box**, and its internal 100 MB of dependencies are not unpacked at run time.

4. **🔴 The bytecode Java version must be ≤ the MSAF runtime (forced out by the MSK real run on 2026-07-27)**: the .class bytecode version (class file major version) of connector modules and of **all of their dependencies** must be ≤ **55 (Java 11)** — the MSAF Flink 1.20 runtime is Java 11,
   - loading higher-version bytecode fails immediately with `UnsupportedClassVersionError` (class major 61 = Java 17 > 55),
   - the exception occurs during **operator initialization** (for example KafkaSource's SplitEnumerator crashes the moment it starts),
   - and MSAF **swallows the root cause** (the JobManager log only shows "Uncaught exception while starting the SplitEnumerator", with no Caused by;
   - the real stack trace is only visible from the Flink job page / the TaskManager).
   - **Measured**: `aws-msk-iam-auth 2.3.7` is compiled for Java 17 → crash;
   - rolling back to `2.2.0` (Java 8, major 52) passes.
   - **Lessons**: ① when choosing a dependency version, check its bytecode version (`unzip -p x.jar Foo.class | od -j6 -N2`; major − 44 = Java version); do not just take "the latest";
   - ② `maven.compiler.release=11` in `parent.pom` only constrains **the source code we compile ourselves**; it has no control over the bytecode of pre-compiled third-party JARs;
   - ③ after changing a dependency version you **must run `mvn clean package`** (without clean, stale .class files of the old version linger and get mixed into the fat JAR — an illusory fix).
   - Systematic self-check: after the build, scan the major version of every .class in the fat JAR; any value > 55 is dangerous.

With these four, modularization gains extensibility (adding a source = adding one version-aligned module) while eliminating the merge / loading hazards. **Code must not move if any one of them is missing.**

### 2.4bis 🔴 Concept clarification: the "JAR boundary" of operating S3 Tables from fully managed services (clarified on 2026-07-27 after a follow-up question)

> The question raised was "do managed Flink / EMR / Glue really all require us to find JARs ourselves to operate S3 Tables? Surely it is not that weak" — this had to be clarified to prevent the misconception "managed means no JAR" from misleading later design.

The three managed services differ in **depth of management**, so their JAR situations differ (confirmed against the AWS documentation):
- **EMR / Glue**: managed **one layer deeper** — even the engine's extension libraries (the Iceberg / S3 Tables integration) are pre-installed in the runtime. Users pick a release / use the native integration and **never touch JARs**.
- **MSAF (managed Flink)**: manages only the **Flink runtime** (JobManager / TaskManager / scaling / snapshots) and **pre-installs no connector at all**. Flink's inherent model is "whatever connector the SQL uses, the application JAR must carry". **This is not specific to S3 Tables, nor is it a weakness**: the Kinesis source, S3 filesystem sink and JDBC sink already running today **are all packaged into the application JAR**; it has nothing to do with "self-hosted vs managed" and everything to do with "it is Flink".

**Conclusion**: on MSAF, "the application carries its own connector JARs" **cannot be avoided** (the platform's responsibility is to do this elegantly — modular on-demand assembly, so users never have to care about it; that is exactly the value of this connector-runtime work). **But** "which JAR to carry" has better and worse options:
- S3 Tables integration has two routes: ① `S3TablesCatalog` direct connection (the status quo, carrying the ~100 MB Hadoop stack); ② the **AWS Iceberg REST endpoint** (`s3tables.<region>.amazonaws.com/iceberg`; the catalog logic lives on the AWS service side, and the client only needs the lightweight Iceberg REST client + `iceberg-aws-bundle`, **with no heavy Hadoop stack**).
- With the REST endpoint the Iceberg module might shrink from ~100 MB to a few MB and eradicate the Jackson conflicts. **To be decided after the phase 2 verification measures whether MSAF Flink + the REST endpoint really works** (no rash switch away from the proven direct connection; see the risks in section 4).

### 2.5 🔴 Ownership of the thin base main class: one unified main class + lazy reflective loading of Iceberg (supplement from the phase 2 deep dive; decided on 2026-07-27)

- **Problem** (exposed while splitting the modules in phase 2; not covered by section 2.4): the `FlinkSqlRunner.java` of the two existing runners **differ** — the s3t main class has two more methods than the base (`isIcebergCatalog` + `registerIcebergCatalog`) and one `CREATE CATALOG` interception branch.
- This is not an optional optimization: it is the **required fix** for Iceberg to work on MSAF (the Iceberg FlinkCatalogFactory behind `CREATE CATALOG 'type'='iceberg'` instantiates a Hadoop Configuration with the system class loader, and MSAF does not provide Hadoop on the system classpath → NoClassDefFoundError; the CatalogLoader + FlinkCatalog must be built with the user class loader **in user code** and registered through registerCatalog).
- So the main class's behavior also forks on "whether Iceberg is used".

**Decision: one unified main class + lazy reflective loading of Iceberg.** The thin base main class **keeps** the Iceberg interception logic (`isIcebergCatalog` / `registerIcebergCatalog`), but the iceberg / hadoop classes (`org.apache.hadoop.conf.Configuration`, `org.apache.iceberg.flink.CatalogLoader` / `FlinkCatalog`, `org.apache.iceberg.catalog.Namespace`) are **loaded by reflection** instead of through compile-time imports:
- The SQL does not use an Iceberg catalog → the interception branch is not triggered, the reflective code never runs, no effect.
- The SQL uses an Iceberg catalog and **the iceberg-s3tables module has been assembled in** (resolveModules matched) → reflection succeeds and the catalog is registered.
- The SQL uses an Iceberg catalog but the module was not assembled in → reflection throws ClassNotFoundException, **a clear error** (instead of a NoClassDefFound crash deep inside) — in practice this cannot happen, because resolveModules matching an Iceberg token always assembles the module in (guaranteed by the registry).

**Why this is right**: one thin base main class fits every combination (a genuine "thin base + modules"); Iceberg classes are touched by reflection only when they are needed and present, and the heavy stack is not compiled into the base. **The reflective semantics are line-for-line equivalent to the existing s3t main class** (only import → Class.forName + Method.invoke); the phase 4 parity check on a real kinesis → s3t job will at the same time confirm that the Iceberg reflective path produces the same output as the existing direct calls in s3t.

### 2.6 Conclusions of the S3 Tables integration-method investigation (2026-07-27; code-level, real-run evidence pending)

Triggered by the follow-up question "why do managed services need a self-built heavy-stack JAR to operate S3 Tables". **Bytecode-level facts** (the Iceberg JARs were unpacked and inspected with javap — more reliable than documentation):
- **Two integration methods**: ① `S3TablesCatalog` direct connection (the status quo, `catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog`, carrying s3-tables-catalog + the ~100 MB Hadoop stack); ② the **Iceberg REST endpoint** (`catalog-impl=org.apache.iceberg.rest.RESTCatalog`, `uri=https://s3tables.<region>.amazonaws.com/iceberg` + SigV4).
- **The REST approach has a cleaner JAR**: `iceberg-flink-runtime` (officially relocated; its internal Jackson is hidden under `org/apache/iceberg/shaded/`; measured **0 same-named class conflicts** with the kafka module) ships `RESTCatalog` + `RESTSigV4AuthManager/Signer` (all the SigV4 that the S3 Tables REST endpoint needs is inside); REST does not need the s3-tables-catalog + S3FileIO set.
- 🔴 **But the main-class reflective interception still cannot be avoided**: the signature `FlinkCatalogFactory.createCatalogLoader(name, props, **Hadoop Configuration**)` **mandates a Hadoop Configuration** (instantiated at the factory layer, regardless of catalog type). So whether direct or REST, the "register the catalog by reflection in user code" of section 2.5 is required — REST only reduces run-time dependencies; it does not change the reflective structure of the main class.
- **The MSAF model**: the application must carry its own connectors (section 2.4bis); REST is no exception, but under REST "that JAR" shrinks from ~100 MB to something lightweight (iceberg-flink-runtime + iceberg-aws-bundle).

**Conclusion**: at the JAR level the REST approach is **feasible and cleaner**, but **whether MSAF Flink + the REST endpoint really produces S3 Tables data has not yet been proven** (the lesson of the painful 412 history: with S3 Tables on MSAF, paper ≠ real run). → Decided: **build a standalone verification job and really run it (without touching the existing, proven S3TablesCatalog direct-connection chain); if it works, adopt REST and simplify the Iceberg module drastically; if not, fall back to the official iceberg-flink-runtime JAR**. Stop the job after verification to cap cost.

**🔴 Real-run verification result (2026-07-27, measured): the REST endpoint did not work on MSAF; it is not adopted for now; falling back to the official iceberg-flink-runtime JAR.**
- A standalone verification runner was built (`flink-sql-runner-s3t-rest`: iceberg-flink-runtime + iceberg-aws-bundle + kinesis, 104 MB, smaller than the current 136 MB s3t) + a standalone MSAF application `bgp-rest-verify` + a Kinesis stream; 30 records were sent; SKIP_RESTORE cold start.
- Symptom: the application went STARTING → READY (the start failed and fell back); the CloudWatch log was **all INFO noise with no clear exception stack**; the main class's `[bgp-rest] Registered...` **never appeared** → the job was never submitted successfully before catalog registration. This is exactly the old MSAF problem recorded in the 412 history, "a start failure swallows the root cause"; pinpointing it would take hours of investigation.
- **Decision (cut losses)**: REST is a **nice-to-have optimization of the S3 Tables integration and does not block the main line** — ① MSK can simply use the official `iceberg-flink-runtime` JAR (measured 0 conflicts with kafka);
  - ② the existing S3TablesCatalog direct connection **already works and the 412 has already been fixed at the root**.
  - Unlimited investment in an optimization that "does not block and has a usable fallback" violates the cost-capping red line.
  - **Hence this module adopts: the Iceberg module uses the official `iceberg-flink-runtime` (relocated, 0 conflicts), and the catalog keeps the existing S3TablesCatalog direct-connection method (verified).**
  - **The REST endpoint is kept on file as a standalone candidate optimization, to be verified again once there is a successful MSAF + REST precedent or a dedicated investigation window.**
- The verification resources (runner JAR / MSAF application / Kinesis stream / log group) were all deleted to cap cost. The verification runner directory does not enter the main line.

- The **non-Iceberg logic** of the thin base main class (StatementSet submission, statement lexical splitting) is kept **verbatim** from the two existing runners (that is the verified critical fix; it is not touched).

---

## 3. 🔴 Complete blast-radius list (every item must be confirmed before the core chain is touched)

> Exhaustive grep evidence (2026-07-27). Each item is annotated with: nature of the change + whether existing verified functionality is affected + regression protection.

| # | Affected surface | Location | Change | Affects existing functionality? | Protection |
|---|---|---|---|---|---|
| 1 | **Runner selection** `runnerFor(sinkType)` | `flink-config.ts:42-45` | Replaced by `resolveModules(finalSql, connectorIds)`; `runnerFor` kept as a fallback until parity | 🔴 Yes (every job start) | Strangler pattern: the new path is added in parallel; the default is switched after parity verification |
| 2 | **Start assembly** `startFlinkJob` | `flink-service.ts:873-927` | `runner=runnerFor(sinkType)` + `if(custom) assembleUberJar` → unified `codeKey=await resolveAndAssemble(finalSql, connectorIds)` | 🔴 Yes | Same as above + headless-browser verification of every combination on real jobs |
| 3 | **Assembly engine** `mergeJars` / `assembleUberJar` | `flink-connectors.ts:77-118` | Extended: accepts a set of module ids (not only user keys); adds content-hash caching; **adds version-conflict detection** (see the risks in section 4) | 🟡 Enhancement (existing custom-sink behavior preserved) | Unit tests cover merge / de-duplication / cache; custom-sink regression |
| 4 | **Runner build artifacts** | `flink-sql-runner/pom.xml`, `flink-sql-runner-s3t/pom.xml` | The base POM is slimmed (connectors removed); N new module sub-builds; s3t → the iceberg-s3tables module (sources removed) | 🔴 Yes (the artifacts change) | Each module builds independently; parity with the old packages first |
| 5 | **Deployment upload** deploy-all.sh | `scripts/deploy-all.sh:310-328` | `pair` list → build + upload the thin base + N modules to `flink/modules/`; **the old packages keep being uploaded** as a fallback during the transition | 🔴 Yes (deployment from zero) | Keep the old-package path until parity; a missing mvn is still a WARNING |
| 6 | **Config env** | `flink-config.ts:19-33`, `flink-stack.ts` | New `FLINK_MODULES_PREFIX`; `s3tableCodeKey` / `codeKey` kept during the transition (fallback) | 🟡 Incremental env | A missing env does not break anything; injected by CDK |
| 7 | **SQL lineage parsing** `parseFlinkSqlLineage` | `flink-service.ts:823` | **Unchanged** (it parses INSERT / FROM, unrelated to connectors); but `resolveModules` reuses the same token regex | 🟢 No | — |
| 8 | **Guard dialect validation** | `cookbook/seed/flink.ts` | **Unchanged**; `resolveModules` runs after the guard and after injection (it takes finalSql) | 🟢 No | The existing flink-dialect tests |
| 9 | **Result reading** results / status routes | `api/flink/jobs/[id]/{results,status}` | **Unchanged** (reads results by job.sinkType, unrelated to JAR assembly) | 🟢 No | contract-guard |
| 10 | **Custom connector upload** | `api/flink/connectors/`, `flink-connectors.ts:42` | Semantics merged into the unified assembly (connectorIds as extra modules); upload / storage unchanged | 🟡 Merged | Headless-browser regression of custom sinks |
| 11 | **CDK permissions** | `flink-stack.ts`, `platform-stack.ts` | The TaskRole reads `flink/modules/*` and writes `flink/jobs/*` (the existing prefix permissions should cover it; to be checked) | 🟡 Permission scope to be checked | Check the IAM prefixes before deployment |
| 12 | **MSK source support** | New | Lands on the foundation: the kafka + msk-iam-auth modules + two registry rows + the authentication mapping | 🟢 Pure increment on top of the foundation | After the foundation in this document is complete |

**Not affected (explicitly delimited, to avoid over-reaching changes)**: the MSAF application lifecycle (create / start / stop / delete), snapshot-restore decisions (pickRestoreType / resolveRestoreType), PropertyGroup SQL injection sharding, the CDC server-id, failure diagnosis (failure-advisor), the data-source SPI (data-source ecosystem). These are orthogonal to "where the connector JARs come from".

---

## 4. Risk register and honest boundaries

| Risk | Impact | Mitigation |
|---|---|---|
| 🔴 **Touching the start path of every job** | Breaking the verified kinesis / cdc → S3 Tables | **Strangler-pattern rollout**: add the new assembly path in parallel; for the existing combinations first verify headlessly that "the assembled JAR really produces S3 Tables data = equivalent to the pre-packaged one"; keep the pre-packaged JARs as a fallback; switch the default only after parity is proven. contract-guard throughout. |
| 🔴 **Silent version conflicts** (quantified by measurement in section 2.4) | `mergeJars` currently does "first added wins" (`:97`). Measured: the two packages share 8,577 same-named classes, but 199 of 200 samples are byte-identical (versions already aligned); the risk exists only under **version divergence** → NoClassDefFound / NoSuchMethod at run time | **Two hard constraints (code must not move without both)**: ① every module inherits the **unified-version parent POM** (pinning Flink + the shared-library BOM), guaranteeing same name = same bytes at the source; ② `mergeJars` gains **byte-level conflict detection**: same-named classes with identical bytes → merge; different → **abort with an error** (no more silent first-comer-wins), so that divergence surfaces at assembly time |
| The Iceberg dynamic-assembly problem | Forcing dynamic assembly of Iceberg → high risk, unverified | **Do not assemble Iceberg dynamically**: pre-shade it into one coexistence-safe bundle module (= today's s3t content); the hard part is frozen into a one-time build artifact |
| Uber-JAR size / the MSAF limit | If the assembled JAR exceeds the MSAF 512 MB limit | Minimize modules (carry only what is used); the Iceberg combination is the ~115 MB order of today's s3t anyway, within the limit; caching avoids repeated builds |
| First-assembly latency | A new combination takes a few extra seconds to assemble on its first start | Content-hash caching: only the first time per combination; common combinations can be pre-warmed |
| Global users bringing their own Kafka distributions | Managed Kafka vendors and self-hosted clusters each authenticate differently | Data-driven registry: the authentication → module mapping is extensible (separate mappings for SASL / mTLS / IAM); this design's modularity exists precisely for this |

**Honest boundaries**:
- This is a **standalone architecture module** (recorded as the **connector runtime** module of Stream Compute), not "part of MSK". MSK is its **first beneficiary and verification vehicle**.
- **No promise to switch every combination at once**: parity in stages (first verify equivalence on kinesis → s3t, the most common and already verified combination, then switch combination by combination).
- The payoff shows when "adding the 2nd+ source / sink has a blast radius approaching zero"; for MSK alone, the foundation costs more than a direct fat JAR. But the fat JAR is a dead end (section 1.2); this is the trade-off of **doing it right once vs piling up half-finished work** — and the explicit requirement was the final form.

---

## 5. Phases (each independently verifiable and reversible)

| Phase | Content | Nature | Acceptance anchor (headless browser / real job) |
|---|---|---|---|
| **Phase 1** | Connector registry (TypeScript) + the pure function `resolveModules(finalSql)` + unit tests (token → module set, including the conditional msk-iam-auth) | 🟢 Pure increment (not wired) | Unit tests: each SQL sample resolves to the correct module set; guard / lineage unaffected |
| **Phase 2** | Module-library build: **the unified-version parent POM (constraint ① of section 2.4)** + the thin base POM + each connector's module POM pulled out + the iceberg-s3tables module; deploy-all.sh builds and uploads `flink/modules/*` (**the old packages coexist**) | 🔴 Build artifacts change | Each module builds independently with mvn; all module JARs are on S3; **the cross-module same-named-class byte-consistency spot check passes** |
| **Phase 3** | `assembleUberJar` extension (module set + content-hash cache) + **byte-level conflict detection (constraint ② of section 2.4: same name, different bytes → error)** + unit tests | 🟡 Enhancement | Unit tests: merge / de-duplication / cache hit / **conflict detection (construct a divergence → error)**; custom-sink regression green |
| **Phase 4** | `startFlinkJob` switches to the assembly path (**the old runnerFor as a fallback, env switch**); parity verified first on a real **kinesis → s3t** job | 🔴 Touches the core | Real job: kinesis → S3 Tables with the assembled JAR produces data = equivalent to the pre-packaged one; contract-guard 0 FAIL |
| **Phase 5** | Combination-by-combination parity switch (cdc → s3t, mysql sink, custom sink) → after all green, **remove the old packages + the fallback** | 🔴 Convergence | Each combination verified equivalent on a real job; regression all green after removal |
| **MSK rollout** | MSK lands: the kafka + msk-iam-auth modules + two registry rows + resolveMskSource + CDK kafka permissions (real cluster) | 🟢 "Adding one line" on top of the foundation | Really create a cluster → Kafka → S3 Tables (IAM and SASL each run; deleted after verification) |

**Recommendation: phase 1 first** (the pure-function registry + resolution; zero wiring, zero risk; the correctness of the token → module mapping is locked by unit tests immediately), then phases 2 / 3 (build and assembly, verifiable offline), and finally phases 4 / 5 (touching the core; strangler-pattern rollout). MSK lands once the foundation is stable.

---

## 6. Relationship to existing designs

- **The data-source SPI of the data-source ecosystem**: the data-source SPI answers "who the source is / credentials / connection identity" (adding a provider = one row); this module answers "which connector JARs the job needs" (adding a module = one row). The two are orthogonal and share one spirit (a data-driven registry, zero-radius additions). The MSK provider (already built as part of the data-source ecosystem) belongs to the former; the MSK connector module belongs to the latter.
- The statement in section 11.6 of the [data-source ecosystem design](./datasource-ecosystem.md), "create a standalone flink-sql-runner-msk package", **is void** (it was a continuation of the fat-JAR dead end); this document is authoritative: MSK = the kafka module + the iceberg-s3tables module (existing) in combination; no MSK-specific package is created.
