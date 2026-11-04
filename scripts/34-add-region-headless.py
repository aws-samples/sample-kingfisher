#!/usr/bin/env python3
"""
34-add-region-headless.py —— **用页面向导**在一个新 region 里从零拉起执行环境(注册 → 部署 → 放行 →
检测初始化 → 启用),幂等,可复用。

    python3 scripts/34-add-region-headless.py --profile temp-account --region us-west-2
      [--components redshift,dms,flink,airflow-serverless] [--home-region us-east-1]
      [--no-enable-region]        # 不自动跑 redeploy-platform 放行(默认会跑)
      [--build-budget 3900] [--shots qa-game/shots-addregion]

🔴 为什么必须在仓里(用户 2026-09-19:「脚本也要沉淀保存,不能只是放到临时目录,我们后面可以快速通过
  无头浏览器拉起来环境和快速进行无头浏览器验证」):临时账号常常只能用 3 天,而「第二个区」这一步
  以前只存在于**不入库**的验收段里 ⇒ 换账号就得从头手搓,手搓的每一步都是新的出错机会。

🔴 为什么走**页面向导**而不是直接打 API:用户看到的是向导页面。只有页面驱动才能发现「注册成功但
  自动触发部署失败」「探活红了页面却不说真因」这类缺陷 —— 接口全对、页面不可用的事本仓栽过两次。

🔴 三步缺一不可(2026-09-19 再次实证,顺序写死在本脚本里):
   ① 向导注册 + 自动触发 CodeBuild(该 region 的 6 个栈)
   ② **控制面放行该 region**:平台 IAM 的 `aws:RequestedRegion` 条件是**部署时静态**写进策略的,
      不放行就会在「检测初始化」被平台自己的 IAM 拒(向导 Step3 会当场把这句话和运维命令贴出来)。
      放行清单由 `redeploy-platform.sh` **从注册表推导** ⇒ 必须在①之后跑。
      起:该区若已是安装 / 升级时预授权的候选区(列表接口 controlPlaneRegionEnabled=true),本步**自动跳过**。
      🔴 顺序还有一层:放行要等 CodeBuild **跑完**再做 —— `redeploy-platform` 会顺手刷新
      `BgpExecEnvDeployStack`(CodeBuild 项目本身),在构建中途改它是自找麻烦。
   ③ 页面「检测初始化」全绿 → 页面「启用」⇒ status=active,才开始承接下推。

退出码:0 = 该 region 已 active;非 0 = 卡在哪一步会打出来(含页面原文)。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kf_headless_lib as L  # noqa: E402

try:
    import boto3
except ImportError:  # pragma: no cover
    sys.exit("需要 boto3:pip install boto3")
try:
    from playwright.async_api import async_playwright
except ImportError:  # pragma: no cover
    sys.exit("需要 playwright:pip install playwright && playwright install chromium")

TERMINAL = {"SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"}

# 🔴 默认组件**必须含 `airflow-serverless`**(2026-09-16 血的教训):经典 MWAA 在已停止提供,
#   写 `mwaa` 等于一个调度组件都没装上 ⇒ 那个区没有编排/调度载体,而症状会散成 20+ 条互不相干的红。
DEFAULT_COMPONENTS = ["redshift", "dms", "flink", "airflow-serverless"]

JS_FETCH = """
async ([path, method, body]) => {
  const init = { method, headers: {} };
  if (body !== null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(path, init);
  let t = ''; try { t = await r.text(); } catch (e) { t = '(no body)'; }
  return { status: r.status, body: t.slice(0, 200000) };
}
"""


async def api(pg, path: str, method: str = "GET", body=None) -> dict:
    """借页面的会话打平台 API(只用来**读真值**,所有动作都走页面按钮)。"""
    r = await pg.evaluate(JS_FETCH, [path, method, body])
    try:
        j = json.loads(r["body"])
    except Exception:
        j = {"__raw": r["body"][:400]}
    return {"status": r["status"], "json": j}


def data_of(res: dict):
    j = res.get("json") or {}
    return j.get("data") if isinstance(j, dict) and "data" in j else j


async def messages(pg) -> str:
    try:
        return await pg.locator(".ant-message").inner_text()
    except Exception:
        return ""


async def list_targets(pg) -> list[dict]:
    r = await api(pg, "/api/admin/exec-envs")
    d = data_of(r)
    rows = d if isinstance(d, list) else (d or {}).get("items") or []
    return [x for x in rows if isinstance(x, dict)]


def pick(rows: list[dict], region: str) -> dict | None:
    for r in rows:
        if r.get("region") == region and not r.get("isHome") and r.get("targetId") != L.HOME:
            return r
    return None


async def open_drawer(pg, base: str, tid: str):
    """打开某个执行环境的详情抽屉(卡片列表里逐个点,直到抽屉里出现它的 targetId)。"""
    await pg.goto(f"{base}/exec-envs", wait_until="domcontentloaded", timeout=60000)
    await pg.wait_for_timeout(3000)
    cards = pg.locator(f"text={tid}")
    n = await cards.count()
    for i in range(max(1, n)):
        try:
            await cards.nth(i).click(timeout=8000)
        except Exception:
            continue
        await pg.wait_for_timeout(2000)
        d = pg.locator(".ant-drawer").filter(has_text=tid)
        if await d.count():
            return d
    return pg.locator(".ant-drawer").filter(has_text=tid)


def run_redeploy(profile: str, home_region: str) -> tuple[bool, str]:
    """跑 `scripts/redeploy-platform.sh` 放行该 region(放行清单由它从注册表推导,不靠人传 -c)。"""
    cmd = [os.path.join(HERE, "redeploy-platform.sh"), profile, home_region]
    L.log(f"[addregion] 放行该 region:{' '.join(cmd)}(约 10–15 分钟)")
    p = subprocess.run(cmd, cwd=os.path.dirname(HERE), capture_output=True, text=True)
    tail = (p.stdout or "")[-1200:] + (p.stderr or "")[-600:]
    # 🔴 读**机读裁决行**,不 grep 中文话术(话术改一个字就会静默判错)。
    #   `env-blocked` = IAM 模拟门没有真红,只有若干行**在本账号里验不了**(被账号所在组织的 SCP 拦住;或:放行清单已覆盖
    #   本账号能挑出的每一个区 ⇒ any-region 轴没有探测区)⇒ 放行这件事是成功的
    #   (那不是那些 region 的属性,也不是平台缺权;换账号必复验)。判成失败就等于「某个区永久不可用」。
    verdict = ""
    for line in (p.stdout or "").splitlines():
        if line.startswith("[redeploy] IAM_GATE_VERDICT="):
            verdict = line.split("=", 1)[1].strip()
    ok = p.returncode == 0 and verdict in ("green", "env-blocked")
    if verdict == "env-blocked":
        L.log("[addregion] ⚠️ IAM 模拟门有若干行在本账号里验不了(组织 SCP / any-region 轴无探测区)—— 放行本身成功,但那几行**不算过关**")
    return ok, tail


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="temp-account")
    ap.add_argument("--region", required=True, help="要装执行环境的 region(如 us-west-2)")
    ap.add_argument("--home-region", default=os.environ.get("KF_HOME_REGION", "us-east-1"))
    ap.add_argument("--components", default=",".join(DEFAULT_COMPONENTS),
                    help="期望的组件集(只用来与向导只读清单比对;实际组件由产品按法域决定,不能勾选)")
    ap.add_argument("--no-enable-region", action="store_true",
                    help="不自动跑 redeploy-platform 放行(那你必须自己跑,否则「检测初始化」必被平台自己的 IAM 拒)")
    ap.add_argument("--build-budget", type=int, default=int(os.environ.get("KF_INIT_BUILD_BUDGET", "3900")))
    ap.add_argument("--shots", default="qa-game/shots-addregion")
    a = ap.parse_args()
    want = [x.strip() for x in a.components.split(",") if x.strip()]

    sess = boto3.Session(profile_name=a.profile, region_name=a.home_region)
    base = L.platform_base(a.profile, a.home_region)
    ddb = sess.client("dynamodb")
    L.log(f"[addregion] 平台 {base} · 目标 region={a.region} · 组件={['core'] + want}")

    # 幂等:该 region 已有 active 环境 ⇒ 直接成功返回(一个 region 只允许一套,产品会 409)
    for row in L.registry(ddb, only_active=False):
        if row["region"] == a.region and row["targetId"] != L.HOME:
            if row["status"] == "active":
                L.log(f"[addregion] ✅ {a.region} 已有 active 执行环境 {row['targetId']}(组件 {row['components']})⇒ 无需再建")
                return 0
            L.log(f"[addregion] {a.region} 已有 {row['targetId']}(status={row['status']})⇒ 从「等构建 → 检测初始化 → 启用」续跑")

    pw = L.admin_pw(a.profile)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1680, "height": 1000}, locale="zh-CN")
        pg = await ctx.new_page()
        if not await L.do_login(pg, base, pw):
            sys.exit("登录失败(口令对吗?平台在预热?)")
        L.log("[addregion] 登录成功")

        t2 = pick(await list_targets(pg), a.region)

        # ── ① 向导注册 + 自动触发部署 ──────────────────────────────────────
        if t2 is None:
            await pg.goto(f"{base}/exec-envs", wait_until="domcontentloaded", timeout=60000)
            await pg.wait_for_timeout(3000)
            await pg.locator('[data-testid="exec-env-new-btn"]').first.click(timeout=15000)
            await pg.wait_for_timeout(1500)
            modal = pg.locator(".ant-modal").filter(has_text="新建执行环境")
            # Step1:选 region(Select 支持搜索 ⇒ 打字 + 回车,不去点虚拟滚动的下拉项)
            # 🔴 先等 region 清单**真的到了**再打字(2026-10-14 …4400 全新账号实证:清单由服务端现查
            #   ec2 describe-regions,冷账号要 2–3 s;向导刚开就打字回车,下拉还是空的 ⇒ 什么都没选中,
            #   整轮重建在这一步白停)。「清单到了」的载体 = 「账号已启用 N 个 region · 查询于 …」这行
            #   (data-testid=wizard-region-source),它只在 regionQueriedAt 置值后才渲染;30 s 读不到 ⇒ 如实报错,不猜。
            src = modal.locator('[data-testid="wizard-region-source"]').filter(has_text="region")
            try:
                await src.wait_for(state="visible", timeout=30000)
            except Exception:
                await L.shot(pg, a.shots, "addregion-00-step1-noregions")
                sys.exit(f"向导 Step1 的 region 清单 30 s 内没加载出来;页面原文:{(await modal.inner_text())[:300]}")
            # 页面在选区那一刻就说「控制面已放行 N 个区」;下拉项标「已放行,建完即可用」/「构建后需运维放行一次」。
            #   把这两处页面原文记进日志(页面证据;候选区预授权的可见性判据)。
            pre = modal.locator('[data-testid="wizard-region-preauth"]')
            L.log(f"[addregion] 向导放行说明:{(await pre.inner_text()) if await pre.count() else '(本版页面没有 wizard-region-preauth)'}")
            await modal.locator(".ant-select").first.click(timeout=8000)
            await pg.keyboard.type(a.region)
            await pg.wait_for_timeout(900)
            opt = pg.locator(".ant-select-item-option").filter(has_text=a.region)
            L.log(f"[addregion] 下拉项原文:{(await opt.first.inner_text()) if await opt.count() else '(没搜到该区的下拉项)'}")
            await pg.keyboard.press("Escape")
            await pg.wait_for_timeout(500)
            step0 = ""
            for attempt in (1, 2):
                await modal.locator(".ant-select").first.click(timeout=8000)
                await pg.keyboard.type(a.region)
                await pg.wait_for_timeout(700)
                await pg.keyboard.press("Enter")
                await pg.wait_for_timeout(800)
                step0 = await modal.inner_text()
                if a.region in step0:
                    break
                L.log(f"[addregion] ⚠️ 第 {attempt} 次打字回车没选中 {a.region}" + ("" if attempt == 2 else ",重试一次"))
                await pg.keyboard.press("Escape")
                await pg.wait_for_timeout(600)
            if a.region not in step0:
                await L.shot(pg, a.shots, "addregion-00-step1-bad")
                sys.exit(f"向导 Step1 没选中 {a.region};页面原文:{step0[:300]}")
            await L.shot(pg, a.shots, "addregion-00-step1")
            await L.click_btn(modal, "下一步", "Next")
            await pg.wait_for_timeout(1200)
            # Step2:是**只读完整组件清单**(每区必装完整集,没有勾选)⇒ 只读出清单
            #        并与期望集比对;少了哪个就如实记下来(那个区会缺相应能力)。组件按 data-testid 认,不靠本地化标签。
            ro = modal.locator("[data-testid=wizard-components-readonly]")
            shown = []
            rows = ro.locator("[data-testid^=wizard-component-]")
            for i in range(await rows.count()):
                shown.append((await rows.nth(i).get_attribute("data-testid")).replace("wizard-component-", ""))
            missing = [k for k in ["core"] + want if k not in shown]
            L.log(f"[addregion] 向导只读组件清单 = {shown}")
            await L.shot(pg, a.shots, "addregion-01-step2")
            if missing:
                L.log(f"[addregion] ⚠️ 只读清单里没有:{missing}(那个区会缺相应能力,如实记下来)")
            await L.click_btn(modal, "下一步", "Next")
            await pg.wait_for_timeout(1200)
            await L.shot(pg, a.shots, "addregion-02-step3")
            await L.click_btn(modal, "开始部署", "Start deploy")
            outcome = ""
            for _ in range(40):
                await pg.wait_for_timeout(1000)
                mt = (await modal.inner_text()) if await modal.count() else ""
                ms = await messages(pg)
                if "部署进行中" in mt or "失败" in ms or "失败" in mt:
                    outcome = f"{mt}\n[message] {ms}"
                    break
            await L.shot(pg, a.shots, "addregion-03-after-start")
            try:
                await pg.keyboard.press("Escape")
            except Exception:
                pass
            t2 = pick(await list_targets(pg), a.region)
            if t2 is None:
                L.log(f"[addregion] ❌ 向导「开始部署」之后注册表里还是没有这个区;页面原文:{outcome[:500]}")
                return 1
            L.log(f"[addregion] 已注册 {t2.get('targetId')} status={t2.get('status')} "
                  f"components={sorted(t2.get('components') or [])} buildId={t2.get('lastBuildId')}")
            if "控制面尚未放行" in outcome:
                L.log("[addregion] 页面已明示:控制面还没放行该 region —— 本脚本第 ② 步会处理")

        tid = t2["targetId"]
        # 该区是否已被控制面放行(安装 / 升级时预授权的候选区)—— 列表接口逐 target 带 controlPlaneRegionEnabled。
        #   已放行 ⇒ 第 ② 步**跳过**(再跑 redeploy 只是白滚一次 ECS);未放行 ⇒ 照旧放行。两种情形都把判断依据打出来。
        region_enabled = t2.get("controlPlaneRegionEnabled")
        L.log(f"[addregion] 控制面对 {a.region} 的放行状态(列表接口 controlPlaneRegionEnabled)= {region_enabled}")

        # 没拿到 buildId(向导自动触发失败)⇒ 走详情页「触发部署」这条人工续跑口
        build_id = t2.get("lastBuildId")
        if not build_id:
            d = await open_drawer(pg, base, tid)
            if await L.click_btn(d, "触发部署", "Trigger deploy"):
                for _ in range(20):
                    await pg.wait_for_timeout(1500)
                    ms = await messages(pg)
                    if ms and ("已触发" in ms or "失败" in ms or "拒" in ms):
                        break
                t2 = pick(await list_targets(pg), a.region) or t2
                build_id = t2.get("lastBuildId")
            await L.shot(pg, a.shots, "addregion-03b-trigger")
            try:
                await pg.keyboard.press("Escape")
            except Exception:
                pass

        # ── 等 CodeBuild 终态 ──────────────────────────────────────────────
        phase, stacks = "none", []
        if t2.get("status") != "active":
            t0 = time.time()
            while time.time() - t0 < a.build_budget:
                q = f"?buildId={build_id}" if build_id else ""
                d = data_of(await api(pg, f"/api/admin/exec-envs/{tid}/build-status{q}")) or {}
                phase = d.get("phase", "?")
                stacks = d.get("stacks") or []
                if phase in TERMINAL:
                    break
                if int(time.time() - t0) % 120 < 16:
                    L.log(f"[addregion] build {build_id} phase={phase} "
                          f"stacks={[(s.get('name'), s.get('status')) for s in stacks]}")
                await pg.wait_for_timeout(15000)
            await L.shot(pg, a.shots, "addregion-04-build")
            stack_ok = bool(stacks) and all(
                str(s.get("status")).endswith("_COMPLETE") and "ROLLBACK" not in str(s.get("status")) for s in stacks)
            L.log(f"[addregion] 构建终态 phase={phase} 栈={[(s.get('name'), s.get('status')) for s in stacks]}")
            if phase != "SUCCEEDED" or not stack_ok:
                return 1

        # ── ② 控制面放行该 region(必须在构建之后、检测初始化之前)──────────────
        #   候选区内的区构建完就已放行(IAM 条件在安装 / 升级时就含它)⇒ 不跑 redeploy,直接进第 ③ 步;
        #   复核以构建后的列表接口为准(不是注册那一刻的值)。
        t2 = pick(await list_targets(pg), a.region) or t2
        region_enabled = t2.get("controlPlaneRegionEnabled")
        if region_enabled is True:
            L.log("[addregion] ✅ 控制面已预授权该 region(候选区)⇒ 跳过放行,不滚 ECS,直接「检测初始化」")
        elif not a.no_enable_region:
            await ctx.close()
            await b.close()
            ok, tail = run_redeploy(a.profile, a.home_region)
            L.log(f"[addregion] 放行 {'✅' if ok else '❌'};redeploy 尾巴:\n{tail[-700:]}")
            if not ok:
                return 1
            # ECS 刚滚过一遍 ⇒ 重新起浏览器会话(旧页面可能拿到 502/陈旧 bundle)
            b = await p.chromium.launch(args=["--no-sandbox"])
            ctx = await b.new_context(viewport={"width": 1680, "height": 1000}, locale="zh-CN")
            pg = await ctx.new_page()
            if not await L.do_login(pg, base, pw):
                sys.exit("放行后重新登录失败(ECS 还在滚?稍后重跑本脚本即可,它是幂等的)")
        else:
            L.log("[addregion] ⚠️ 跳过放行(--no-enable-region):你必须自己跑 "
                  "`scripts/redeploy-platform.sh`,否则「检测初始化」会被平台自己的 IAM 拒")

        # ── ③ 页面「检测初始化」→「启用」────────────────────────────────────
        d = await open_drawer(pg, base, tid)
        await L.shot(pg, a.shots, "addregion-05-drawer")
        if not await L.click_btn(d, "检测初始化", "Probe", "Detect"):
            L.log("[addregion] ❌ 抽屉里找不到「检测初始化」按钮")
            return 1
        probe = None
        for _ in range(24):
            await pg.wait_for_timeout(5000)
            t2 = data_of(await api(pg, f"/api/admin/exec-envs/{tid}")) or t2
            probe = t2.get("probe")
            if probe and probe.get("at"):
                break
        await pg.wait_for_timeout(1500)
        await L.shot(pg, a.shots, "addregion-06-probe")
        items = (probe or {}).get("items") or []
        bad = [(i.get("name"), (i.get("error") or "")[:160]) for i in items if not i.get("ok")]
        has_reg = await d.locator("[data-testid=region-not-enabled]").count() > 0
        has_fin = await d.locator("[data-testid=finalize-error]").count() > 0
        L.log(f"[addregion] 检测初始化 ok={(probe or {}).get('ok')} 项数={len(items)} 红项={bad} "
              f"region-not-enabled={has_reg} finalize-error={has_fin}")
        if not (probe and probe.get("ok")):
            if has_reg:
                L.log("[addregion] ❌ 页面说控制面仍未放行该 region ⇒ 跑 "
                      f"`scripts/redeploy-platform.sh {a.profile} {a.home_region}` 后重跑本脚本")
            return 1
        # 🔴 「启用」只对 status=testing(相位 verifying)开放;探活全绿 ≠ 相位已推进 —— 完成序(reconcileAfterProbe)还要
        #   「探活精确覆盖声明组件」等栅栏。就是:18 项全绿、按钮在但**灰**,相位停在 provisioning。
        #   判据必须等那件事真发生(status 变 testing)再点;等不到就把 status 与抽屉标题原文记下来,别把「灰」报成「找不到」。
        status_after = None
        for _ in range(12):
            t2 = data_of(await api(pg, f"/api/admin/exec-envs/{tid}")) or t2
            status_after = t2.get("status")
            if status_after in ("testing", "active"):
                break
            await pg.wait_for_timeout(5000)
        L.log(f"[addregion] 探活后注册表 status={status_after}(「启用」要求 testing)")
        if status_after not in ("testing", "active"):
            head = (await d.locator(".ant-drawer-header").first.inner_text()).strip()[:120] if await d.locator(".ant-drawer-header").count() else "?"
            L.log(f"[addregion] ❌ 探活全绿但相位没推进到 testing(抽屉标题「{head}」)⇒ 这是产品的完成序没过栅栏"
                  "(看审计 exec-env.probe 的 reconcileAdvanced / 平台日志),不是放行问题;修好重跑本脚本即可续跑")
            return 1
        enable_btn = d.locator("button", has_text="启用").first
        if not await enable_btn.count():
            enable_btn = d.locator("button", has_text="Enable").first
        if not await enable_btn.count():
            L.log("[addregion] ❌ 抽屉里没有「启用」按钮(DOM 里一个都没有)")
            return 1
        if await enable_btn.is_disabled():
            L.log(f"[addregion] ❌ 「启用」按钮在但被禁用(status={status_after})⇒ 产品前置未满足,不是判据找不到")
            return 1
        await enable_btn.click(timeout=15000)
        await pg.wait_for_timeout(4000)
        t2 = data_of(await api(pg, f"/api/admin/exec-envs/{tid}")) or t2
        await L.shot(pg, a.shots, "addregion-07-enabled")
        L.log(f"[addregion] 启用后 status={t2.get('status')}")
        await ctx.close()
        await b.close()

    if t2.get("status") != "active":
        return 1
    L.log(f"[addregion] ✅ {a.region} 的执行环境 {tid} 已 active,可承接下推。"
          f"下一步:./scripts/23-seed-game-region.sh {a.profile} {tid} 然后 "
          f"./scripts/32-verify-all-regions.sh {a.profile} {a.home_region}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
