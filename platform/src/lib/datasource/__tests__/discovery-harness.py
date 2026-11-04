# §discovery —— 数据源表发现脚本(lib/datasource/glue-reach.ts buildDiscoveryScript 的产物)的**离线替身**:
#   把平台生成的 PySpark 脚本原样 exec,底下换成假的 awsglue / pyspark / boto3(内存里的 information_schema 行、假 secret、
#   假 S3 put_object),跑完把「发了哪些 JDBC 选项、读了哪个 secret、往哪个桶 / 键写了什么 JSON、退出码」吐成 JSON。
#   判据断的是**结果**(归一后的表 / 列 / 可空 / 缺省 schema 去前缀、库名护栏真拒),不是脚本里有没有某段文字。
#   只模拟脚本真会用到的那几种调用;遇到不认识的调用直接报错(宁可替身红,不许静默放过)。
import contextlib
import io
import json
import sys
import types

CFG = json.loads(open(sys.argv[1]).read())
SCRIPT = open(CFG["script"]).read()
STATE = {"puts": [], "jdbc": {}, "secret_ids": [], "exit": 0, "error": ""}


class FakeRow:
    def __init__(self, d):
        self._d = d

    def __getitem__(self, k):
        if k not in self._d:
            raise KeyError(f"row has no column {k!r}(脚本读了 information_schema 没给的列)")
        return self._d[k]


class FakeDF:
    def __init__(self, rows):
        self._rows = rows

    def collect(self):
        return [FakeRow(r) for r in self._rows]


class FakeReader:
    def __init__(self):
        self.opts = {}
        self.fmt = None

    def format(self, f):
        self.fmt = f
        return self

    def option(self, k, v):
        self.opts[k] = v
        return self

    def load(self):
        if self.fmt != "jdbc":
            raise RuntimeError(f"unexpected read format {self.fmt!r}")
        for k in ("url", "driver", "user", "password", "dbtable"):
            if k not in self.opts:
                raise RuntimeError(f"jdbc read missing option {k!r}")
        STATE["jdbc"] = dict(self.opts)
        if CFG.get("fail_jdbc"):
            raise RuntimeError(CFG["fail_jdbc"])
        return FakeDF(CFG.get("rows", []))


class FakeSpark:
    @property
    def read(self):
        return FakeReader()


class FakeGlueContext:
    def __init__(self, sc):
        self.spark_session = FakeSpark()


class FakeSparkContext:
    pass


def _getResolvedOptions(argv, names):
    out = {}
    for n in names:
        if n not in CFG["args"]:
            raise SystemExit(f"missing required arg --{n}")
        out[n] = CFG["args"][n]
    return out


class FakeSecrets:
    def get_secret_value(self, SecretId):
        STATE["secret_ids"].append(SecretId)
        return {"SecretString": json.dumps(CFG["secret"])}


class FakeS3:
    def put_object(self, **kw):
        body = kw.pop("Body")
        kw["Body"] = json.loads(body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body)
        STATE["puts"].append(kw)
        return {}


def _client(name, region_name=None):
    STATE.setdefault("client_regions", {})[name] = region_name
    if name == "secretsmanager":
        return FakeSecrets()
    if name == "s3":
        return FakeS3()
    raise RuntimeError(f"unexpected boto3 client {name!r}")


awsglue = types.ModuleType("awsglue")
awsglue_utils = types.ModuleType("awsglue.utils")
awsglue_utils.getResolvedOptions = _getResolvedOptions
awsglue_context = types.ModuleType("awsglue.context")
awsglue_context.GlueContext = FakeGlueContext
pyspark = types.ModuleType("pyspark")
pyspark_context = types.ModuleType("pyspark.context")
pyspark_context.SparkContext = FakeSparkContext
boto3 = types.ModuleType("boto3")
boto3.client = _client
sys.modules.update({
    "awsglue": awsglue, "awsglue.utils": awsglue_utils, "awsglue.context": awsglue_context,
    "pyspark": pyspark, "pyspark.context": pyspark_context, "boto3": boto3,
})

out = io.StringIO()
try:
    with contextlib.redirect_stdout(out):
        exec(compile(SCRIPT, "discovery-script.py", "exec"), {"__name__": "__main__"})  # nosec B102 # nosemgrep: python.lang.security.audit.exec-detected —— 测试夹具:执行被测的生成脚本本身
except SystemExit as e:
    STATE["exit"] = e.code if isinstance(e.code, int) else 1
    STATE["error"] = str(e.code)
except Exception as e:  # noqa: BLE001 —— 替身要把脚本抛的东西原样吐出来
    STATE["exit"] = 1
    STATE["error"] = f"{type(e).__name__}: {e}"
STATE["stdout"] = out.getvalue()
print(json.dumps(STATE, ensure_ascii=False))
