#!/usr/bin/env python3
# 🔴 **为什么入仓**:每次动 `buildCarrierArtifact` / 归一清单,都要重跑这条判别力验证 ——
#   它回答的是「这条机制到底分不分得清 ok 与 stale」。放 /tmp 就等于下次换机器重新写一遍。
#   (2026-09-22 用户:「你真是丢三落四,这个问题我提醒你 N 次了」)
# 用法:python3 scripts/38-drift-discrim.py   (只动验收残留,绝不碰 Showcase-*)
"""该缺陷的**判别力**验证:造一个「定义故意落后」的载体,看比对能不能判出 `stale`。

🔴 为什么非做不可:上一步真环境跑出来**全是 `ok`** —— 那既可能是「确实都最新」,
   也可能是「这条机制恒回 ok」。**分不清就等于没有判据。**
   (本仓纪律:判别力不许依赖运气,必须造出「对错两种实现结果不同」的夹具。)

做法:改 DDB 上**一个验收残留工作流**的 `cronExpression`(不走发布路径 ⇒ 载体上的定义不动)
      ⇒ 重新生成出来的定义里 `schedule` 就与已发布的不同 ⇒ 必须判 `stale`。
      (`publish-dag.ts:295` = `const cron = workflow.cronExpression || null` ⇒ 不看
       `scheduleEnabled`,所以改这个字段一定会改变生成的定义。夹具有效性已先读代码坐实。)

🔴 四条判据(缺一条就不算验过判别力):
  ① 改**之前**必须是 `ok` —— 否则「改后是 stale」可能是**恒 stale**,和恒 ok 一样没判别力;
  ② 夹具自己要有判据:接口必须**真的读到**我改后的 cron(否则我在验一个没发生的改动);
  ③ 改**之后**那一行必须是 `stale`;
  ④ 🔴 **负向控制组**:同一次读里,**没被动过的**别的已发布行必须**仍是 ok**
     —— 排除「一改就全红 / 任何时候读都是 stale」。

🔴 三条安全线:
  ① 只动**验收残留**对象(名字以 `slsw-cron-`/`wf2r-` 开头),绝不碰 `Showcase-*` 示范对象;
  ② 改之前先把原值**存下来**,`finally` 里无条件还原,并**再读一次确认还原成功**;
  ③ 只改 DDB 的一个字段,**不触发任何发布** ⇒ 真实载体一个字节都不动。
"""
import asyncio, sys, json, importlib.util
sys.path.insert(0, "/home/ec2-user/kf-deploy-from-github/scripts")
spec = importlib.util.spec_from_file_location("m33", "/home/ec2-user/kf-deploy-from-github/scripts/33-verify-regions-headless.py")
m33 = importlib.util.module_from_spec(spec); spec.loader.exec_module(m33)
import boto3
from playwright.async_api import async_playwright

TABLE = "bgp-workflows"
OK_TO_TOUCH = ("slsw-cron-", "wf2r-")   # 只动验收残留
NEVER = "Showcase"                       # 示范对象绝不碰


def ddb():
    return boto3.Session(profile_name="temp-account", region_name="us-east-1").client("dynamodb")


def scan_all():
    c = ddb(); r = c.scan(TableName=TABLE); items = r.get("Items") or []
    while "LastEvaluatedKey" in r:
        r = c.scan(TableName=TABLE, ExclusiveStartKey=r["LastEvaluatedKey"])
        items += r.get("Items") or []
    return items


def find_victim():
    """🔴 挑**有 cron 的**残留行:cron=None 的行改成有 cron 也能造出差异,
       但「从无到有」与「值变了」是两条不同的路径;先验更常见的那条(值变了)。"""
    for it in scan_all():
        n = (it.get("name") or {}).get("S") or ""
        if NEVER in n or not n.startswith(OK_TO_TOUCH):
            continue
        if not ((it.get("deployments") or {}).get("M") or {}):
            continue
        if not ((it.get("cronExpression") or {}).get("S")):
            continue
        return {
            "workflowId": (it.get("workflowId") or {}).get("S"),
            "userId": (it.get("userId") or {}).get("S"),
            "name": n,
            "cron": (it.get("cronExpression") or {}).get("S"),
        }
    return None


def set_cron(v, cron):
    ddb().update_item(
        TableName=TABLE,
        Key={"userId": {"S": v["userId"]}, "workflowId": {"S": v["workflowId"]}},
        UpdateExpression="SET cronExpression = :c",
        ExpressionAttributeValues={":c": {"S": cron}},
    )


def read_cron(v):
    r = ddb().get_item(TableName=TABLE, Key={"userId": {"S": v["userId"]}, "workflowId": {"S": v["workflowId"]}})
    return ((r.get("Item") or {}).get("cronExpression") or {}).get("S")


async def read_all(pg):
    """一次读回全部行(含 drift)—— 🔴 夹具行与控制组必须**在同一次读里**取,
       否则「别的行是 ok」可能只是读在了另一个时刻。"""
    return await pg.evaluate(
        """async () => {
             const res = await fetch('/api/workflow?withDrift=1', {credentials:'include'});
             const d = await res.json();
             const rows = Array.isArray(d) ? d : ((d && d.data) || []);
             return rows.map(x => ({name:x.name, cron:x.cronExpression||null, drift:x.carrierDrift??null}));
           }""")


