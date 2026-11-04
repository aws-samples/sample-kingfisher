# Flink SQL Runner

`flink-sql-runner` is the generic Flink SQL streaming job runner that Kingfisher deploys to
Amazon Managed Service for Apache Flink (MSAF) for the realtime compute module. It is a single
shaded JAR with one main class, `com.bgp.flink.FlinkSqlRunner`, that takes a multi-statement
Flink SQL script from the MSAF application properties and runs it as a long-lived streaming job.

The JAR hardcodes no account, stream, bucket or table names. Everything comes from the SQL text,
which the platform renders for the chosen execution region before it starts the application.

## What the runner does

1. Reads the application properties through the Managed Flink runtime library and reassembles
   the SQL script (see "Runtime properties" below).
2. Splits the script into statements on `;` after stripping `--` line comments and `/* */` block
   comments. Semicolons inside single-quoted strings and backtick identifiers are ignored, and a
   doubled quote or doubled backtick inside a literal is treated as an escape, not a terminator.
3. Executes DDL and `SET` statements immediately through `TableEnvironment.executeSql`.
4. Collects every `INSERT` into one `StatementSet` and submits it once, so a script may feed several sinks.
5. Fails fast when the SQL property is missing or when the script contains no `INSERT` (no sink means no output).

## Runtime properties

The platform injects the script through the MSAF property group `bgp`:

| Group / key | Meaning |
|---|---|
| `bgp` / `sql` | The whole script when it fits in one property value |
| `bgp` / `sql.0`, `sql.1`, ... | Byte-sized shards of a long script, concatenated in ascending order |
| `bgp1`, `bgp2`, ... / `sql.N` | Overflow groups used when one group runs out of keys |

MSAF limits the size of one property value and the number of keys per group; sharding across
`bgp*` groups removes any practical limit on script length. The runner concatenates all `sql`
and `sql.N` values from every `bgp*` group (plain `sql` sorts first). The same encoding is
written by `buildSqlGroups` and read back by `reassembleSqlFromGroups` in
`platform/src/lib/realtime/flink-service.ts`. The runner ignores groups with other names, which
the platform reserves for user-defined runtime properties.

## Connectors in this package

Flink core and Table API artifacts are `provided` by the Managed Flink runtime and are not shaded in.
The package bundles the Kinesis Data Streams SQL connector, the filesystem connector, the JSON
format, the JDBC connector with the MySQL driver, and the Managed Flink runtime library that
exposes the application properties. Exact artifact versions live in `pom.xml` and are listed in
[`docs/supported-versions.md`](../docs/supported-versions.md).

Two sibling packages carry a copy of this source extended with Iceberg catalog registration and
add heavier connector stacks:

| Package | Adds | Used for |
|---|---|---|
| `../flink-sql-runner-s3t` | Apache Iceberg and the S3 Tables catalog | Any source to an S3 Tables (Iceberg) sink |
| `../flink-sql-runner-s3t-kafka` | Kafka SQL connector and MSK IAM authentication | MSK or Kafka source to an S3 Tables sink |

Lightweight connectors can also be assembled at job start from the modules under
`../flink-connector-modules/`; see "How the platform uses it".

## Build

Maven and a JDK are required on the build machine. The bytecode target and the Flink line are set in
`pom.xml` and documented in [`docs/supported-versions.md`](../docs/supported-versions.md).

```bash
mvn -q -B -DskipTests package
# output: target/flink-sql-runner.jar
```

`target/` and `*.jar` are ignored by git, so a fresh clone has no JAR. `scripts/deploy-all.sh` builds
the JAR with Maven when it is missing and uploads it to the Glue scripts bucket of the home region
(`bgp-glue-scripts-<account>`) under `flink/flink-sql-runner.jar`. Without Maven the deployment still
completes, but realtime compute cannot start jobs.

## How the platform uses it

- `infra/lib/platform-stack.ts` injects `FLINK_CODE_BUCKET` (the scripts bucket), `FLINK_CODE_KEY`
  (`flink/flink-sql-runner.jar`) and `FLINK_RUNTIME_ENVIRONMENT` (the MSAF runtime, overridable with
  the CDK context `-c flink-runtime=`) into the platform container.
- `platform/src/lib/realtime/flink-config.ts` reads those variables; `runnerFor(sinkType)` returns this
  JAR for every sink type except `s3table`.
- `platform/src/lib/realtime/flink-service.ts` creates or updates the MSAF application with
  `CodeContent.S3ContentLocation` pointing at the bucket and key, and with the `bgp*` property groups.
- `platform/src/lib/realtime/flink-place.ts` (`ensureRunnerJar`) copies the JAR from the home scripts
  bucket into the scripts bucket of an execution region on first use, so the JAR is uploaded once.
- Custom sinks: a user-uploaded connector JAR under `flink/connectors/` is merged with this runner into
  a per-job uber JAR under `flink/jobs/` (`platform/src/lib/realtime/flink-connectors.ts`). Modular
  assembly from `flink/modules/` is cached under `flink/uber-cache/` by content hash.
- The MSAF execution role is defined in `infra/lib/flink-stack.ts` (home region, gated by
  `-c enable-flink=1`) and `infra/lib/exec-env/flink-stack.ts` (execution regions). Both grant read
  access to the `flink/` prefix of the regional scripts bucket.

## Placeholders in platform templates

Scripts shipped by the platform reference placeholders that `flink-service.ts` replaces at start time,
for example `${SOURCE_STREAM_ARN}`, `${REGION}`, `${OUTPUT_PATH}`, `${MYSQL_URL}`, `${MYSQL_USER}` and
`${MYSQL_PASSWORD}`. Secrets are read from Secrets Manager at that moment and are never stored in the
job definition.

## How to extend

- New connector for this package: add the dependency to `pom.xml` (keep the Flink core artifacts
  `provided`), rebuild, upload to the same key, and record the version in `docs/supported-versions.md`.
- New lightweight connector assembled at runtime: add a module under `../flink-connector-modules/`;
  `deploy-all.sh` builds and uploads every module to `flink/modules/`.
- New heavyweight package (anything that pulls in Iceberg or Hadoop): copy this module, add the
  dependencies, give it its own `finalName`, and wire a new code-key environment variable through
  `platform-stack.ts`, `flink-config.ts` and the routing in `flink-connectors.ts`.
- Changes to statement handling belong in `FlinkSqlRunner.java`. The two S3 Tables packages carry the
  same splitter and property reassembly; keep the shared parts in step.
