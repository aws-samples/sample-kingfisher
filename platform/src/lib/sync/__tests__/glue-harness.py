# @kf-batch 37-sync-capability —— 同步 Glue 脚本的**行为**判据夹具:把平台生成的脚本原样 exec,
# 底下换成假的 awsglue / pyspark / boto3(内存里的 S3 Tables 表、Redshift 表、源库表),
# 跑完把「表里最后剩什么、发过哪些语句、抛了什么」吐成 JSON。判据断的是**结果**(目标表有没有被清空、
# 失败时是否原样),不是脚本里有没有某段文字。
# 只模拟脚本真会发出的那几种语句形态;遇到不认识的语句直接报错(宁可夹具红,不许静默放过)。
import json
import re
import sys
import types
import io
import contextlib

CFG = json.loads(open(sys.argv[1]).read())
SCRIPT = open(CFG["script"]).read()

STATE = {
    "spark_sql": [], "rs_sql": [], "rs_batches": [], "conf": {}, "read_dbtables": [],
    # S3 Tables 表带列序(cols)与列类型(types):写入按**位置**模拟(与真 Spark INSERT ... SELECT 一致),读表给出带类型的 schema;
    # props = 表属性(TBLPROPERTIES)。与 rs_tables 的 marked 同口径:缺省 marked=True(平台建的,带标记);
    # marked=False = 客户自己建的外来表(没有平台标记)。也可直接给 props 预置任意属性。
    "s3": {k: {"rows": v.get("rows", []), "spec": v.get("spec", []),
               "cols": v.get("cols") or (list(v["rows"][0].keys()) if v.get("rows") else []),
               "types": v.get("types", {}),
               "props": dict(v.get("props", {}), **({"bgp.created-by": "bgp-platform-created"} if v.get("marked", True) and "props" not in v else {}))}
           for k, v in CFG.get("s3_tables", {}).items()},
    "rs": {k: {"rows": v.get("rows", []), "marked": v.get("marked", True)} for k, v in CFG.get("rs_tables", {}).items()},
    "staging": {}, "commits": 0,
}
VIEWS = {}
FAIL = CFG.get("fail", {})


# ── 表达式(只实现脚本用到的:col / cast / date_format / isNull / max)──
class Expr:
    def __init__(self, fn, name=None, src=None):
        self.fn, self.name, self.src = fn, name, (src or name)

    def alias(self, n):
        return Expr(self.fn, n, self.src)

    def cast(self, t):
        def conv(v):
            if v is None:
                return None
            if t == "int":
                return int(v)
            if t == "double":
                return float(v)
            if t == "string":
                return str(v)
            if t == "timestamp":
                s = str(v)
                m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
                return (m.group(1), m.group(2), m.group(3)) if m else None
            raise Exception("harness: unsupported cast " + t)
        return Expr(lambda r: conv(self.fn(r)), self.name, self.src)

    def isNull(self):
        return Expr(lambda r: self.fn(r) is None)


def F_col(name):
    return Expr(lambda r: r.get(name), name, name)


def F_date_format(e, fmt):
    def f(r):
        v = e.fn(r)
        if v is None:
            return None
        y, m, d = v
        return fmt.replace("yyyy", y).replace("MM", m).replace("dd", d)
    return Expr(f)


def F_max(name):
    return ("max", name)


class DT:
    def __init__(self, n, simple=None):
        self.n = n
        self._simple = simple or n.replace("Type()", "").lower()

    def __str__(self):
        return self.n

    def simpleString(self):
        return self._simple


class ByteType(DT):
    pass


class ShortType(DT):
    pass


class FloatType(DT):
    pass


class Field:
    def __init__(self, name, dt):
        self.name, self.dataType = name, dt


class Schema:
    def __init__(self, fields):
        self.fields = fields

    def fieldNames(self):
        return [f.name for f in self.fields]

    def __getitem__(self, k):
        return [f for f in self.fields if f.name == k][0]


class Writer:
    def __init__(self, df):
        self.df = df

    def mode(self, m):
        return self

    def parquet(self, path):
        STATE["staging"][path] = [dict(r) for r in self.df.rows]


