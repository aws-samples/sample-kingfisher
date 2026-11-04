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
INC_COL = "id"
INC_VAL = ""
INCREMENTAL = True

# S3 Tables catalog path (backtick bucket name with hyphens)
S3T_CATALOG = "s3tablescatalog"
S3T_BUCKET_RAW = "bgp-table-bucket"
BT = chr(96)
S3T_BUCKET = BT + S3T_BUCKET_RAW + BT
S3T_NAMESPACE = "gamedb"

# ── PlaceWire v1 读取函数(单一作者 = platform/src/lib/place/wire-py.ts,勿手改)─────────
import json as _pw_json
import re as _pw_re


class BgpPlaceWireInvalid(Exception):
    def __init__(self, path, why):
        Exception.__init__(self, "PLACE_WIRE_INVALID " + path + " " + why)
        self.path = path


_PW_TARGET_ID = r"^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$"
_PW_REGION = r"^[a-z]{2}(-[a-z]+)+-\d$"
_PW_SECRET_ARN = r"^arn:[a-z-]+:secretsmanager:"
_PW_S3_LOCATION = r"^(s3://.+)?$"


def _pw_test(pattern, s):
    if pattern.endswith("$"):
        return _pw_re.fullmatch(pattern[1:-1] if pattern.startswith("^") else pattern[:-1], s, _pw_re.ASCII) is not None
    return _pw_re.match(pattern, s, _pw_re.ASCII) is not None


def _pw_only(o, allowed, at):
    for k in o.keys():
        if k not in allowed:
            raise BgpPlaceWireInvalid(at + "." + k, "unknown")


def _pw_str(o, k, at, pattern=None, min_length=None):
    if k not in o:
        raise BgpPlaceWireInvalid(at + "." + k, "missing")
    v = o[k]
    if not isinstance(v, str):
        raise BgpPlaceWireInvalid(at + "." + k, "not-string")
    if min_length is not None and len(v) < min_length:
        raise BgpPlaceWireInvalid(at + "." + k, "empty")
    if pattern is not None and not _pw_test(pattern, v):
        raise BgpPlaceWireInvalid(at + "." + k, "pattern")
    return v


def bgp_read_place(raw):
    """读一个 PlaceWire(dict 或其 JSON 文本)⇒ 归一后的新 dict;不合法 ⇒ BgpPlaceWireInvalid(没有任何缺省值)。"""
    o = raw
    if isinstance(raw, str):
        try:
            o = _pw_json.loads(raw)
        except Exception:
            raise BgpPlaceWireInvalid("$", "json")
    if not isinstance(o, dict):
        raise BgpPlaceWireInvalid("$", "not-object")
    _pw_only(o, ("v", "targetId", "region", "redshift", "athena"), "$")
    v = o.get("v")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != 1:
        raise BgpPlaceWireInvalid("$.v", "not-1")
    out = {"v": 1}
    out["targetId"] = _pw_str(o, "targetId", "$", pattern=_PW_TARGET_ID)
    out["region"] = _pw_str(o, "region", "$", pattern=_PW_REGION)
    if "redshift" in o:
        r = o["redshift"]
        if not isinstance(r, dict):
            raise BgpPlaceWireInvalid("$.redshift", "not-object")
        _pw_only(r, ("workgroup", "database", "secretArn"), "$.redshift")
        leg = {
            "workgroup": _pw_str(r, "workgroup", "$.redshift", min_length=1),
            "database": _pw_str(r, "database", "$.redshift", min_length=1),
        }
        if "secretArn" in r:
            leg["secretArn"] = _pw_str(r, "secretArn", "$.redshift", pattern=_PW_SECRET_ARN)
        out["redshift"] = leg
    if "athena" in o:
        a = o["athena"]
        if not isinstance(a, dict):
            raise BgpPlaceWireInvalid("$.athena", "not-object")
        _pw_only(a, ("workgroup", "outputLocation", "catalogRef"), "$.athena")
        out["athena"] = {
            "workgroup": _pw_str(a, "workgroup", "$.athena", min_length=1),
            "outputLocation": _pw_str(a, "outputLocation", "$.athena", pattern=_PW_S3_LOCATION),
            "catalogRef": _pw_str(a, "catalogRef", "$.athena", min_length=1),
        }
    return out


