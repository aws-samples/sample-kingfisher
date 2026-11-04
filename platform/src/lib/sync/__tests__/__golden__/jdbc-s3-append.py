import sys
import re
import json
import boto3
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job

args = getResolvedOptions(sys.argv, ["JOB_NAME"])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args["JOB_NAME"], args)

# Get credentials from Secrets Manager(源密钥在源自己的区;原则 2 保证源区 = 作业落点区)
sm = boto3.client("secretsmanager", region_name="us-east-1")
secret = json.loads(sm.get_secret_value(SecretId="arn:aws:secretsmanager:us-east-1:123456789012:secret:src-AbC")["SecretString"])
db_user = secret["username"]
db_pass = secret["password"]

jdbc_url = "jdbc:mysql://db.example.internal:3306/gamedb?zeroDateTimeBehavior=CONVERT_TO_NULL"
tables = ["players","orders"]
# 🔴 零表就**响亮失败**(不许空转成功)。
# 真环境实测:表清单为空时本脚本一路跑到 "SYNC RESULTS: {}" 然后 SUCCEEDED,
# 于是平台把任务标成 succeeded 而数仓里连表都没建 —— 看板全绿、什么都没发生。
if not tables:
    raise Exception("同步任务没有可同步的表(sourceTables 为空):拒绝空转成功。请在任务里勾选要同步的表。")
target_names = {"players":"players","orders":"orders"}
results = {}
INC_COL = ""
INC_VAL = ""
INCREMENTAL = False

# S3 Tables catalog path (backtick bucket name with hyphens)
S3T_CATALOG = "s3tablescatalog"
S3T_BUCKET_RAW = "bgp-table-bucket"
BT = chr(96)
S3T_BUCKET = BT + S3T_BUCKET_RAW + BT
S3T_NAMESPACE = "gamedb"