class DF:
    def __init__(self, rows, cols, types=None):
        self.rows, self.cols = rows, cols
        self.types = dict(types or {})
        self.persisted = False

    def select(self, *exprs):
        rows = [{e.name: e.fn(r) for e in exprs} for r in self.rows]
        return DF(rows, [e.name for e in exprs], {e.name: self.types.get(e.src, "string") for e in exprs})

    @property
    def columns(self):
        return list(self.cols)

    @property
    def schema(self):
        return Schema([Field(c, DT("StringType()", self.types.get(c, "string"))) for c in self.cols])

    @property
    def dtypes(self):
        return [(c, "string") for c in self.cols]

    def withColumn(self, name, e):
        rows = [dict(r, **{name: e.fn(r)}) for r in self.rows]
        cols = self.cols + ([name] if name not in self.cols else [])
        out = DF(rows, cols, self.types)
        out.persisted = self.persisted
        return out

    def persist(self, *_a):
        self.persisted = True
        STATE["persisted"] = True
        return self

    def count(self):
        return len(self.rows)

    def filter(self, e):
        return DF([r for r in self.rows if e.fn(r)], self.cols, self.types)

    def distinct(self):
        seen, rows = set(), []
        for r in self.rows:
            k = tuple(r.get(c) for c in self.cols)
            if k not in seen:
                seen.add(k)
                rows.append(r)
        return DF(rows, self.cols, self.types)

    def createOrReplaceTempView(self, name):
        VIEWS[name] = self

    def collect(self):
        return [tuple(r.get(c) for c in self.cols) for r in self.rows]

    def agg(self, spec):
        _, name = spec
        vals = [r.get(name) for r in self.rows if r.get(name) is not None]
        return DF([{"m": max(vals) if vals else None}], ["m"])

    @property
    def write(self):
        return Writer(self)


class Result:
    def __init__(self, rows):
        self.rows = rows

    def collect(self):
        return self.rows


class Conf:
    def set(self, k, v):
        STATE["conf"][k] = v
        STATE.setdefault("conf_log", []).append([k, v])

    def get(self, k, d=None):
        return STATE["conf"].get(k, d)


def _keys_of(row, keys):
    return tuple(row.get(k) for k in keys)


def _positional_rows(t, view):
    # 真 Spark 的 INSERT ... SELECT 按**位置**写:第 i 个 SELECT 列进目标第 i 列;列数不同才报错
    tcols = STATE["s3"][t]["cols"] or list(view.cols)
    if len(tcols) != len(view.cols):
        raise Exception("Cannot write to %s, column count mismatch: table has %d columns, data has %d" % (t, len(tcols), len(view.cols)))
    STATE["s3"][t]["cols"] = tcols
    return [{tc: r.get(vc) for tc, vc in zip(tcols, view.cols)} for r in view.rows]


def _parse_on(on, left="t", right="s"):
    # ON t.k1 = s.k1 AND t.k2 = s.k2 ⇒ [("k1","k1"),("k2","k2")];也接受 <=> 。写法不对就报错(不许静默当成空条件)
    pairs = []
    for term in re.split(r"\s+AND\s+", on.strip()):
        m = re.match(r"^%s\.(\w+)\s*(?:=|<=>)\s*%s\.(\w+)$" % (re.escape(left), re.escape(right)), term.strip())
        if not m:
            raise Exception("harness: unknown ON term: " + term)
        pairs.append((m.group(1), m.group(2)))
    return pairs


def _col_ci(cols, name):
    # Spark 标识符不区分大小写:按小写找真实列名;找不到 ⇒ 报错(真 Spark 会 AnalysisException)
    for c in cols:
        if c.lower() == name.lower():
            return c
    raise Exception("harness: column not found: " + name + " in " + str(cols))


