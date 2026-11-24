# Flink SQL Runner for S3 Tables (Iceberg)

`flink-sql-runner-s3t` is the connector package of the Kingfisher Flink SQL runner for jobs whose sink is
Amazon S3 Tables, the managed Apache Iceberg store that forms the platform data lake. It runs on the same
Managed Service for Apache Flink (MSAF) runtime as the generic package `../flink-sql-runner`, with the same
main class `com.bgp.flink.FlinkSqlRunner`, and differs in two ways: it bundles the Iceberg runtime and the
S3 Tables catalog, and it registers Iceberg catalogs from user code instead of letting Flink SQL do it.

The runtime version is a single fact for the whole platform, `FLINK_RUNTIME_ENVIRONMENT`. Packages differ
only in the connectors they carry, never in the Flink version. Pinned versions are listed in
[`docs/supported-versions.md`](../docs/supported-versions.md).

## Why a separate package

Iceberg, Hadoop and the AWS SDK modules add tens of thousands of classes. Merging them into a job JAR at
start time hits the ZIP64 entry limit of the runtime merge step, so Iceberg-capable packages are prebuilt
with Maven and chosen by routing rather than assembled on the fly. Jobs that do not write to S3 Tables keep
using the small generic package, so adding this one changed nothing for them.

## Catalog registration from user code

A plain `CREATE CATALOG ... WITH ('type'='iceberg', ...)` is handled by the Iceberg `FlinkCatalogFactory`,
which asks the Flink runtime to instantiate `org.apache.hadoop.conf.Configuration`. Managed Flink does not
place Hadoop on the system class path; Hadoop exists only inside the user JAR, so that path ends in
`NoClassDefFoundError`.

This runner therefore intercepts every `CREATE CATALOG` statement whose options contain `catalog-impl` or
`'type'='iceberg'` and performs the registration itself: it parses the catalog name and the `WITH` options,
creates the Hadoop `Configuration` with the user class loader, builds `CatalogLoader.custom(...)` and a
`FlinkCatalog`, and calls `registerCatalog`. `type` and `catalog-impl` are removed from the option map; every
other option (notably `warehouse`) is passed to the catalog. When `catalog-impl` is absent, the S3 Tables
catalog implementation `software.amazon.s3tables.iceberg.S3TablesCatalog` is used. The approach follows the
AWS S3 Tables sink sample and does not depend on the Flink version.

All other statements are processed exactly as in the generic runner: DDL and `SET` run immediately, `INSERT`
statements are collected into one `StatementSet`, comments and quoted semicolons are handled by the same
splitter, and the SQL script arrives through the same `bgp*` property groups (`sql`, `sql.N`).

## Connectors in this package

Flink core and Table API artifacts are `provided` by the runtime. The package bundles the Kinesis Data Streams
SQL connector, the JSON format, the MySQL CDC SQL connector with the MySQL driver, the Dropwizard metrics
reporter, the Iceberg core, AWS and Flink runtime modules, the S3 Tables catalog for Iceberg, the AWS SDK
S3 Tables client, Hadoop common and Avro. Versions are pinned in `pom.xml` and listed in
[`docs/supported-versions.md`](../docs/supported-versions.md). The Kafka SQL connector is deliberately not
included; Kafka or MSK sources that write to S3 Tables use `../flink-sql-runner-s3t-kafka`.

## Build

```bash
mvn -q -B -DskipTests package
# output: target/flink-sql-runner-s3t.jar
```

Maven and a JDK are required; `target/` and `*.jar` are not committed. `scripts/deploy-all.sh` builds the JAR
when it is missing and uploads it to the home-region Glue scripts bucket (`bgp-glue-scripts-<account>`) under
`flink/flink-sql-runner-s3t.jar`.

## How the platform uses it

- `infra/lib/platform-stack.ts` injects `FLINK_S3T_CODE_KEY` (`flink/flink-sql-runner-s3t.jar`) next to
  `FLINK_CODE_BUCKET`, `FLINK_RUNTIME_ENVIRONMENT`, `FLINK_S3TABLES_BUCKET` (the platform table bucket) and
  `FLINK_S3TABLE_DB` (the namespace that receives streaming results).
- `platform/src/lib/realtime/flink-config.ts`: `runnerFor("s3table")` returns this key, and `tableBucketArn(place)`
  derives the warehouse ARN from the resolved execution region, so a job created in an execution region writes
  to that region's table bucket.
- `platform/src/lib/realtime/flink-connectors.ts` routes any job whose SQL resolves to the `iceberg-s3tables`
  module to this package, unless the SQL also uses a Kafka source.
- `platform/src/lib/realtime/flink-place.ts` copies the JAR into the scripts bucket of an execution region on
  first use.

## Script shape

```sql
CREATE TABLE orders_src (...) WITH ('connector'='kinesis', 'stream.arn'='${SOURCE_STREAM_ARN}', ...);
CREATE CATALOG s3t WITH (
  'type'='iceberg',
  'catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse'='${TABLE_BUCKET_ARN}'
);
CREATE DATABASE IF NOT EXISTS s3t.`${S3TABLE_DB}`;
CREATE TABLE IF NOT EXISTS s3t.`${S3TABLE_DB}`.`flink_region_agg` (...);
INSERT INTO s3t.`${S3TABLE_DB}`.`flink_region_agg`
SELECT ... FROM TABLE(TUMBLE(...)) GROUP BY window_start, window_end, region;
```

`${SOURCE_STREAM_ARN}`, `${TABLE_BUCKET_ARN}`, `${S3TABLE_DB}` and `${REGION}` are replaced by
`flink-service.ts` from the resolved execution region before the application starts. Nothing account-specific
is stored in the repository or in the JAR.

## How to extend

- Additional source or sink connectors go into `pom.xml`. Keep the Avro and logging exclusions, which prevent
  duplicate classes in the shaded JAR, and record new versions in `docs/supported-versions.md`.
- `FlinkSqlRunner.java` here is byte-identical to the copy in `../flink-sql-runner-s3t-kafka`; change both.
- A different catalog implementation only needs `catalog-impl` in the SQL; the interception passes it through.
