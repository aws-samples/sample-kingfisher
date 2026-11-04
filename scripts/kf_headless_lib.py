#!/usr/bin/env python3
"""
kf_headless_lib.py —— 仓内**无头浏览器**脚本的共用底座(登录 / 带执行范围开页 / 点控件 / 判据台账)。

🔴 为什么在 `scripts/` 而不是 `qa-game/verify/`:`qa-game/` 本机专用、**不入库**。而用户 2026-09-19
  的要求是「脚本也要沉淀保存,不能只是放到临时目录,后面可以快速通过无头浏览器拉起来环境和快速验证」
  ⇒ 凡「换账号后还要再用一次」的东西必须在仓里、`git clone` 之后就能跑,只需要
  `pip install boto3 playwright && playwright install chromium` 加一份 admin 口令。

🔴 单一作者:登录、`?scope=` 开页、等页面落定、点 antd 控件这几件事只有这一份实现。
  以前 33 号脚本自己带一份、加区脚本再抄一份 ⇒ 同一个坑(antd 的 Radio.Button 不是 button、
  首次进站的导览遮罩、出站 IP 决定语种)要修两遍,而漏修的那一份就是下一次假红。
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

try:
    import boto3
except ImportError:  # pragma: no cover
    sys.exit("需要 boto3:pip install boto3")

HOME = "tgt_home"
ACTIVE = ("active", "ready", "in-service", "running", "legacy-seeded")
SUCCESS_WORDS = ("成功", "Success", "success", "succeeded", "SUCCEEDED")

# 🔴 `/schedule` 只是兼容跳转(`router.replace("/monitor?tab=schedule")`),而 replace **不带 query**
#   ⇒ `?scope=` 会掉一次,只靠 ScopeProvider 从 localStorage 播种再写回地址栏才救回来。
#   判据不该建立在这种间接前提上,直接打权威路径。
SCHED_PATH = "/monitor?tab=schedule"


def log(m: str) -> None:
    print(m, flush=True)


# ── AWS 侧真值(CFN 输出 / 注册表 / 口令)──────────────────────────────────────
def cfn_out(cf, stack: str, key: str) -> str:
    try:
        for o in cf.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs") or []:
            if o.get("OutputKey") == key:
                return o.get("OutputValue") or ""
    except Exception:
        pass
    return ""


def registry(ddb, only_active: bool = True) -> list[dict]:
    """执行环境注册表(**只在主控区**)。返回 [{targetId, region, status, components, resources}]。"""
    out = []
    for it in ddb.scan(TableName="bgp-execution-envs").get("Items", []):
        g = lambda k: (it.get(k) or {}).get("S") or ""
        if not g("targetId") or not g("region"):
            continue
        if only_active and g("status") not in ACTIVE:
            continue
        res = {k: list(v.values())[0] for k, v in (it.get("resources", {}).get("M") or {}).items() if "S" in v}
        comps = [list(x.values())[0] for x in (it.get("components") or {}).get("L", [])]
        out.append({"targetId": g("targetId"), "region": g("region"), "status": g("status"),
                    "components": comps, "resources": res})
    return sorted(out, key=lambda x: (x["targetId"] != HOME, x["targetId"]))


def pw_file_path(profile: str) -> str:
    """口令落盘位置(与 `scripts/10-bootstrap-cognito.sh` 的 `PW_FILE` 同一口径:按 profile 分文件)。"""
    return os.environ.get("BGP_PW_FILE", f"/tmp/bgp-cognito-pw-{profile}.json")


def merge_pw(file_map: dict, env_json: str = "", env_admin: str = "") -> dict:
    """**纯函数**:把三个来源合成一张口令表,并定义优先级。

    优先级(低 → 高):落盘文件 < `BGP_USER_PW_JSON`(逐用户覆盖)< `BGP_ADMIN_PASSWORD`(只盖 admin)。
    🔴 `BGP_ADMIN_PASSWORD` **只准盖 `admin` 这一个键**:它历史上被当成「全平台统一口令」用,
      而 `deploy-all` 给每个用户生成**各自的**随机口令 ⇒ 拿 admin 的口令去登 biz-tester 必失败,
      而失败会被 Cognito 记成错密码(攒够就把用户临时锁掉,连对的口令也登不进)。
    """
    out = {str(k): str(v) for k, v in (file_map or {}).items() if isinstance(v, str) and v}
    if env_json:
        try:
            out.update({str(k): str(v) for k, v in json.loads(env_json).items() if isinstance(v, str) and v})
        except Exception as e:
            log(f"[kf] ⚠️ BGP_USER_PW_JSON 解析失败({e})⇒ 忽略它,只用落盘文件")
    if env_admin:
        out["admin"] = env_admin
    return out


def user_pw_map(profile: str) -> dict:
    """🔴🔴 **整张口令表的唯一作者**(登录态那一层必须读它,不许自己再写一份)。

    2026-09-20 的代价(同一个根因的第二半):`admin_pw()` 这个作者早就在了,而验收层
    `vlib.USER_PW` 仍自己维护一张表 —— 表里**把 admin 的口令套给五个用户**,而且那五个名字有
    三个(`data-engineer` / `data-analyst` / `developer`)在 Cognito 里**根本不存在**:
    名册也是第二份、也是编的。于是段 `w3e` / `gbc`(用 `biz-tester` 验 viewer 只读)直接崩,
    段 `p51`(用 `pm-tester` 验非 admin)判红,而这三条红看起来像三个独立问题。
      ⇒ 口令**和名册**都只有这一个作者:表里有谁 = 这个环境真有谁(文件由第 11 步落盘)。
    """
    f = pw_file_path(profile)
    try:
        with open(f, encoding="utf-8") as fh:
            file_map = json.load(fh)
    except Exception:
        file_map = {}
    m = merge_pw(file_map, os.environ.get("BGP_USER_PW_JSON", ""), os.environ.get("BGP_ADMIN_PASSWORD", ""))
    if not m:
        sys.exit(f"拿不到任何口令:{f} 读不到,env BGP_USER_PW_JSON / BGP_ADMIN_PASSWORD 也没设"
                 f"(第 11 步 10-bootstrap-cognito.sh 会把五个用户的口令落盘)")
    return m


def serviceable_rows(rows, drop_home: bool = True) -> list:
    """**纯函数**:从注册表/`/api/admin/exec-envs` 的行里筛出**真能承接**的执行目标。

    🔴🔴 这里钉的是一个**被撞了三次**的区分 —— 同一张表,三种口径,绝不能混用:

    | 问句 | 口径 | 用在哪 |
    |---|---|---|
    | 这个区**看得见**吗? | 呈现面(连 registered / 正在装的都要列) | 顶栏、清单页(记忆 scope-view-vs-serviceable) |
    | 这个区**被占了**吗? | 非死状态(registered 也算占位!) | 「一区只许一套」守卫、w5a 落点体检 |
    | 这个区**能承接**吗? | `ACTIVE` —— 本函数 | **判据要拿它当载体的时候** |

    2026-09-20 的代价:`tgt_euw1_a` 状态是 `registered`(注册了,但部署被组织 SCP 拦住、**从来没装出来**),
    而两条判据用「占位口径」去挑载体:
      · 段 `net0` N0-1 遍历所有非死的非 home 目标 ⇒ 「描述符缺 resources.vpcId」(它当然没有,它没装);
      · 段 `journey` J22 的**正控制**取 `others[0]` ⇒ 字典序拿到 euw1 ⇒ 「BgpExecEnv-* 栈数=0」判红,
        而它要证的那件事(home 抽屉不说假话)**页面完全是对的**。
    两条红都不是产品问题,是判据拿了一个没有载体的区当载体。
    🔴 并且刻意**不认任何区域名**(用户 2026-09-19:「不能永久拒绝某一个区域,那只是现在这个临时账号的
      限制,别人的真实账号没有」)—— 换到没有那条 SCP 的账号,那个区装出来就自动成为载体。
    """
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        tid = str(r.get("targetId") or "")
        if not tid:
            continue
        if drop_home and (r.get("isHome") is True or tid == HOME):
            continue
        if str(r.get("status") or "") not in ACTIVE:
            continue
        out.append(r)
    return sorted(out, key=lambda x: str(x.get("targetId")))


def admin_pw(profile: str) -> str:
    m = user_pw_map(profile)
    pw = m.get("admin") or ""
    if not pw:
        sys.exit(f"口令表里没有 admin(有 {sorted(m)});看 {pw_file_path(profile)}")
    return pw


def pick_non_admin(names) -> str:
    """**纯函数**:名册里挑一个稳定的非 admin 用户(按字典序,可复现)。挑不到回空串。

    🔴 为什么不许写死一个名字:段 `p51` 的 M10 默认写了 `pm-tester`,而「名册里有谁」是**环境属性**
      (`scripts/10-bootstrap-cognito.sh` 的 `USERS=(...)` 才是那个作者)—— 写死的名字换个账号就不存在,
      而症状是「非 admin 登录失败」,看起来像权限缺陷。
    """
    cands = sorted(str(n) for n in (names or []) if str(n) and str(n) != "admin")
    return cands[0] if cands else ""


def non_admin_user(profile: str) -> str:
    u = pick_non_admin(user_pw_map(profile).keys())
    if not u:
        sys.exit(f"名册里只有 admin,拿不到非管理员用户;看 {pw_file_path(profile)}")
    return u


def platform_base(profile: str, home_region: str) -> str:
    sess = boto3.Session(profile_name=profile, region_name=home_region)
    base = cfn_out(sess.client("cloudformation"), "BgpPlatformStack", "PlatformUrl").rstrip("/")
    if not base:
        sys.exit("读不到 BgpPlatformStack.PlatformUrl(平台没装?profile / region 对吗?)")
    return base


# ── 页面小工具 ────────────────────────────────────────────────────────────────
async def do_login(pg, base: str, pw: str, user: str = "admin") -> bool:
    """页面登录。失败时**把原因打出来**,而不是只回 False。

    🔴 2026-09-20 的代价:那一轮 30 段全部「登录失败」,而日志只有一句
      「登录失败(口令对吗?平台在预热?)」—— 三种完全不同的原因(口令错 / 平台没起来 /
      Cognito 因反复错密码把用户**临时锁了**)长成同一句话,查根因白花了一轮。
      真根是 `vlib` 读不到 env 就**静默用硬编码口令** ⇒ ~90 次错密码 ⇒ Cognito 限流,
      连**口令正确**的那一相也登不进去。⇒ 失败时把页面上的错误文案 + 非 2xx 响应打出来。
    """
    fails: list[str] = []
    pg.on("response", lambda r: fails.append(f"{r.status} {r.request.method} {r.url[:90]}")
          if r.status >= 400 else None)
    await pg.goto(f"{base}/login", wait_until="networkidle", timeout=60000)
    await pg.wait_for_timeout(2500)
    await pg.locator("input").first.fill(user)
    await pg.locator("input[type=password]").first.fill(pw)
    btn = pg.locator("button[type=submit]")
    if await btn.count() == 0:
        btn = pg.locator("button").filter(has_text="登")
    await btn.first.click()
    for _ in range(15):
        await pg.wait_for_timeout(2000)
        if "/login" not in pg.url:
            # ① 首次进站会自动开导览,遮罩会挡住后面每一次点击 ⇒ 一次性播「已看过」并**清进度**
            #    (只播 seen 是改了一半 —— 那条教训已经付过一次学费)。
            # ② 🔴 语种钉成中文:平台按**出站 IP 的国家**建议语种(美国在英语区),跑验收的机器在
            #    us-east-1 ⇒ 页面会渲染英文。上一轮「治理搜索框是英文占位符」就是这个原因,
            #    而按中文标签找控件会当场找不到。钉死让「点控件」可复现;判据本身仍中英双语都收。
            await pg.evaluate(
                "() => { try { localStorage.setItem('bgp-guide-seen-v1', new Date().toISOString());"
                " localStorage.setItem('bgp-tour-done', JSON.stringify(['dev','admin','analyst']));"
                " localStorage.setItem('bgp-locale', 'zh');"
                " localStorage.removeItem('bgp-tour-progress'); } catch (e) {} }")
            return True
    # 失败:把能说明原因的东西都打出来(页面错误文案往往直接写着 Cognito 的拒因)
    try:
        txt = await pg.evaluate("() => document.body.innerText || ''")
    except Exception:
        txt = ""
    hint = " ".join(txt.split())[:240]
    log(f"[login] ❌ {user} 登录失败 —— 页面停在 {pg.url}")
    if hint:
        log(f"[login]    页面文案:{hint!r}")
    if fails:
        log(f"[login]    非 2xx 响应:{fails[-4:]}")
    log("[login]    🔴 三种原因要分清:① 口令错(检查 /tmp/bgp-cognito-pw-<profile>.json,"
        "别让 BGP_ADMIN_PASSWORD 里的旧值盖掉它)② 平台还没起来 "
        "③ Cognito 因反复错密码**临时锁了这个用户**(等几分钟;而这通常说明前面有脚本在用错口令)")
    return False


async def goto_scope(pg, base: str, path: str, tid: str, settle: str = "", budget_s: int = 30) -> str:
    """带执行范围打开页面,并**等页面落定**再取整页文本。

    🔴 不落定就断言 = 断在渲染中间态:真环境实测过一条「页面文本只有 430 字、清单还没回来」的假红。
    `settle` 给一个「这一页拉到数据就一定会出现」的字符串(如该区的 workgroup 名 / 对象名前缀)。
    """
    sep = "&" if "?" in path else "?"
    await pg.goto(f"{base}{path}{sep}scope={tid}", wait_until="domcontentloaded", timeout=60000)
    await pg.wait_for_timeout(2500)
    try:
        await pg.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    txt = await pg.evaluate("() => document.body.innerText || ''")
    if settle:
        t0 = time.time()
        while settle not in txt and time.time() - t0 < budget_s:
            await pg.wait_for_timeout(1500)
            txt = await pg.evaluate("() => document.body.innerText || ''")
    return txt


async def page_text(pg) -> str:
    return await pg.evaluate("() => document.body.innerText || ''")


async def shot(pg, out_dir: str, name: str) -> None:
    if not out_dir:
        return
    os.makedirs(out_dir, exist_ok=True)
    try:
        await pg.screenshot(path=os.path.join(out_dir, f"{name}.png"))
    except Exception:
        pass


async def click_btn(scope, *labels: str) -> bool:
    """点 `<button>`(按可见文案,给多个候选:中/英)。`scope` 可以是 page 也可以是某个 Locator。"""
    for lb in labels:
        try:
            b = scope.locator("button", has_text=lb).first
            if await b.count():
                await b.click(timeout=15000)
                return True
        except Exception:
            continue
    return False


async def click_radio(scope, *labels: str) -> bool:
    """点 antd 的 Radio.Button。

    🔴 它渲染成 `<label class="ant-radio-button-wrapper">`,**不是 `<button>`** ——
      按 button 找一定找不到(为此白红过一轮,红的是判据不是产品)。
    """
    for lb in labels:
        try:
            r = scope.locator(".ant-radio-button-wrapper").filter(has_text=lb).first
            if await r.count():
                await r.click(timeout=10000)
                return True
        except Exception:
            continue
    return False


async def click_tab(pg, *labels: str) -> str:
    """点 antd Tab(按可见文案)。返回点中的那个文案,没点到回空串。

    🔴 为什么必须点:`/modeling` 默认停在「数仓分层」Tab,码表/维度建模的表格**根本没渲染**
      ⇒ 只读整页 innerText 会把「对象不在」误判成产品缺陷(真踩过)。
    """
    for lb in labels:
        try:
            tab = pg.locator(".ant-tabs-tab", has_text=lb).first
            if await tab.count():
                await tab.click()
                await pg.wait_for_timeout(1800)
                return lb
        except Exception:
            continue
    return ""


async def confirm_popconfirm(pg, budget_ms: int = 8000) -> bool:
    """antd Popconfirm 的「确定」。返回是否真的点到了。

    🔴 两个坑一起堵:
      ① **气泡是异步挂上来的**(带动画)。第一版只等 700ms 就去找 ⇒ 常常没找到、返回 False;
         而更早那一版还更糟:找不到也不吭声,脚本照样打印「已触发」,而 DAG 那边 run 数是 0
         (2026-09-19 实证)。所以这里**轮询**到预算用完,并把「点没点到」当返回值交出去 ——
         乐观 = 判据在说谎。
      ② antd **不卸载**关过的气泡 ⇒ 必须只在**可见**气泡里找(`:visible` 按真实可见性判,
         比猜 `.ant-popover-hidden` 这类类名稳)。
    """
    t0 = time.time()
    while (time.time() - t0) * 1000 < budget_ms:
        try:
            pops = pg.locator(".ant-popover:visible")
            if await pops.count():
                pop = pops.last
                for sel in ("button.ant-btn-primary", "button"):
                    btn = pop.locator(sel).last
                    if await btn.count() and await btn.is_visible():
                        await btn.click(timeout=8000)
                        await pg.wait_for_timeout(1200)
                        return True
        except Exception:
            pass
        await pg.wait_for_timeout(300)
    return False


async def visible_modal(pg, budget_ms: int = 8000):
    """等**可见**的 antd 弹窗出现并返回它;超时返回 None。

    🔴 两个坑:
      ① **本仓这个 antd 版本里没有 `.ant-modal-content` 这个类** —— 弹窗的 DOM 是
         `.ant-modal-root > .ant-modal-wrap > .ant-modal`。找 `.ant-modal-content` 永远是 0,
         于是判据报「弹窗没出现」,而弹窗其实开得好好的(2026-09-19 用 `elementFromPoint` 才看穿:
         盖在目标上的正是 `.ant-modal-wrap`,也就是说**弹窗确实在**)。
         🔴 教训:「找不到元素」先怀疑**选择器指的东西根本不存在**,而不是先怀疑时序。
      ② antd 关过的弹窗留在 DOM 里 ⇒ 必须按 `:visible` 的真实可见性挑,不能盯第一个匹配元素。
    """
    t0 = time.time()
    while (time.time() - t0) * 1000 < budget_ms:
        for sel in (".ant-modal:visible", ".ant-modal-content:visible"):
            try:
                loc = pg.locator(sel)
                if await loc.count():
                    return loc.last
            except Exception:
                pass
        await pg.wait_for_timeout(300)
    return None


async def click_until_modal(pg, target, attempts: int = 3, budget_ms: int = 6000):
    """点一个控件并**核实弹窗真的开了**;没开就再点,最多 attempts 次。返回弹窗 Locator 或 None。

    🔴 为什么要核实再重试:真环境实测到「点击成功返回、但弹窗没开」——同一个元素、同一段代码,
      换一次进站顺序就复现不了。这类瞬时吞点击不值得继续追根因(它不是产品缺陷:同一个按钮
      人点、API 打都正常),但**必须**让判据不因它假红 ⇒ 点了就核实,核实不过就再点。
    """
    for i in range(attempts):
        try:
            await target.click(timeout=10000)
        except Exception:
            pass
        m = await visible_modal(pg, budget_ms)
        if m is not None:
            return m
        await pg.wait_for_timeout(600)
    return None


# 兼容旧名(33 号脚本按这个名字 import)
wait_modal = visible_modal


def row_state(txt: str, name: str, window: int = 220) -> str:
    """取某一行名字之后的一小段文本(判状态用:成功 / Success / succeeded 都算)。"""
    i = txt.find(name)
    return txt[i:i + window] if i >= 0 else ""


def all_windows(txt: str, name: str, window: int = 240) -> list[str]:
    """该名字每一次出现后的一小段(运行实例表按开始时间倒序 ⇒ 第一段是最新那次运行)。"""
    out, i = [], txt.find(name)
    while i >= 0 and len(out) < 12:
        out.append(txt[i:i + window])
        i = txt.find(name, i + 1)
    return out


def has_success(s: str) -> bool:
    return any(w in s for w in SUCCESS_WORDS)


# ── 判据台账 ──────────────────────────────────────────────────────────────────
class Rep:
    """判据台账:每条一行,末尾打总表并决定退出码;可选产出「能力 × 区域 × 执行方式」矩阵。"""

    # 🔴🔴 **7 → 9 类**(补 `realtime` 实时计算 / `genbi` 智能问数)。
    #   立包理由(用户 2026-09-19 连问五句后现形):这张矩阵原来只有七类,**实时计算与智能问数在矩阵
    #   之外** —— 它们只由「自造夹具、验完删净」的硬门段覆盖 ⇒ ① 用户切到那个区看不到一套跑着的对象;
    #   ② 🔴 更深一层:**矩阵里没有的那一类 = 默认豁免**,hook 判据 ⑥ 再严也拦不住清单里没写的东西。
    #   同日代价实证:实时计算在第二个区其实是废的(Kinesis 建流 / 造数 / Flink 日志组三处 IAM 都钉在
    #   部署区,`SimulatePrincipalPolicy` 坐实 us-west-2 全 implicitDeny)—— 没有任何门看得见,
    #   因为「实时」这一格根本不存在。
    #   🔴 本清单与 `.claude/skills/multi-region-gate/gate.py` 的 `REQUIRED_CAPABILITIES`
    #     **必须逐字相等**(只改这一处 = 新两类照旧豁免);由闭合判据
    #     `platform/src/lib/exec-env/__tests__/capability-matrix-lists.test.ts` 钉死。
    CAPS = ("seed", "sync", "etl", "compute", "realtime", "orchestration", "governance", "modeling", "genbi")
    MODES = ("manual", "dispatch")

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []
        self.matrix: dict[str, dict[str, dict[str, str]]] = {}
        # 缺格 → **它自己那条登记项的 id**(判据 ⑥ 逐格点名用;见 emit_matrix 的 gapRegistry)
        self.gap_reg: dict[str, str] = {}

    def add(self, tid: str, name: str, ok: bool, ev: str, gap: bool = False,
            cap: str = "", mode: str = "", reg: str = "") -> None:
        st = "gap" if gap else ("ok" if ok else "fail")
        self.rows.append((tid, name, st, ev))
        if cap:
            # 一格可能被多条判据覆盖:**取最差**(fail > gap > ok)——「有一条过了」不算这一格过
            cur = self.matrix.setdefault(cap, {}).setdefault(tid, {}).get(mode or "manual", "")
            rank = {"": 0, "ok": 1, "gap": 2, "fail": 3}
            self.matrix[cap][tid][mode or "manual"] = st if rank[st] >= rank.get(cur, 0) else cur
        log(f"  {'⚠️' if st == 'gap' else ('✅' if st == 'ok' else '❌')} [{tid}] {name}: {ev}")
        # 🔴🔴 登记项的**机器标记**(2026-09-20 根治「两本台账」):
        #   本类的 `gap` 与验收段 `Reporter.add(passed=None)` 是**同一件事**(如实登记),可盖章步原来
        #   只读验收日志 ⇒ 矩阵这 9 个缺格的登记**结构上进不了章**,于是判据 ⑥ 里「gap 必须有登记」
        #   那半条无从成立(它当时还在拿能力名做子串匹配:`sync` 命中了另一条登记里的文件路径就放行)。
        #   ⇒ 两个作者打同一种机器标记,盖章步两本日志都读;缺格再**逐格点名**自己的 id。
        if st == "gap":
            if cap and not reg:
                # fail-closed:缺格不许匿名。匿名缺格 = 判据 ⑥ 无从核对 = 悄悄放过。
                raise ValueError(f"缺格必须点名自己的登记 id:cap={cap} tid={tid} mode={mode} 判据={name}"
                                 f" —— 给 Rep.add(..., gap=True, reg=\"<ID>\")")
            rid = reg or (name.split() or ["(无id)"])[0]
            if cap:
                self.gap_reg[f"{cap}×{tid}×{mode or 'manual'}"] = rid
            log(f"[REG] {rid} :: [{tid}] {name} {ev}")

    def emit_matrix(self, path: str, targets: list[str], source: str) -> None:
        """写出 Stop hook 判据 ⑥ 要的形状;**缺格如实留空**(hook 把空当「没验过」而不是豁免)。"""
        import datetime
        m = {c: {t: {md: self.matrix.get(c, {}).get(t, {}).get(md, "") for md in self.MODES} for t in targets}
             for c in self.CAPS}
        out = {"at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
               "source": source, "targets": targets, "matrix": m,
               # 🔴 每个 `gap` 格子点名**它自己**那条登记项的 id(判据 ⑥ 按 id 逐字核对 registered)。
               #   钉的是记忆 criteria-must-anchor-to-its-own-object:别人的登记不能给自己放行。
               "gapRegistry": dict(self.gap_reg)}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        log(f"[headless] 三维矩阵已写出 → {path}")
        miss = [f"{c}×{t}×{md}" for c in self.CAPS for t in targets for md in self.MODES if not m[c][t][md]]
        if miss:
            log(f"[headless] 🔴 矩阵缺 {len(miss)} 格(hook 判据 ⑥ 会据此拦):{miss[:12]}")

    def finish(self) -> int:
        fails = [r for r in self.rows if r[2] == "fail"]
        gaps = [r for r in self.rows if r[2] == "gap"]
        print()
        print("| 执行范围 | 判据 | 状态 | 证据 |")
        print("|---|---|---|---|")
        for tid, name, st, ev in self.rows:
            mark = {"ok": "✅", "fail": "❌", "gap": "⚠️"}[st]
            print(f"| {tid} | {name} | {mark} | {ev.replace('|', '/')[:150]} |")
        print(f"\n{'❌' if fails else '✅'} 合计 {len(self.rows)} 条:失败 {len(fails)} · 登记 {len(gaps)}")
        return 1 if fails else 0

async def wait_not_loading(target, budget_ms: int = 60000) -> bool:
    """等一个 antd 按钮**退出 loading 态**再让人点它。

    🔴 2026-09-19 真踩:`<Button loading={busy}>` 在 loading 期间**不响应点击**(antd 会把它变成
      非交互),而我在「发布到 MWAA 调度」刚点完、busy 还是 true 的时候就去点同一排的
      「触发一次调度」⇒ 点击被吞、气泡没弹,判据报「二次确认没点掉」。
      手工复现不了,正因为手工的时候没有刚刚发布过 —— 这类「前一个动作的 loading 尾巴」
      是页面级自动化最常见的假红来源之一。
    """
    t0 = time.time()
    while (time.time() - t0) * 1000 < budget_ms:
        try:
            cls = await target.get_attribute("class") or ""
            dis = await target.get_attribute("disabled")
            if "ant-btn-loading" not in cls and dis is None:
                return True
        except Exception:
            pass
        await target.page.wait_for_timeout(500)
    return False

async def object_texts(pg, name: str, limit: int = 20) -> list[str]:
    """按**对象**读「含这个名字的那一块自己的文本」—— 表格行、卡片、列表项都通吃。

    做法:取所有 innerText 含 `name` 的元素里**最小的那些**(它的子元素都不再含这个名字),
    于是拿到的就是「这一个对象自己的那一块」(名字 + 它的标签 + 它的状态)。

    🔴 为什么需要它(2026-09-19 真踩,与 `row_texts` 那个坑**方向相反**):
      判据在**整页文本**上做负向断言 —— 「主控区视角的离线计算页不许出现别的区的 targetId」——
      当场被打红。查清后发现**页面是对的**:同一页上有几个**多区绑定**的对象(`ui-*` 夹具,
      绑了 home + usw2),页面给它挂上**所有绑定区**的标签,那正是「不丢东西」的护栏在起作用。
      ⇒ 整页负向断言会**用邻居的数据把自己判红**;窗口跨行会**用邻居的数据给自己放行**。
      两者同一个根:**判据必须锚定到它要判的那个对象**,不是整页、也不是一个字符窗口。

    🔴 **本函数只是兜底,优先用产品给的锚点**(2026-09-19 当天第三次订正):
      「最小的含名元素」可能**比对象那一块还小** —— 卡片的名字常在自己的元素里,而区标 / 状态是它的
      **兄弟**元素 ⇒ 读回来的文本里没有标,判据把「标挂着的」判成「没挂标」。启发式再调参只是换个猜法。
      正解是先看产品有没有稳定锚点(本仓 `/etl-jobs` 早就有 `data-testid="job-row-<id>"` /
      `engine-job-row-<id>`),有就用 `row_texts(pg, name, css=<那个选择器>)`;没有才用本函数。
      没有锚点又确实需要时,该给产品**加**一个 —— 这跟当初给 EMR 按钮加 `emr-run-btn` 是同一件事。
    """
    js = """(args) => {
      const [name, limit] = args;
      const out = [];
      for (const e of document.querySelectorAll("*")) {
        const t = e.innerText || "";
        if (!t.includes(name)) continue;
        let childHas = false;
        for (const c of e.children) { if ((c.innerText || "").includes(name)) { childHas = true; break; } }
        if (childHas) continue;
        out.push(t.trim().slice(0, 500));
        if (out.length >= limit) break;
      }
      return out;
    }"""
    try:
        return await pg.evaluate(js, [name, limit])
    except Exception:
        return []


async def row_texts(pg, name: str, css: str = "tr") -> list[str]:
    """按 **DOM 逐行**取「含这个名字的行」的完整文本。

    🔴 为什么必须逐行读,而不是在整页文本里开一个字符窗口:2026-09-19 真踩 ——
      我用 240 字的窗口判「这一行是不是 触发=自动 + 成功」,而窗口**跨进了下一行**:
      于是 `Showcase-usw2-a-ETL-RetentionLTV` 那一行明明写着「手动」也判过了,
      `Flow-ROI-Daily` 明明是「运行中」也判过了 —— 判据拿邻居的数据给自己放行,
      这就是「放宽通过」,而放宽通过没有意义。
      逐行读 DOM 天然有边界:一个 `<tr>` 就是一次运行,不会串味。
    """
    out = []
    try:
        loc = pg.locator(css).filter(has_text=name)
        n = await loc.count()
        for i in range(min(n, 30)):
            try:
                out.append(await loc.nth(i).inner_text())
            except Exception:
                continue
    except Exception:
        pass
    return out


async def row_badges(pg, name: str, css: str = "tbody tr") -> list[dict]:
    """按 **DOM 逐行**取「含这个名字的行」里出现的 `data-testid` 集合(+ 行文本)。

    🔴 与 `row_texts` 同一个理由,但判的是**徽标**而不是文字:文字会被 i18n / 文案改动打破,
      而「这一行上挂的是哪个出口」才是事实(本仓纪律:判据钉事实,不钉形态,更不钉文案)。
    🔴 为什么必须**逐行**:同一张表上别的行会有自己的徽标 —— 整页查 `carrier-drift-ok`
      在不在,会被**邻居行**的绿标放行(本仓记过两次的同形错:字符窗口跨行拿邻居的「成功」)。
    """
    # 🔴🔴 **异常绝不许吞成「这一行没有徽标」**(2026-09-22 真踩,代价是两轮白跑):
    #   第一版写的是 `tr.eval_on_selector_all(...)` —— 而 Playwright 的 **Locator 没有这个方法**
    #   (它在 Page / ElementHandle 上)⇒ `AttributeError` 被 `except Exception: continue` 吞掉
    #   ⇒ 判据报「命中 0 行 · 徽标=[]」,而真相是**我的代码错了**。
    #   于是我两次去查「是不是没部署 / 是不是筛选把行滤光了」,而页面从头到尾是对的。
    #   这与本仓那条「**『判不了』不许说成结论**」是同一个错误形态 —— 我当天刚在
    #   `ledger_sync.py` 里写下这条纪律,转头就在这里犯了。
    #   ⇒ 读取出错就**如实抛出去**(调用处的 `rep.add` 会把它记成 fail),不许静默返回空。
    out: list[dict] = []
    loc = pg.locator(css).filter(has_text=name)
    n = await loc.count()
    for i in range(min(n, 30)):
        tr = loc.nth(i)
        ids = await tr.locator("[data-testid]").evaluate_all(
            "els => els.map(e => e.getAttribute('data-testid'))")
        out.append({"text": await tr.inner_text(), "testids": [x for x in ids if x]})
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 🔴🔴 治理目录搜索的**唯一作者**(2026-09-21 立)
#
# 【为什么必须收口 —— 这一处让我白烧了两轮 2 小时的硬门,而产品从头到尾是对的】
# 判据原来各自写成 `fill(kw)` → 触发 → `wait_for_timeout(3000)` → 读 DOM。带时间戳的
# `page.on("request"/"response")` 对照实验(两次复现一致):
#     0.4s REQ keyword=       →  6.1s RESP   ← 进页那次晚到,被产品的序号保护正确丢弃
#     4.1s REQ keyword=probe  →  7.8s RESP   ← 已不是最后一次 ⇒ 也被丢弃
#     5.3s REQ keyword=probe  → 11.5s RESP   ← 最后一次才被接受
#     8.3s ← **判据就在这一刻读**:表格是「暂无数据」
#    20.3s ← 读:1 行,内容完全正确
# 🔴 **同一个根因表现成两种完全不同的症状**:本机复现读到「暂无数据」,硬门读到
#   「未过滤的第一页 20 行」(20 = antd 默认 pageSize)—— 看你恰好读在哪一刻。
#   我因此差点去查「为什么会显示未过滤列表」,那是个不存在的 bug。
#
# 【为什么是「单一作者」而不是「把那三处各改一遍」】
# 2026-09-21 先只改了 33 号脚本那一处,下一轮硬门 **`DQ-P1` 立刻红在同一个写法上**
# (`verify_dq_directquery.py` 里还有一份 `fill` + `Enter` + 固定 3s + 读整页)。
# 那个「找资产搜索框」的占位符正则当时在**至少 3 处**各写了一遍 —— 典型的
# 「列举式修法一定漏第 N+1 个」。⇒ 收成这一份,并配一条**闭合式**自检(见下)。
# ══════════════════════════════════════════════════════════════════════════════

#: 🔴 目录搜索框的定位口径 —— **只允许在本文件出现一次**(`assert_single_catalog_search_author` 钉着)。
#   要按占位符找**可见的那个**:OR 选择器 + `.first` 会命中页面上别处不可填的隐藏 input
#   (实测 `fill` 直接 30s 超时);也不能只写中文占位符 —— 同一套页面会渲染中/英两种。
CATALOG_BOX_JS = """() => {
  const els = [...document.querySelectorAll('input[placeholder]')];
  return els.findIndex(e => /asset|资产|table\\/database|表\\/库|数据资产/i.test(e.placeholder)
                            && e.offsetParent !== null && !e.disabled && !e.readOnly);
}"""

#: 结果行的**表名**(第一列)。🔴 不拿整行文本切片,也不读整页 innerText ——
#  判据要锚定到它要判的那个对象(整页会被「默认列表 / 别处的最近资产」放行)。
CATALOG_NAMES_JS = """() => [...document.querySelectorAll('tbody tr')]
      .map(r => ((r.querySelector('td')?.innerText || '').match(/[a-z][a-z0-9_]{2,}/i) || [''])[0])
      .filter(Boolean)"""

CATALOG_ROWS_JS = """() => [...document.querySelectorAll('tbody tr')]
      .map(r => (r.innerText || '').replace(/\\s+/g, ' '))"""


async def catalog_box(pg):
    """拿到目录搜索框的 locator;找不到就**响亮报错**(静默跳过 = 判据退化成看第一屏的抽奖)。"""
    idx = await pg.evaluate(CATALOG_BOX_JS)
    if idx is None or idx < 0:
        raise RuntimeError("找不到目录搜索框(判据无从判起 —— 不许静默跳过)")
    return pg.locator("input[placeholder]").nth(idx), idx


async def catalog_search_settled(pg, keyword: str, budget_s: int = 45):
    """在治理目录里搜一次,**等到它自己那一次响应真的回来 + DOM 与关键词自洽**,再返回。

    回 `(names, rows, timeline, settled_at)`:
      · `names`     结果行的表名集合(set)
      · `rows`      结果行的整行文本(list,给需要断更多内容的判据)
      · `timeline`  这次交互的**请求/响应时间线**(必须原样写进判据证据 —— 见文件头那段)
      · `settled_at` 稳态用了多少秒;`None` = 预算内没到稳态(判据应据此判红)

    🔴 三条纪律,都是真栽过才写下来的:
      ① **等事件,不等秒数**:固定 sleep 读到的是任意中间态;
      ② **触发只用一种**:`fill` 本身可能就触发一次搜索,再 Enter、再点按钮 = 三次请求,
         前两次的响应会被产品的序号保护丢弃,于是要等**最后**那一次的往返;
      ③ **「没变」不等于「稳住了」** —— 空关键词时别拿「两次读一样」当稳态信号:
         响应还没到时页面还显示上一次的残留,那时「两次一样」当场成立(实测把基线取成 1 行)。
         空关键词的稳态判据是「结果行 > 1」(未过滤的一页必然不止一行)。
    """
    t0 = time.time()
    timeline: list[str] = []

    def _req(r):
        if "/api/governance/catalog" in r.url:
            timeline.append(f"{time.time() - t0:.1f}s REQ {r.url.split('catalog')[-1]}")

    def _resp(r):
        if "/api/governance/catalog" in r.url:
            timeline.append(f"{time.time() - t0:.1f}s RESP {r.url.split('catalog')[-1]}")

    pg.on("request", _req)
    pg.on("response", _resp)
    settled_at = None
    try:
        box, _ = await catalog_box(pg)
        pat = f"keyword={keyword}&"
        async with pg.expect_response(
            lambda r: "/api/governance/catalog" in r.url and pat in (r.url + "&"),
            timeout=budget_s * 1000,
        ):
            await box.fill(keyword)
            await box.press("Enter")   # 🔴 只一种触发
        for _ in range(int(budget_s * 2)):
            await pg.wait_for_timeout(500)
            names = await pg.evaluate(CATALOG_NAMES_JS)
            if keyword:
                if names and all(keyword.lower() in n.lower() for n in names):
                    settled_at = round(time.time() - t0, 1)
                    break
            elif len(names) > 1:
                settled_at = round(time.time() - t0, 1)
                break
    finally:
        pg.remove_listener("request", _req)
        pg.remove_listener("response", _resp)
    names = await pg.evaluate(CATALOG_NAMES_JS)
    rows = await pg.evaluate(CATALOG_ROWS_JS)
    return set(names), rows, timeline, settled_at


def assert_single_catalog_search_author(roots=("scripts", "qa-game/verify")) -> str:
    """🔴 **闭合式**自检:目录搜索框的定位口径只允许出现在本文件。

    它列的是「**唯一允许的形态**」而不是「枚举哪几处写错了」—— 枚举一定漏第 N+1 个
    (2026-09-21 就是这么漏掉 `verify_dq_directquery.py` 的)。
    `qa-game/` 不入库 ⇒ 目录不存在时**跳过那一个根**,而不是报错(判据不该依赖本机布局)。
    """
    import glob

    me = os.path.basename(__file__)
    # 🔴 标记串要**逐字节出现在源文件里**。第一版写成 `table\\/database`(Python 转义后是单反斜杠),
    #   而各处源码里是 `table\\\\/database`(JS 正则在 Python 字符串里要双写)⇒ **一个都匹配不到,自检假绿**。
    #   量具自己也要校准:改成正则里那段不含反斜杠的片段。
    marker = "asset|资产|table"
    offenders: list[str] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for f in sorted(glob.glob(os.path.join(root, "*.py"))):
            if os.path.basename(f) == me:
                continue
            try:
                txt = open(f, encoding="utf-8").read()
            except OSError:
                continue
            if marker in txt:
                offenders.append(f)
    if offenders:
        raise SystemExit(
            "⛔ 目录搜索框的定位口径出现在这些文件里:" + ", ".join(offenders) +
            f"\n   它的唯一作者是 {me} 的 CATALOG_BOX_JS / catalog_search_settled();"
            "\n   各写一份 ⇒ 同一个坑要修 N 遍,而漏修的那一份就是下一轮的假红"
            "(2026-09-21 DQ-P1 就是这么红的)。"
        )
    return f"目录搜索单一作者 ✓(扫了 {', '.join(r for r in roots if os.path.isdir(r))})"