def _merge_rows(t, view, on):
    # 真 Iceberg MERGE INTO ... UPDATE SET * / INSERT * 按**列名**展开:源列集合必须与目标相同(否则 AnalysisException)
    tcols = STATE["s3"][t]["cols"]
    if sorted(c.lower() for c in tcols) != sorted(c.lower() for c in view.cols):
        raise Exception("harness: MERGE INTO column set mismatch: table %s vs source %s" % (tcols, view.cols))
    pairs = [(_col_ci(tcols, a), _col_ci(view.cols, b)) for a, b in _parse_on(on)]
    by_name = {c.lower(): c for c in view.cols}
    rows = [dict(r) for r in STATE["s3"][t]["rows"]]
    for s in view.rows:
        new_row = {tc: s.get(by_name[tc.lower()]) for tc in tcols}
        hit = [i for i, r in enumerate(rows) if all(r.get(tk) == s.get(sk) for tk, sk in pairs)]
        if len(hit) > 1:
            raise Exception("harness: MERGE INTO matched multiple target rows (Iceberg would fail the same way)")
        if hit:
            rows[hit[0]] = new_row
        else:
            rows.append(new_row)
    return rows


class Reader:
    def format(self, f):
        return self

    def options(self, **kw):
        self.kw = kw
        return self

    def load(self):
        dbt = self.kw["dbtable"]
        STATE["read_dbtables"].append(dbt)
        m = re.match(r"^\(SELECT (.+?) FROM (\S+)(?: WHERE (.*))?\) AS (\w+)$", dbt)
        tname = m.group(2) if m else dbt
        if tname not in CFG["source"]:
            raise Exception("harness: source table not found: " + tname)
        src = CFG["source"][tname]
        rows = [dict(r) for r in src["rows"]]
        cols = list(src["cols"])
        if m:
            sel = m.group(1).strip()
            if sel != "*":
                # 投影下推:只带回 SELECT 列出的列
                cols = [c.strip() for c in sel.split(",")]
                rows = [{c: r.get(c) for c in cols} for r in rows]
            if m.group(3) and "filter" in CFG:
                # 夹具按配置的谓词文本挑行(不解析 SQL;判据另断谓词文本本身)
                rows = [r for r in rows if eval(CFG["filter"], {}, {"r": r})]  # nosec B307 # nosemgrep: python.lang.security.audit.eval-detected —— 测试夹具:谓词文本来自测试配置
        return DF(rows, cols, {c: src.get("types", {}).get(c, "string") for c in cols})