def bgp_place_leg(place, leg):
    """取某条腿;落点里没有 ⇒ 拒(不回落)。"""
    v = place.get(leg)
    if not v:
        raise BgpPlaceWireInvalid("$." + leg, "missing-leg")
    return v
# ── PlaceWire v1 读取函数 结束 ─────────────────────────────────────────────────────────

# 数仓落点 = PlaceWire v1(平台生成期产出并自校验;本脚本用同源读取函数再读一遍,
#   缺 / 不合法 / 没有数仓腿 ⇒ 当场抛,不会落到任何缺省区或工作组)。
_BGP_PLACE = bgp_read_place("{\"v\":1,\"targetId\":\"tgt_home\",\"region\":\"us-east-1\",\"redshift\":{\"workgroup\":\"bgp-workgroup\",\"database\":\"dev\",\"secretArn\":\"arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift!bgp-namespace-admin-AbCdEf\"}}")
_BGP_RS = bgp_place_leg(_BGP_PLACE, "redshift")

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

    # Write to Redshift via Data API.
    # BUG-G2 根因修复:此前用 Glue 的 IAM 身份(IAMR:bgp-glue-role)执行 Data API,该身份对 dev 库
    # 无 CREATE 权限 → CREATE SCHEMA "permission denied for database dev" → 建表报 schema 不存在。
    # 改用 **Redshift 托管 admin secret**(与 DMS 路径 execAdminSql 一致,有全权),所有 Data API 语句
    # 都带 SecretArn=admin 执行,从而能建 schema/表/授权。admin secret 名固定 redshift!bgp-namespace-admin。
    import time
    # 数仓四样(区/workgroup/库/凭证)全部来自注入的 binding。
    rs_client = boto3.client("redshift-data", region_name=_BGP_PLACE["region"])
    rs_workgroup = _BGP_RS["workgroup"]
    rs_database = _BGP_RS["database"]
    rs_schema = "public"
    rs_table = f"{rs_schema}.{target_name}"
    # Bug#3:SORTKEY/DISTKEY 作为【数据】注入,建表前用真实 df.columns 校验(TS 生成期拿不到列)。
    RS_SORT_KEYS = []
    RS_DIST_KEY = ""
    RS_DIST_STYLE = ""
    # 🔴 执行凭证 ARN 由平台生成期从 binding 解析后**注入**(home = 既有 admin secret,
    # 与旧运行期探名拿到的是同一把;非 home = 该 target 自己的凭证)。原先 Python 侧按 home 命名
    # 运行期探名的写法已退役 —— 那个名字是主控区的,非 home 区按它探,探到 = 连错身份,
    # 探不到 = 静默回 IAM,两头都是错。值为 None(无密钥裸环境)= 回退 IAM 身份(旧语义不变)。
    RS_ADMIN_SECRET_ARN = _BGP_RS.get("secretArn")
    print(f"Writing to Redshift: {rs_table} via Data API (admin secret: {'yes' if RS_ADMIN_SECRET_ARN else 'no/fallback-IAM'})")

    try:
        cols = df.columns
        col_types = []
        for f in df.schema.fields:
            t = str(f.dataType)
            # SYNC-FIX(typemap): map EVERY Spark numeric type Redshift-compatibly, matching WIDER
            # types FIRST (Spark repr strings are substrings — "Integer" contains "Int"; "LongType"
            # /"Bigint" and "ShortType"/"ByteType" do NOT contain "Int"). Narrow ints (Byte/Short)
            # are already cast to IntegerType above so the staging Parquet's physical type matches
            # Redshift and COPY(Parquet) succeeds — the Byte/Short branch here maps to INTEGER to
            # stay consistent with that cast (belt-and-suspenders; without the cast, a ByteType would
            # otherwise fall through to VARCHAR and break COPY with Spectrum Scan Error 15007).
            if "Boolean" in t: col_types.append("BOOLEAN")
            elif "Byte" in t or "Short" in t: col_types.append("INTEGER")
            elif "Long" in t or "Bigint" in t: col_types.append("BIGINT")
            elif "Integer" in t or "Int" in t: col_types.append("INTEGER")
            elif "Double" in t or "Float" in t: col_types.append("DOUBLE PRECISION")
            elif "Decimal" in t:
                p = getattr(f.dataType, 'precision', 18)
                s = getattr(f.dataType, 'scale', 2)
                col_types.append(f"DECIMAL({p},{s})")
            elif "Date" in t and "Timestamp" not in t: col_types.append("DATE")
            elif "Timestamp" in t: col_types.append("TIMESTAMP")
            else:
                # 防线②:未知/未覆盖类型不再"静默塞 VARCHAR"。VARCHAR 是安全兜底(不丢数),但若该
                # 列在 Parquet 里是非字符串物理类型,COPY(Parquet) 会像 TINYINT 那次一样报 Spectrum
                # Scan Error 再退化成慢 INSERT。发一个 machine-parseable 告警标记,让新类型盲区在下一
                # 次运行就暴露(而不是潜伏),同时 str-cast 该列使 Parquet 物理类型=string 与 VARCHAR 一致
                # (COPY 也能成)。这样"覆盖不到的类型"既不丢数、又不隐性退化、还会被看见。
                print(f"SYNC_UNMAPPED_TYPE col={f.name} spark_type={t} -> VARCHAR(65535) (cast to string for COPY-safety)")
                df = df.withColumn(f.name, _NF.col(f.name).cast("string"))
                col_types.append("VARCHAR(65535)")

        col_defs = ", ".join(f"{c} {ct}" for c, ct in zip(cols, col_types))

        # Bug#3:用【真实列 cols】校验 SORTKEY/DISTKEY,剔除不存在的列(大小写不敏感,因 Redshift
        # 不带引号标识符折叠小写)→ 避免 CREATE TABLE 报 "column xxx does not exist"。规则与 TS 侧
        # buildRedshiftTableClause(availableColumns) 逐字对齐(同一 SSOT,只是执行侧列到 Python 才有)。
        _cols_lower = {c.lower() for c in cols}
        _sort_valid = [k for k in RS_SORT_KEYS if k.lower() in _cols_lower]
        for _k in RS_SORT_KEYS:
            if _k.lower() not in _cols_lower:
                print(f"SYNC_KEY_DROPPED kind=sortkey col={_k} table={target_name} reason=not_in_synced_columns")
        _dist_valid = RS_DIST_KEY if (RS_DIST_KEY and RS_DIST_KEY.lower() in _cols_lower) else ""
        if RS_DIST_KEY and not _dist_valid:
            print(f"SYNC_KEY_DROPPED kind=distkey col={RS_DIST_KEY} table={target_name} reason=not_in_synced_columns")
        _rs_clause = ""
        if RS_DIST_STYLE == "key":
            if _dist_valid:
                _rs_clause += f" DISTKEY({_dist_valid})"
        elif RS_DIST_STYLE and RS_DIST_STYLE != "auto":
            _rs_clause += f" DISTSTYLE {RS_DIST_STYLE.upper()}"
        if _sort_valid:
            _rs_clause += f" SORTKEY({', '.join(_sort_valid)})"

        # SYNC-FIX: run a Data API statement and FAIL FAST. A statement that does not
        # reach FINISHED raises immediately — never silently continue (root-caused two
        # bugs: a failed INSERT was swallowed so the job "succeeded" with 0 rows, and a
        # permission-denied INSERT was retried for every batch, burning minutes of compute).
        # (2026-10-26 测试账号真环境):Redshift Data API 对单条语句偶发回「An I/O error occurred while sending to the backend」
        #   这类**连接层瞬态错**;原来一次失败即抛 ⇒ CREATE 已成、COMMENT(平台标记)失败 ⇒ 留下一张**无标记的空表**,
        #   之后每次运行都被 SYNC_REFUSED_CLEAR_FOREIGN_TABLE 拒绝(守卫按设计,可那张表是平台自己建的,用户无路可走)。
        #   修两处:① run_stmt / run_batch / 探测只对连接层瞬态签名**有界重试**(3 次,2 / 4 秒;权限 / 语法 / 对象不存在等照旧
        #   立刻抛,不回到「每批都重试」的老病);② 建表与打标记放进**同一个事务**(batch_execute_statement),要么都成要么都不成 ——
        #   「平台建的表一定带标记」从此是不变量。Data API 的 FAILED 表示该语句未提交,重试同一条语句是安全的。
        _last_err = {"msg": ""}
        _TRANSIENT_BACKEND_SIGNATURES = ("i/o error", "connection reset", "connection refused", "could not connect",
                                         "server closed the connection", "terminating connection", "ssl syscall error",
                                         "connection timed out", "connection has been closed", "broken pipe")

        def _is_transient_backend_error(err):
            e = (err or "").lower()
            return any(sig in e for sig in _TRANSIENT_BACKEND_SIGNATURES)

        def _wait_statement(sid):
            while True:
                desc = rs_client.describe_statement(Id=sid)
                if desc["Status"] in ("FINISHED", "FAILED", "ABORTED"):
                    return desc
                time.sleep(1)

        def _data_api_kwargs():
            # 带 admin SecretArn 执行(有全权);无则回退 IAM 身份(兼容旧行为)。
            _kw = {"WorkgroupName": rs_workgroup, "Database": rs_database}
            if RS_ADMIN_SECRET_ARN:
                _kw["SecretArn"] = RS_ADMIN_SECRET_ARN
            return _kw

        def _submit_with_retry(submit, label, attempts=3):
            # submit() 发一条 / 一批语句并等到终态;只在连接层瞬态签名上重试,其余错误原样交回调用方(不吞、不改语义)。
            desc = None
            for _i in range(attempts):
                desc = submit()
                if desc["Status"] == "FINISHED":
                    _last_err["msg"] = ""
                    return desc
                _last_err["msg"] = str(desc.get("Error", "") or "")
                if _i + 1 < attempts and _is_transient_backend_error(_last_err["msg"]):
                    print(f"SYNC_RS_TRANSIENT_RETRY label={label} attempt={_i + 1} err={_last_err['msg'][:160]}")
                    time.sleep(2 * (_i + 1))
                    continue
                return desc
            return desc

        def run_stmt(sql, label, fatal=True):
            desc = _submit_with_retry(lambda: _wait_statement(rs_client.execute_statement(Sql=sql, **_data_api_kwargs())["Id"]), label)
            if desc["Status"] != "FINISHED":
                msg = f"{label} failed: {desc.get('Error','')}"
                if fatal:
                    raise Exception(msg)
                print(msg)
                return False
            return True

        def run_batch(sqls, label):
            # Data API 的 batch_execute_statement 把多条语句作为**一个事务**执行(全成或全不成)。
            desc = _submit_with_retry(lambda: _wait_statement(rs_client.batch_execute_statement(Sqls=sqls, **_data_api_kwargs())["Id"]), label)
            if desc["Status"] != "FINISHED":
                raise Exception(f"{label} failed: {desc.get('Error','')}")
            return True

        def _is_concurrent_schema_create(err):
            # 与 Node 侧 lib/redshift/concurrent-schema.ts 同一套签名(两个运行时各一份,判据钉住同源)。
            e = (err or "").lower()
            if "pg_namespace_nspname_index" in e:
                return True
            dup = ("duplicate key" in e) or ("already exists" in e)
            return dup and (("schema" in e) or ("namespace" in e))

        def ensure_schema(sql, label="CREATE SCHEMA", attempts=4):
            # 🔴 CREATE SCHEMA IF NOT EXISTS 在 Redshift **不是原子的**:N 个同步任务并发跑时,
            #   几个会同时看到「schema 不存在」并都去往 pg_namespace 插一行,后提交的撞唯一索引:
            #   duplicate key violates unique constraint "pg_namespace_nspname_index"
            #   (possibly caused by concurrent transaction conflict)
            #   2026-09-19 真环境:第二个 region 6 个同步任务并发 ⇒ 3 个当场失败,而依赖它们的
            #   ETL / 编排 / 治理跟着红 —— 一个根因六条红。主控区没现形只因为那边并发度是 1。
            #   重试就能好:并发者提交之后再跑一次就是真正的 no-op 成功 ⇒ 成功本身即证明 schema 在。
            #   🔴 判别力:只在这个签名上重试;权限不足等一切别的错误照旧**立刻**抛(那条教训在下面)。
            for _i in range(attempts):
                if run_stmt(sql, label, fatal=False):
                    return True
                if not _is_concurrent_schema_create(_last_err["msg"]):
                    raise Exception(f"{label} failed: {_last_err['msg']}")
                print(f"SYNC_SCHEMA_CONCURRENT attempt={_i + 1} err={_last_err['msg'][:160]}")
                time.sleep(2 + 2 * _i)
            raise Exception(f"{label} failed after {attempts} attempts: {_last_err['msg']}")

        # BUG-G2 修复:建表前先建 schema。现在用 admin secret 执行(有 CREATE ON DATABASE 权限),
        # CREATE SCHEMA 真失败要暴露(不再吞掉导致后续建表报 schema 不存在);而**并发创建者赢了**
        # 这一种不是失败,由 ensure_schema 重试到 no-op 成功。
        ensure_schema(f"CREATE SCHEMA IF NOT EXISTS {rs_schema}", "CREATE SCHEMA")
        # Create table if missing. 用 DELETE 而不是 TRUNCATE:①TRUNCATE 是 owner-only;
        # ②增量幂等路径要按 WHERE 精确删区间(见下方 inc_where),TRUNCATE 做不到。
        # 🔴 L1后**不再需要**"向导预建的表 owner 不同"这层担心:sync/execute-ddl
        #    已改用同一个 admin secret ⇒ 两侧同 owner,不靠任何补授权。
        #    (本注释在 TS 模板串里,禁写反引号——它会当场截断模板字符串。)
        # SYNC-FIX(sortkey): 建表带上 DISTKEY/DISTSTYLE/SORTKEY(与预览 DDL 一致;此前执行脚本裸建表丢了它们)。
        #   Bug#3:_rs_clause 是上面用真实 cols 校验后组装的(不存在的键已剔除),不再是 TS 静态拼死。
        # 🔴 生产上线批次 A:**不许静默清空客户已有的表**(规则唯一作者 lib/sync/target-table-guard.ts)。
        #   平台自己建的表带标记;要整表清空一张「已存在且无标记」的表,必须在任务的确认清单里,
        #   否则本次运行**在任何 DELETE 之前**失败。这里是所有入口(向导 / 调度 / API / Copilot)唯一必经点。
        PLATFORM_TABLE_MARKER = "bgp-platform-created"
        OVERWRITE_CONFIRMED = set([])
        def _query_rows(sql, label):
            _sid_box = {}
            def _submit_probe():
                _sid_box["sid"] = rs_client.execute_statement(Sql=sql, **_data_api_kwargs())["Id"]
                return _wait_statement(_sid_box["sid"])
            desc = _submit_with_retry(_submit_probe, label)
            if desc["Status"] != "FINISHED":
                raise Exception(f"{label} failed: {desc.get('Error','')}")
            if not desc.get("HasResultSet"):
                return []
            return rs_client.get_statement_result(Id=_sid_box["sid"]).get("Records", [])
        _rs_fq = f"{rs_schema.lower()}.{target_name}"
        _rows = _query_rows(
            "SELECT COALESCE(d.description, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0 "
            f"WHERE c.relkind = 'r' AND n.nspname = '{rs_schema.lower()}' AND c.relname = '{target_name}'",
            "PROBE(target table)")
        _existed = len(_rows) > 0
        _marked = _existed and str((_rows[0][0] or {}).get("stringValue", "")) == PLATFORM_TABLE_MARKER
        _will_clear = (INCREMENTAL and not inc_where)
        if _will_clear and _existed and not _marked and _rs_fq not in OVERWRITE_CONFIRMED:
            raise Exception(
                f"SYNC_REFUSED_CLEAR_FOREIGN_TABLE table={_rs_fq}: 目标表已存在且不是平台建的,"
                f"本次同步会整表清空它 —— 未经确认,拒绝执行(一行未删)。"
                f"如确需覆盖,请在同步任务里确认覆盖该表;否则改用追加写入或换一个目标表名。")
        create_sql = f"CREATE TABLE IF NOT EXISTS {rs_table} ({col_defs}){_rs_clause}"
        print(f"DDL: {create_sql}")
        if _existed:
            # 已存在(带标记,或用户已确认覆盖)⇒ 建表语句照旧单条跑(IF NOT EXISTS 下是 no-op),不碰标记。
            run_stmt(create_sql, "DDL")
        else:
            # 建表 + 打平台标记在**同一个事务**里 —— 标记打不上就连表也不留(否则下次运行会被守卫当成客户的表拒掉)。
            run_batch([create_sql, f"COMMENT ON TABLE {rs_table} IS '{PLATFORM_TABLE_MARKER}'"], "DDL+COMMENT(platform marker)")
            print(f"SYNC_TABLE_MARKED table={_rs_fq}")

        # 🔴 **原来这里有一条"把目标表授权给 PUBLIC"的语句,已删(L1 第 ② 处,52 SPEC §3.5)。**
        # 它把每次同步的目标表对**库内所有身份**放开 = 直接击穿项目隔离,而它的唯一理由
        # ("平台查询页/再跑时可能不是 owner")已经不存在:本脚本与 sync/execute-ddl、
        # 平台 16 处读路径现在都用同一个 admin secret ⇒ 同 owner,天然可读可写。
        # 🔴 别加回来(生成侧提示词/配方已同步撤掉该建议,并有扫描门禁钉死)。

        # SYNC-FIX(dup): 增量 append 幂等 —— 落库前删掉本次将要重载的区间,再写入。即使水位未前进
        # (日志解析失败等)而重跑,也不会重复追加。表此前若不存在,CREATE IF NOT EXISTS 已建空表,
        # DELETE 命中 0 行(安全幂等)。三种情形:
        #  · 有水位:按与读取完全相同的谓词 incCol>水位 精确删该区间;
        #  · 增量但水位为空(全量回填):读的是整表,故整表清空后重载(等价该表 overwrite);
        #  · 非增量的纯 append:保持原样追加(不删)。
        if inc_where:
            run_stmt(f"DELETE FROM {rs_table} WHERE {inc_where}", "DELETE(incremental idempotent reload)")
            print(f"Idempotent pre-delete on {rs_table} WHERE {inc_where}")
        elif INCREMENTAL:
            run_stmt(f"DELETE FROM {rs_table}", "DELETE(incremental full reload — empty watermark)")
            print(f"Idempotent full reload on {rs_table} (incremental, empty watermark)")

        # SYNC-FIX(B9): bulk-load via Redshift COPY (S3 staging Parquet) instead of row-by-row
        # Data API INSERTs. A 420k-row table was ~1h of serial 100-row INSERTs; COPY loads in
        # parallel from S3 in seconds-to-minutes. COPY needs an IAM role that is (a) ASSOCIATED
        # to the Redshift namespace and (b) able to read the staging bucket. We DISCOVER that role
        # at runtime (account/stack churn-proof, never hardcoded); if none is usable we FALL BACK
        # to the legacy batched INSERT so the path never regresses.
        def discover_copy_role():
            # Derive namespace from the workgroup at runtime (no hardcoded namespace name),
            # then read its associated IAM roles. COPY's IAM_ROLE must be one associated to the
            # namespace AND able to read the staging bucket.
            try:
                rss = boto3.client("redshift-serverless", region_name=_BGP_PLACE["region"])
                ns_name = rss.get_workgroup(workgroupName=rs_workgroup)["workgroup"]["namespaceName"]
                ns = rss.get_namespace(namespaceName=ns_name)["namespace"]
                roles = []
                for r in (ns.get("iamRoles") or []):
                    m = re.search(r"arn:aws:iam::[^,)\"\s]+", r)
                    if m: roles.append(m.group(0))
                # Prefer a role whose name hints broad S3 read (immersion/admin/spectrum), else first associated.
                for r in roles:
                    if any(k in r for k in ["Immersion", "Admin", "Redshift", "Spectrum", "Copy"]):
                        return r
                return roles[0] if roles else None
            except Exception as e:
                print(f"COPY role discovery failed: {str(e)[:200]}")
                return None

        # Staging 桶来自注入的落点 binding(单一作者 resolveGlueBinding;home 与旧「按运行期账号拼
        # bgp-datalake-<acct>」逐字相等)。原来在脚本里按账号拼,非 home 的湖桶名带 slug 后缀 ⇒ 必错,
        # 而且错法是把该区数据 stage 进一个不存在/别人的桶名。
        staging = f"s3://bgp-datalake-123456789012/sync-staging/{args['JOB_NAME']}/{target_name}/"
        inserted = 0
        loaded_via = None
        # SYNC-FIX(dup): 增量稳态可能读到 0 行(谓词命中无新增)。此时 pre-delete 已幂等执行,
        # 直接跳过写入 —— 净效果 +0 行,且避免空 staging 的 COPY 歧义。
        copy_role = discover_copy_role() if row_count > 0 else None
        if row_count == 0:
            print(f"No new rows above watermark on {rs_table} — skip load (idempotent +0 rows).")
            loaded_via = "SKIP"
        if copy_role:
            try:
                # Write staging Parquet (overwrite this job's own prefix each run — idempotent).
                df.write.mode("overwrite").parquet(staging)
                # Explicit column list so COPY maps by name (robust if the table was pre-created by
                # the wizard with a different column order); Parquet is written from the same df.
                copy_sql = (
                    f"COPY {rs_table} ({','.join(cols)}) FROM '{staging}' IAM_ROLE '{copy_role}' "
                    f"FORMAT AS PARQUET SERIALIZETOJSON"
                )
                print(f"COPY: {rs_table} FROM {staging} (role={copy_role})")
                run_stmt(copy_sql, "COPY(Parquet)")
                inserted = row_count
                loaded_via = "COPY"
            except Exception as e:
                # 防线①:COPY 回退 INSERT 不再静默。发一个 machine-parseable 告警标记(poller
                # 解析后把 run 标 degraded=copy_fallback),否则"COPY 失败→慢 INSERT 兜底"会像
                # TINYINT 那次一样潜伏很久无人察觉(数据不丢、任务仍 SUCCEEDED、只是慢十倍)。
                # 全球用户任何未覆盖的类型/权限盲区导致的性能退化,从此下一次运行就能被看见。
                print(f"COPY failed, will fall back to batched INSERT: {str(e)[:300]}")
                print(f"SYNC_DEGRADED reason=copy_fallback table={rs_table} detail={str(e)[:200].replace(chr(10),' ')}")
                loaded_via = None

        if loaded_via not in ("COPY", "SKIP"):
            # Fallback: batched INSERT via Data API (FAIL FAST: first failing batch raises).
            rows = df.collect()
            batch_size = 100
            inserted = 0
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i+batch_size]
                values_list = []
                for row in batch:
                    vals = []
                    for v in row:
                        if v is None: vals.append("NULL")
                        elif isinstance(v, (int, float)): vals.append(str(v))
                        else: vals.append("'" + str(v).replace("'", "''") + "'")
                    values_list.append("(" + ",".join(vals) + ")")
                insert_sql = f"INSERT INTO {rs_table} ({','.join(cols)}) VALUES {','.join(values_list)}"
                run_stmt(insert_sql, f"Insert batch @row{i}")
                inserted += len(batch)
            loaded_via = "INSERT"

        print(f"Written {inserted} rows to Redshift: {rs_table} via {loaded_via}")
        # SYNC-FIX(B1): machine-parseable marker so the poller can backfill real metrics.
        print(f"REDSHIFT_ROWS_WRITTEN table={rs_table} rows={inserted}")
    except Exception as e:
        print(f"Redshift write error: {e}")
        raise e

    results[table_name] = {"rows": row_count, "columns": col_count}
    # SYNC-FIX(B1): emit per-table rows-read marker for metric backfill (covers S3-only targets too).
    print(f"ROWS_READ table={table_name} rows={row_count}")
    print(f"Table {table_name} sync completed: {row_count} rows")

print(f"\n{'='*60}")
print(f"SYNC RESULTS: {json.dumps(results)}")
# 目标标识按实际写入路径打印(不能无条件说"Target: S3 Tables",否则 writeS3=False 时会造成
# "看着写了 S3Table 实则没写"的假象=假成功误导;根因见 api/sync targetType 校验注释)。
print(f"Target(s): Redshift")
print(f"{'='*60}")

job.commit()