for table_name in tables:
    print(f"\n{'='*60}")
    print(f"Syncing table: {table_name}")
    print(f"{'='*60}")
    # SYNC-07: resolve the target table name (defaults to the source name).
    target_name = target_names.get(table_name, table_name)
    # 目标表名【标识符安全化】。DynamoDB/S3 源的"表名"来自 AWS 资源名,允许连字符/点
    # (如 bgp-orders / my.table),但 Redshift/S3Tables 的 SQL 标识符不允许裸连字符 → 建表 DDL 语法错
    # (真 bug: "syntax error at or near '-' in context 'public.bgp-'")。JDBC 源表名本是 SQL 标识符不受影响。
    # 统一把非法字符(非字母/数字/下划线)→ 下划线,数字开头补 _。覆盖 Redshift + S3Tables 两个目标。
    # 🔴 Bug#2 修复:必须先【转小写】再替非法字符 —— S3Tables/Iceberg 表标识符要求小写,Oracle 源默认
    #   全大写(ORA_EVENTS)不转小写 → S3Tables "Invalid table identifier" 建表崩(Redshift 大小写不敏感
    #   不受影响,但 both 目标下 S3Tables 侧必崩)。规则与 TS 侧 SSOT sanitizeS3TablesIdentifier 逐字对齐
    #   (lib/sync/s3tables-identifier.ts:小写 + re.sub[^a-z0-9_]→_ + 数字开头补_);改一处两处同改。
    _san = re.sub(r'[^a-z0-9_]', '_', target_name.lower())
    if _san and _san[0].isdigit():
        _san = '_' + _san
    if _san != target_name:
        print(f"Sanitized target table name for SQL identifier: {target_name} -> {_san}")
    target_name = _san
    if target_name != table_name:
        print(f"Target table name: {target_name}")

    # Read from source (SYNC-05: incremental predicate when configured)
    # SYNC-FIX(dup): 增量"读取谓词"与"幂等清理谓词"共用同一 WHERE(incCol > 水位)。落库前按同一谓词
    # 先删既有行再写,使重跑不产生重复追加。根因:append 模式下若水位未前进(此前依赖日志解析
    # INC_WATERMARK 这一尽力而为步骤,日志抓取失败即不前进),同一区间会被反复叠加(838070=419035×2)。
    inc_where = ""
    if INC_COL and INC_VAL != "":
        # 增量谓词:数字水位不加引号,非数字(时间戳/字符串)加引号并转义,避免 SQL 语法错。
        _pv = INC_VAL if INC_VAL.replace(".", "", 1).lstrip("-").isdigit() else "'" + INC_VAL.replace("'", "''") + "'"
        inc_where = f"{INC_COL} > {_pv}"
    read_table = table_name
    if inc_where:
        read_table = f"(SELECT * FROM {table_name} WHERE {inc_where}) AS incq"
        print(f"Incremental read predicate: {inc_where}")
    df = spark.read.format("jdbc").options(
        url=jdbc_url,
        dbtable=read_table,
        user=db_user,
        password=db_pass,
        driver="com.mysql.cj.jdbc.Driver",
    ).load()

    # SYNC-FIX(parquet-copy): normalize NARROW integer columns (Spark ByteType from MySQL
    # TINYINT, ShortType from SMALLINT) to IntegerType BEFORE any write. ROOT CAUSE of the
    # persistent "Spectrum Scan Error 15007 — incompatible Parquet schema" on COPY: Spark writes
    # ByteType/ShortType to Parquet as physical INT32 carrying an INT(8,*)/INT(16,*) logical
    # annotation; Redshift COPY FORMAT AS PARQUET rejects that annotation even against a SMALLINT
    # column (the physical/logical pair does not match). Casting to IntegerType emits a plain
    # INT32 with no narrowing annotation, which COPYs cleanly into an INTEGER column. This makes
    # the staging Parquet, the S3 Tables write, and the Redshift DDL all agree on INTEGER — so
    # the fast COPY path works for EVERY table with boolean/flag columns instead of silently
    # degrading to the slow row-by-row INSERT fallback. Widening TINYINT/SMALLINT->INTEGER is
    # lossless. Types are matched widest-first below because Spark repr strings are substrings.
    from pyspark.sql.types import ByteType as _ByteT, ShortType as _ShortT
    from pyspark.sql import functions as _NF
    for _f in df.schema.fields:
        if isinstance(_f.dataType, (_ByteT, _ShortT)):
            df = df.withColumn(_f.name, _NF.col(_f.name).cast("int"))

    row_count = df.count()
    col_count = len(df.columns)
    print(f"Read {row_count} rows, {col_count} columns from {table_name}")
    print(f"Schema: {df.dtypes}")
    # SYNC: 增量真前进 —— 输出本次读到的最大水位,供 poller 回写 task.incrementalValue,
    # 使下次只读 incCol > 新水位 的行(否则每次重读同一区间、append 重复)。
    if INC_COL and (INC_COL in df.columns) and row_count > 0:
        try:
            from pyspark.sql import functions as _F
            _mx = df.agg(_F.max(INC_COL)).collect()[0][0]
            if _mx is not None:
                print(f"INC_WATERMARK col={INC_COL} max={_mx}")
        except Exception as _e:
            print(f"INC_WATERMARK skip: {str(_e)[:120]}")

    # Write to S3 Tables (managed Iceberg)
    # Spark 临时视图名也需标识符安全(源表名 table_name 可能含连字符/点,如 DynamoDB 表
    # bgp-verify-ddb-1m → temp_bgp-verify-ddb-1m 是非法视图名 "Invalid view name")。用已 sanitize 的
    # target_name(上方 re.sub 处理过)构造,保证视图名合法。真 bug:100万 DDB→S3Table 首次现形。
    temp_view = f"temp_{target_name}"
    df.createOrReplaceTempView(temp_view)
    s3t_table = f"s3tablescatalog.{S3T_NAMESPACE}.{target_name}"

    try:
        # Step 1: Check if table exists by trying to read it
        table_exists = False
        try:
            spark.sql(f"SELECT 1 FROM {s3t_table} LIMIT 1")
            table_exists = True
            print(f"Table {s3t_table} exists")
        except:
            print(f"Table {s3t_table} does not exist, will create")

        # Step 2: Write data
        if table_exists:
            # SYNC-FIX(dup): 增量 append 幂等 —— 与 Redshift 路径一致(Iceberg format-version 2 支持行级
            # DELETE):有水位删该区间;增量但水位为空删整表(全量回填);非增量纯 append 不删。
            if inc_where:
                spark.sql(f"DELETE FROM {s3t_table} WHERE {inc_where}")
                print(f"Idempotent pre-delete on {s3t_table} WHERE {inc_where}")
            elif INCREMENTAL:
                spark.sql(f"DELETE FROM {s3t_table}")
                print(f"Idempotent full reload on {s3t_table} (incremental, empty watermark)")
            # Append
            spark.sql(f"INSERT INTO {s3t_table} SELECT * FROM {temp_view}")
            print(f"APPEND {s3t_table}: inserted {row_count} rows")
        else:
            # Create new table with data
            partition_clause = ""
            create_sql = f"CREATE TABLE {s3t_table} USING iceberg {partition_clause} TBLPROPERTIES ('format-version'='2', 'write.parquet.compression-codec'='zstd', 'bgp.created-by'='bgp-platform-created') AS SELECT * FROM {temp_view}"
            spark.sql(create_sql)
            print(f"CREATED {s3t_table} with {row_count} rows")

        print(f"Written to S3 Tables: {s3t_table}")
        print(f"Table Bucket: {S3T_BUCKET_RAW}, Namespace: {S3T_NAMESPACE}")


    except Exception as e:
        error_msg = str(e)
        print(f"S3 Tables write error: {error_msg[:300]}")
        raise e

    results[table_name] = {"rows": row_count, "columns": col_count}
    # SYNC-FIX(B1): emit per-table rows-read marker for metric backfill (covers S3-only targets too).
    print(f"ROWS_READ table={table_name} rows={row_count}")
    print(f"Table {table_name} sync completed: {row_count} rows")

print(f"\n{'='*60}")
print(f"SYNC RESULTS: {json.dumps(results)}")
# 目标标识按实际写入路径打印(不能无条件说"Target: S3 Tables",否则 writeS3=False 时会造成
# "看着写了 S3Table 实则没写"的假象=假成功误导;根因见 api/sync targetType 校验注释)。
print(f"Target(s): S3 Tables (bgp-table-bucket/gamedb)")
print(f"{'='*60}")

job.commit()