class Spark:
    conf = Conf()
    read = Reader()

    def table(self, name):
        if not name.endswith(".partitions"):
            t = STATE["s3"].get(name)
            if t is None:
                raise Exception("Table or view not found: " + name)
            return DF([dict(r) for r in t["rows"]], list(t["cols"]), t.get("types"))
        t = name[: -len(".partitions")]
        spec = STATE["s3"][t]["spec"]
        if not spec:
            return types.SimpleNamespace(schema=Schema([Field("record_count", DT("LongType()"))]))
        inner = types.SimpleNamespace(fields=[Field(n, DT("StringType()")) for n in spec])
        return types.SimpleNamespace(schema=Schema([Field("partition", inner), Field("record_count", DT("LongType()"))]))

    def sql(self, q):
        STATE["spark_sql"].append(q)
        q1 = " ".join(q.split())
        m = re.match(r"^SELECT 1 FROM (\S+) LIMIT 1$", q1)
        if m:
            if m.group(1) not in STATE["s3"]:
                raise Exception("Table not found")
            return Result([(1,)])
        m = re.match(r"^INSERT OVERWRITE (\S+) SELECT \* FROM (\S+)$", q1)
        if m:
            if FAIL.get("s3_write"):
                raise Exception("harness: injected S3 write failure")
            t, v = m.group(1), VIEWS[m.group(2)]
            new_rows = _positional_rows(t, v)
            mode = STATE["conf"].get("spark.sql.sources.partitionOverwriteMode", "static")
            if mode == "dynamic" and STATE["s3"][t]["spec"]:
                spec = STATE["s3"][t]["spec"]
                hit = {_keys_of(r, spec) for r in new_rows}
                kept = [r for r in STATE["s3"][t]["rows"] if _keys_of(r, spec) not in hit]
                STATE["s3"][t]["rows"] = kept + new_rows
            else:
                STATE["s3"][t]["rows"] = new_rows
            STATE["commits"] += 1
            return Result([])
        m = re.match(r"^INSERT INTO (\S+) SELECT \* FROM (\S+)$", q1)
        if m:
            if FAIL.get("s3_write"):
                raise Exception("harness: injected S3 write failure")
            STATE["s3"][m.group(1)]["rows"] += _positional_rows(m.group(1), VIEWS[m.group(2)])
            STATE["commits"] += 1
            return Result([])
        m = re.match(r"^MERGE INTO (\S+) t USING (\S+) s ON (.+?) WHEN MATCHED THEN UPDATE SET \* WHEN NOT MATCHED THEN INSERT \*$", q1)
        if m:
            if FAIL.get("s3_write"):
                raise Exception("harness: injected S3 write failure")
            t = m.group(1)
            if t not in STATE["s3"]:
                raise Exception("Table not found: " + t)
            STATE["s3"][t]["rows"] = _merge_rows(t, VIEWS[m.group(2)], m.group(3))
            STATE["commits"] += 1
            return Result([])
        m = re.match(r"^SHOW TBLPROPERTIES (\S+)$", q1)
        if m:
            if m.group(1) not in STATE["s3"]:
                raise Exception("Table not found: " + m.group(1))
            return Result([(k, v) for k, v in STATE["s3"][m.group(1)]["props"].items()])
        m = re.match(r"^DELETE FROM (\S+)$", q1)
        if m:
            STATE["s3"][m.group(1)]["rows"] = []
            STATE["commits"] += 1
            return Result([])
        m = re.match(r"^DELETE FROM (\S+) WHERE .*$", q1)
        if m:
            STATE["commits"] += 1
            return Result([])
        m = re.match(r"^CREATE TABLE (\S+) USING iceberg (.*?)TBLPROPERTIES \((.*?)\) AS SELECT \* FROM (\S+)$", q1)
        if m:
            if FAIL.get("s3_write"):
                raise Exception("harness: injected S3 write failure")
            spec = []
            pm = re.match(r"PARTITIONED BY \((.*)\)", m.group(2).strip())
            if pm:
                for p in [x.strip() for x in pm.group(1).split(",")]:
                    tm = re.match(r"^(days|months)\((\w+)\)$", p)
                    spec.append(tm.group(2) + ("_day" if tm.group(1) == "days" else "_month") if tm else p)
            # 表属性按 'k'='v' 解析存起来(平台标记就在这里;SHOW TBLPROPERTIES 原样回)
            props = {k: v for k, v in re.findall(r"'([^']+)'\s*=\s*'([^']*)'", m.group(3))}
            _v = VIEWS[m.group(4)]
            STATE["s3"][m.group(1)] = {"rows": [dict(r) for r in _v.rows], "spec": spec, "cols": list(_v.cols), "types": dict(_v.types), "props": props}
            STATE["commits"] += 1
            return Result([])
        m = re.match(r"^SELECT COUNT\(\*\) FROM (\S+)$", q1)
        if m:
            n = len(STATE["s3"][m.group(1)]["rows"])
            return Result([(n + CFG.get("s3_count_skew", 0),)])
        m = re.match(r"^SELECT COUNT\(\*\) FROM (\S+) t LEFT SEMI JOIN \(SELECT DISTINCT (.+) FROM (\S+)\) b ON .*$", q1)
        if m:
            keys = [k.strip() for k in m.group(2).split(",")]
            hit = {_keys_of(r, keys) for r in VIEWS[m.group(3)].rows}
            n = len([r for r in STATE["s3"][m.group(1)]["rows"] if _keys_of(r, keys) in hit])
            return Result([(n + CFG.get("s3_count_skew", 0),)])
        raise Exception("harness: unknown spark sql: " + q1)


SPARK = Spark()


