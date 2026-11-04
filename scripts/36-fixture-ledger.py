#!/usr/bin/env python3
"""
36-fixture-ledger.py —— **验收夹具台账**:把「哪些对象是示范对象(要留)、哪些是验收段留下的夹具
(该清)」一次列清楚;删除必须**逐个指名**,永不接受通配。

    python3 scripts/36-fixture-ledger.py --profile temp-account              # 只列(默认,零副作用)
    python3 scripts/36-fixture-ledger.py --profile temp-account \
            --delete "fk2r-0919095841-home,fk2r-0919095841-usw2_a"           # 只删点到名字的这几个

🔴 **为什么要有它**(第 4 步的一般化):本仓反复出现两个对偶的毛病
  ① 验收段「自造夹具、验完删净」⇒ 判据全绿而**用户切过去看到空页面**(记忆
     `all-capabilities-visible-in-every-region`);
  ② 而删不净的那些又堆在页面上,让用户分不清「示范对象」和「脏数据」:2026-09-19 就有 3 个
     停在 READY 的 MSAF 应用、2 行无名 error 同步任务、1 个残留数据源 —— 它们当年那一轮其实是
     **空跑**(源流 `bgp-flink-source` 根本不存在,平台刻意不建固定流)。
  两个毛病要一起治:**示范对象长期保留 + 夹具有台账可清**。

🔴 **删除的安全形状**(本仓纪律:删数据必须由人指名):
  · 默认 **只列不删**;
  · `--delete` 只接受**逗号分隔的确切名字 / id**,不接受 `*`、前缀、正则;
  · 名字在台账里被判为「示范对象」时**拒绝删除**(要删得先改台账规则,那是显式决定);
  · 删除一律走**产品自己的 DELETE 接口**(而不是直接动 DDB / AWS):流作业的 DELETE 会真去销毁
    MSAF 应用、同步任务的 DELETE 会真去停后台通道 —— 绕过它就是「记录删了、后台还在计费」。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

import boto3

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kf_headless_lib as L  # noqa: E402

# 示范对象:**长期保留**,用户切到那个区就该看见它们(任何时候都不许被本脚本删掉)
KEEP_PREFIXES = ("Showcase-",)
# 已知的验收段前缀(硬门段名 + 时间戳)。只用来**给出建议**,删不删仍然要人点名。
FIXTURE_PREFIXES = (
    "fk2r-", "wf2r-", "scq-", "sls-", "slsw-", "o2-", "o4-", "w3", "w5", "dqx-", "dqx_",
    "mrj-", "mrj_", "rdata-", "rdata_", "p51", "ui_rs_demo", "wp24-", "gbc-", "net0-",
    "journey-", "DispatchCheck-",
)


def classify(name: str) -> str:
    """`keep`(示范对象)/ `fixture`(像验收夹具)/ `unknown`(说不清 ⇒ 不给建议,默认不动)。"""
    n = (name or "").strip()
    if not n:
        return "fixture"          # 无名对象只可能是半截创建失败的记录
    if any(n.startswith(p) for p in KEEP_PREFIXES):
        return "keep"
    if any(n.startswith(p) for p in FIXTURE_PREFIXES):
        return "fixture"
    return "unknown"


WILDCARDS = "*?%"


def reject_reason(token: str, kls: str | None) -> str | None:
    """能不能删这一个?回 None = 可以删;回字符串 = 拒绝的理由(人话)。

    🔴 这是本脚本唯一的安全面,所以抽成**纯函数**并由离线判据驱动
    (`infra/test/fixture-ledger-classify/test_classify.py`):
      ① 通配符一律拒 —— 「删一批」永远不该是一条命令能表达的事;
      ② 示范对象一律拒 —— 它们是用户切区要看见的那一套,删了就等于「这个区什么都没做」;
      ③ 空 token 拒(命令行里多打一个逗号不该变成一次删除)。
    """
    t = (token or "").strip()
    if not t:
        return "空名字(命令行里多打了一个逗号?)"
    if any(ch in t for ch in WILDCARDS):
        return f"含通配符 {''.join(ch for ch in WILDCARDS if ch in t)!r} —— 本脚本只接受确切名字/id"
    if kls == "keep":
        return "它是示范对象(长期保留)—— 用户切到那个区要看见它"
    return None


class Api:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                  "x-bgp-project": "proj-default", "x-bgp-env": "dev"}

    def call(self, method: str, path: str, body=None, timeout: int = 180):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=self.h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310 # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected —— 目标是本平台 CloudFront 地址(来自栈输出),开发机脚本
                txt = r.read().decode()
                return r.status, (json.loads(txt) if txt else {})
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(txt)
            except Exception:
                return e.code, {"raw": txt[:400]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="temp-account")
    ap.add_argument("--home-region", default=os.environ.get("KF_HOME_REGION", "us-east-1"))
    ap.add_argument("--delete", default="",
                    help="要删的**确切名字**(逗号分隔)。不接受通配/前缀;示范对象会被拒绝")
    a = ap.parse_args()

    sess = boto3.Session(profile_name=a.profile, region_name=a.home_region)
    ddb, cf, cog = sess.client("dynamodb"), sess.client("cloudformation"), sess.client("cognito-idp")
    base = L.cfn_out(cf, "BgpPlatformStack", "PlatformUrl").rstrip("/")
    client_id = L.cfn_out(cf, "BgpAuthStack", "ClientId")
    if not base or not client_id:
        sys.exit("读不到平台地址 / ClientId(平台没装?)")
    tok = cog.initiate_auth(AuthFlow="USER_PASSWORD_AUTH", ClientId=client_id,
                            AuthParameters={"USERNAME": "admin", "PASSWORD": L.admin_pw(a.profile)})
    api = Api(base, tok["AuthenticationResult"]["IdToken"])

    def g(it, k):
        return (it.get(k) or {}).get("S") or ""

    # (表名, id 字段, DELETE 路由模板, 人话)
    KINDS = [
        ("bgp-flink-jobs", "jobId", "/api/flink/jobs/{id}", "实时作业(DELETE 会真去销毁 MSAF 应用)"),
        ("bgp-sync-tasks", "taskId", "/api/sync/{id}", "同步任务(DELETE 会真去停后台通道)"),
        ("bgp-datasources", "datasourceId", "/api/datasources/{id}", "数据源"),
        ("bgp-workflows", "workflowId", "/api/workflow/{id}", "编排"),
        ("bgp-etl-jobs", "jobId", "/api/etl-jobs/{id}", "离线作业"),
        ("bgp-engine-jobs", "jobId", "/api/engines/emr-serverless/{id}", "引擎作业"),
    ]
    want = [x.strip() for x in a.delete.split(",") if x.strip()]
    rows: list[tuple[str, str, str, str, str]] = []   # (kind, name, id, 分类, route)
    for table, idk, route, human in KINDS:
        try:
            items = ddb.scan(TableName=table).get("Items", [])
        except Exception as e:
            print(f"[台账] ⚠️ 读不到 {table}:{str(e)[:120]}")
            continue
        for it in items:
            nm, oid = g(it, "name"), g(it, idk)
            if not oid:
                continue
            rows.append((human, nm, oid, classify(nm), route.replace("{id}", oid)))

    print("\n| 类型 | 名字 | 判定 | id |")
    print("|---|---|---|---|")
    for human, nm, oid, kls, _ in sorted(rows, key=lambda r: (r[3], r[0], r[1])):
        badge = {"keep": "🟢 示范对象(长期保留)", "fixture": "🧹 像验收夹具", "unknown": "❔ 说不清"}[kls]
        print(f"| {human} | {nm or '(无名)'} | {badge} | {oid} |")
    n_keep = sum(1 for r in rows if r[3] == "keep")
    n_fix = sum(1 for r in rows if r[3] == "fixture")
    print(f"\n合计 {len(rows)} 个对象:示范 {n_keep} · 像夹具 {n_fix} · 说不清 {len(rows) - n_keep - n_fix}")

    if not want:
        print("\n(默认只列不删。要删就用 --delete \"确切名字1,确切名字2\";"
              "无名对象用它的 id。示范对象会被拒绝。)")
        return 0

    print(f"\n=== 按指名删除 {len(want)} 个 ===")
    bad = 0
    for token in want:
        why = reject_reason(token, None)
        if why:
            print(f"  ⛔ 拒绝 {token!r}:{why}")
            bad += 1
            continue
        hits = [r for r in rows if r[1] == token or r[2] == token]
        if not hits:
            print(f"  ⚠️ 台账里没有 {token!r}(可能已经删了)")
            continue
        for human, nm, oid, kls, route in hits:
            why = reject_reason(token, kls)
            if why:
                print(f"  ⛔ 拒绝删 {nm or oid}({human}):{why}")
                bad += 1
                continue
            st, j = api.call("DELETE", route)
            code = ((j.get("error") or {}) if isinstance(j, dict) else {}).get("code")
            print(f"  {'✅' if st in (200, 204) else '❌'} {human} {nm or '(无名)'} {oid} ⇒ HTTP {st}"
                  f"{'' if st in (200, 204) else ' ' + str(code or json.dumps(j, ensure_ascii=False)[:160])}")
            if st not in (200, 204):
                bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