def states_of(row):
    return list((row or {}).get("drift", {}).values()) if (row or {}).get("drift") else []


def fmt(rows, victim):
    out = []
    for x in rows:
        if not x["drift"]:
            continue
        tag = "◀ 夹具" if x["name"] == victim else ""
        st = {k: v.get("state") for k, v in x["drift"].items()}
        out.append(f"     {x['name'][:34]:36s} cron={str(x['cron'])[:12]:13s} {json.dumps(st)} {tag}")
    return "\n".join(out)


async def main():
    v = find_victim()
    if not v:
        print("🔴 找不到可用的验收残留工作流(残留前缀 + 已发布 + 有 cron)⇒ 这次验不了判别力,不许当成通过")
        return
    print(f"夹具对象(验收残留,非示范):{v['name']} · 原 cron={v['cron']!r}")
    assert NEVER not in v["name"], "拒绝:夹具落到了示范对象上"

    verdicts = []   # (是否成立, 这一条判的是什么)
    sess = boto3.Session(profile_name="temp-account", region_name="us-east-1")
    base = m33.cfn_out(sess.client("cloudformation"), "BgpPlatformStack", "PlatformUrl").rstrip("/")
    pw = m33.admin_pw("temp-account")
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1680, "height": 1000}, locale="zh-CN")
        pg = await ctx.new_page()
        assert await m33.do_login(pg, base, pw)
        await pg.goto(f"{base}/monitor", wait_until="domcontentloaded", timeout=60000)
        await pg.wait_for_timeout(2000)

        rows0 = await read_all(pg)
        b4 = next((x for x in rows0 if x["name"] == v["name"]), None)
        print(f"\n① 改之前:\n{fmt(rows0, v['name'])}")
        s0 = states_of(b4)
        ok0 = bool(s0) and all(x.get("state") == "ok" for x in s0)
        verdicts.append((ok0, "① 改之前夹具行是 ok(否则「改后 stale」可能是恒 stale)"))
        if not ok0:
            print(f"   🔴 夹具行改之前就不是 ok({json.dumps(s0, ensure_ascii=False)[:200]})"
                  f" ⇒ 这个对象证不了判别力")

        new_cron = "7 7 * * *" if (v["cron"] or "") != "7 7 * * *" else "9 9 * * *"
        try:
            set_cron(v, new_cron)
            print(f"\n② 把 DDB 上的 cron 改成 {new_cron!r}(**不重发载体** ⇒ 已发布定义里的 schedule 还是旧的)")
            await pg.wait_for_timeout(1500)
            rows1 = await read_all(pg)
            af = next((x for x in rows1 if x["name"] == v["name"]), None)
            print(f"\n③ 改之后:\n{fmt(rows1, v['name'])}")

            # ② 夹具自己的判据:接口真的读到了我改的值
            seen = (af or {}).get("cron")
            verdicts.append((seen == new_cron,
                             f"② 接口真的读到了改后的 cron(读到 {seen!r},期待 {new_cron!r})"))
            # ③ 夹具行必须 stale
            s1 = states_of(af)
            got_stale = any(x.get("state") == "stale" for x in s1)
            verdicts.append((got_stale, "③ 定义落后时判成 stale"))
            if s1:
                print(f"   夹具行明细:{json.dumps(s1, ensure_ascii=False)[:400]}")
            # ④ 负向控制组:同一次读里别的已发布行仍是 ok
            others = [x for x in rows1 if x["drift"] and x["name"] != v["name"]]
            bad = [(x["name"], {k: q.get("state") for k, q in x["drift"].items()})
                   for x in others if any(q.get("state") != "ok" for q in x["drift"].values())]
            verdicts.append((bool(others) and not bad,
                             f"④ 负向控制:同一次读里另 {len(others)} 行已发布载体仍全是 ok"
                             f"{'' if not bad else ' ⇒ 变红的:' + json.dumps(bad, ensure_ascii=False)[:200]}"))
        finally:
            set_cron(v, v["cron"] or new_cron)
            back = read_cron(v)
            print(f"\n④ 还原:cron={back!r} ⇒ {'✅ 与原值一致' if back == v['cron'] else '🔴🔴 还原失败,必须人工核对'}")
            rows2 = await read_all(pg)
            fin = next((x for x in rows2 if x["name"] == v["name"]), None)
            s2 = states_of(fin)
            back_ok = bool(s2) and all(x.get("state") == "ok" for x in s2)
            print(f"⑤ 还原后夹具行 drift={json.dumps((fin or {}).get('drift'), ensure_ascii=False)} ⇒ "
                  f"{'✅ 回到 ok(收口:夹具没留下副作用)' if back_ok else '🔴 没回到 ok,要查'}")
            verdicts.append((back_ok, "⑤ 还原后回到 ok(同一对象两种状态都出现过 ⇒ 真判别力 + 夹具无副作用)"))

    print("\n" + "─" * 72)
    for ok, what in verdicts:
        print(f"  {'✅' if ok else '🔴'} {what}")
    allok = all(ok for ok, _ in verdicts)
    print("─" * 72)
    print("✅✅ **载体落后判别力端到端成立**:同一个对象,定义落后判 stale、还原后判 ok,且没被动的行不受影响"
          if allok else
          "🔴🔴 判别力**未坐实** —— 上面任一条红就不许把这条机制说成「能用」")
    sys.exit(0 if allok else 1)

asyncio.run(main())