# ── Redshift Data API(语句按形态模拟;batch = 一个事务,失败整批不生效)──
def rs_apply(sql, st):
    s = " ".join(sql.split())
    m = re.match(r"^CREATE SCHEMA IF NOT EXISTS (\S+)$", s)
    if m:
        return None
    if s.startswith("SELECT COALESCE(d.description, '') FROM pg_class"):
        mm = re.search(r"n.nspname = '(\w+)' AND c.relname = '(\w+)'", s)
        fq = mm.group(1) + "." + mm.group(2)
        if fq in st:
            return [[{"stringValue": "bgp-platform-created" if st[fq]["marked"] else ""}]]
        return []
    m = re.match(r"^CREATE TABLE IF NOT EXISTS (\S+) \(", s)
    if m:
        st.setdefault(m.group(1).lower(), {"rows": [], "marked": False})
        return None
    m = re.match(r"^COMMENT ON TABLE (\S+) IS '(.*)'$", s)
    if m:
        st[m.group(1).lower()]["marked"] = True
        return None
    m = re.match(r"^DROP TABLE IF EXISTS (\S+)$", s)
    if m:
        st.pop(m.group(1).lower(), None)
        return None
    m = re.match(r"^CREATE TABLE (\S+) \(LIKE (\S+)\)$", s)
    if m:
        st[m.group(1).lower()] = {"rows": [], "marked": False, "stage": True}
        return None
    m = re.match(r"^DELETE FROM (\S+)$", s)
    if m:
        st[m.group(1).lower()]["rows"] = []
        return None
    m = re.match(r"^DELETE FROM (\S+) WHERE (\w+) IN \(SELECT DISTINCT (\w+) FROM (\S+)\)$", s)
    if m:
        t, k, stg = m.group(1).lower(), m.group(2), m.group(4).lower()
        hit = {r.get(k) for r in st[stg]["rows"]}
        st[t]["rows"] = [r for r in st[t]["rows"] if r.get(k) not in hit]
        return None
    m = re.match(r"^DELETE FROM (\S+) USING (\S+) WHERE (.+)$", s)
    if m:
        # 序 37 B-61:DELETE … USING stage WHERE t.k = stage.k AND … —— 删掉目标里键命中暂存表的行。
        # 键值按 str 比(本夹具的 Redshift 路径把所有值当字符串装进暂存表,而预置的目标行可能是数字;真 Redshift 按类型比)
        t, stg = m.group(1).lower(), m.group(2).lower()
        pairs = _parse_on(m.group(3), left=m.group(1), right=m.group(2))
        hit = {tuple(str(r.get(sk)) for _, sk in pairs) for r in st[stg]["rows"]}
        st[t]["rows"] = [r for r in st[t]["rows"] if tuple(str(r.get(tk)) for tk, _ in pairs) not in hit]
        return None
    m = re.match(r"^DELETE FROM (\S+) WHERE .*$", s)
    if m:
        return None
    m = re.match(r"^COPY (\S+) \((.*?)\) FROM '(\S+)' IAM_ROLE .*$", s)
    if m:
        if FAIL.get("copy"):
            raise Exception("harness: injected COPY failure")
        st[m.group(1).lower()]["rows"] += [dict(r) for r in STATE["staging"][m.group(3)]]
        return None
    m = re.match(r"^INSERT INTO (\S+) \((.*?)\) SELECT (.*?) FROM (\S+)$", s)
    if m:
        st[m.group(1).lower()]["rows"] += [dict(r) for r in st[m.group(4).lower()]["rows"]]
        return None
    m = re.match(r"^SELECT COUNT\(\*\) FROM (\S+)$", s)
    if m:
        return [[{"longValue": len(st[m.group(1).lower()]["rows"]) + CFG.get("rs_count_skew", 0)}]]
    m = re.match(r"^SELECT COUNT\(\*\) FROM (\S+) WHERE (\w+) IN \(SELECT DISTINCT (\w+) FROM (\S+)\)$", s)
    if m:
        t, k, stg = m.group(1).lower(), m.group(2), m.group(4).lower()
        hit = {r.get(k) for r in st[stg]["rows"]}
        return [[{"longValue": len([r for r in st[t]["rows"] if r.get(k) in hit]) + CFG.get("rs_count_skew", 0)}]]
    m = re.match(r"^SELECT COUNT\(\*\) FROM (\S+) t WHERE EXISTS \(SELECT 1 FROM (\S+) s WHERE (.+)\)$", s)
    if m:
        t, stg = m.group(1).lower(), m.group(2).lower()
        pairs = _parse_on(m.group(3))
        hit = {tuple(str(r.get(sk)) for _, sk in pairs) for r in st[stg]["rows"]}
        return [[{"longValue": len([r for r in st[t]["rows"] if tuple(str(r.get(tk)) for tk, _ in pairs) in hit]) + CFG.get("rs_count_skew", 0)}]]
    raise Exception("harness: unknown redshift sql: " + s)


