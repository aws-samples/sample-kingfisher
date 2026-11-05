CREATE TABLE payments_src (
  payment_id BIGINT,
  player_id BIGINT,
  amount_usd DECIMAL(12,2),
  pay_time TIMESTAMP(3),
  PRIMARY KEY (payment_id) NOT ENFORCED
) WITH (
  'connector' = 'mysql-cdc',
  'hostname' = '${SRC_HOSTNAME}', 'port' = '${SRC_PORT}',
  'username' = '${SRC_USERNAME}', 'password' = '${SRC_PASSWORD}',
  'database-name' = '${SRC_DATABASE}', 'table-name' = 'payments',
  'server-id' = '5860-5864', 'scan.incremental.snapshot.enabled' = 'true'
);

CREATE TABLE players_src (
  player_id BIGINT,
  source_channel_id INT,
  PRIMARY KEY (player_id) NOT ENFORCED
) WITH (
  'connector' = 'mysql-cdc',
  'hostname' = '${SRC_HOSTNAME}', 'port' = '${SRC_PORT}',
  'username' = '${SRC_USERNAME}', 'password' = '${SRC_PASSWORD}',
  'database-name' = '${SRC_DATABASE}', 'table-name' = 'players',
  'server-id' = '5865-5869', 'scan.incremental.snapshot.enabled' = 'true'
);

CREATE CATALOG s3t WITH (
  'type' = 'iceberg',
  'catalog-impl' = 'software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse' = '${TABLE_BUCKET_ARN}'
);
CREATE DATABASE IF NOT EXISTS s3t.`${S3TABLE_DB}`;

CREATE TABLE IF NOT EXISTS s3t.`${S3TABLE_DB}`.`channel_revenue_rt` (
  source_channel_id INT,
  revenue_usd DECIMAL(20,2),
  payment_cnt BIGINT,
  PRIMARY KEY (source_channel_id) NOT ENFORCED
);

INSERT INTO s3t.`${S3TABLE_DB}`.`channel_revenue_rt`
SELECT p.source_channel_id,
       SUM(pay.amount_usd) AS revenue_usd,
       COUNT(*) AS payment_cnt
FROM payments_src pay
JOIN players_src p ON pay.player_id = p.player_id
GROUP BY p.source_channel_id;