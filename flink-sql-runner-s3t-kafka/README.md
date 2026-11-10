# Flink SQL Runner for Kafka/MSK sources and S3 Tables sinks

`flink-sql-runner-s3t-kafka` is the Kingfisher Flink SQL runner package for jobs that read from Apache Kafka or
Amazon MSK and write to Amazon S3 Tables (managed Iceberg). It is the S3 Tables package `../flink-sql-runner-s3t`
plus the Kafka SQL connector and MSK IAM authentication, built once with Maven. The main class is the same
`com.bgp.flink.FlinkSqlRunner`, the Java source is a byte-identical copy of the S3 Tables package, and the
runtime is the platform-wide `FLINK_RUNTIME_ENVIRONMENT`. Pinned versions are listed in
[`docs/supported-versions.md`](../docs/supported-versions.md).

## Why a third package

- The S3 Tables package carries no Kafka SQL connector, so its service loader has no `KafkaDynamicTableFactory`.
- Iceberg-capable packages are prebuilt, not merged at job start, because the runtime merge step cannot hold the
  Iceberg and Hadoop class count (ZIP64 entry limit). The Kafka module therefore cannot be added on the fly.
- Without this package a Kafka source combined with an Iceberg sink fails at startup with
  `Could not find any factory for identifier 'kafka'`.

Building the combination once keeps the S3 Tables package untouched, so Kinesis and CDC sources that write to
S3 Tables are unaffected.

## What this package adds

Relative to `../flink-sql-runner-s3t`, the `pom.xml` differs only in the following:

| Addition | Purpose |
|---|---|
| `org.apache.flink:flink-sql-connector-kafka` | Kafka table source and sink for Flink SQL |
| `software.amazon.msk:aws-msk-iam-auth` | `IAMClientCallbackHandler` for SASL/IAM authentication to MSK |
| Shade relocation `org.apache.kafka` to `org.apache.flink.kafka.shaded.org.apache.kafka` | Aligns the IAM handler with the shaded Kafka client |

The Flink Kafka connector ships its Kafka client classes under a shaded package. The MSK IAM library implements
the Kafka `AuthenticateCallbackHandler` interface against the unshaded package, so without the relocation the
handler would not match the interface the connector loads. The relocation rewrites the library onto the shaded
package; the connector itself is already shaded and is not affected. The MSK IAM library is pinned to a release
whose bytecode level the Managed Flink runtime can load; see `docs/supported-versions.md`.

Everything else is inherited from the S3 Tables package: Kinesis connector, JSON format, MySQL CDC connector and
driver, Iceberg runtime, S3 Tables catalog, Hadoop common, Avro, and the catalog registration from user code that
avoids the Hadoop class-loading failure on Managed Flink.

## Build

```bash
mvn -q -B -DskipTests package
# output: target/flink-sql-runner-s3t-kafka.jar
```sql

Maven and a JDK are required; `target/` and `*.jar` are not committed. `scripts/deploy-all.sh` builds the JAR when
it is missing and uploads it to the home-region Glue scripts bucket (`bgp-glue-scripts-<account>`) under
`flink/flink-sql-runner-s3t-kafka.jar`.

## How the platform uses it

- `infra/lib/platform-stack.ts` injects `FLINK_S3T_KAFKA_CODE_KEY` (`flink/flink-sql-runner-s3t-kafka.jar`).
- `platform/src/lib/realtime/flink-config.ts` exposes it as `FLINK.s3tKafkaCodeKey`.
- `platform/src/lib/realtime/flink-connectors.ts` selects this package when the connector modules resolved from
  the SQL contain both `iceberg-s3tables` and `kafka`; `iceberg-s3tables` alone selects the S3 Tables package.
- `platform/src/lib/realtime/flink-place.ts` copies the JAR into the scripts bucket of an execution region on
  first use.
- Kafka jobs that do not write to S3 Tables do not use this package; they are assembled at job start from the
  `kafka` and `msk-iam-auth` modules under `../flink-connector-modules/`.

## Script shape

```sql
CREATE TABLE events_src (...) WITH (
  'connector'='kafka', 'topic'='${KAFKA_TOPIC}', 'scan.startup.mode'='earliest-offset', 'format'='json'
  ${KAFKA_AUTH_PROPS}
);
CREATE CATALOG s3t WITH ('type'='iceberg',
  'catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog', 'warehouse'='${TABLE_BUCKET_ARN}');
INSERT INTO s3t.`${S3TABLE_DB}`.`events_agg` SELECT ... FROM TABLE(TUMBLE(...)) GROUP BY ...;
```

`${KAFKA_AUTH_PROPS}` expands to the bootstrap servers plus `security.protocol = SASL_SSL` and either the
`AWS_MSK_IAM` mechanism with the IAM callback handler or SCRAM with credentials fetched from Secrets Manager at
start time. `${KAFKA_TOPIC}`, `${TABLE_BUCKET_ARN}` and `${S3TABLE_DB}` are filled in by `flink-service.ts` from
the resolved execution region. Nothing account-specific is stored in the repository or in the JAR.

## How to extend

- Keep `src/` identical to `../flink-sql-runner-s3t`; apply runner fixes to both.
- When bumping the Kafka connector, re-check the shaded package name used by the relocation in `pom.xml`.
- When bumping the MSK IAM library, confirm its bytecode target against the Managed Flink runtime Java version in
  `docs/supported-versions.md`.