class RsData:
    def __init__(self):
        self.res = {}
        self.n = 0

    def _id(self, status, result=None, err=""):
        self.n += 1
        sid = "s%d" % self.n
        self.res[sid] = (status, result, err)
        return {"Id": sid}

    def execute_statement(self, **kw):
        STATE["rs_sql"].append(kw["Sql"])
        try:
            r = rs_apply(kw["Sql"], STATE["rs"])
            return self._id("FINISHED", r)
        except Exception as e:  # noqa: BLE001
            return self._id("FAILED", None, str(e))

    def batch_execute_statement(self, **kw):
        STATE["rs_batches"].append(kw["Sqls"])
        if FAIL.get("swap"):
            return self._id("FAILED", None, "harness: injected swap failure")
        import copy
        trial = copy.deepcopy(STATE["rs"])
        try:
            for q in kw["Sqls"]:
                rs_apply(q, trial)
        except Exception as e:  # noqa: BLE001
            return self._id("FAILED", None, str(e))
        STATE["rs"] = trial
        return self._id("FINISHED", None)

    def describe_statement(self, Id):
        st, r, err = self.res[Id]
        return {"Status": st, "Error": err, "HasResultSet": r is not None}

    def get_statement_result(self, Id):
        return {"Records": self.res[Id][1] or []}


RSDATA = RsData()


def fake_client(name, **_kw):
    if name == "redshift-data":
        return RSDATA
    if name == "secretsmanager":
        return types.SimpleNamespace(get_secret_value=lambda **k: {"SecretString": json.dumps({"username": "u", "password": "p"})})
    if name == "redshift-serverless":
        return types.SimpleNamespace(
            get_workgroup=lambda **k: {"workgroup": {"namespaceName": "ns"}},
            get_namespace=lambda **k: {"namespace": {"iamRoles": ["IamRole(applyStatus=in-sync, iamRoleArn=arn:aws:iam::123456789012:role/RedshiftCopy)"]}},
        )
    raise Exception("harness: unexpected boto3 client " + name)


def install_fakes():
    mods = {}
    for n in ["awsglue", "awsglue.utils", "awsglue.context", "awsglue.job", "pyspark", "pyspark.context", "pyspark.sql", "pyspark.sql.types", "pyspark.sql.functions", "boto3"]:
        mods[n] = types.ModuleType(n)
    mods["awsglue.utils"].getResolvedOptions = lambda argv, names: {"JOB_NAME": "bgp-sync-golden"}
    mods["pyspark.context"].SparkContext = lambda: object()

    class GlueContext:
        def __init__(self, sc):
            self.spark_session = SPARK
    mods["awsglue.context"].GlueContext = GlueContext

    class Job:
        def __init__(self, gc):
            pass

        def init(self, *a):
            pass

        def commit(self):
            STATE["job_committed"] = True
    mods["awsglue.job"].Job = Job
    mods["pyspark.sql.types"].ByteType = ByteType
    mods["pyspark.sql.types"].ShortType = ShortType
    mods["pyspark.sql.types"].FloatType = FloatType
    f = mods["pyspark.sql.functions"]
    f.col, f.date_format, f.max = F_col, F_date_format, F_max
    mods["pyspark"].StorageLevel = types.SimpleNamespace(MEMORY_AND_DISK="MEMORY_AND_DISK")
    mods["boto3"].client = fake_client
    sys.modules.update(mods)


install_fakes()
sys.argv = ["job.py", "--JOB_NAME", "bgp-sync-golden"] + CFG.get("argv", [])
out = io.StringIO()
err = None
import time as _t
_t.sleep = lambda *_a: None
try:
    with contextlib.redirect_stdout(out):
        exec(compile(SCRIPT, "job.py", "exec"), {"__name__": "__main__"})  # nosec B102 # nosemgrep: python.lang.security.audit.exec-detected —— 测试夹具:执行被测的生成脚本本身
except Exception as e:  # noqa: BLE001
    err = str(e)
STATE["error"] = err
STATE["stdout"] = out.getvalue()
print(json.dumps(STATE, default=str))
