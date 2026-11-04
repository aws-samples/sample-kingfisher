#!/usr/bin/env python3
"""37-fixture-reseal.py —— **示范对象的载体收口**(幂等,可反复跑)。

    python3 scripts/37-fixture-reseal.py [--profile temp-account]

🔴🔴 **为什么它必须在仓里**(2026-09-22 用户原话:「你真是丢三落四,这个问题我提醒你 N 次了,
   每次都有一样的问题」):我当天刚说完 `/tmp/sync_pointers.py` 在 /tmp、**换机器就没了**
   是老毛病,**转头就把这个收口脚本也写在了 /tmp** —— 同一个错、同一天、第二次。
   凡「以后还会再用一次」的能力,一律进 `scripts/`;`/tmp` 只放这一次性的一次性诊断。
   同族:`36-fixture-ledger.py`(夹具台账,删必须逐个指名)。

原始缘由
========
收口:把两个示范工作流的**载体**重新发布,让它与当前定义一致。

🔴 为什么要这个脚本(2026-09-22 02:2x):无头判据 `2d` 被 `timeout 1500` 杀在
   「还原 cron 之后再发一次」之前 ⇒ DDB 是原值 `0 3 * * *`,而 MSAF 上的定义还是夹具的
   `7 7 * * *` ⇒ 产品**正确地**判成 `stale`。
   **产品没问题,是我的夹具没收口。** 本仓纪律:判据不许留下副作用。

🔴 教训(已写进台账):夹具的还原只放在 `finally` 里**不够** —— 进程被 SIGTERM 杀掉时
   `finally` 不保证跑完。凡「改了真环境状态」的判据,都要有一个**独立的、幂等的收口脚本**,
   而且收口断言要断**最终状态**(载体与定义一致),不是断「我执行过还原动作」。

做法:走产品自己的重发通道 `POST /api/workflow/{id}/publish`(与界面上那个按钮同一条路),
     然后复读 `?withDrift=1` 确认回到 `ok`。**只碰 `Showcase-*-Flow-ROI-Daily` 两个对象。**
"""
import asyncio, sys, json, importlib.util, time
sys.path.insert(0, "/home/ec2-user/kf-deploy-from-github/scripts")
spec = importlib.util.spec_from_file_location("m33", "/home/ec2-user/kf-deploy-from-github/scripts/33-verify-regions-headless.py")
m33 = importlib.util.module_from_spec(spec); spec.loader.exec_module(m33)
import boto3
from playwright.async_api import async_playwright

# 🔴 **闭合式**:不列「要收哪几个对象」(那必然漏掉第 N+1 个),而是收口**所有** drift 非 `ok`
#   的已发布工作流 —— 「载体上的定义落后于当前定义」本来就没有正当情形,一律该重发。
#   第一版写死了两个示范对象名,当天就漏掉了被夹具改过的那个**残留**对象。


async def rows(pg):
    return await pg.evaluate(
        """async () => {
             const res = await fetch('/api/workflow?withDrift=1', {credentials:'include'});
             const d = await res.json();
             const a = Array.isArray(d) ? d : ((d && d.data) || []);
             return a.map(x => ({id:x.workflowId, name:x.name, cron:x.cronExpression||null, drift:x.carrierDrift??null}));
           }""")


def states(r):
    return {k: (v or {}).get("state") for k, v in ((r or {}).get("drift") or {}).items()}


async def main():
    sess = boto3.Session(profile_name="temp-account", region_name="us-east-1")
    base = m33.cfn_out(sess.client("cloudformation"), "BgpPlatformStack", "PlatformUrl").rstrip("/")
    pw = m33.admin_pw("temp-account")
    bad = 0
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1680, "height": 1000}, locale="zh-CN")
        pg = await ctx.new_page()
        assert await m33.do_login(pg, base, pw)
        await pg.goto(f"{base}/monitor", wait_until="domcontentloaded", timeout=60000)
        await pg.wait_for_timeout(1500)

        before = await rows(pg)
        published = [x for x in before if states(x)]
        need = [x for x in published if any(v != "ok" for v in states(x).values())]
        print(f"① 已发布载体 {len(published)} 个 · 需要收口(drift 非 ok)的 {len(need)} 个")
        for r in published:
            mark = "← 要收口" if r in need else ""
            print(f"   {r['name'][:38]:40s} cron={str(r['cron'])[:12]:13s} "
                  f"{json.dumps(states(r), ensure_ascii=False)} {mark}")
        if not need:
            print("\n✅ 所有已发布载体都与当前定义一致,无需收口(幂等)")
            sys.exit(0)
        WANT = [x["name"] for x in need]

        for r in need:
            nm = r["name"]
            out = await pg.evaluate(
                """async (id) => {
                     const res = await fetch(`/api/workflow/${id}/publish`, {method:'POST', credentials:'include'});
                     let d = {}; try { d = await res.json(); } catch (e) {}
                     return { status: res.status, ok: d && d.success === true, partial: !!(d && d.partial),
                              perTarget: (d && d.perTarget) || [], err: (d && d.error) || null };
                   }""", r["id"])
            print(f"② 重发 {nm}: HTTP {out['status']} success={out['ok']} partial={out['partial']} "
                  f"perTarget={json.dumps(out['perTarget'], ensure_ascii=False)[:180]}"
                  + (f" err={out['err']}" if out["err"] else ""))
            if not out["ok"] or out["partial"]:
                bad += 1

        # 🔴 收口断言 = **最终状态**,不是「我执行过还原动作」。等到 ok 为止(有预算)。
        deadline = time.time() + 300
        while time.time() < deadline:
            now = await rows(pg)
            picks = [next((x for x in now if x["name"] == nm), None) for nm in WANT]
            if all(p and states(p) and all(v == "ok" for v in states(p).values()) for p in picks):
                break
            await pg.wait_for_timeout(8000)
        now = await rows(pg)
        print()
        for nm in WANT:
            r = next((x for x in now if x["name"] == nm), None)
            st = states(r)
            good = bool(st) and all(v == "ok" for v in st.values())
            if not good:
                bad += 1
            print(f"{'✅' if good else '🔴'} ③ 收口后 {nm}: cron={r and r['cron']!r} "
                  f"drift={json.dumps(st, ensure_ascii=False)}")
    print("\n" + ("✅ 全部已发布载体都与当前定义一致(夹具副作用已清)"
                  if not bad else f"🔴 还有 {bad} 处没收口,必须继续查"))
    sys.exit(1 if bad else 0)

asyncio.run(main())
