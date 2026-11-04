#!/usr/bin/env python3
"""
33-verify-regions-headless.py —— **无头浏览器**(页面驱动)逐区验证**九类**能力。

    python3 scripts/33-verify-regions-headless.py --profile temp-account [--targets tgt_usw2_a,tgt_home]
                                                  [--home-region us-east-1] [--run-sync] [--shots DIR]

🔴 **为什么必须是无头浏览器**(用户 2026-09-18 立为红线):
  「只能是无头浏览器验证才有效,因为后续也是人操作页面。」接口通 ≠ 页面上看得见、点得动 ——
  本仓已经栽过两次:① 判据全绿而用户切到那个区看到的是空页面;② 页面在某个区显示的是**另一个区**
  的工作组与 Endpoint(接口完全正确,是前端的陈旧响应竞态)。这两类缺陷**只有页面级验证抓得到**。

🔴 **自包含**:不 import `qa-game/verify/vlib.py`(那个目录本机专用、不入库)。换账号 / 换机器
  重新 clone 之后本文件即可直接跑,只需要 playwright + 一份 admin 口令。

它验什么(每个活跃 target 一遍,全部**在页面上**判):
  1 数据源  `/datasources`   该区的 Showcase 源在列表里,且行上标的区就是该区
  2 同步    `/sync`          该区的 Showcase 同步任务在列表里且状态为成功
  3 ETL     `/etl-jobs`      Redshift / Glue / EMR 三个 Showcase 作业卡片在,且带该区标签 + succeeded
  4 编排    `/workflow`      该区的 Showcase 工作流在列表里(已发布 / 有调度)
  5 治理    `/governance`    目录里**搜得到**该区的表 + 目录新鲜度行在(不许显示「0 张表」)
  6 建模    `/modeling`      码表 / 维度在列表里;落地状态如实读(非 home 现状 = credential-gap ⇒ 登记)
  7 直查    `/redshift`      工作组与 Endpoint 必须是**该区**的(负向:整页不许出现主控区的 workgroup 名)
  8 实时    `/realtime-compute` 该区的 Showcase 流作业**正在运行**;负向:不出现别的区的流作业
  9 问数    `/genbi`         该区的 Showcase 会话卡片在「我的卡片」里、能打开续聊;落点复述在
  可选 `--run-sync`:在页面上**点一次**同步任务的「启动」并等到成功 —— 人的动线本身也被验一次。
  可选 `--run-engines`:对**每个引擎**(Redshift SQL / Glue PySpark / EMR Serverless)在页面上点
    「立即运行」(= 单独执行 `manual`)并等到成功;编排页点「触发一次」;**实时计算**页对示范流作业
    点「停止」→「启动」并等它回到「运行中」(收口断言:示范对象跑完还得在跑)。

🔴 **三维覆盖**(用户 2026-09-18:「下发执行,单独执行,各种操作都必须要验证到位。而且各种执行引擎都要
  执行到位,不然功能和引擎就会有盲区。这个要写进去 hook 里面,不然总是跳过」):
  本脚本产出 **能力 × 区域 × 执行方式** 矩阵(9 × N × 2;`--emit-matrix <path>` 写 JSON),Stop hook 的判据 ⑥
  (`.claude/skills/multi-region-gate/gate.py`)按它判死 —— 少一格就拦,`gap` 必须同时登记在章的
  `registered` 里,否则算「悄悄放过」。

  **两种执行方式的语义**(取产品自己的词表 —— `/monitor` 运行实例页的「触发」列就是这两个值):
    · `manual`   = **单独执行**:人在该区页面上对**单个对象**点一次(「立即运行」/「启动」/「运行检查」),
                   平台按该对象的章把活派到该区跑,页面自己的状态源变成成功。
    · `dispatch` = **下发执行**:不由人逐个点 —— 在页面上给该区的对象**配上调度并启用**,由平台把 DAG
                   下发到**该区**的 MWAA Serverless,到点由调度真跑;判据是 `/monitor` 运行实例页上
                   出现该对象的一行、**「触发」列是「自动」**、区域列是该区、状态成功(`--run-dispatch`)。

  **18 格清单**(9 能力 × 2 执行方式,逐格都必须有值;🔴 不许用 `n/a` 蒙):
    | 能力 | manual | dispatch |
    |---|---|---|
    | seed         | `/datasources` 该区示范源在列表里 | ⚠️ 登记:造数只有部署期 Glue 作业 + 本机脚本(22/23-seed-*),产品里没有「在该区下发一次造数」的载体 |
    | sync         | `/sync` 点「启动」跑到成功 | ⚠️ 登记:载体未交付,但页面必须如实说「定时未交付」 |
    | etl          | `/etl-jobs` 逐引擎点「立即运行」跑到成功 | 发布调度到该区 + 「触发一次调度」⇒ 运行实例页「触发=自动」那一行 |
    | compute      | EMR Serverless 点「立即运行」跑到成功 | 同上 |
    | realtime     | 该区的示范流作业**正在运行**;页面上「停止」→「启动」并回到运行中(收口) | 主控区视角一次提交勾多个区 ⇒ **每个区各建一个作业**(扇出;夹具不启动、验完即删) |
    | orchestration| `/workflow` 在列表里 + 触发一次 | 配 cron 真烧一轮 ⇒ 运行实例页「触发=自动」那一行 |
    | governance   | `/governance` 目录搜得到该区表 + 「运行检查」在该区数仓真跑 | ⚠️ 登记:治理三件(目录同步/质量检查/敏感扫描)只有页面手动触发,**没有调度载体** |
    | modeling     | `/modeling` 点「码表」「维度建模」Tab 看得到该区示范定义 | 「落地」把定义物化到该区(home ✅ / 非 home = credential-gap ⚠️) |
    | genbi        | 该区的示范会话卡片在「我的卡片」里,且能**打开续聊** | ⚠️ 登记:没有定时问数 / 订阅式报告这样的载体;判别方式 = 调度清单里不出现问数对象 |

  🔴 **realtime 与 genbi 是 2026-09-19 才补进矩阵的**。补之前它们只由「自造夹具、验完删净」
    的硬门段覆盖 ⇒ ① 用户切过去看不到跑着的对象;② **矩阵里没有的那一类 = 默认豁免**。
    代价实证:实时计算在第二个区其实是废的(Kinesis 建流 / 造数 / Flink 日志组三处 IAM 都钉死在
    部署区,SimulatePrincipalPolicy 坐实 us-west-2 全 implicitDeny),而全量硬门一直是绿的。

退出码:有 ❌ 即非零;⚠️(合同缺口 / 缺载体)不算失败但会打出来。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time

try:
    import boto3
except ImportError:  # pragma: no cover
    sys.exit("需要 boto3:pip install boto3")
try:
    from playwright.async_api import async_playwright
except ImportError:  # pragma: no cover
    sys.exit("需要 playwright:pip install playwright && playwright install chromium")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kf_headless_lib as L  # noqa: E402

# 🔴 单一作者:登录 / 带 ?scope= 开页并等落定 / 点 antd 控件 / 判据台账 全在 `kf_headless_lib.py`。
#   本文件曾经自带一份,加区脚本(34)又抄了一份 ⇒ 同一个坑要修两遍,漏修的那份就是下一次假红
#   (2026-09-19 实证:antd 关过的气泡只加 `.ant-popover-hidden` 不卸载 ⇒ `.last` 落在隐藏气泡上,
#    「触发一次调度」静默没点掉,而脚本照样打印「已触发」)。
HOME, ACTIVE, SUCCESS_WORDS, SCHED_PATH = L.HOME, L.ACTIVE, L.SUCCESS_WORDS, L.SCHED_PATH
log, cfn_out, registry, admin_pw = L.log, L.cfn_out, L.registry, L.admin_pw
do_login, goto_scope, shot = L.do_login, L.goto_scope, L.shot
click_tab, click_btn, click_radio = L.click_tab, L.click_btn, L.click_radio
confirm_popconfirm, wait_modal = L.confirm_popconfirm, L.wait_modal
click_until_modal, wait_not_loading = L.click_until_modal, L.wait_not_loading
row_texts = L.row_texts

# 矩阵的 source 必须是**本脚本**(hook 判据 ⑥ 要它证明「是无头浏览器产出的」)
SOURCE = "scripts/33-verify-regions-headless.py"
row_state, all_windows, Rep = L.row_state, L.all_windows, L.Rep


# ── 载体定义落后:呈现面判据(2d)─────────────────────────────────────────
WF_TABLE = "bgp-workflows"


def _wf_row(ddb, name: str) -> dict | None:
    """按 name 在工作流表里找那一行(返回主键 + 当前 cron)。翻完页,**不许 head 截断**。

    🔴 「`head` 截断过的输出不许当全集下结论」是本仓刚记下的教训(2026-09-21 我用
      `head -10` 数 `list-applications`,两次下错结论)。分页 API 同理。
    """
    kw = {"TableName": WF_TABLE}
    while True:
        r = ddb.scan(**kw)
        for it in r.get("Items") or []:
            if ((it.get("name") or {}).get("S") or "") == name:
                return {"userId": (it.get("userId") or {}).get("S"),
                        "workflowId": (it.get("workflowId") or {}).get("S"),
                        "cron": (it.get("cronExpression") or {}).get("S")}
        if "LastEvaluatedKey" not in r:
            return None
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


#: 夹具原值的**落盘基线**。🔴🔴 2026-09-22 真踩:判据进程被杀在还原之前 ⇒ 下一次跑把
#   **被改过的值**当成了原值(`7 7 * * *`),于是那个对象的真实基线 `25 13 * * *` **永久丢了**。
#   ⇒ 改动前先落盘;还原成功后才删掉那条。文件在 /tmp 是刻意的:它描述的是**本机这一轮**的
#   未完成动作,不是要长期保存的东西(长期口径由 `scripts/37-fixture-reseal.py` 的
#   「所有已发布载体都必须 drift=ok」兜底 —— 那一条与基线无关,闭合)。
_BASELINE = "/tmp/kf-drift-fixture-baseline.json"


def _baseline_load() -> dict:
    try:
        with open(_BASELINE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _baseline_save(d: dict) -> None:
    try:
        with open(_BASELINE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
    except Exception:
        pass


def _baseline_remember(row: dict) -> str:
    """记下夹具的原值,并返回**可信的**原值。

    🔴 如果文件里已经有这一行的基线,说明**上一次没还原完** ⇒ 以文件里的为准,
      绝不拿当前(已被改过的)值当原值。
    """
    d = _baseline_load()
    k = str(row["workflowId"])
    if k in d:
        return str(d[k].get("cron") or row["cron"])
    d[k] = {"userId": row["userId"], "cron": row["cron"], "name": row["name"]}
    _baseline_save(d)
    return str(row["cron"])


def _baseline_clear(row: dict) -> None:
    d = _baseline_load()
    if str(row["workflowId"]) in d:
        d.pop(str(row["workflowId"]), None)
        _baseline_save(d)


def _set_wf_cron(ddb, row: dict, cron: str) -> None:
    ddb.update_item(TableName=WF_TABLE,
                    Key={"userId": {"S": row["userId"]}, "workflowId": {"S": row["workflowId"]}},
                    UpdateExpression="SET cronExpression = :c",
                    ExpressionAttributeValues={":c": {"S": cron}})


async def _drift_badge(pg, base: str, tid: str, name: str) -> dict:
    """开调度配置页、用产品自己的「名称」筛选缩到那一行,逐行读它的徽标。

    🔴 为什么用筛选而不是翻页找:本轮该缺陷的根因就是「判据只读第一页」的反面
      示范作业被 10 行验收残留挤到第 2 页,产品每一层都是对的而判据红了。
      用产品自己的筛选定位,既不依赖行数也不依赖排序;而「用户找得到这一行吗」
      是 2c 在管的事(那一条刻意不筛选),两条判据各钉一层,不互相顶替。
    """
    await goto_scope(pg, base, SCHED_PATH, tid, settle="", budget_s=25)
    try:
        box = pg.locator('input[placeholder="名称"]').first
        await box.fill(name)
        await box.press("Enter")
    except Exception:
        pass
    rows = await L.row_badges(pg, name)
    ids: list[str] = []
    for r in rows:
        ids += r["testids"]
    return {"rows": len(rows), "ids": ids, "text": (rows[0]["text"] if rows else "")}


def _has(*want: str):
    """谓词:这些徽标都出现了。"""
    return lambda ids: all(w in ids for w in want)


async def _drift_badge_until(pg, base: str, tid: str, name: str, pred, budget_s: int = 420) -> dict:
    """反复**重新取数**直到 `pred(徽标)` 成立;超时如实返回最后一次读到的(判据自然红)。

    🔴 「判据的读取时刻必须与它等的那件事同步」(本仓白烧过两轮硬门):固定 sleep 读到的是
      任意中间态。这里等的是**那一行的徽标变成什么**,而不是「睡够了」。
    🔴 为什么每轮都**重新开页**而不是在同一页上轮询:改 DDB 不会让页面自己去重查,
      必须真的再取一次数 —— 否则我会在一份陈旧的 DOM 上等到超时,然后误判产品。
    🔴 超时**不当成通过**:返回最后一次的真实徽标,由调用处的 `rep.add` 如实判红。
    """
    deadline = time.time() + budget_s
    got = await _drift_badge(pg, base, tid, name)
    while not pred(got["ids"]) and time.time() < deadline:
        got = await _drift_badge(pg, base, tid, name)
    return got


RESIDUE_PREFIXES = ("slsw-cron-", "wf2r-")

#🔴🔴 **实时计算页上的「验收残留」前缀**(根治)。
#该缺陷的真相:产品每一层都对(AWS 应用 RUNNING · 台账 running · 接口回 11 行含目标行),
#   坏在页面主列表用的是 antd **默认 `pageSize=10`**,而**10 行验收残留**把示范作业按
#   `createdAt` 降序挤到了**第 11 位 = 第 2 页** ⇒ 用户切过去「什么都没看见」。
#   ⇒ 这是 `all-capabilities-visible-in-every-region` 的**反面**:
#     以前是「验收删干净 = 用户眼里没做」,这次是「**验收留太多 = 把真东西挤没了**」。两头都要管。
#   🔴 为什么要**闭合式按前缀查**而不是「本轮建的删掉就算」:那 3 个 `DispatchCheck-RT-*` 残留
#     正是**以前某几轮删失败**留下的 —— 而当时清理失败**只写了 log、没有 rep.add**
#     ⇒ **判据压根看不见清理失败** ⇒ 失败就静默累积。按前缀查能把历史残留一并看见。
RESIDUE_JOB_PREFIXES = ("DispatchCheck-RT-", "scq-flink-", "dc-fixture-", "kf-probe-")


async def table_rows_all_pages(pg, budget_pages: int = 12) -> list[str]:
    """把一张 antd 表**所有页**的行文本读回来(用产品自己的「下一页」翻)。

    🔴 为什么需要它(该缺陷的另一半):判据只读第一页 ⇒ 对象被挤到第 2 页就假红。
      但**不许**因此把判据放宽成「存在于某处」就算过 —— 那会丢掉「用户看不见」这层语义。
      ⇒ 分两层:本函数给「产品能力真值」(它到底在不在),
        而「第一页看不看得见」由另一条判据(`8e` 残留清零)守住。
    """
    out: list[str] = []
    for _ in range(budget_pages):
        for t in await pg.locator("tbody tr").all_inner_texts():
            out.append(t)
        nxt = pg.locator("li.ant-pagination-next:not(.ant-pagination-disabled)")
        if not await nxt.count():
            break
        try:
            await nxt.first.click()
            await pg.wait_for_timeout(900)
        except Exception:
            break
    return out

#: 🔴 **判据分层**(2026-09-22):`2d①`「示范对象的载体是最新的」是 **per-region 事实**,逐区必验;
#   而 `2d②..⑤`「落后时显示需重发 / 出路点得通 / 回到最新」判的是**前端呈现逻辑**,
#   那是**平台级代码**,不随区变 ⇒ **至少一个区端到端验过**就成立。
#   这条分层不是为了少验,恰恰相反:它让我**不必为了凑绿去动示范对象** ——
#   而"动示范对象"正是 2026-09-22 02:2x 那次副作用的来源。
#   缺口不会被藏起来:逐区循环结束后有一条总判据 `2d-UI`,一个区都没验到就红。
_DRIFT_UI = {"verified_on": ""}


def _residue_fixture(ddb, tid: str) -> dict | None:
    """挑一个**验收残留**工作流当夹具(绑在该区、已发布、有 cron)。

    🔴🔴 为什么必须是残留而**不是示范对象**(2026-09-22 02:2x 真踩):第一版拿
      `Showcase-*-Flow-ROI-Daily` 当夹具 —— 流程是「改 cron → 验 stale → 重发 → 还原 cron →
      **再重发一次**」,而进程被 `timeout` 杀在最后那一步之前(SIGTERM 下 `finally` 不保证跑完)
      ⇒ DDB 是原值而 MSAF 上的定义还是夹具的 `7 7 * * *` ⇒ **示范对象被我留成了 `stale`**。
      (产品判得完全正确 —— 是判据留下了副作用,而本仓纪律是「判据的夹具不许顺手触发副作用」。)
    ⇒ 根治不是「把预算调大」(那只是让概率变小),而是**换夹具**:用残留对象,
      即使一次都没收口,受影响的也是**本来就要删的东西**;示范对象**只读**。
    """
    for it in (ddb.scan(TableName=WF_TABLE).get("Items") or []):
        n = (it.get("name") or {}).get("S") or ""
        if not n.startswith(RESIDUE_PREFIXES) or "Showcase" in n:
            continue
        if not (it.get("cronExpression") or {}).get("S"):
            continue
        dep = (it.get("deployments") or {}).get("M") or {}
        if tid not in dep:
            continue
        return {"userId": (it.get("userId") or {}).get("S"),
                "workflowId": (it.get("workflowId") or {}).get("S"),
                "name": n, "cron": (it.get("cronExpression") or {}).get("S")}
    return None


async def drift_badge_criteria(pg, base: str, tid: str, pfx: str, ddb, rep: Rep, shots: str) -> None:
    # ① 示范对象:**只读**。它同时是「夹具没留副作用」的常驻看守 ——
    #    任何一轮里它变成 stale,都说明上一轮有人(很可能是我)没收口。
    name = f"{pfx}-Flow-ROI-Daily"
    # 🔴 **必须等**:`withDrift=1` 让这张表的请求要 1.3 秒才回来,单次读到的是空表
    #   (我第一版把这里写成单次 `_drift_badge` ⇒ 两个区都「命中 0 行」,而 API 层明明是 ok)。
    #   同步点 = 「那一行真的挂上了某个 `carrier-drift-*` 徽标」,不是「睡够了」。
    b4 = await _drift_badge_until(
        pg, base, tid, name,
        lambda ids: any(x.startswith("carrier-drift-") for x in ids), budget_s=120)
    await shot(pg, shots, f"{tid}-drift-before")
    # ① 现网必须是 ok —— 否则「造完是 stale」证不了判别力(可能恒 stale)
    rep.add(tid, "2d① 🔴 现网已发布的载体定义**就是**当前生成器产出的(绿标「最新」)",
            b4["rows"] > 0 and "carrier-drift-ok" in b4["ids"],
            f"命中 {b4['rows']} 行 · 徽标={b4['ids']}"
            + ("" if "carrier-drift-ok" in b4["ids"] else " ⇒ 现网载体本来就落后 / 或这一列压根没渲染"))

    # ②..⑤ 用**验收残留**当夹具(改它 ⇒ 就算没收口也只影响本来要删的东西)
    if _DRIFT_UI["verified_on"]:
        log(f"[headless] {tid}:呈现面(平台级)已在 {_DRIFT_UI['verified_on']} 端到端验过,本区只验 2d①")
        return
    row = _residue_fixture(ddb, tid)
    self_made = False
    if not row:
        # 🔴🔴 2026-10-01 全新账号(…4691)实测:没有任何验收残留 ⇒ 两个区都「不造夹具」⇒ `2d-UI` **恒红**。
        #   判据的前提「账号里总有上一轮的残留」是一条**未声明前提**,换账号即失效。
        #   ⇒ 自己造一个**一次性**夹具(经产品自己的 API、绑该区、发布、带 cron),用完经产品 DELETE 删掉,
        #   并且「删净」本身是一条判据(`2d⑥`)。仍然**绝不**退回示范对象。
        row = await _make_drift_fixture(pg, base, ddb, tid, rep)
        if not row:
            return
        self_made = True
    name = row["name"]
    # 🔴 原值取**落盘基线**(上一次没还原完时,DDB 里那个值是夹具的,不是原值)
    orig = _baseline_remember(row)
    row = {**row, "cron": orig}
    mutated = "7 7 * * *" if orig != "7 7 * * *" else "9 9 * * *"
    try:
        # ② 造一个真落后的载体:只改定义的**输入**,不重发 ⇒ 载体上那份定义一个字节都没动
        _set_wf_cron(ddb, row, mutated)
        # 🔴 等到它**真的**变 stale,而不是睡一觉就读:改 DDB 之后页面要重新取一次数才看得到。
        #   产品要是恒 ok,这里会等满预算然后如实返回 ok ⇒ 判据红(超时绝不当成通过)。
        af = await _drift_badge_until(pg, base, tid, name, _has("carrier-drift-stale"))
        await shot(pg, shots, f"{tid}-drift-stale")
        stale_ok = ("carrier-drift-stale" in af["ids"]) and ("carrier-drift-ok" not in af["ids"])
        rep.add(tid, "2d② 🔴🔴 定义落后时那一行显示「载体需重新发布」,**且那一行不再有绿标**",
                af["rows"] > 0 and stale_ok,
                f"命中 {af['rows']} 行 · 徽标={af['ids']}"
                + ("" if stale_ok else " ⇒ 界面把「落后」说成了「最新」/ 或两个徽标同时挂着"))
        # 🔴 出路必须在同一行上给出来,不能只报警不给动作
        rep.add(tid, "2d③ 界面在那一行上直接给出「重新发布」的出路(不是只报个警)",
                "carrier-republish" in af["ids"], f"徽标={af['ids']}")

        # ③ 点它 ⇒ 真的回到「最新」
        clicked = True
        try:
            await pg.locator('[data-testid="carrier-republish"]').first.click()
        except Exception as e:
            clicked = False
            rep.add(tid, "2d④ 点「重新发布」这一下本身成功", False, f"点击失败:{str(e)[:120]}")
        # 🔴 同步点 = 「那一行回到最新」,不是「按钮不转了」——重发成功后按钮**整个消失**,
        #   拿按钮的 loading 当口径会当场 stale element。
        fixed = (await _drift_badge_until(pg, base, tid, name, _has("carrier-drift-ok"))
                 if clicked else await _drift_badge(pg, base, tid, name))
        await shot(pg, shots, f"{tid}-drift-republished")
        rep.add(tid, "2d④ 🔴 点「重新发布」⇒ 载体真被重发,那一行回到「最新」(出路是通的)",
                "carrier-drift-ok" in fixed["ids"] and "carrier-drift-stale" not in fixed["ids"],
                f"徽标={fixed['ids']}")
    finally:
        # ④ 收口:cron 还原 ⇒ 载体又落后(因为上一步把它发成了 mutated 的定义)⇒ 必须再发一次。
        #   🔴 不再发一次就会把示范对象留在「落后」状态,下一轮这一格红,而红的是**我的夹具**不是产品。
        _set_wf_cron(ddb, row, orig)
        back = await _drift_badge_until(pg, base, tid, name, _has("carrier-drift-stale"), budget_s=120)
        again_stale = "carrier-drift-stale" in back["ids"]
        try:
            if again_stale:
                await pg.locator('[data-testid="carrier-republish"]').first.click()
        except Exception:
            pass
        fin = await _drift_badge_until(pg, base, tid, name, _has("carrier-drift-ok"))
        await shot(pg, shots, f"{tid}-drift-restored")
        if "carrier-drift-ok" in fin["ids"]:
            _baseline_clear(row)   # 🔴 只有真的回到 ok 才允许清基线
        _DRIFT_UI["verified_on"] = tid
        rep.add(tid, "2d⑤ 🔴 收口:夹具还原后回到「最新」(判据不许留下副作用)",
                "carrier-drift-ok" in fin["ids"],
                f"还原 cron={orig!r} · 还原后先判 stale={again_stale}(这本身是第二次判别力)"
                f" · 重发后徽标={fin['ids']}")
        if self_made:
            await _drop_drift_fixture(pg, ddb, tid, row, rep)


#🔴 自造夹具的名字前缀:落在 `RESIDUE_PREFIXES` 的 `wf2r-` 口径里 ⇒ 万一本轮被杀在删除之前,
#   下一轮 `_residue_fixture` 会把它当残留复用,`36-fixture-ledger.py` 也会把它归为 fixture(不会被当成示范对象)。
SELF_DRIFT_PREFIX = "wf2r-b09drift-"

#: 经**页面自己的 fetch**(全局拦截器带登录 token)调产品 API —— 不另起一套鉴权客户端。
_PAGE_API_JS = """async ([m, p, b]) => {
  const r = await fetch(p, {method: m,
    headers: {'Content-Type': 'application/json', 'x-bgp-project': 'proj-default', 'x-bgp-env': 'dev'},
    body: b === null ? undefined : JSON.stringify(b)});
  const t = await r.text(); let j = {};
  try { j = JSON.parse(t); } catch (e) { j = {raw: t.slice(0, 300)}; }
  return [r.status, j];
}"""


async def _page_api(pg, method: str, path: str, body=None) -> tuple[int, dict]:
    st, j = await pg.evaluate(_PAGE_API_JS, [method, path, body])
    return int(st), (j if isinstance(j, dict) else {"data": j})


def _wf_item(ddb, wf_id: str) -> dict | None:
    for it in _scan_all(ddb, WF_TABLE):
        if (it.get("workflowId") or {}).get("S") == wf_id:
            return it
    return None


def _scan_all(ddb, table: str) -> list[dict]:
    out, kw = [], {"TableName": table}
    while True:
        r = ddb.scan(**kw)
        out += r.get("Items") or []
        if "LastEvaluatedKey" not in r:
            return out
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


async def _make_drift_fixture(pg, base: str, ddb, tid: str, rep: Rep) -> dict | None:
    """建一个一次性工作流夹具:绑 `tid`、带 cron、真发布到该区。造不出来 ⇒ 如实打红(不许静默跳过)。

    🔴 夹具自己要有判据:「建出来了」不算,要**该区的载体真发布了**(DDB `deployments` 里有 `tid`)——
      否则 `2d②` 读到的「落后」可能只是「从来没发布过」。
    """
    await goto_scope(pg, base, SCHED_PATH, tid, settle="", budget_s=25)
    name = f"{SELF_DRIFT_PREFIX}{tid[len('tgt_'):]}-{time.strftime('%m%d%H%M%S', time.gmtime())}"
    body = {"name": name, "description": "判据的一次性夹具(用完即删)", "targetId": tid,
            "cronExpression": "0 3 * * *",
            "dagDefinition": {"nodes": [{"id": "n1", "type": "sql", "data": {"sql": "SELECT 1"}}], "edges": []}}
    why = ""
    try:
        st, j = await _page_api(pg, "POST", "/api/workflow", body)
        d = j.get("data") if isinstance(j.get("data"), dict) else j
        wf_id = (d or {}).get("workflowId") or ""
        if st not in (200, 201) or not wf_id:
            why = f"建夹具失败 HTTP {st} {str(j)[:200]}"
        else:
            st2, j2 = await _page_api(pg, "POST", f"/api/workflow/{wf_id}/publish", {})
            if st2 != 200:
                why = f"发布夹具失败 HTTP {st2} {str(j2)[:200]}"
            else:
                deadline = time.time() + 180
                while time.time() < deadline:
                    it = _wf_item(ddb, wf_id)
                    dep = ((it or {}).get("deployments") or {}).get("M") or {}
                    if it and tid in dep:
                        rep.add(tid, "2d⓪ 自造夹具:一次性工作流已建出且**真发布到该区**(夹具自己的判据)", True,
                                f"{name} · workflowId={wf_id} · deployments 含 {tid}")
                        return {"userId": (it.get("userId") or {}).get("S"), "workflowId": wf_id,
                                "name": name, "cron": (it.get("cronExpression") or {}).get("S")}
                    await asyncio.sleep(5)
                why = f"发布 200 但 180s 内 deployments 里没出现 {tid}"
            # 造到一半:能删就删,别留半成品
            await _page_api(pg, "DELETE", f"/api/workflow/{wf_id}")
    except Exception as e:
        why = f"页面交互异常:{str(e)[:160]}"
    rep.add(tid, "2d⓪ 自造夹具:一次性工作流已建出且**真发布到该区**(夹具自己的判据)", False, why)
    return None


async def _drop_drift_fixture(pg, ddb, tid: str, row: dict, rep: Rep) -> None:
    """经产品 DELETE 删掉自造夹具;收口断言 = **注册记录真没了**(不是「我调过 DELETE」)。"""
    st, j, gone = 0, {}, False
    try:
        st, j = await _page_api(pg, "DELETE", f"/api/workflow/{row['workflowId']}")
        for _ in range(12):
            if _wf_item(ddb, row["workflowId"]) is None:
                gone = True
                break
            await asyncio.sleep(5)
    except Exception as e:
        j = {"error": str(e)[:160]}
    if gone:
        _baseline_clear(row)
    rep.add(tid, "2d⑥ 🔴 自造夹具**建了必撤**(收口断言 = 工作流记录真没了;产品 DELETE 会先撤各区产物)",
            gone, f"{row['name']} · DELETE HTTP {st} · 记录已消失={gone}" + ("" if gone else f" · {str(j)[:200]}"))


# ════════════════════════════════════════════════════════════════════════════════
# 5h 🔴🔴 **:治理页的取数,陈旧响应一律不许赢**(观察面 = 「数据分级」的字段清单)
#
# 【5e 之外为什么还要这一条】`5e` 判的是**目录搜索**那一条路(该缺陷的真根)。
#   是**另外 12 条路**:血缘 / 影响分析 / 授权 / 分级 / 质量规则 / 质量结果 / 跑检查 /
#   加规则 / 敏感扫描 / 采纳 / 同步 schema —— 当时它们**一条闸都没有**。
#   结构判据(`catalog-search-race.test.ts` 的棘轮 12 → 0)+ 变异 4/4 钉住的是「**代码里有那个比较**」;
#   本仓纪律要求「每修一个 bug 必须在无头判据里留一条」,因为只有行为判据能钉
#   「**用户眼里最终显示的是后一次的结果**」。(这两层判的不是同一件事:2026-09-22 第一版
#   `guarded()` 就把 `finally` 里关 loading 的那次比较当成了写前的闸,结构判据全绿而闸是假的。)
#
# 【为什么挑「数据分级」当观察面】它的危害最直白:字段清单来自被选中的那张表,而下拉里显示的
#   表名(`classFqn`)是用户动作**同步**写的 ⇒ 陈旧响应赢了的样子就是
#   **「下拉写着表 B,底下列的是表 A 的字段」**,而用户接着就在这份清单上打敏感级别 / 脱敏策略
#   ⇒ **脱敏规则会落到错的表上**。它还一次盖住两个接口(`columns` + `classification` 是一个
#   `Promise.all`),比单接口的观察面更接近真实形态。
#
# 【判别力不靠运气】与 `5e` 同一手法:`page.route` 把**先点的那张表**的两个请求人为延迟
#   ⇒ 它必然晚到。没有序号闸 ⇒ 晚到的 A 覆盖 B ⇒ **必红**;有闸 ⇒ A 的写被丢掉 ⇒ **必绿**。
#
# 🔴 夹具自己要有判据(缺一条这判据就会假绿):
#   ① 两张表的字段集**互有差异**(否则「最终显示谁」根本判不出来);
#   ② A 的响应**确实晚于** B 的(否则竞态压根没发生);
#   ③ 读到的必须是**分级页签那张表**(不是目录表、不是别的页签残留在 DOM 上的表)。
# ════════════════════════════════════════════════════════════════════════════════

#: 分级页签里**那张字段表**的字段名。
#  🔴 锚定到「表头同时有『敏感级别』和『脱敏』」的那张表 —— 目录表也有「敏感级别」列,只有分级表
#    两个都有 ⇒ 闭合地认对象,不用下标(本仓:判据不许用下标表达语义、必须锚定到它要判的那个对象)。
#  🔴🔴 **判不了一律回 `null`**:没渲染 / 认到 0 张或 2 张 / 不在当前页签上,都是「判不了」,
#    绝不许退化成「这张表没有字段」——2026-09-22 `row_badges` 把 `AttributeError` 吞成
#    「这一行没有徽标」,白烧两轮硬门、带偏两个调查方向。
CLASS_COLS_JS = """() => {
  const hit = [...document.querySelectorAll('.ant-table')].filter(tb => {
    const h = tb.querySelector('thead')?.innerText || '';
    return /敏感级别|Sensitivity/.test(h) && /脱敏|Mask/.test(h);
  });
  if (hit.length !== 1) return null;
  const tb = hit[0];
  if (!tb.closest('.ant-tabs-tabpane-active')) return null;
  const body = tb.querySelector('.ant-table-tbody');
  if (!body) return null;
  return [...body.querySelectorAll('tr.ant-table-row')]
    .map(r => (((r.querySelector('td')?.innerText || '').trim().split('\\n')[0]) || '').trim())
    .filter(Boolean);
}"""

#: 目录页签那张表的候选行:`[{fqn, cols}]`。
#  🔴 **列下标由表头推出来**,不写死(本仓:门禁/判据不许用下标表达语义)。
#  🔴 判不了 ⇒ 回 `null`(同 `CLASS_COLS_JS`)。
CATALOG_CANDIDATES_JS = """() => {
  const hit = [...document.querySelectorAll('.ant-table')].filter(tb => {
    const h = tb.querySelector('thead')?.innerText || '';
    return /数据资产|Asset/.test(h) && /字段数|Columns/.test(h);
  });
  if (hit.length !== 1) return null;
  const tb = hit[0];
  if (!tb.closest('.ant-tabs-tabpane-active')) return null;
  const heads = [...tb.querySelectorAll('thead th')].map(e => (e.innerText || '').trim());
  const ci = heads.findIndex(h => /字段数|Columns/.test(h));
  if (ci < 0) return null;
  return [...tb.querySelectorAll('.ant-table-tbody tr.ant-table-row')].map(r => {
    const tds = [...r.querySelectorAll('td')];
    const parts = (tds[0]?.innerText || '').split('\\n').map(s => s.trim())
                    .filter(s => /[a-z0-9]/i.test(s));
    const fqn = parts.find(s => s.includes('.')) || '';
    const n = parseInt((((tds[ci] || {}).innerText || '').match(/\\d+/) || ['0'])[0], 10);
    return { fqn, cols: n };
  }).filter(x => x.fqn);
}"""

#: 🔴 判据分层(同 `_DRIFT_UI`):陈旧响应竞态是**平台级前端逻辑**,不随区变 ⇒ 至少一个区端到端
#  验过就成立;一个区都没验到由逐区循环后的总判据 `5h-UI` 打红(「本区没夹具就跳过」不许静默
#  退化成「这条机制从来没验过」)。
_CLASS_RACE = {"verified_on": "", "why": ""}


_CATALOG_NEXT = ".ant-tabs-tabpane-active .ant-pagination-next"


async def _catalog_page_next(pg) -> bool:
    """目录表翻到下一页(产品自己的分页)。没有下一页 ⇒ False。翻过去要等行真换了(读取时刻与事件同步)。"""
    nxt = pg.locator(_CATALOG_NEXT)
    if await nxt.count() != 1 or "ant-pagination-disabled" in (await nxt.first.get_attribute("class") or ""):
        return False
    before = await pg.evaluate(CATALOG_CANDIDATES_JS)
    await nxt.first.click()
    for _ in range(30):
        await pg.wait_for_timeout(500)
        if await pg.evaluate(CATALOG_CANDIDATES_JS) != before:
            return True
    raise RuntimeError("点了目录表「下一页」15s 内行没变(翻页没生效 ⇒ 夹具判不了)")


async def _catalog_row(pg, fqn: str, max_pages: int = 12):
    """目录表里 fqn 那一行(恰好 1 行才返回)。不在当前页 ⇒ 回第 1 页逐页找(候选可能不在第一页)。"""
    rows = pg.locator(".ant-tabs-tabpane-active tr.ant-table-row").filter(has_text=fqn)
    if await rows.count():
        return rows
    first = pg.locator(".ant-tabs-tabpane-active .ant-pagination-item-1")
    if await first.count() == 1:
        await first.first.click()
        await pg.wait_for_timeout(1200)
    for _ in range(max_pages):
        if await rows.count():
            return rows
        if not await _catalog_page_next(pg):
            break
    return rows


async def _class_open(pg, fqn: str, wait_settled: bool = True, budget_s: int = 45) -> list:
    """回到**数据目录**页签,点某一行的「分级」按钮 ⇒ 切到分级页签;可选等字段表就绪。

    🔴 按 **fqn** 认那一行(它在行里原样渲染,且全局唯一;用短表名会撞上同名异库的表)。
    回字段名 list(`wait_settled=False` 时回空 list —— 调用方自己负责等)。
    🔴 夹具步骤自己要有判据:页签要真切过去、行要唯一命中、按钮要真在。
    """
    if not await L.click_tab(pg, "数据目录", "Data Catalog", "Catalog"):
        raise RuntimeError("找不到「数据目录」Tab")
    rows = await _catalog_row(pg, fqn)
    nr = await rows.count()
    if nr != 1:
        raise RuntimeError(f"目录里用 {fqn!r} 命中 {nr} 行(必须恰好 1 行,否则判据会认错对象)")
    btn = rows.locator("button").filter(has_text=re.compile("分级|Classif"))
    nb = await btn.count()
    if nb != 1:
        raise RuntimeError(f"{fqn!r} 那一行上「分级」按钮命中 {nb} 个(必须恰好 1 个)")
    await btn.click()
    if not wait_settled:
        return []
    for _ in range(budget_s * 2):
        await pg.wait_for_timeout(500)
        cols = await pg.evaluate(CLASS_COLS_JS)
        if cols:
            return cols
    raise RuntimeError(f"{fqn!r} 的字段清单 {budget_s}s 内没就绪(读到={await pg.evaluate(CLASS_COLS_JS)!r};"
                       f"`null` = 判不了/表没渲染,`[]` = 该表真没字段)")


async def class_race_criterion(pg, base: str, tid: str, rep: Rep, shots: str) -> None:
    """陈旧响应竞态的**行为判据**:人为制造确定竞态,断言最终显示的是**后一次**点的那张表。"""
    if _CLASS_RACE["verified_on"]:
        log(f"[headless] {tid}:陈旧响应竞态(平台级)已在 {_CLASS_RACE['verified_on']} 端到端验过,本区跳过")
        return
    ok, ev = False, ""
    try:
        # ① 先从目录**表自己的「字段数」列**推候选(不写死表名 —— 5e 那次写死 `dws` 在第二个区
        #    只匹配到 1 行,判据当场自己报「没有判别力」)。🔴 按字段数从多到少试:
        #    验收残留表往往只有 1 个占位列,拿它们当夹具必然「两张表字段集一模一样」(本区实测:
        #    未过滤的第一页前 6 行全是 `home_orders_*`、各 1 列 ⇒ 第一版夹具就这么废了)。
        # 🔴 2026-10-11 第二十轮:只看**第一页** ⇒ 前面各段新建的表把 `ad_channels` 挤到后面,第一页只剩 1 张
        #   ≥2 列的表 ⇒ 夹具造不出(产品是对的)。判别力不许押在「第一页恰好有什么」上(v1.10 同一教训)
        #   ⇒ 用产品自己的分页逐页找,直到**同一页**凑出 ≥2 张(竞态的两次点击要在同一页上发生)。
        cand, pages_seen = [], 0
        while True:
            raw = await pg.evaluate(CATALOG_CANDIDATES_JS)
            if raw is None:
                raise RuntimeError("读不到目录那张表(`null` = 判不了)⇒ 不算过关")
            pages_seen += 1
            cand = [c for c in raw if c["cols"] >= 2]
            cand.sort(key=lambda c: (-c["cols"], c["fqn"]))
            # 🔴 同名表只留一张(2026-10-09 第十六轮:验收夹具在多个 schema 里留下同构的 `ad_campaigns` 副本,
            #   前 6 个候选全是它 ⇒ 配不出「互有差异」的一对)。同名副本几乎总是同构,量它们不增加判别力。
            seen_base: set = set()
            cand = [c for c in cand if not (c["fqn"].split(".")[-1] in seen_base or seen_base.add(c["fqn"].split(".")[-1]))]
            if len(cand) >= 2 or pages_seen >= 12 or not await _catalog_page_next(pg):
                break
        log(f"[headless] {tid}:5h 夹具候选来自目录第 {pages_seen} 页({[(c['fqn'], c['cols']) for c in cand][:6]})")
        if len(cand) < 2:
            raise RuntimeError(f"目录逐页找了 {pages_seen} 页,没有一页上字段数 ≥2 的表有 2 张 ⇒ 造不出「两张表互相盖」"
                               f"的夹具(最后一页候选={[(c['fqn'], c['cols']) for c in cand]})")
        # ② 逐个量字段集,找出**互有差异**的一对(A 的独有字段非空、B 的独有字段也非空)。
        #    差异是判别依据:只有它非空,「最终显示的是谁」才判得出来。
        measured: dict[str, set] = {}
        notes: list[str] = []
        pair = None
        for c in cand[:6]:
            fq = c["fqn"]
            try:
                cols = set(await _class_open(pg, fq))
            except Exception as e:
                notes.append(f"{fq}:{str(e).splitlines()[0][:70]}")
                continue
            if not cols:
                notes.append(f"{fq}:字段清单为空(OM 未收录列)⇒ 不能当夹具")
                continue
            for other, ocols in measured.items():
                # 🔴 fqn 互不为子串:否则下面按 URL 里的 fqn 认请求时会张冠李戴
                if other in fq or fq in other:
                    continue
                if (cols - ocols) and (ocols - cols):
                    pair = (other, fq)
                    break
            measured[fq] = cols
            if pair:
                break
        if not pair:
            raise RuntimeError(f"目录里找不到「字段集互有差异」的两张表 ⇒ 这条判据没有判别力,"
                               f"必须换夹具而不是让它绿(量过={{ {', '.join(f'{k}:{len(v)}列' for k, v in measured.items())} }};"
                               f"跳过原因={notes})")
        fqn_a, fqn_b = pair              # A = 先点的(被人为延迟),B = 后点的(应该赢)
        A, B = fqn_a.split(".")[-1], fqn_b.split(".")[-1]
        colsA, colsB = measured[fqn_a], measured[fqn_b]
        only_a, only_b = colsA - colsB, colsB - colsA

        # ③ 人为延迟 **A** 的两个请求(产品里 `columns` 与 `classification` 是一个 `Promise.all`,
        #    延迟其中任一个就会把整次写 state 推后;两个都延迟更贴近真实的「那一次整体慢」)。
        DELAY = 8.0
        t0 = time.time()
        seen: dict = {"a": [], "b": [], "a_req": 0}

        async def _slow_a(route):
            if fqn_a in route.request.url:
                seen["a_req"] += 1
                await asyncio.sleep(DELAY)
            await route.continue_()

        def _on_resp(r):
            if "/api/governance/columns" not in r.url and "/api/governance/classification" not in r.url:
                return
            if fqn_a in r.url:
                seen["a"].append(round(time.time() - t0, 1))
            elif fqn_b in r.url:
                seen["b"].append(round(time.time() - t0, 1))

        await pg.route("**/api/governance/columns*", _slow_a)
        await pg.route("**/api/governance/classification*", _slow_a)
        pg.on("response", _on_resp)
        try:
            await _class_open(pg, fqn_a, wait_settled=False)   # 先点 A —— 被延迟,**不等它**
            await pg.wait_for_timeout(600)
            colsB2 = await _class_open(pg, fqn_b)              # 立刻点 B —— 马上回来并渲染
            # 🔴 等 A 那两个请求**也真的回来了**再读(等事件不等秒数:固定 sleep 读到的是中间态)
            for _ in range(int((DELAY + 40) * 2)):
                await pg.wait_for_timeout(500)
                if len(seen["a"]) >= 2:
                    break
            await pg.wait_for_timeout(3000)                # 给「陈旧响应写 state」留足提交时间
            final = await pg.evaluate(CLASS_COLS_JS)
        finally:
            pg.remove_listener("response", _on_resp)
            await pg.unroute("**/api/governance/columns*")
            await pg.unroute("**/api/governance/classification*")
        await shot(pg, shots, f"{tid}-governance-class-race")

        # ④ 夹具判据:A 的响应必须**确实晚于** B 的,否则竞态没发生 ⇒ 这条判据会假绿
        if seen["a_req"] == 0:
            raise RuntimeError("一次都没拦到 A 的请求 ⇒ 夹具没成立(判据不许在没制造竞态时变绿)")
        if len(seen["a"]) < 2 or not seen["b"]:
            raise RuntimeError(f"响应没收齐:A={seen['a']} B={seen['b']} ⇒ 判不了,不算过关")
        if max(seen["a"]) <= max(seen["b"]):
            raise RuntimeError(f"A 的响应没有晚于 B(A={seen['a']} B={seen['b']})⇒ 竞态压根没发生")
        if final is None:
            raise RuntimeError("读不到分级页签那张字段表(`null` = 判不了)⇒ 不算过关")
        fin = set(final)
        stale_won = sorted(only_a & fin)
        ok = (not stale_won) and bool(only_b & fin)
        ev = (f"A(先点、被延迟 {DELAY}s)={A} · B(后点、应该赢)={B} · "
              f"判别依据:A 独有字段={sorted(only_a)[:6]} B 独有字段={sorted(only_b)[:6]} · "
              f"响应时刻 A={seen['a']} B={seen['b']}(A 确实更晚 ⇒ 竞态确定发生)· "
              f"竞态后页面上列出的字段={sorted(fin)[:8]}{'…' if len(fin) > 8 else ''} ⇒ "
              + ("最后一次点的表赢了(陈旧响应被丢掉)" if ok
                 else f"🔴 **陈旧响应赢了** —— 页面列出了 A 独有的字段 {stale_won[:6]},"
                      f"而下拉里选的是 B ⇒ 用户会把敏感级别/脱敏策略打到**错的表**上")
              + (f" · 候选量测={{ {', '.join(f'{k}:{len(v)}列' for k, v in measured.items())} }}")
              + (f" · B 第二次量到 {len(colsB2)} 列" if colsB2 else ""))
        if ok:
            _CLASS_RACE["verified_on"] = tid
    except Exception as e:
        ok, ev = False, f"🔴 判据自身出错(不算过关):{str(e).splitlines()[0][:220]}"
    _CLASS_RACE["why"] = ev
    rep.add(tid, "5h 🔴🔴 治理页取数:**陈旧响应不许赢**(观察面=数据分级的字段清单,"
                 "人为延迟先点的那张表 ⇒ 竞态确定发生)", ok, ev, cap="governance", mode="manual")



# ── CAP-SEED:在该区下发一次造数(交付 4d2ae48)─────────────────────────────
#   主控区造数 = DROP + 重建源库 7 张示范表(5–8 分钟);其它区 = 重写该区湖里的 Parquet + 重建 Glue 表。
#   🔴 造数是**确定性重建**,行数不变 ⇒ 判据不看「行数增长」,看「该区造数作业有一次 SUCCEEDED、开始于触发之后」(真值)
#      + 运行实例页该区那一行到成功(页面)。
#   🔴 立即造数这一格**阻塞到终态**才往下走:主控区后面紧接着要跑同步,源库正在重建时同步会读到半截表。
#   🔴 生产模式部署不建造数作业 ⇒ 正确答案是页面如实报「该区没有造数作业」(409 seed-job-missing),不是成功。
_PROFILE = {"name": "temp-account"}


def _seed_job_name(tid: str) -> str:
    return "bgp-game-seed" if tid == HOME else f"bgp-game-seed-{tid}"


def _deploy_mode(region_home: str) -> str:
    try:
        ssm = boto3.Session(profile_name=_PROFILE["name"], region_name=region_home).client("ssm")
        return ssm.get_parameter(Name="/bgp/deploy-mode")["Parameter"]["Value"]
    except Exception:
        return "?"


def _seed_runs_after(region: str, tid: str, t0: float) -> list[dict]:
    glue = boto3.Session(profile_name=_PROFILE["name"], region_name=region).client("glue")
    try:
        runs = glue.get_job_runs(JobName=_seed_job_name(tid), MaxResults=10).get("JobRuns", [])
    except Exception as e:
        return [{"JobRunState": f"读不到:{type(e).__name__}"}]
    return [r for r in runs if r.get("StartedOn") and r["StartedOn"].timestamp() >= t0 - 60]


async def _seed_monitor_row(pg, base: str, tid: str, region: str, name: str, auto: bool, since: str) -> str:
    """运行实例页:名字 == name、区域 == 该区、触发 == 手动/自动、开始于 since 之后的那一行(逐行读 DOM)。回行文本或 ''。"""
    await goto_scope(pg, base, "/monitor", tid, settle="", budget_s=10)
    box = pg.locator('input[placeholder*="任务名称"]').or_(pg.locator('input[placeholder*="Task name"]')).first
    if await box.count():
        await box.fill(name)
    await pg.locator('[data-testid="monitor-search-btn"]').first.click()
    await pg.wait_for_timeout(4000)
    for w in await row_texts(pg, name):
        m_ts = re.match(r"\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", w)
        trig = ("自动" in w) if auto else ("手动" in w)
        if m_ts and m_ts.group(1) >= since and region in w and trig:
            return " ".join(w.split())
    return ""


async def seed_run_once_cell(pg, base: str, t: dict, rep: Rep, shots: str, home_region: str) -> None:
    tid, region = t["targetId"], t["region"]
    mode = _deploy_mode(home_region)
    t0 = time.time()
    since = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t0 - 60))
    ev, ok = "", False
    try:
        # 造数面板已按用户 2026-10-21 拍板移出前台(「造数据不需要在前台预留面板,这是测试使用的」)⇒ 本格改为**测试夹具**:
        #   在该区视角的页面上下文里直接 POST /api/seed/run(点名 targetId;与原面板同一条路由、同一份请求体);
        #   观测不变:页面(运行实例页该区「造数」手动行)+ 真值(该区 JobRun SUCCEEDED 晚于触发)。
        await goto_scope(pg, base, "/datasources", tid, settle="")
        resp = await pg.evaluate("""async (b) => { const r = await fetch('/api/seed/run', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)}); return {status: r.status, text: await r.text()}; }""",
            {"targetId": tid, "dataset": "gamedata"})
        rtxt = " ".join(str(resp.get("text", "")).split())
        is_ok = resp.get("status") == 202
        restate = f"POST /api/seed/run targetId={tid} dataset=gamedata ⇒ HTTP {resp.get('status')}"
        if mode == "production":
            ok = (not is_ok) and ("造数作业" in rtxt or "seed-job-missing" in rtxt)
            ev = f"部署模式 production ⇒ 应如实报没有造数作业 · 响应={rtxt[:160]!r}"
        else:
            row = ""
            if is_ok:
                for _ in range(40):   # ≤ 30 分钟,每 45s 看一次运行实例页
                    row = await _seed_monitor_row(pg, base, tid, region, f"造数 · {tid}", False, since)
                    if row and (any(x in row for x in SUCCESS_WORDS) or "失败" in row):
                        break
                    await pg.wait_for_timeout(45000)
            runs = _seed_runs_after(region, tid, t0)
            truth = [r.get("JobRunState") for r in runs]
            row_ok = bool(row) and any(x in row for x in SUCCESS_WORDS)
            ok = is_ok and tid in restate and row_ok and "SUCCEEDED" in truth
            ev = (f"复述={restate[:90]!r} · 结果={rtxt[:100]!r} · 运行实例行={row[:150]!r} · "
                  f"真值 {region} {_seed_job_name(tid)} 触发后的 JobRun={truth}")
    except Exception as e:
        ev = f"页面交互异常:{type(e).__name__}: {str(e)[:200]}"
    await shot(pg, shots, f"{tid}-seed-run-once")
    rep.add(tid, "1b 🔴 造数据(测试夹具;面板已按用户 10-21 拍板移出前台):POST /api/seed/run 点名**该区** ⇒ 该区造数作业跑 ⇒ 运行实例页该区「造数」手动行成功 + 该区 JobRun SUCCEEDED 晚于触发",
            ok, ev, cap="seed", mode="manual")


SEED_SCHED_PREFIX = "kf-gate-seedsch-"


async def seed_dispatch_arm(pg, base: str, t: dict, home_region: str) -> dict:
    """定时造数·装弹(测试夹具;面板已按用户 10-21 拍板移出前台):经 API 建一条**只触发一次**的定时(自定义 cron,UTC,约 7 分钟后)
    并启用(与原面板同样的两次请求)⇒ 回 {name, cron, since, taskId, a_n, na_n, err};a_n = 载体真挂上(deployments 有 workflowArn)。
    先把所有区都装上再一起收(cron 是墙上时间,串行等就是双倍 wall-clock)。"""
    tid = t["targetId"]
    fire = time.gmtime(time.time() + 7 * 60)
    st = {"name": f"{SEED_SCHED_PREFIX}{tid}-{time.strftime('%m%d%H%M', fire)}",
          "cron": f"{fire.tm_min} {fire.tm_hour} * * *",
          "since": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() - 60)),
          "taskId": "", "a_n": 0, "na_n": 0, "err": ""}
    try:
        await goto_scope(pg, base, "/datasources", tid, settle="")
        created = await pg.evaluate("""async (b) => { const r = await fetch('/api/seed/schedules', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)}); return {status: r.status, body: await r.json().catch(() => ({}))}; }""",
            {"name": st["name"], "dataset": "gamedata", "targetId": tid, "cronExpression": st["cron"]})
        row_c = (created.get("body") or {}).get("data") or {}
        st["taskId"] = str(row_c.get("taskId") or "")
        if not st["taskId"]:
            st["err"] = f"建定时造数失败:HTTP {created.get('status')} {json.dumps(created.get('body'), ensure_ascii=False)[:200]}"
            return st
        enabled = await pg.evaluate("""async (b) => { const r = await fetch('/api/schedule/enable', {method:'POST',
            headers:{'Content-Type':'application/json'}, body: JSON.stringify(b)}); return {status: r.status, body: await r.json().catch(() => ({}))}; }""",
            {"taskId": st["taskId"], "taskType": "seed", "cronExpression": st["cron"], "enabled": True})
        if not (enabled.get("body") or {}).get("success"):
            st["err"] = f"启用定时失败:HTTP {enabled.get('status')} {json.dumps(enabled.get('body'), ensure_ascii=False)[:200]}"
            return st
        await pg.wait_for_timeout(3000)
        # 「载体真挂上」= 读该区视角清单里这一行的 deployments[*].workflowArn(原面板绿标 isArmed 的同一判定)
        lst = await pg.evaluate("async (q) => (await (await fetch('/api/seed/schedules' + q)).json()).data || []", f"?scope={tid}")
        mine = [x for x in lst if str(x.get("taskId")) == st["taskId"]]
        armed = bool(mine) and bool(mine[0].get("scheduleEnabled")) and bool(mine[0].get("cronExpression")) and any(
            (d or {}).get("workflowArn") for d in (mine[0].get("deployments") or {}).values())
        st["a_n"] = 1 if armed else 0
        st["na_n"] = 0 if (armed or not mine) else 1
        if not mine:
            st["err"] = f"建好并启用后在该区视角清单里找不到 taskId={st['taskId']}"
    except Exception as e:
        st["err"] = f"页面交互异常:{type(e).__name__}: {str(e)[:200]}"
    return st


async def seed_dispatch_harvest(pg, base: str, t: dict, st: dict, rep: Rep, shots: str, budget_s: int = 1800) -> None:
    tid, region = t["targetId"], t["region"]
    armed = st["a_n"] == 1 and st["na_n"] == 0 and not st["err"]
    hit, t0 = "", time.time()
    while armed and time.time() - t0 < budget_s:
        r = await _seed_monitor_row(pg, base, tid, region, st["name"], True, st["since"])
        if r and (any(x in r for x in SUCCESS_WORDS) or "失败" in r):
            hit = r
            break
        await pg.wait_for_timeout(45000)
    await shot(pg, shots, f"{tid}-seed-dispatch")
    ok = armed and bool(hit) and any(x in hit for x in SUCCESS_WORDS)
    rep.add(tid, "1c 🔴 造数据的**下发执行**(测试夹具;面板已按用户 10-21 拍板移出前台):API 建定时造数 + 启用 ⇒ 载体真挂上(deployments 有 workflowArn)⇒ 由该区调度真跑成功(运行实例页「触发=自动」)⇒ 收口删定时",
            ok, (st["err"] or f"定时 {st['name']} cron={st['cron']!r}(UTC)· 绿标(有产物)={st['a_n']} · 待发布载体={st['na_n']} · "
                 f"自动行={hit[:150]!r}" + ("" if hit or not armed else f" · 等了 {int(time.time() - t0)}s 没有该区自动行")),
            cap="seed", mode="dispatch")


async def seed_dispatch_cleanup(pg, base: str) -> None:
    """建了必撤:删掉本段建的全部定时造数(按名字前缀;先撤载体再删记录 —— 撤不下来产品拒删并留记录 ⇒ 日志吼)。"""
    try:
        await goto_scope(pg, base, "/datasources", HOME, settle="", budget_s=10)
        lst = await pg.evaluate("async () => (await (await fetch('/api/seed/schedules')).json()).data || []")
        for it in [x for x in lst if str(x.get("name", "")).startswith(SEED_SCHED_PREFIX)]:
            code = await pg.evaluate("async (id) => (await fetch('/api/seed/schedules/' + id, {method:'DELETE'})).status", it.get("taskId"))
            log(f"[seed] 收口删定时造数 {it.get('name')} ⇒ HTTP {code}" + ("" if code == 200 else " 🔴 没删掉"))
    except Exception as e:
        log(f"[seed] 🔴 定时造数收口失败(账号里可能还留着定时造数!):{str(e)[:150]}")


# ── 逐区验证 ──────────────────────────────────────────────────────────────────
async def verify_target(pg, base: str, t: dict, rep: Rep, shots: str, run_sync: bool,
                        run_engines: bool = False, ddb=None, home_region: str = "us-east-1") -> None:
    tid, region, res = t["targetId"], t["region"], t["resources"]
    slug = tid.replace("tgt_", "").replace("_", "-")
    pfx = f"Showcase-{slug}"
    wg = res.get("redshiftWorkgroup") or ("bgp-workgroup" if tid == HOME else "")
    home_wg = "bgp-workgroup"
    log(f"\n=== 无头验证 {tid}({region})· 示范对象前缀 {pfx}-* ===")

    # 1 数据源
    txt = await goto_scope(pg, base, "/datasources", tid, settle=pfx)
    await shot(pg, shots, f"{tid}-datasources")
    n_src = txt.count(f"{pfx}-")
    rep.add(tid, "1 数据源页:该区的示范数据源在列表里", n_src > 0,
            f"页面上 {pfx}-* 出现 {n_src} 次" + ("" if n_src else "(空 = 用户切过来看不到东西)"),
            cap="seed", mode="manual")
    # 1b 🔴 造数「立即造数」(CAP-SEED 交付;原「产品无载体」登记 CAP-SEED-DISPATCH-NOCARRIER 关闭)
    await seed_run_once_cell(pg, base, t, rep, shots, home_region)

    # 2 同步
    txt = await goto_scope(pg, base, "/sync", tid, settle=f"{pfx}-Sync" if tid != HOME else f"{pfx}-GameSync")
    await shot(pg, shots, f"{tid}-sync")
    key = f"{pfx}-Sync" if tid != HOME else f"{pfx}-GameSync"
    n_task = txt.count(key)
    # 🔴 逐行读 DOM 判状态(字符窗口会跨行 ⇒ 拿邻居的「成功」放行自己,2026-09-19 真踩)
    rows_ = await row_texts(pg, key)
    ok_rows = [r for r in rows_ if any(w in r for w in SUCCESS_WORDS)]
    rep.add(tid, "2 数据同步页:该区的同步任务在列表里,且**每一行**都是成功态",
            bool(rows_) and len(ok_rows) == len(rows_),
            f"任务行 {len(rows_)} 个(页面文本出现 {n_task} 次)· 成功态的行 {len(ok_rows)} 个 —— 必须相等",
            cap="sync", mode="manual")

    if run_sync and n_task > 0:
        # 人的动线:在页面上点「启动」再等终态(不走接口)
        started = False
        try:
            row = pg.locator("tr", has_text=key).first
            btn = row.locator("text=启动").or_(row.locator("text=Start")).first
            if await btn.count():
                await btn.click()
                await pg.wait_for_timeout(3000)
                started = True
        except Exception as e:
            rep.add(tid, "2b 页面上点「启动」跑一次同步", False, f"点击失败:{str(e)[:120]}")
        if started:
            reached = ""
            t0 = time.time()
            while time.time() - t0 < 900:
                await pg.wait_for_timeout(20000)
                t2 = await goto_scope(pg, base, "/sync", tid, settle=key)
                near = row_state(t2, key, 400)
                if any(w in near for w in SUCCESS_WORDS):
                    reached = "成功"
                    break
                if "失败" in near or "failed" in near.lower():
                    reached = "失败"
                    break
            await shot(pg, shots, f"{tid}-sync-after-run")
            rep.add(tid, "2b 🔴 页面上点「启动」跑一次同步 ⇒ 页面自己变成成功态(人的动线)",
                    reached == "成功", f"轮询到的终态={reached or '超时未到终态'}")

    # 2c 调度配置页:该区的示范任务在「可下发」清单里(载体存在 —— 真跑那一格由 --run-dispatch 填)
    sch = await goto_scope(pg, base, SCHED_PATH, tid, settle=pfx, budget_s=25)
    await shot(pg, shots, f"{tid}-schedule")
    n_sched = sch.count(f"{pfx}-")
    rep.add(tid, "2c 调度配置页:该区的示范任务在清单里(下发载体在)", n_sched > 0,
            f"调度配置页上 {pfx}-* 出现 {n_sched} 次")

    # 2d 🔴🔴 呈现面:「已发布的载体上那份定义,还是当前生成器产出的吗」
    #     —— 改了产物生成器,存量载体**不会自动重发**;那不是一个 bug,是一台产 bug 的机器
    #     (本轮最重的就是从它的现场挖出来的)。机制在库里而界面上看不见 = 写了等于没写。
    # 🔴 四层都要钉,缺一层就不成立:
    #   ① 现网是 ok(否则下面「造完是 stale」可能是**恒 stale**,和恒 ok 一样没判别力);
    #   ② 造一个真落后的载体 ⇒ 那一行显示「载体需重新发布」,**且那一行不再有绿标**;
    #   ③ 点页面上的「重新发布」⇒ 回到「最新」(出路真的通,不是只报个警);
    #   ④ 还原夹具 ⇒ 又变 stale ⇒ 再发一次 ⇒ 回 ok(收口:最终状态与开工时逐字节相同)。
    # 🔴 逐行读徽标,不整页查:整页查 `carrier-drift-ok` 会被**邻居行**的绿标放行。
    await drift_badge_criteria(pg, base, tid, pfx, ddb, rep, shots)

    # 3 ETL / 计算(卡片列表,不是表格)
    txt = await goto_scope(pg, base, "/etl-jobs", tid, settle=f"{pfx}-ETL")
    await shot(pg, shots, f"{tid}-etl-jobs")
    have = {k: (f"{pfx}-{k}" in txt) for k in ("ETL-ChannelROI", "ETL-RetentionLTV", "EMR-BehaviorFunnel")}
    n_ok = sum(1 for k in have if have[k] and any(w in row_state(txt, f"{pfx}-{k}", 200) for w in SUCCESS_WORDS))
    rep.add(tid, "3 离线计算页:Redshift SQL 与 Glue PySpark 两个示范作业都在且成功态",
            have["ETL-ChannelROI"] and have["ETL-RetentionLTV"]
            and all(any(w in row_state(txt, f"{pfx}-{k}", 200) for w in SUCCESS_WORDS)
                    for k in ("ETL-ChannelROI", "ETL-RetentionLTV")),
            f"卡片在={have} · 成功态 {n_ok}/3", cap="etl", mode="manual")
    rep.add(tid, "3a 离线计算页:EMR Serverless 示范作业在且成功态(引擎不许有盲区)",
            have["EMR-BehaviorFunnel"]
            and any(w in row_state(txt, f"{pfx}-EMR-BehaviorFunnel", 200) for w in SUCCESS_WORDS),
            f"EMR 卡片在={have['EMR-BehaviorFunnel']}", cap="compute", mode="manual")
    # 3b 区标签:🔴 判据钉的是**事实**不是形状 —— 事实是「界面不说谎:不会把别的区的章挂在这里」。
    #   主控区的卡片**刻意一个区标都不挂**(产品明示:存量作业全是 home,挂满标反而把要注意的那几个淹没),
    #   所以「home 页面上要出现 tgt_home」是我钉错了形状(真环境实测 home 页 tgt_home 出现 0 次)。
    #
    # 🔴🔴 第二次订正(2026-09-19 夜):这条原来在**整页文本**上做负向断言(「页面上不出现
    #   别的区的 targetId」)—— 当场被打红,而**页面是对的**:同一页上有几个**多区绑定**的对象
    #   (`ui-*` 夹具绑了 home + usw2),页面给它挂上**所有绑定区**的标签,那正是「不丢东西」的
    #   护栏在起作用。整页负向断言 = **用邻居的数据把自己判红**(与「字符窗口跨行 ⇒ 用邻居的数据
    #   给自己放行」同一个根:判据必须锚定到**它要判的那个对象**)。
    #   ⇒ 改成逐对象读自己那一块(`object_texts` 通吃表格行 / 卡片 / 列表项):
    #     · 本区的每张 Showcase 卡片里**不许**出现别的区的 targetId(那才是「把别区的章挂在这里」);
    #     · 非 home 再加:它自己的 targetId 必须在**每张**卡片上出现(挂标是产品明示的设计)。
    show_names = [f"{pfx}-{k}" for k in ("ETL-ChannelROI", "ETL-RetentionLTV", "EMR-BehaviorFunnel")]
    # 🔴 第三次订正:锚点用**产品自己给的** `data-testid="job-row-<id>"` / `engine-job-row-<id>`。
    #   上一版用「取最小的含名元素」这个启发式 ⇒ **取得太小**:卡片的名字在自己的元素里,而区标是它的
    #   **兄弟**元素 ⇒ 三张卡片全被判成「没挂本区标」(而页面上标是挂着的)。启发式再调参只是换个猜法。
    #   教训:**判据要按对象锚定,就先找产品有没有给锚点** —— 本页早就有了,是我没用。
    #   没有锚点时才回落到 `object_texts`(它的局限写在函数注释里)。
    CARD = '[data-testid^="job-row-"], [data-testid^="engine-job-row-"]'
    bad_tag, missing_own = [], []
    for nm in show_names:
        blocks = await row_texts(pg, nm, css=CARD) or await L.object_texts(pg, nm)
        if not blocks:
            missing_own.append(f"{nm}(卡片读不到)")
            continue
        blk = blocks[0]
        strays = sorted({x for x in re.findall(r"tgt_[a-z0-9_]+", blk) if x != tid})
        if strays:
            bad_tag.append(f"{nm}→{strays}")
        if tid != HOME and tid not in blk:
            missing_own.append(f"{nm}(没挂本区标)")
    if tid == HOME:
        rep.add(tid, "3b 区标(逐卡片):主控区刻意不挂标,且**每张 Showcase 卡片**里不出现别的区的章",
                not bad_tag and not missing_own,
                f"挂了别区章的卡片={bad_tag or '无'} · 读不到的卡片={missing_own or '无'} —— "
                f"home 不挂标是产品明示的设计;🔴 整页里出现别区 targetId 是**合法的**"
                f"(多区绑定的对象会挂上所有绑定区的标签),所以这条只看每张卡片自己那一块")
    else:
        rep.add(tid, "3b 区标(逐卡片):每张 Showcase 卡片都挂本区的章,且不出现别的区的章",
                not bad_tag and not missing_own,
                f"挂了别区章的卡片={bad_tag or '无'} · 没挂本区标/读不到={missing_own or '无'}")

    # 3c 🔴 单独执行(manual):在**页面上**逐引擎点「立即运行」并等成功 —— 用户 2026-09-18 点名
    #     「下发执行、单独执行,各种操作都必须要验证到位;各种执行引擎都要执行到位,不然功能和引擎就会有盲区」。
    if run_engines:
        for cap_key, job_key in (("etl", "ETL-ChannelROI"), ("etl", "ETL-RetentionLTV"), ("compute", "EMR-BehaviorFunnel")):
            name = f"{pfx}-{job_key}"
            ok, ev = False, ""
            try:
                await goto_scope(pg, base, "/etl-jobs", tid, settle=name)
                await pg.locator(f"text={name}").first.click()
                await pg.wait_for_timeout(2500)
                # 🔴 两个面板两个 testid:Glue/Redshift 在页面本体(etl-run-btn),EMR 在 EmrJobPanel
                #   (emr-run-btn)。第一版只找前者 ⇒ EMR 那一格必红,而红的是判据不是产品。
                btn = pg.locator('[data-testid="etl-run-btn"], [data-testid="emr-run-btn"]').first
                if not await btn.count():
                    ev = "页面上找不到「立即运行」按钮(testid etl-run-btn / emr-run-btn)"
                else:
                    label = (await btn.inner_text()).strip()
                    await btn.click()
                    await pg.wait_for_timeout(2000)
                    # 多区绑定时会弹运行范围确认框;单区直接跑
                    modal = pg.locator('[data-testid="run-targets-modal"]')
                    if await modal.count() and await modal.is_visible():
                        await modal.locator("button", has_text="确").first.click()
                    # 等这张卡片的状态变成成功(页面自己的状态源)。
                    # 🔴 第五十轮(11-01)矩阵 compute × home × manual 唯一一格红 = 这里的读法:`row_state(整页文本, name, 200)` 是从作业名起
                    #   往后数 200 个字的文本窗口,卡片名被省略号截断 / 相邻卡片紧挨着时,窗口会读到**邻卡**的「失败」(产品侧台账与 EMR 都 succeeded)。
                    #   ⇒ 按卡片 DOM 锚定:行 testid `job-row-<id>` / `engine-job-row-<id>`(页面给无头验收的稳定锚点)filter(has_text=name) 只读这一张卡的文本;
                    #   找不到卡时才退回文本窗口(并在证据里写明)。判据对象不变,只是读法从「邻居的文本」改成「它自己的文本」(criteria-must-anchor-to-its-own-object)。
                    t0 = time.time()
                    reached = ""
                    read_via = ""
                    while time.time() - t0 < 1500:
                        await pg.wait_for_timeout(20000)
                        t2 = await goto_scope(pg, base, "/etl-jobs", tid, settle=name)
                        card = pg.locator("[data-testid^=job-row-], [data-testid^=engine-job-row-]").filter(has_text=name)
                        if await card.count():
                            near = " ".join((await card.first.inner_text()).split())
                            read_via = "卡片锚定"
                        else:
                            near = row_state(t2, name, 200)
                            read_via = "文本窗口(没找到卡片)"
                        if any(w in near for w in SUCCESS_WORDS):
                            reached = "成功"
                            break
                        if "failed" in near.lower() or "失败" in near:
                            reached = "失败"
                            break
                    ok = reached == "成功"
                    ev = f"按钮文案={label!r}(护栏:单区必须复述 region)· 轮询终态={reached or '超时'}(读法={read_via or '未读到'})"
            except Exception as e:
                ev = f"页面交互异常:{str(e)[:120]}"
            await shot(pg, shots, f"{tid}-run-{job_key}")
            rep.add(tid, f"3c 🔴 页面上点「立即运行」跑 {job_key}(单独执行)", ok, ev, cap=cap_key, mode="manual")

    # 4 编排
    txt = await goto_scope(pg, base, "/workflow", tid, settle=f"{pfx}-Flow")
    await shot(pg, shots, f"{tid}-workflow")
    rep.add(tid, "4 编排页:该区的示范工作流在列表里", f"{pfx}-Flow" in txt,
            f"含 {pfx}-Flow-ROI-Daily={f'{pfx}-Flow' in txt}")

    # 4a 🔴 在页面上点「触发」并等到成功 —— 2026-09-19 全新账号首装真撞到的缺陷只有这一步抓得到:
    #   刚 CreateWorkflow 完就 StartWorkflowRun 会撞 airflow-serverless 的角色传播窗口,
    #   产品当时把它抛成硬 500 ⇒ 页面上就是「编排触发失败」。已根治(startWorkflowRun 里重试),
    #   这条判据是它的**行为**看守:点了就必须跑到成功,不许只看「列表里有这一行」。
    if run_engines and f"{pfx}-Flow" in txt:
        wf_ok, wf_ev = False, ""
        try:
            row = pg.locator("tr", has_text=f"{pfx}-Flow").first
            trg = row.locator("a", has_text="触发").or_(row.locator("a", has_text="Trigger")).first
            if not await trg.count():
                wf_ev = "🔴 行上找不到「触发」"
            else:
                await trg.click()
                await pg.wait_for_timeout(2500)
                modal = pg.locator(".ant-modal-content").last
                if await modal.count() and await modal.is_visible():
                    await click_btn(modal, "触发运行", "确定", "OK")   # 多绑时先问「在哪些区跑」
                    await pg.wait_for_timeout(2500)
                t0 = time.time()
                reached = ""
                while time.time() - t0 < 900:
                    await pg.wait_for_timeout(20000)
                    t2 = await goto_scope(pg, base, "/workflow", tid, settle=f"{pfx}-Flow")
                    near = row_state(t2, f"{pfx}-Flow", 260)
                    if any(w in near for w in SUCCESS_WORDS):
                        reached = "成功"
                        break
                    if "失败" in near or "failed" in near.lower():
                        reached = "失败"
                        break
                wf_ok = reached == "成功"
                wf_ev = f"点了行上的「触发」· 轮询终态={reached or '超时未到终态'}"
        except Exception as e:
            wf_ev = f"页面交互异常:{str(e)[:120]}"
        await shot(pg, shots, f"{tid}-workflow-trigger")
        rep.add(tid, "4a 🔴 编排页上点「触发」⇒ 该区真跑到成功(角色传播窗口那个缺陷的看守)",
                wf_ok, wf_ev, cap="orchestration", mode="manual")
    else:
        rep.add(tid, "4a 编排页上点「触发」(需 --run-engines)", f"{pfx}-Flow" in txt,
                "本轮没带 --run-engines ⇒ 只核了对象在;这一格的**执行**判据要带上那个开关才算数",
                cap="orchestration", mode="manual")
    # 4b 🔴 下发执行(dispatch):页面上必须能看出「已发布到该区调度 + 定时」;并点一次触发
    sched_txt = row_state(txt, f"{pfx}-Flow", 400)
    has_cron = ("⏱" in sched_txt) or ("0 3" in sched_txt) or ("已发布" in sched_txt) or ("Published" in sched_txt) \
        or ("Scheduled" in sched_txt) or ("已调度" in sched_txt)
    rep.add(tid, "4b 🔴 编排页:该区的工作流**已下发**(页面上看得到已发布/定时)", has_cron,
            f"该行附近文本={sched_txt[:120]!r}", cap="orchestration", mode="dispatch")

    # 5 治理:目录搜得到该区的表 + 新鲜度
    await pg.goto(f"{base}/governance?scope={tid}", wait_until="domcontentloaded", timeout=60000)
    await pg.wait_for_timeout(4000)
    probe = "dws_channel_roi_daily"
    # ══════════════════════════════════════════════════════════════════════
    # 🔴🔴 **搜索 + 等稳态 + 时间线,唯一作者在 `kf_headless_lib.catalog_search_settled()`。**
    #
    # 这一处红过**两轮**硬门,而产品从头到尾是对的。第一版是 `fill` + 触发 + **固定 sleep 3s** + 读 DOM;
    # 带时间戳的对照实验(两次复现一致)显示搜索响应要 **8~12s** 才被接受,判据在 8.3s 读到的是
    # 「暂无数据」,而硬门那次读到「**未过滤的第一页 20 行**」—— **同一个根因的两种快照**,
    # 看你恰好读在哪一刻。我因此差点去查「为什么会显示未过滤列表」,那是个不存在的 bug。
    # 🔴 第二版只改了这一处 ⇒ 下一轮硬门 `DQ-P1` 立刻红在**同一个写法**上
    #   (`verify_dq_directquery.py` 里还有一份)⇒ **列举式修法一定漏第 N+1 个** ⇒ 收成单一作者。
    # ══════════════════════════════════════════════════════════════════════
    try:
        _names, crows, timeline, settled_at = await L.catalog_search_settled(pg, probe)
        searched = (f"已搜索过滤(单一作者 catalog_search_settled)"
                    + (f" · 稳态于 +{settled_at}s" if settled_at is not None else " · 🔴 45s 内没到稳态"))
    except Exception as e:
        crows, timeline, searched = [], [], f"🔴 搜索失败 {str(e)[:80]}"
    txt = await pg.evaluate("() => document.body.innerText || ''")
    await shot(pg, shots, f"{tid}-governance")
    fresh = ("同步" in txt or "fresh" in txt) and "0 张表" not in txt
    # 🔴 断言读**搜索结果行**,不读整页 innerText —— 整页会被「默认列表 / 别处的最近资产」放行
    #   (本仓 criteria-must-anchor-to-its-own-object:判据必须锚定到它要判的那个对象)。
    hit_row = [r for r in crows if probe in r]
    # 🔴 **夹具步骤自己要有判据**:搜索到底生效了没有 = 「每一条结果行都含关键词」。
    #   只看行数不够(全量第一页恰好 20 行也可能被当成结果)。
    filter_worked = bool(crows) and all(probe in r for r in crows)
    rep.add(tid, "5 治理页:目录里搜得到该区算出来的表 + 目录新鲜度在(不许显示 0 张表)",
            bool(hit_row) and filter_worked and fresh,
            f"{searched} · 结果行 {len(crows)} 条 · 命中 {probe} 的行 {len(hit_row)} 条 · "
            f"搜索真生效(每行都含关键词)={filter_worked} · 新鲜度/同步时间={fresh}"
            + ("" if filter_worked else f" · 🔴 前 2 行={crows[:2]}(没过滤 ⇒ 搜索没生效,判据不许拿默认列表放行)")
            # 🔴 常驻时间线:这条判据红过两轮,每次都靠现场重做时间戳实验才定得了性。
            + f" · 时间线={timeline}",
            cap="governance", mode="manual")

    # ══════════════════════════════════════════════════════════════════════
    # 5e 🔴🔴 **陈旧响应不许赢**(该缺陷的真根就是它)
    #
    # 【为什么这条判据必须人为制造竞态】竞态的行为判据**天生不稳定**:要它红,必须让
    #   「先发的那次」比「后发的那次」**晚回来**,而返回顺序不由判据控制 ——
    #   跑一百次可能九十九次是正常顺序,判据绿而缺陷完好无损(本仓 stale-response-race 那次
    #   就是**判据红而我手工绿**,因为我那个上下文恰好没触发竞态)。
    # ⇒ 用 `page.route` 把**先发那一次**的响应**人为延迟**,让它必然晚到。这样:
    #     · 产品没有序号保护 ⇒ 陈旧结果覆盖最新结果 ⇒ 本判据**必红**(2026-09-21 实测坐实);
    #     · 有序号保护       ⇒ 陈旧结果被丢弃       ⇒ 本判据**必绿**。
    #   判别力不靠运气,这才叫「无头浏览器验证通过」。
    # ══════════════════════════════════════════════════════════════════════
    race_ev = ""
    race_ok = False
    try:
        # 🔴 定位搜索框走**单一作者**(它自己找不到就响亮报错)
        cbox, _ridx = await L.catalog_box(pg)

        async def _names():
            """结果行的表名 —— 口径来自单一作者(别再各写一遍选择器)。"""
            return await pg.evaluate(L.CATALOG_NAMES_JS)

        async def _hits(kw, budget=45):
            """搜一次并等到稳态 —— 🔴 **唯一作者** `L.catalog_search_settled`,见它的文件头。"""
            got, _rows, _tl, _st = await L.catalog_search_settled(pg, kw, budget_s=budget)
            return got

        # ① 🔴🔴 **判别词必须从这个区自己的目录里推出来,不许写死。**
        #   上一版写死 `SHORT="dws"`,在 usw2 上只匹配到 1 行 ⇒ `only_short` 为空 ⇒
        #   这条判据**自己报「没有判别力」而红**。判别力不能依赖
        #   「某个区恰好有好几张同前缀的表」这种运气。
        #   闭合式做法:先取该区未过滤的一页名字,找一个**至少匹配两行**的公共前缀 ——
        #   SHORT = 那个前缀,LONG = 其中某一行的全名 ⇒ `only_short` 必非空(构造保证)。
        base_names = sorted(await _hits(""))
        LONG = SHORT = ""
        for plen in range(12, 2, -1):
            groups: dict[str, list[str]] = {}
            for n in base_names:
                if len(n) > plen:
                    groups.setdefault(n[:plen].lower(), []).append(n)
            cand = [(p, ns) for p, ns in groups.items() if len(ns) >= 2]
            if cand:
                p, ns = sorted(cand, key=lambda x: (-len(x[1]), x[0]))[0]
                SHORT, LONG = p, sorted(ns)[0]
                break
        if not SHORT:
            raise RuntimeError(f"该区目录里找不到「同前缀 ≥2 行」的表 ⇒ 造不出判别夹具"
                               f"(未过滤一页 = {base_names[:12]});这是**判据没有判别力**,不许让它绿")

        # ② 量两个词的结果集,算出**判别依据** = 只有短词才会匹配到的那些行。
        #   🔴 不比「行数」:基线行数本身会被别的请求影响(实测同一条件下量到过 20 行和 1 行两种值),
        #     拿它当判据 = 判据自己不稳。而「两个词的结果集有差异」这一点是稳定的。
        s_long = await _hits(LONG)
        s_short = await _hits(SHORT)
        only_short = s_short - s_long
        if not only_short:
            raise RuntimeError(f"两个搜索词结果集无差异(长={LONG!r}→{sorted(s_long)} 短={SHORT!r}→{sorted(s_short)})"
                               f"⇒ 这条判据没有判别力,必须换词而不是让它绿")

        # ② 人为延迟**先发那一次**,让陈旧响应必然晚到 ⇒ 竞态确定发生。
        delayed = {"n": 0}

        async def _slow_long(route):
            is_long = f"keyword={LONG}" in route.request.url
            if is_long:
                delayed["n"] += 1
                await asyncio.sleep(4.0)
            await route.continue_()
            if is_long:
                # 🔴 标记「延迟过的那一次已经放行」⇒ 下面等它而不是等一个固定秒数
                delayed["done"] = True

        await pg.route("**/api/governance/catalog*", _slow_long)
        await cbox.fill(LONG)
        await cbox.press("Enter")          # 先发长词 —— 被人为延迟 4s
        await pg.wait_for_timeout(250)     # 不等它回来
        await cbox.fill(SHORT)
        await cbox.press("Enter")          # 立刻发短词 —— 马上回来
        # 🔴 等长词那次**也真的回来了**再读:它被人为延迟 4s,而响应本身还要几秒。
        #   固定 9s 不够(判据 5 就是这么红了两轮)⇒ 等到「延迟过的那次已收到」再加一小段提交时间。
        for _ in range(60):
            await pg.wait_for_timeout(500)
            if delayed.get("done"):
                break
        await pg.wait_for_timeout(3000)
        final = await _names()
        await pg.unroute("**/api/governance/catalog*")
        won = only_short & set(final)
        race_ok = bool(won)
        race_ev = (f"判别依据(只有短词 {SHORT!r} 才匹配到的行)={sorted(only_short)} · "
                   f"人为延迟长词 {delayed['n']} 次 · 竞态后最终={sorted(set(final))} ⇒ "
                   + ("最后一次搜索赢了(陈旧响应被丢弃)" if race_ok
                      else "🔴 **陈旧的长词响应赢了** —— 前端没有丢弃陈旧响应"))
    except Exception as e:
        race_ok, race_ev = False, f"🔴 判据自身出错(不算过关):{str(e).splitlines()[0][:160]}"
    rep.add(tid, "5e 🔴🔴 目录搜索:**陈旧响应不许赢**(人为延迟先发那次 ⇒ 竞态确定发生,判别力不靠运气;"
                 "「某区视角显示别的区的数仓」的真根就是它)", race_ok, race_ev,
            cap="governance", mode="manual")

    # ══════════════════════════════════════════════════════════════════════
    # 5f 🔴🔴 **:目录搜索不许影响别的页签的「可选资产」清单。**
    #
    # 【这条判据是怎么来的】(`5b` 超时)我原先判成「纯判据问题,不许改产品」。
    #   决定性对照实验(同一浏览器同一次运行,只差「中间搜没搜」)推翻了它:
    #     A 组 全新进页面        ⇒ 质量页签下拉输入探针表 ⇒ **1 条,选得到**
    #     B 组 先在目录里搜别的词 ⇒ 同一串操作           ⇒ **空态,选不到**
    #   根因:血缘 / 影响分析 / 数据分级 / 数据质量**四处**都写着
    #   `options={catalogData.map(...)}`,而 `catalogData` 的语义是
    #   **「目录页签当前那次搜索的结果」** —— 一份 state 被当成两件事用。
    #   用户视角:在目录里搜过一次之后,想给别的表跑质量检查就选不到了,
    #   而界面上**没有任何线索**(得回目录把搜索框清空才行)。
    #
    # 🔴 **夹具自己要有判据**:先断「用来搅浑的那个词搜出来的结果里确实不含探针表」——
    #   否则这条判据会在一个「其实没搅浑」的场景里轻松变绿(没有判别力)。
    # 🔴 判别力不靠运气:修复前这一步**必然**空态(上面那个 A/B 实验已坐实),
    #   修复后必然选得到 —— 两种实现的结果不同,这才叫判得出来。
    # ══════════════════════════════════════════════════════════════════════
    f_ok, f_ev = False, ""
    try:
        # ① 找一个「不是探针表」的真实资产名当搅浑用的搜索词
        _names0, _r0, _t0, _s0 = await L.catalog_search_settled(pg, "")
        other = next((n for n in sorted(_names0) if probe not in n), "")
        if not other:
            raise RuntimeError(f"该区目录里除了 {probe!r} 没有第二张表 ⇒ 造不出「候选被过滤掉」的场景(判据没有判别力)")
        # ② 搅浑:把目录搜成一个**不含探针表**的结果集
        _fn, _fr, _ftl, _fst = await L.catalog_search_settled(pg, other)
        if any(probe in n for n in _fn):
            raise RuntimeError(f"夹具不成立:用 {other!r} 搜出来的结果里含 {probe!r} ⇒ 没搅浑,这条判据会假绿")
        if not _fn:
            raise RuntimeError(f"夹具不成立:用 {other!r} 搜出来是空的 ⇒ 分不清「被过滤掉」与「压根没数据」")
        # ③ 切到数据质量页签,看它的资产下拉还能不能选到探针表
        if not await click_tab(pg, "数据质量", "Data Quality", "Quality"):
            raise RuntimeError("找不到「数据质量」Tab")
        _space = pg.locator(".ant-space").filter(
            has=pg.locator("button", has_text="运行检查").or_(pg.locator("button", has_text="Run check"))
        ).first
        await _space.wait_for(state="visible", timeout=25000)
        _sel = _space.locator(".ant-select").first
        await _sel.wait_for(state="visible", timeout=15000)
        await _sel.click()
        await _sel.locator("input").first.fill(probe)
        _opt = pg.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter(
            has_text=probe
        )
        try:
            await _opt.first.wait_for(state="visible", timeout=12000)
            f_ok = True
        except Exception:
            f_ok = False
        _cnt = await _opt.count()
        _empty = await pg.evaluate(
            "() => document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-empty').length")
        await pg.keyboard.press("Escape")
        f_ev = (f"搅浑用的词={other!r}(搜出 {len(_fn)} 张、确认不含探针表)· "
                f"随后在**数据质量**页签搜 {probe!r} ⇒ 候选 {_cnt} 条 · 空态节点={_empty} ⇒ "
                + ("候选清单没被目录搜索污染" if f_ok
                   else "🔴 **选不到了** —— 资产候选清单被「目录搜索结果」污染(一份 state 两个语义)"))
    except Exception as e:
        f_ok, f_ev = False, f"🔴 判据自身出错(不算过关):{str(e).splitlines()[0][:160]}"
    rep.add(tid, "5f 🔴🔴 目录搜索**不许**影响别的页签的可选资产清单(`catalogData` 一份 state 两个语义)",
            f_ok, f_ev, cap="governance", mode="manual")

    # ══════════════════════════════════════════════════════════════════════
    # 5g 🔴 **进治理页只取一次目录数据**,且候选清单真的会就绪。
    #
    # 【为什么非要一条行为判据】该缺陷的**第一版修法**是「初始化各调一次」
    #   (`searchCatalog("")` + `loadAllAssets()`),当时 11 条结构判据**全绿**,
    #   而带时间戳的真环境测量当场否证:
    #     1.6s REQ keyword=&scope=…   ← 两条请求**参数逐字节相同**
    #     1.6s REQ keyword=&scope=…
    #     6.2s RESP 200                ← 第一个
    #    10.4s RESP 200                ← 第二个被拖慢 4.2s(服务端串行处理这个重活)
    #   ⇒ 候选清单就绪 **+6.2s → +11.1s**,用户一进页面点「数据质量」就是空下拉。
    #   🔴 **「多发了一次一模一样的请求」这件事,文本判据看不见** —— 只有数真实请求才看得见。
    #
    # 🔴 就绪判据**等事件不等秒数**(本批纪律):轮询到候选非空为止,预算有界。
    # 🔴 夹具自己要有判据:必须**真的重新进过一次页面**(请求数 ≥ 1),否则这条判据在数 0 个请求时也会绿。
    # ══════════════════════════════════════════════════════════════════════
    g_ok, g_ev = False, ""
    try:
        _n = {"req": 0}

        def _count_req(r):
            if "/api/governance/catalog" in r.url:
                _n["req"] += 1

        pg.on("request", _count_req)
        _t0 = time.time()
        await pg.goto(f"{base}/governance?scope={tid}", wait_until="domcontentloaded", timeout=60000)
        # 等候选清单就绪(等的是「它非空了」,不是秒数);预算 40s
        _ready_at = None
        _opts_n = 0
        for _ in range(40):
            await pg.wait_for_timeout(1000)
            # 候选清单在 React state 里,DOM 上只有下拉打开才看得见 ⇒ 用「目录页签的计数」当就绪信号:
            # 它与候选清单在**同一次取数**里被填(bootstrapCatalog),所以它非 0 就说明那一次已经回来了。
            _txt = await pg.evaluate("() => document.body.innerText || ''")
            _m = re.search(r"(?:数据目录|Catalog)\s*\((\d+)\)", _txt)
            if _m and int(_m.group(1)) > 0:
                _ready_at = round(time.time() - _t0, 1)
                _opts_n = int(_m.group(1))
                break
        pg.remove_listener("request", _count_req)
        if _n["req"] == 0:
            raise RuntimeError("这次进页面一个目录请求都没发出 ⇒ 夹具没成立(判据不许在数 0 个请求时变绿)")
        g_ok = (_n["req"] == 1) and (_ready_at is not None)
        g_ev = (f"进页面发出 {_n['req']} 次 /api/governance/catalog 请求(必须恰好 1 次)· "
                + (f"候选/目录就绪于 +{_ready_at}s({_opts_n} 行)" if _ready_at is not None
                   else "🔴 40s 内一直没就绪")
                + ("" if _n["req"] == 1 else
                   " ⇒ 🔴 **多发了参数相同的请求**:它们会在服务端串行、互相拖慢,首屏候选清单更晚就绪"))
    except Exception as e:
        g_ok, g_ev = False, f"🔴 判据自身出错(不算过关):{str(e).splitlines()[0][:160]}"
    rep.add(tid, "5g 🔴 进治理页**只取一次**目录数据,且候选清单会就绪(别拿多一次请求换语义分离)",
            g_ok, g_ev, cap="governance", mode="manual")

    # 5h 🔴🔴 陈旧响应不许赢(见 `class_race_criterion` 的整段理由)。
    #    🔴 刻意放在 5g **之后**:5g 刚重进过一次页面 ⇒ 目录是**未过滤**的一页(5f 搅浑过搜索框),
    #      而这条判据要从未过滤的目录里挑夹具表。
    await class_race_criterion(pg, base, tid, rep, shots)

    # 5b 🔴 治理**真执行**一次:数据质量「运行检查」是实时打在**该区数仓**上的(不是元数据)。
    #     🔴 空输入陷阱:没有规则时它也会「成功地什么都不做」(0/0/0)⇒ 判据必须要求
    #        「评分有数 + 至少一条规则有非『未运行』的结果」,否则就是又一次 vacuous success。
    qok, qev = False, ""
    try:
        picked = await click_tab(pg, "数据质量", "Data Quality", "Quality")
        if not picked:
            qev = "🔴 找不到「数据质量」Tab"
        else:
            # ══════════════════════════════════════════════════════════════
            # 🔴🔴 **2026-09-21 订正:这里原来用「全页 `.ant-select` 的下标」认控件,它偏了。**
            #
            # 原写法:先在 JS 里按语义找到那个 Select(对的),再把它**换算成全页 `.ant-select`
            # 的下标**交给 Playwright(错的)。`click_tab` 之后**没有等这一屏渲染完**就算下标,
            # 一旦质量 Tab 的内容晚到一点,下标就落到别的 Select 上 ⇒ 填错框 ⇒ Enter 什么也没选上
            # ⇒ 「运行检查」按钮**一直 disabled** ⇒ `btn.click()` 干等 **30s 超时**,
            # 而报出来的症状是一句 `Locator.click: Timeout` —— 离根因很远。
            # (本仓早有这条铁律:**门禁/判据不许用下标表达语义**。)
            #
            # 🔴 改成**全程用结构关系**,不出现任何下标:
            #   `.ant-space` 里含「运行检查」按钮的那一个 → 它的第一个 `.ant-select`;
            #   并且**先等它可见**再动手(等的是元素,不是秒数)。
            # 🔴 选项要**点中那一条**而不是按 Enter(Enter 在「下拉还没过滤完」时什么也不选)。
            # 🔴 **夹具步骤自己要有判据**:选完必须断「按钮真的变可用了」——
            #   否则下一步就是那个 30s 超时,而它会把根因藏起来。
            # ══════════════════════════════════════════════════════════════
            space = pg.locator(".ant-space").filter(
                has=pg.locator("button", has_text="运行检查").or_(pg.locator("button", has_text="Run check"))
            ).first
            await space.wait_for(state="visible", timeout=25000)
            sel = space.locator(".ant-select").first
            await sel.wait_for(state="visible", timeout=15000)
            await sel.click()
            await sel.locator("input").first.fill(probe)
            # 等**那一条选项**出现(不是等秒数),再点它
            # 🔴 2026-10-12 第二十九轮订正:原来 has_text=probe(**子串**)取 .first —— 目录里一旦有别的表名含这个子串
            #   (那轮 = `tmp_dws_channel_roi_daily_ro…`,0 条规则),就点到它 ⇒ 运行检查「成功地什么都不做」⇒ 评分=无,
            #   而八轮绿只是靶表恰好排第一。改为**整词**匹配(前后都不是标识符字符),并把选中的那条写进证据。
            _word = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(probe) + r"(?![A-Za-z0-9_])")
            opt = pg.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option").filter(
                has_text=_word
            ).first
            await opt.wait_for(state="visible", timeout=20000)
            _opt_text = (await opt.inner_text()).strip()
            await opt.click()
            # 🔴 读「选中了哪张表」只认 Select 自己显示的文字(用户看到的那一行):这版 antd 把选中值渲染在 `.ant-select-content`
            #   (带 title),根本没有 `.ant-select-selection-item`(第三十 / 三十一轮两次 10s 超时都栽在钉错了这个类名;真 DOM 探针坐实)。
            #   不钉内部类名,轮询 ≤ 10s 直到显示文字含整词;再按 Escape 收起下拉。
            _picked = ""
            _t_pick = time.time()
            while time.time() - _t_pick < 10:
                _picked = (await sel.inner_text()).strip()
                if _word.search(_picked):
                    break
                await pg.wait_for_timeout(250)
            await pg.keyboard.press("Escape")
            if not _word.search(_picked):
                raise RuntimeError(f"夹具没就位:选中的是 {_picked!r},不是整词 {probe!r}(候选那条={_opt_text!r})")
            btn = space.locator("button", has_text="运行检查").or_(space.locator("button", has_text="Run check")).first
            if not await btn.count():
                qev = "🔴 找不到「运行检查」按钮"
            elif not await btn.is_enabled(timeout=15000):
                # 🔴 夹具判据:选表没生效就**在这里**说清楚,不要让它退化成一句 30s click 超时
                qev = (f"🔴 夹具没就位:选了表 {probe!r} 之后「运行检查」按钮仍 disabled "
                       f"⇒ 说明这次选择没落到那个 Select 上(判据不许接着点下去等超时)")
            else:
                await btn.click()
                t0 = time.time()
                while time.time() - t0 < 180:
                    await pg.wait_for_timeout(5000)
                    q = await pg.evaluate("() => document.body.innerText || ''")
                    if ("质量评分" in q or "Quality score" in q) and re.search(r"(passed|failed|error)", q):
                        break
                q = await pg.evaluate("() => document.body.innerText || ''")
                m = re.search(r"(?:质量评分|Quality score)\s*\n?\s*([0-9]+)", q)
                ran = bool(re.search(r"\b(passed|failed)\b", q)) and ("未运行" not in q or q.count("未运行") == 0)
                qok = bool(m) and ran
                qev = (f"选中={_picked!r} · 评分={m.group(1) if m else '无'} · 规则最近结果有非「未运行」态={ran}"
                       f"(0 规则时平台也会『成功地什么都不做』,故两条都要)")
    except Exception as e:
        qev = f"页面交互异常:{str(e)[:120]}"
    await shot(pg, shots, f"{tid}-governance-quality")
    rep.add(tid, "5b 🔴 治理页「运行检查」在**该区数仓**上真跑出结果(空规则的假绿已堵)", qok, qev,
            cap="governance", mode="manual")

    # 5c 治理的「下发执行」:🔴 载体已交付(平台动作节点 + 定时治理任务)⇒ 登记关闭,
    #     改成真跑判据 —— 装弹在 dispatch_arm ④(页面建定时任务 → 绿标看产物),收弹在 dispatch_harvest
    #     (/monitor 等「触发=自动 + 该区 + 成功」那一行)。

    # 6 建模:🔴 默认停在「数仓分层」Tab,码表/维度建模的表格**根本没渲染** ⇒ 必须点 Tab 再读。
    #   manual  = 该区的示范定义在列表里看得见
    #   dispatch= 「落地」把定义物化到该区(控制面 → 该区数据面);非 home 现状 = credential-gap
    await goto_scope(pg, base, "/modeling", tid, settle="", budget_s=10)
    seen_ct = seen_dim = False
    txt_ct = txt_dim = ""
    picked_ct = await click_tab(pg, "码表", "Code table", "Code tables")
    if picked_ct:
        txt_ct = await pg.evaluate("() => document.body.innerText || ''")
        seen_ct = f"{pfx}-dim_code_channel_type" in txt_ct
        await shot(pg, shots, f"{tid}-modeling-codetables")
    picked_dim = await click_tab(pg, "维度建模", "Dimensional modeling", "Dimension")
    if picked_dim:
        txt_dim = await pg.evaluate("() => document.body.innerText || ''")
        seen_dim = f"{pfx}-dim_channel" in txt_dim
        await shot(pg, shots, f"{tid}-modeling-dimensions")
    rep.add(tid, "6 建模页:点「码表」「维度建模」两个 Tab,该区的示范定义都在列表里",
            seen_ct and seen_dim,
            f"Tab 命中={picked_ct or '❌'}/{picked_dim or '❌'} · 码表在={seen_ct} · 维度在={seen_dim}",
            cap="modeling", mode="manual")

    # 6b 落地(= 建模的下发执行):逐区观测态由 `LandedTags` 渲染成 `<区>: <状态>` 的标签
    #   🔴 第一版把非 home 写成**硬编码 gap**,那条判据永远不会变绿 —— 交付了它也照样 ⚠️,
    #     等于「登记」变成了「免检」。而且它扫的字样(credential / 凭证)页面上根本不出现:
    #     UI 真正渲染的是「⊘ 缺写入通道」(LAND_TAG)。两处都改成**按页面真文本逐区读**:
    #     已落地(✓)⇒ ok;⊘ 缺写入通道 ⇒ gap(登记);其它(未落 / drift / 失败)⇒ 判红。
    txt = (txt_ct or "") + "\n" + (txt_dim or "")
    mark = "本地" if tid == HOME else tid      # home 的标签写「本地」,非 home 写 targetId
    m = re.search(re.escape(mark) + r":\s*([^\n\t]{1,24})", txt)
    st_txt = (m.group(1).strip() if m else "")
    landed_ok = st_txt.startswith("✓")
    cred_gap = "缺写入通道" in st_txt or "⊘" in st_txt
    if tid == HOME:
        rep.add(tid, "6b 建模落地:定义已物化到主控区(行上逐区观测态 = ✓)", landed_ok,
                f"该区标签文本={st_txt!r}(应以 ✓ 开头)", cap="modeling", mode="dispatch")
    elif landed_ok:
        rep.add(tid, "6b 🎉 建模落地到非主控区**已成立**(窄权写通道已交付)", True,
                f"该区标签文本={st_txt!r} —— 可以把这一格的登记项关掉了", cap="modeling", mode="dispatch")
    elif cred_gap:
        rep.add(tid, "6b 建模落地到非主控区(登记:窄权写通道未交付)", False,
                f"该区标签文本={st_txt!r} = ⊘ 缺写入通道 —— 七类能力里唯一还不成立的那类,如实登记",
                gap=True, cap="modeling", mode="dispatch", reg="CAP-MODELING-DISPATCH-WP11B")
    else:
        rep.add(tid, "6b 建模落地到非主控区:观测态既不是 ✓ 也不是「缺写入通道」⇒ 判红", False,
                f"该区标签文本={st_txt!r}(未落 / drift / 失败都算红:那是真出问题,不是已知缺口)",
                cap="modeling", mode="dispatch")

    # ══════════════════════════════════════════════════════════════════════════
    # 8 实时计算
    # 🔴 与其它能力不同:流式作业的「成功」**不是终态 succeeded,而是持续运行中**。
    #   manual = 人在该区页面上对这一个作业点一次「停止」再点「启动」,并**等它回到运行中**
    #            (收口断言:不是「点了没报错」,而是回到稳态 —— 示范对象跑完还得在跑)。
    #   dispatch = 另一相:在**主控区视角**一次提交勾多个区,由平台把作业下发到各区(见
    #              verify_realtime_dispatch)。这一格不在这里填。
    # ══════════════════════════════════════════════════════════════════════════
    rt_name = f"{pfx}-RT-OrderAmount1m"
    txt = await goto_scope(pg, base, "/realtime-compute", tid, settle=rt_name, budget_s=40)
    await shot(pg, shots, f"{tid}-realtime")
    # 🔴🔴 **不只读第一页**。第一页先读(它同时告诉我「用户一眼看不看得见」),
    #   第一页没有就用产品自己的分页翻下去 —— 「产品能力在不在」与「用户一眼看不看得见」
    #   是**两件事**,分两条判据钉(可见性由 `8e` 残留清零守住,不许靠放宽 `8` 蒙过去)。
    rt_rows = await row_texts(pg, rt_name)
    on_first_page = bool(rt_rows)
    page_note = "第 1 页"
    if not rt_rows:
        all_txt = await table_rows_all_pages(pg)
        rt_rows = [t for t in all_txt if rt_name in t]
        page_note = f"**不在第 1 页**(翻完 {len(all_txt)} 行才找到)" if rt_rows else "翻完所有页都没有"
    running_now = any(("运行中" in r) or ("Running" in r) for r in rt_rows)
    rep.add(tid, "8 实时计算页:该区的示范流作业在列表里,且**正在运行**",
            bool(rt_rows) and running_now,
            f"匹配行 {len(rt_rows)} 条 · 有「运行中」={running_now} · 位置={page_note} · "
            f"首行={' '.join((rt_rows[0] if rt_rows else '').split())[:110]!r}",
            cap="realtime", mode="manual")

    # 8e 🔴🔴 **建了必撤**(该缺陷的根治那一半):实时计算页上不许留验收残留。
    #   残留本身不影响产品对不对,但它**把示范对象挤出第一页** ⇒ 用户切过来「什么都没看见」。
    #   🔴 闭合式按**前缀**查(不是「本轮建的删掉就算」):那 3 个 `DispatchCheck-RT-*` 正是
    #     以前某几轮**删失败**留下的,而当时清理失败只写 log、没有判据 ⇒ 静默累积。
    resid_all = await table_rows_all_pages(pg)
    resid = [t for t in resid_all if any(pfx in t for pfx in RESIDUE_JOB_PREFIXES)]
    rep.add(tid, "8e 🔴🔴 实时计算页**零验收残留**(建了必撤;残留会把示范对象挤出第一页 ⇒ 用户眼里「没做」)",
            not resid,
            (f"全表 {len(resid_all)} 行,残留 0 条 · 示范作业在{page_note}" if not resid else
             f"🔴 残留 {len(resid)} 条(前缀 {RESIDUE_JOB_PREFIXES}):"
             + " / ".join(" ".join(t.split())[:40] for t in resid[:6])
             + " ⇒ 建了必撤;删数据要用户逐个指名,清单已列全"))
    # 8b 负向控制:该区的列表里**不许**出现别的区的示范流作业(流式一区一个,页面按 ?scope= 过滤)
    others_rt = [x for x in re.findall(r"Showcase-[a-z0-9-]+-RT-OrderAmount1m", txt) if x != rt_name]
    rep.add(tid, "8b 负向:该区的实时计算页不出现**别的区**的示范流作业",
            not others_rt, f"页面上出现的其它区流作业={sorted(set(others_rt)) or '无'}(必须无)")

    # 8c manual:停一次 → 起一次 → 回到运行中(只有带 --run-engines 才做:它要动真资源、分钟级)
    if run_engines and rt_rows:
        ev, ok = "", False
        try:
            async def rt_state() -> str:
                await goto_scope(pg, base, "/realtime-compute", tid, settle=rt_name, budget_s=30)
                rows_ = await row_texts(pg, rt_name)
                return " ".join((rows_[0] if rows_ else "").split())

            async def click_row_link(label: str) -> bool:
                row = pg.locator("tr", has_text=rt_name).first
                a = row.locator("a", has_text=label).first
                if not await a.count():
                    return False
                await a.click(timeout=15000)
                await pg.wait_for_timeout(2500)
                return True

            stopped = started = False
            if not await click_row_link("停止"):
                ev = "🔴 行上找不到「停止」(作业不在运行/启动态?)"
            else:
                t0 = time.time()
                while time.time() - t0 < 900:
                    await pg.wait_for_timeout(20000)
                    s = await rt_state()
                    if ("已停止" in s) or ("Stopped" in s):
                        stopped = True
                        break
                    if ("失败" in s) or ("error" in s.lower()):
                        break
                if not stopped:
                    ev = "🔴 点了「停止」但 15 分钟内没到「已停止」"
                else:
                    # 🔴 antd 的行内链接在上一个动作的 message 还在时也能点,但表格可能还没重渲染 ⇒ 重新开页再点
                    if not await click_row_link("启动"):
                        ev = "🔴 停下来之后行上找不到「启动」"
                    else:
                        t1 = time.time()
                        while time.time() - t1 < 1200:
                            await pg.wait_for_timeout(20000)
                            s = await rt_state()
                            if ("运行中" in s) or ("Running" in s):
                                started = True
                                break
                            if ("失败" in s) or ("error" in s.lower()):
                                break
                        ev = ("停 → 起 一个来回都在页面上完成,状态回到「运行中」" if started
                              else "🔴 点了「启动」但 20 分钟内没回到「运行中」(示范对象现在是停的!)")
            ok = stopped and started
        except Exception as e:
            ev = f"页面交互异常:{str(e)[:140]}"
        await shot(pg, shots, f"{tid}-realtime-restart")
        rep.add(tid, "8c 🔴 实时计算的单独执行:页面上「停止」→「启动」并**回到运行中**(收口断言)",
                ok, ev, cap="realtime", mode="manual")

    # ══════════════════════════════════════════════════════════════════════════
    # 9 智能问数
    #   manual = 在该区页面上真问一次 → 有答案 → 「保存对话」存成卡片 → 在「我的卡片」里
    #            **打开续聊**(三步都在页面上;只核「有历史」等于没验用户看得见的那一面)。
    #   dispatch = 产品**没有载体**(没有定时问数 / 订阅式报告)⇒ 如实登记,判据带判别力(见 9c)。
    # ══════════════════════════════════════════════════════════════════════════
    ask_title = f"{pfx}-Ask-"
    await pg.goto(f"{base}/genbi?scope={tid}", wait_until="domcontentloaded", timeout=60000)
    await pg.wait_for_timeout(4000)
    gtxt = await L.page_text(pg)
    await shot(pg, shots, f"{tid}-genbi")
    # 9a 落点复述:问数页必须当场说清「在哪个区问」(护栏 2)
    note = ""
    try:
        n = pg.locator('[data-testid="genbi-scope-note"]')
        if await n.count():
            note = (await n.first.inner_text()).strip()
    except Exception:
        pass
    mark = region if tid != HOME else HOME
    rep.add(tid, "9a 问数页把「在哪个区问」复述出来(落点复述护栏)",
            bool(note) and (region in note or tid in note),
            f"genbi-scope-note={note[:120]!r}(应含 {mark})")

    # 9b 该区的示范卡片在「我的卡片」里,且能**打开续聊**
    card_ok, card_ev = False, ""
    try:
        if await pg.locator('[data-testid="genbi-my-cards-btn"]').count():
            await pg.locator('[data-testid="genbi-my-cards-btn"]').first.click()
            await pg.wait_for_timeout(3000)
            drawer = pg.locator('[data-testid="genbi-cards-drawer"]')
            dtxt = (await drawer.first.inner_text()) if await drawer.count() else ""
            if ask_title not in dtxt:
                card_ev = f"🔴 卡片抽屉里没有 {ask_title}*(切到这个区看不到示范问数)· 抽屉文本={dtxt[:160]!r}"
            else:
                # 找到那张卡片所在的 List.Item,点它的「打开续聊」
                item = pg.locator(".ant-list-item", has_text=ask_title).first
                opener = item.locator('a[data-testid^="genbi-card-open-"]').first
                if not await opener.count():
                    card_ev = "🔴 卡片行上找不到「打开续聊」入口"
                else:
                    await opener.click()
                    await pg.wait_for_timeout(3500)
                    # 可能弹「这张卡片属于另一个区」的确认(本判据是同区打开 ⇒ 正常不该弹)
                    sw = pg.locator('[data-testid="genbi-card-switch-resume"]')
                    if await sw.count() and await sw.first.is_visible():
                        await sw.first.click()
                        await pg.wait_for_timeout(3500)
                    after = await L.page_text(pg)
                    # 打开成功的事实:对话正文里出现那一轮的问题文本
                    card_ok = "roas" in after.lower() or "ROAS" in after
                    card_ev = (f"卡片在抽屉里 + 点了「打开续聊」· 正文里出现那一轮问题={card_ok}")
        else:
            card_ev = "🔴 问数页上找不到「我的卡片」按钮"
    except Exception as e:
        card_ev = f"页面交互异常:{str(e)[:140]}"
    await shot(pg, shots, f"{tid}-genbi-cards")
    rep.add(tid, "9b 🔴 智能问数的单独执行:该区的示范会话卡片在「我的卡片」里,且能打开续聊",
            card_ok, card_ev, cap="genbi", mode="manual")

    # 9c 问数的「下发执行」:🔴 载体已交付(问数卡片定时刷新)⇒ 登记关闭,改成真跑判据
    #     装弹在 dispatch_arm ⑤(给 9b 那张示范卡配定时 → 绿标),收弹在 dispatch_harvest
    #     (监控页名字是「问数卡片 <cardId 末 6 位>」,标题只留在该区 ⇒ 按这个名字过滤,不能按 pfx)。

    # 7 直查:工作组 / Endpoint 必须是该区的(负向:整页不许出现主控区的 workgroup 名)
    txt = await goto_scope(pg, base, "/redshift", tid, settle=wg or "Endpoint", budget_s=40)
    await shot(pg, shots, f"{tid}-redshift")
    bare_home = len(re.findall(re.escape(home_wg) + r"(?![-\w])", txt))
    if tid == HOME:
        rep.add(tid, "7 直查页:工作组与 Endpoint 是主控区的(正向控制:必须命中)", bare_home > 0,
                f"整页命中裸 {home_wg} {bare_home} 次(应 >0)")
    else:
        rep.add(tid, "7 🔴 直查页:工作组与 Endpoint 是**该区**的,整页不出现主控区的工作组名",
                (wg in txt) and bare_home == 0,
                f"含该区 {wg}={wg in txt} · 裸 {home_wg} 命中 {bare_home} 次(必须 0 —— 出现即界面在说谎)")


# ── 实时计算的「下发执行」(一次提交 → 每个区各建一个)────────────────────────
# 🔴 为什么实时计算的 dispatch **不能**照抄别的能力:流式作业没有「到点跑一次」的语义 ——
#   它是长期运行的。所以「不由人在该区逐个点、而由平台把活派到该区」这件事,在实时这一类上
#   已交付的载体就是 **一次提交多区扇出**:人在**主控区视角**勾上多个执行区,平台在
#   **每个区各建一个作业**(MSAF application 是区域资源,一区一个)。判据就钉这个事实。
#
# 🔴 判别力:产品一旦退回「只建一个」或「都建在主控区」,这条当场红(此前正是那样)。
# 🔴 为什么这一相用**夹具**而不是示范对象:示范对象已经在各区跑着(那是 manual 那一格的事实);
#   而「一次提交扇出」必须**真的提交一次**才能验。夹具刻意**不启动** ⇒ 不建任何 MSAF 应用、
#   零 AWS 成本、验完当场从页面上删掉,不留残留(示范对象照旧长期保留,用户眼里不空)。
async def verify_realtime_dispatch(pg, base: str, targets: list[dict], rep: Rep, shots: str,
                                   all_targets: list[dict] | None = None) -> None:
    ts = time.strftime("%m%d%H%M", time.gmtime())
    name = f"DispatchCheck-RT-{ts}"
    # 🔴 表单点的是产品的「全选当前活跃区」⇒ 产品按**注册表全部活跃区**扇出,与 `--targets` 无关。
    #   命名 / 串区负向 / 收尾都必须按扇出面(fan),判据只对 `targets` 出。
    #   (2026-10-10:`--targets tgt_home` 单跑 ⇒ usw2 那份没人删 ⇒ 第十七轮 8e 红在我自己留的残留上)
    fan = [t["targetId"] for t in (all_targets or targets)]
    tids = fan
    log(f"\n--- 实时计算的下发执行:在主控区视角一次提交勾 {len(tids)} 个区 ---")
    created_names: dict[str, str] = {}
    submit_ev = ""
    try:
        await pg.goto(f"{base}/realtime-compute?scope={HOME}", wait_until="domcontentloaded", timeout=60000)
        await pg.wait_for_timeout(3500)
        if not await click_btn(pg, "新建流作业", "New streaming job"):
            submit_ev = "🔴 找不到「新建流作业」按钮"
        else:
            await pg.wait_for_timeout(1500)
            modal = await wait_modal(pg, 8000)
            if modal is None:
                submit_ev = "🔴 点了「新建流作业」但弹窗没出现"
            else:
                await modal.locator("input").first.fill(name)
                # 「全选当前活跃区」= 产品自己给的入口,比我去点多选下拉稳(虚拟滚动/tag 删除都是坑)
                allbtn = modal.locator('[data-testid="flink-create-targets-all"]').first
                if not await allbtn.count():
                    submit_ev = "🔴 新建表单里没有「全选当前活跃区」按钮(多区扇出入口不在?)"
                else:
                    await allbtn.click()
                    await pg.wait_for_timeout(1200)
                    mtxt = await modal.inner_text()
                    await shot(pg, shots, "rt-dispatch-form")
                    # 页面必须把语义说清:N 个区各建一个(而不是一个作业跑两区)
                    said = ("个区各建一个作业" in mtxt) if len(tids) > 1 else ("单区" in mtxt)
                    if not await click_btn(modal, "创 建", "创建", "Create"):
                        submit_ev = "🔴 弹窗里找不到「创建」"
                    else:
                        await pg.wait_for_timeout(6000)
                        submit_ev = f"已在主控区视角提交一次(表单复述「{'各建一个' if said else '没说清'}」)"
    except Exception as e:
        submit_ev = f"页面交互异常:{str(e)[:140]}"
    log(f"  · 提交:{submit_ev}")

    # 逐区核对:该区视角下**有且只有自己那一个**(名字后缀 = 去掉 tgt_ 前缀的 targetId)
    for t in targets:
        tid = t["targetId"]
        want_name = f"{name}-{tid[len('tgt_'):]}" if len(tids) > 1 else name
        ok, ev = False, ""
        try:
            txt = await goto_scope(pg, base, "/realtime-compute", tid, settle=want_name, budget_s=40)
            rows_ = await row_texts(pg, want_name)
            # 负向:别的区那一个不许出现在这个区的视角里
            strays = [f"{name}-{x[len('tgt_'):]}" for x in tids if x != tid and f"{name}-{x[len('tgt_'):]}" in txt]
            ok = bool(rows_) and not strays
            ev = (f"该区视角下有 {len(rows_)} 行 {want_name} · 串进来的别区作业={strays or '无'} · "
                  f"{submit_ev}")
        except Exception as e:
            ev = f"页面交互异常:{str(e)[:120]} · {submit_ev}"
        await shot(pg, shots, f"{tid}-rt-dispatch")
        rep.add(tid, "8d 🔴 实时的下发执行:主控区一次提交 ⇒ **该区**真出现一个属于它的流作业",
                ok, ev, cap="realtime", mode="dispatch")
        if ok:
            created_names[tid] = want_name

    # 清夹具:从**页面上**删(顺带把删除这条路也走一遍);示范对象不动
    # 🔴🔴 **删净这件事必须有判据**(该缺陷的直接根因):这里原来失败只写 `log`
    #   ⇒ 判据压根看不见清理失败 ⇒ 失败就静默累积。那 3 个 `DispatchCheck-RT-*` 残留
    #   就是这么来的,而它们把示范作业挤到了第 2 页 ⇒ 用户切过去「什么都没看见」。
    #   ⇒ 收口断言 = **最终状态**(列表里真没了),不是「我点过删除」。
    teardown_fail: list[str] = []
    # 收尾按**扇出面**逐区找本次夹具(不论该区判据过没过、在不在 --targets 里)
    for tid in fan:
        nm = f"{name}-{tid[len('tgt_'):]}" if len(fan) > 1 else name
        try:
            await goto_scope(pg, base, "/realtime-compute", tid, settle=nm, budget_s=30)
            if not await row_texts(pg, nm):
                continue
            created_names.setdefault(tid, nm)
            row = pg.locator("tr", has_text=nm).first
            a = row.locator("a", has_text="删除").first
            if await a.count():
                await a.click()
                if not await confirm_popconfirm(pg):
                    log(f"[cleanup] 🔴 {nm} 的删除二次确认没点掉(账号里留了个夹具作业)")
                else:
                    await pg.wait_for_timeout(2500)
                    left = await row_texts(pg, nm)
                    if left:
                        teardown_fail.append(f"{nm}(点了删除但仍在列表里)")
                    log(f"[cleanup] {nm} 已删({'仍在列表里!' if left else '列表里已消失'})")
            else:
                teardown_fail.append(f"{nm}(行上找不到「删除」)")
                log(f"[cleanup] 🔴 {nm} 行上找不到「删除」")
        except Exception as e:
            teardown_fail.append(f"{nm}(删除异常:{str(e)[:80]})")
            log(f"[cleanup] 🔴 删 {nm} 异常:{str(e)[:120]}")
    if created_names:
        rep.add(sorted(created_names)[0],
                "8d-撤 🔴 下发执行的夹具**建了必撤**(收口断言 = 列表里真没了,不是「我点过删除」)",
                not teardown_fail,
                (f"{len(created_names)} 个夹具全部删净" if not teardown_fail else
                 f"🔴 {len(teardown_fail)} 个没删净:" + " / ".join(teardown_fail)
                 + " ⇒ 残留会把示范对象挤出第一页"))


# ── 下发执行(dispatch)────────────────────────────────────────────────────────
# 🔴 为什么单独一相:「下发执行」的判据**不能**是「页面上看得到定时文本」—— 那只证明配上了,
#   不证明调度真把活派到该区跑成了。真判据只有一个形状:`/monitor` 运行实例页上出现该对象的一行、
#   **「触发」列 = 自动**、区域列 = 该区、状态成功。
#   两条路子:① 离线作业有「触发一次调度」(`data-testid="scheduler-trigger"`)—— 跑的是**已发布到
#   该区的调度产物**,秒级起、不用等 cron;② 同步 / 编排只有 cron 一条路 ⇒ 临时配成「每 5 分钟」
#   真烧一轮,收完再还原成每天(绝不把 5 分钟的定时留在账号里)。
CRON_DAILY = "0 3 * * *"
FAST_MINUTES = 5      # 编排:每 5 分钟烧一轮就够(两个 SQL 节点,秒级)
SYNC_MINUTES = 10     # 同步:主控区那个任务 1200 万行约 7 分钟 ⇒ 间隔必须 > 单次耗时,否则叠车撞运行锁



_ARMED_AT: dict[str, float] = {}   # 每区装弹开始时刻(收弹只认这之后开始的运行)


async def dispatch_arm(pg, base: str, t: dict, rep: Rep, shots: str) -> dict:
    """给该区的对象**配上调度并发布/启用**,能立刻触发调度产物的就立刻触发。返回 {对象名: 能力}。"""
    tid = t["targetId"]
    _ARMED_AT[tid] = time.time()
    slug = tid.replace("tgt_", "").replace("_", "-")
    pfx = f"Showcase-{slug}"
    armed: dict[str, str] = {}
    log(f"\n--- 下发执行:装弹 {tid} ---")

    # ① 三个离线作业:发布调度到该区 ⇒ 立刻「触发一次调度」(跑调度产物,不是手工路径)
    for cap_key, job_key in (("etl", "ETL-ChannelROI"), ("etl", "ETL-RetentionLTV"),
                             ("compute", "EMR-BehaviorFunnel")):
        name = f"{pfx}-{job_key}"
        ev = ""
        try:
            await goto_scope(pg, base, "/etl-jobs", tid, settle=name)
            await pg.locator(f"text={name}").first.click()
            await pg.wait_for_timeout(2500)
            box = pg.locator('input[placeholder^="cron:"]').first
            if not await box.count():
                ev = "🔴 作业面板里没有 cron 输入框"
            else:
                await box.fill(CRON_DAILY)
                if not await click_btn(pg, "发布到 MWAA 调度", "Publish to MWAA"):
                    ev = "🔴 找不到「发布到 MWAA 调度」按钮"
                else:
                    trig = pg.locator('[data-testid="scheduler-trigger"]')
                    t0 = time.time()
                    while time.time() - t0 < 120 and not await trig.count():
                        await pg.wait_for_timeout(5000)
                    if not await trig.count():
                        ev = "🔴 发布后 120s 内没出现「触发一次调度」(= 发布没成功)"
                    else:
                        # 🔴 必须等它退出 loading:刚点完「发布」时 busy 还是 true,antd 的 loading
                        #   按钮**不响应点击** ⇒ 气泡不弹,判据会报成「二次确认没点掉」(2026-09-19 真踩)。
                        await wait_not_loading(trig.first)
                        await trig.first.click()
                        # 🔴 二次确认点没点到必须**采信返回值**:antd 关过的气泡不卸载,
                        #   `.last` 会落在隐藏气泡上 ⇒ 静默没点掉,而 DAG 那边 run 数是 0,
                        #   脚本却照样打印「已触发」。乐观 = 判据在说谎(2026-09-19 实证)。
                        if not await confirm_popconfirm(pg):
                            ev = "🔴 点了「触发一次调度」但二次确认没点掉(气泡没出现/被隐藏气泡抢了)"
                        else:
                            armed[name] = cap_key
                            ev = f"已发布 cron={CRON_DAILY} 并「触发一次调度」(跑该区调度产物)"
        except Exception as e:
            ev = f"页面交互异常:{str(e)[:120]}"
        log(f"  · {name}: {ev}")
        await shot(pg, shots, f"{tid}-dispatch-arm-{job_key}")
        if name not in armed:
            rep.add(tid, f"D 下发执行装弹失败:{job_key}", False, ev, cap=cap_key, mode="dispatch")

    # ② 编排:工作流详情页配「每 5 分钟」并发布到该区(只有 cron 一条路,得真等一轮)
    wf = f"{pfx}-Flow-ROI-Daily"
    ev = ""
    try:
        await goto_scope(pg, base, "/workflow", tid, settle=wf)
        await pg.locator(f"text={wf}").first.click()
        await pg.wait_for_timeout(4000)
        box = pg.locator('input[placeholder^="cron:"]').first
        if not await box.count():
            ev = "🔴 工作流详情页没有 cron 输入框"
        else:
            await box.fill(f"*/{FAST_MINUTES} * * * *")
            if await click_btn(pg, "应用并发布", "Apply & publish", "Apply and publish"):
                await pg.wait_for_timeout(8000)
                armed[wf] = "orchestration"
                ev = f"已把 cron 改成 */{FAST_MINUTES} 并「应用并发布」到该区(收完还原成每天)"
            else:
                ev = "🔴 找不到「应用并发布」按钮"
    except Exception as e:
        ev = f"页面交互异常:{str(e)[:120]}"
    log(f"  · {wf}: {ev}")
    await shot(pg, shots, f"{tid}-dispatch-arm-workflow")
    if wf not in armed:
        rep.add(tid, "D 下发执行装弹失败:编排工作流", False, ev, cap="orchestration", mode="dispatch")

    # ③ 同步:🔴 **载体未交付,如实登记**(2026-09-19 真环境查实)
    #   在调度配置页给同步任务配 cron + 打开「启用」,记录里真的写上了 scheduleEnabled/cron,
    #   但平台**不建任何调度产物**:`airflowDagId` 空、两个 region 的 EventBridge Scheduler 各 0 条、
    #   MWAA Serverless 里没有 sync 的 DAG。实测配 `*/10` 等了 25 分钟一次都没跑。
    #   ⇒ 这一格不是「判据没覆盖」,是**产品没有载体**。判据因此改成钉**诚实**:
    #     页面必须显示「定时未交付」而不是「自动调度」绿标;并如实登记成缺口。
    #   🔴 判别力:载体一交付(发布单节点 DAG + `_exec_sync` 补写 run 台账),标签会变成「自动调度」,
    #     这条判据当场变红 ⇒ 逼着把这一格重新做成真跑判据,而不是永远 ⚠️ 下去。
    sync_name = f"{pfx}-GameSync-7tables" if tid == HOME else f"{pfx}-Sync-ad_channels"
    ev, honest = "", False
    try:
        await goto_scope(pg, base, SCHED_PATH, tid, settle=sync_name, budget_s=30)
        row = pg.locator("tr", has_text=sync_name).first
        # 先把 cron 配上并启用 —— 要验的正是「配了之后页面怎么说」
        tag = row.locator(".ant-tag").filter(has_text=re.compile(r"\*|未配置|Not")).first
        if await tag.count():
            modal = await click_until_modal(pg, tag)
            if modal is not None and await click_radio(modal, "每N分钟", "Every N minutes"):
                num = modal.locator("input.ant-input-number-input").first
                if await num.count():
                    await num.fill(str(SYNC_MINUTES))
                    await pg.wait_for_timeout(500)
                await click_btn(modal, "确 定", "确定", "OK")
                await pg.wait_for_timeout(4000)
        row = pg.locator("tr", has_text=sync_name).first
        sw = row.locator(".ant-switch").first
        if await sw.count() and "ant-switch-checked" not in (await sw.get_attribute("class") or ""):
            await sw.click()
            await pg.wait_for_timeout(5000)
        rows_ = await row_texts(pg, sync_name)
        line = " ".join((rows_[0] if rows_ else "").split())
        # 🔴 **载体已交付,这一格从「如实登记」改回真跑**。
        #   旧判据钉的是**诚实**(页面必须说「定时未交付」),并刻意写成「载体一交付就变红,逼着改回真跑」
        #   —— 它在 2026-09-20 真的红了,所以现在按设计改判。
        #   新判据两段:
        #     ① 这里只判「**载体真的挂上了**」—— 绿标的判据是**产物**(deployments 里有 workflowArn),
        #        不是 `scheduleEnabled` 这个愿望字段;界面 testid `schedule-armed` 就是这个意思。
        #     ② 真跑那一半交给 `dispatch_harvest`:把它登记进 `armed` ⇒ 它会去 /monitor 逐行等
        #        「触发=自动 + 区域=该区 + 成功」的那一行(与编排那一格同一条口径)。
        #   🔴 负向同时钉住:旧的「定时未交付」文案不许再出现(载体已交付,留着就是另一种说谎);
        #     而「待发布载体」出现 = 载体没发成(存量行 / 发布失败),那是真红不是登记。
        armed_tag = await pg.locator('[data-testid="schedule-armed"]').count()
        not_armed = await pg.locator('[data-testid="sync-schedule-not-armed"]').count()
        ok_arm = armed_tag > 0 and not_armed == 0 and ("定时未交付" not in line)
        ev = (f"行上文本={line[:140]!r} · 绿标(有产物)={armed_tag} · 待发布载体={not_armed} · "
              f"旧文案「定时未交付」={'定时未交付' in line}")
    except Exception as e:
        ev = f"页面交互异常:{str(e)[:120]}"
        ok_arm = False
    await shot(pg, shots, f"{tid}-dispatch-arm-sync")
    rep.add(tid, "3 🔴 同步的**下发执行**:载体真挂上了(绿标看的是**产物** deployments.workflowArn,"
                 "不是 scheduleEnabled 这个愿望字段;旧的「定时未交付」文案必须已消失)",
            ok_arm, f"{ev} —— 按任务绑定的每个执行范围各发一份**单节点 sync 工作流**到该区的 "
                    f"MWAA Serverless;真跑那一半由下面的「收弹」判据等定时烧出来",
            cap="sync", mode="dispatch")
    if ok_arm:
        armed[sync_name] = "sync"     # ⇒ dispatch_harvest 去 /monitor 等「触发=自动 + 该区 + 成功」

    # ④ 治理(CAP-GOV):治理页「定时治理任务」页签建一个**长期示范对象**(目录同步 · 只刷 Glue,
    #    零数仓唤醒成本)。已存在就复用;每次都把 cron 拉到每 N 分钟并启用(收完还原成每天)。
    #    🔴 绿标判据看**产物**(gov-schedule-armed = deployments 里真有 workflowArn),不看 scheduleEnabled。
    gov = f"{pfx}-GovCatalog"
    ev, ok_gov = "", False
    try:
        await goto_scope(pg, base, "/governance", tid, settle="", budget_s=15)
        await pg.locator('[data-testid="gov-tab-schedules"]').first.click(timeout=15000)
        await pg.wait_for_timeout(3500)
        row = pg.locator('tr[data-testid^="gov-schedule-row-"]', has_text=gov).first
        if await row.count():
            tid_attr = (await row.get_attribute("data-testid") or "").replace("gov-schedule-row-", "")
            # 复用:先停再按每 N 分钟重启(toggle 用行上的 cron;每 N 分钟要走 API 那条同源入口 = 页面同一个按钮)
            await pg.evaluate("""async ([id, cron]) => { await fetch('/api/schedule/enable', {method:'POST',
                headers:{'Content-Type':'application/json'}, body: JSON.stringify({taskId:id, taskType:'governance',
                cronExpression:cron, enabled:true})}); }""", [tid_attr, f"*/{FAST_MINUTES} * * * *"])
            await goto_scope(pg, base, "/governance", tid, settle="", budget_s=15)
            await pg.locator('[data-testid="gov-tab-schedules"]').first.click(timeout=15000)
            await pg.wait_for_timeout(3500)
        else:
            await pg.locator('[data-testid="gov-schedule-create-btn"]').first.click(timeout=15000)
            modal = pg.locator('[data-testid="gov-schedule-modal"]').or_(pg.locator(".ant-modal").filter(has=pg.locator('[data-testid="gov-schedule-name"]'))).first
            await pg.locator('[data-testid="gov-schedule-name"]').first.fill(gov)
            await pg.locator('[data-testid="gov-schedule-action"]').first.click()
            await pg.wait_for_timeout(600)
            await pg.locator(".ant-select-dropdown:visible .ant-select-item-option", has_text="目录同步").first.click()
            await pg.wait_for_timeout(600)
            cron_box = pg.locator('[data-testid="gov-schedule-cron"]').first
            await click_radio(cron_box, "每N分钟", "Every N minutes")
            num = cron_box.locator("input.ant-input-number-input").first
            if await num.count():
                await num.fill(str(FAST_MINUTES))
                await num.press("Tab")
            await pg.wait_for_timeout(500)
            await pg.locator('[data-testid="gov-schedule-submit"]').first.click()
            await pg.wait_for_timeout(9000)
        row = pg.locator('tr[data-testid^="gov-schedule-row-"]', has_text=gov).first
        rtxt = " ".join(((await row.inner_text()) if await row.count() else "").split())
        a_n = await row.locator('[data-testid^="gov-schedule-armed-"]').count() if await row.count() else 0
        na_n = await row.locator('[data-testid^="gov-schedule-not-armed-"]').count() if await row.count() else 0
        ok_gov = a_n == 1 and na_n == 0
        ev = f"行={rtxt[:140]!r} · 绿标(有产物)={a_n} · 待发布载体={na_n}"
    except Exception as e:
        ev = f"页面交互异常:{str(e)[:140]}"
    await shot(pg, shots, f"{tid}-dispatch-arm-governance")
    rep.add(tid, "5c 🔴 治理的**下发执行**:页面建定时治理任务(目录同步)⇒ 载体真挂上了(绿标看产物 deployments.workflowArn)",
            ok_gov, f"{ev} —— 单节点 platform-action 工作流发布到**该区**的 MWAA Serverless;真跑由「收弹」等定时烧出来",
            cap="governance", mode="dispatch")
    if ok_gov:
        armed[gov] = "governance"

    # ⑤ 问数(CAP-GENBI):给 9b 那张示范卡配「每 N 分钟」定时刷新(刷新同一张卡,不占额度)。
    ask_title = f"{pfx}-Ask-"
    ev, ok_card, card_name = "", False, ""
    try:
        await goto_scope(pg, base, "/genbi", tid, settle="", budget_s=15)
        await pg.locator('[data-testid="genbi-my-cards-btn"]').first.click(timeout=15000)
        await pg.wait_for_timeout(3000)
        item = pg.locator(".ant-list-item", has_text=ask_title).first
        sched = item.locator('a[data-testid^="genbi-card-schedule-"]').first
        if not await sched.count():
            ev = "🔴 示范卡片行上没有「定时刷新」入口"
        else:
            cid = (await sched.get_attribute("data-testid") or "").replace("genbi-card-schedule-", "")
            card_name = f"问数卡片 {cid[-6:]}"
            await sched.click()
            await pg.wait_for_timeout(1500)
            m = pg.locator('[data-testid="genbi-card-schedule-modal"]').or_(pg.locator(".ant-modal").filter(has=pg.locator('[data-testid="genbi-card-schedule-cron"]'))).first
            cron_box = pg.locator('[data-testid="genbi-card-schedule-cron"]').first
            await click_radio(cron_box, "每N分钟", "Every N minutes")
            num = cron_box.locator("input.ant-input-number-input").first
            if await num.count():
                await num.fill(str(FAST_MINUTES))
                await num.press("Tab")
            sw = pg.locator('[data-testid="genbi-card-schedule-enabled"]').first
            if await sw.count() and "ant-switch-checked" not in (await sw.get_attribute("class") or ""):
                await sw.click()
            await pg.locator('[data-testid="genbi-card-schedule-save"]').first.click()
            await pg.wait_for_timeout(9000)
            await goto_scope(pg, base, "/genbi", tid, settle="", budget_s=15)
            await pg.locator('[data-testid="genbi-my-cards-btn"]').first.click(timeout=15000)
            await pg.wait_for_timeout(3000)
            a_n = await pg.locator(f'[data-testid="genbi-card-schedule-armed-{cid}"]').count()
            na_n = await pg.locator(f'[data-testid="genbi-card-schedule-not-armed-{cid}"]').count()
            ok_card = a_n == 1 and na_n == 0
            ev = f"卡片 {cid} · 定时绿标(有产物)={a_n} · 待发布载体={na_n}"
    except Exception as e:
        ev = f"页面交互异常:{str(e)[:140]}"
    await shot(pg, shots, f"{tid}-dispatch-arm-genbi-card")
    rep.add(tid, "9c 🔴 问数的**下发执行**:示范卡片配定时刷新 ⇒ 载体真挂上了(绿标看产物)",
            ok_card, f"{ev} —— 刷新同一张卡 + 运行历史;真跑由「收弹」在监控页等「{card_name or '问数卡片 …'}」的自动成功行",
            cap="genbi", mode="dispatch")
    if ok_card:
        armed[card_name] = "genbi"
    return armed



async def dispatch_harvest(pg, base: str, t: dict, armed: dict, rep: Rep, shots: str,
                           budget_s: int = 1800) -> None:
    """在 `/monitor` 运行实例页上收:该对象有一行「触发=自动」+ 区域=该区 + 状态成功。"""
    tid, region = t["targetId"], t["region"]
    slug = tid.replace("tgt_", "").replace("_", "-")
    pfx = f"Showcase-{slug}"
    if not armed:
        return
    log(f"\n--- 下发执行:收弹 {tid}(最多等 {budget_s // 60} 分钟)---")
    got: dict[str, str] = {}
    t0 = time.time()
    # 🔴 只认**装弹之后**才开始的那一次运行(行首时间戳 ≥ 装弹时刻 − 60s):否则上一轮留下的「自动 + 成功」
    #   行会让这一次根本没触发的调度照样判绿(2026-10-10 实测:同步那格命中的是 4 小时前的一次运行)。
    armed_at = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(_ARMED_AT.get(tid, t0) - 60))
    while time.time() - t0 < budget_s and len(got) < len(armed):
        await goto_scope(pg, base, "/monitor", tid, settle="", budget_s=10)
        try:
            box = pg.locator('input[placeholder*="任务名称"]').or_(
                pg.locator('input[placeholder*="Task name"]')).first
        except Exception:
            box = None
        # 🔴 名字过滤分组:Showcase 对象按 pfx;问数卡片定时的名字刻意不含标题(标题只留在该区)⇒ 按它自己的名字
        filters = sorted({pfx} | {n for n in armed if not n.startswith(pfx)})
        for flt in filters:
            try:
                if box is not None and await box.count():
                    await box.fill(flt)
                await pg.locator('[data-testid="monitor-search-btn"]').first.click()
                await pg.wait_for_timeout(4000)
            except Exception:
                pass
            for name in armed:
                if name in got or (flt == pfx) != name.startswith(pfx):
                    continue
                # 🔴 逐行读 DOM(一个 <tr> = 一次运行),不在整页文本里开字符窗口 ——
                #   窗口会跨进下一行,让「手动 / 运行中」的行拿邻居的「自动 / 成功」给自己放行。
                for w in await row_texts(pg, name):
                    auto = ("自动" in w) or ("schedule" in w.lower())
                    okw = any(x in w for x in SUCCESS_WORDS)
                    m_ts = re.match(r"\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", w)
                    fresh = bool(m_ts) and m_ts.group(1) >= armed_at
                    if auto and okw and region in w and fresh:
                        got[name] = " ".join(w.split())[:200]
                        break
        if len(got) < len(armed):
            await pg.wait_for_timeout(45000)
    await shot(pg, shots, f"{tid}-dispatch-monitor")
    for name, cap_key in armed.items():
        w = got.get(name, "")
        rep.add(tid, f"D 🔴 下发执行:{name} 由**调度**在该区跑成功(运行实例页「触发=自动」)",
                bool(w),
                (f"命中行:{w[:150]!r}" if w
                 else f"等了 {int(time.time() - t0)}s 仍没有「触发=自动 + 区域={region} + 成功 + 开始于装弹之后({armed_at} UTC 起)」的行"),
                cap=cap_key, mode="dispatch")


async def dispatch_restore(pg, base: str, t: dict, armed: dict) -> None:
    """还原:把临时的「每 5 分钟」改回每天 —— 绝不把高频定时留在账号里(钱与噪声)。"""
    tid = t["targetId"]
    slug = tid.replace("tgt_", "").replace("_", "-")
    pfx = f"Showcase-{slug}"
    wf = f"{pfx}-Flow-ROI-Daily"
    if wf in armed:
        try:
            await goto_scope(pg, base, "/workflow", tid, settle=wf)
            await pg.locator(f"text={wf}").first.click()
            await pg.wait_for_timeout(4000)
            box = pg.locator('input[placeholder^="cron:"]').first
            if await box.count():
                await box.fill(CRON_DAILY)
                await click_btn(pg, "应用并发布", "Apply & publish")
                await pg.wait_for_timeout(6000)
            log(f"[restore] {wf} cron → {CRON_DAILY}")
        except Exception as e:
            log(f"[restore] 🔴 {wf} 还原失败(账号里还留着高频定时!):{str(e)[:120]}")
    # 治理定时 / 卡片定时 —— 还原成每天(治理)/ 停用(卡片);走页面同源的那两个接口
    for name, cap_key in armed.items():
        if cap_key not in ("governance", "genbi"):
            continue
        try:
            await goto_scope(pg, base, "/genbi" if cap_key == "genbi" else "/governance", tid, settle="", budget_s=10)
            if cap_key == "governance":
                lst = await pg.evaluate("async (s) => (await (await fetch('/api/governance/schedules?scope=' + s)).json()).data || []", tid)
                for it in [x for x in lst if x.get("name") == name]:
                    await pg.evaluate("""async ([id, cron]) => { await fetch('/api/schedule/enable', {method:'POST',
                        headers:{'Content-Type':'application/json'}, body: JSON.stringify({taskId:id, taskType:'governance',
                        cronExpression:cron, enabled:true})}); }""", [it.get("taskId"), CRON_DAILY])
                log(f"[restore] {name} cron → {CRON_DAILY}")
            else:
                cid6 = name.split(" ")[-1]
                lst = await pg.evaluate("async () => (await (await fetch('/api/genbi/cards/schedules')).json()).data || []")
                for it in [x for x in lst if str(x.get("cardId", "")).endswith(cid6)]:
                    await pg.evaluate("""async (id) => { await fetch('/api/genbi/cards/' + id + '/schedule', {method:'POST',
                        headers:{'Content-Type':'application/json'}, body: JSON.stringify({cronExpression:'0 3 * * *', enabled:false})}); }""",
                        it.get("cardId"))
                log(f"[restore] {name} 定时刷新已停用")
        except Exception as e:
            log(f"[restore] 🔴 {name} 还原失败(账号里还留着高频定时!):{str(e)[:120]}")
    sync_name = f"{pfx}-GameSync-7tables" if tid == HOME else f"{pfx}-Sync-ad_channels"
    if sync_name in armed:
        try:
            await goto_scope(pg, base, SCHED_PATH, tid, settle=sync_name, budget_s=30)
            row = pg.locator("tr", has_text=sync_name).first
            tag = row.locator(".ant-tag").filter(has_text=re.compile(r"\*|未配置|Not")).first
            if not await tag.count():
                tag = row.locator(".ant-tag").nth(1)
            modal = await click_until_modal(pg, tag)
            if modal is None:
                raise RuntimeError("还原时「配置调度」弹窗点 3 次都没出现")
            await click_radio(modal, "每天", "Daily")
            await pg.wait_for_timeout(800)
            await click_btn(modal, "确 定", "确定", "OK")
            await pg.wait_for_timeout(4000)
            log(f"[restore] {sync_name} cron → 每天")
        except Exception as e:
            log(f"[restore] 🔴 {sync_name} 还原失败(账号里还留着高频定时!):{str(e)[:120]}")


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="temp-account")
    ap.add_argument("--home-region", default=os.environ.get("KF_HOME_REGION", "us-east-1"))
    ap.add_argument("--targets", default="", help="只验这几个 targetId(逗号分隔);缺省 = 注册表里全部 active")
    ap.add_argument("--run-sync", action="store_true", help="额外在页面上点一次同步「启动」并等到成功(人的动线)")
    ap.add_argument("--run-engines", action="store_true",
                    help="额外在页面上逐引擎点「立即运行」并等到成功(单独执行;三引擎不许有盲区)")
    ap.add_argument("--skip-verify", action="store_true",
                    help="跳过逐区判据、只跑下发执行那一相(调试用;缺格会如实留空,hook 判据 ⑥ 照样拦)")
    ap.add_argument("--run-dispatch", action="store_true",
                    help="额外验**下发执行**:页面上配调度并发布 → 由调度真跑 → 运行实例页「触发=自动」那一行;收完还原 cron")
    ap.add_argument("--dispatch-budget", type=int, default=1800, help="收「触发=自动」那一行的最长等待秒数")
    ap.add_argument("--emit-matrix", default="", help="把「能力 × 区域 × 执行方式」矩阵写成 JSON(给 Stop hook 判据 ⑥)")
    ap.add_argument("--shots", default="qa-game/shots-headless", help="截图目录(空串 = 不截图)")
    a = ap.parse_args()
    _PROFILE["name"] = a.profile

    sess = boto3.Session(profile_name=a.profile, region_name=a.home_region)
    base = cfn_out(sess.client("cloudformation"), "BgpPlatformStack", "PlatformUrl").rstrip("/")
    if not base:
        sys.exit("读不到 BgpPlatformStack.PlatformUrl(平台没装?)")
    targets = registry(sess.client("dynamodb"))
    all_targets = list(targets)   # 产品「全选当前活跃区」的扇出面(收尾要按它清,不按 --targets)
    want = {x.strip() for x in a.targets.split(",") if x.strip()}
    if want:
        targets = [t for t in targets if t["targetId"] in want]
    if not targets:
        sys.exit("没有可验的执行环境")
    # 🔴 闭合式自检:目录搜索框的定位口径只允许有一个作者(列唯一允许的形态,不枚举违规)
    log("[headless] " + L.assert_single_catalog_search_author())
    log(f"[headless] 平台 {base} · 待验 {[t['targetId'] for t in targets]}")

    rep = Rep()
    pw = admin_pw(a.profile)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1680, "height": 1000}, locale="zh-CN")
        pg = await ctx.new_page()
        if not await do_login(pg, base, pw):
            sys.exit("登录失败(口令对吗?平台在预热?)")
        log("[headless] 登录成功")
        for t in (() if a.skip_verify else targets):
            try:
                await verify_target(pg, base, t, rep, a.shots, a.run_sync, a.run_engines,
                                    ddb=sess.client("dynamodb"), home_region=a.home_region)
            except Exception as e:
                rep.add(t["targetId"], "整区验证异常(脚本或页面挂了,不是通过)", False, str(e)[:200])
            # 🔴 逐区增量落盘:2026-09-19 真踩 —— 跑完 70 分钟、判据全过,却在**最后一步**因为
            #   `emit_matrix` 改了签名而调用点没跟着改(TypeError)⇒ 整轮产物一个字节都没留下。
            #   凡「跑很久才产出一件东西」的脚本,都该在中途就把已得的部分写下来。
            if a.emit_matrix:
                try:
                    rep.emit_matrix(a.emit_matrix, [x["targetId"] for x in targets], SOURCE)
                except Exception as e2:
                    log(f"[headless] ⚠️ 增量落盘失败(不影响继续跑):{str(e2)[:120]}")
        # 🔴🔴 呈现面的**总判据**:`2d②..⑤` 判的是平台级前端逻辑(不随区变)⇒ 至少一个区
        #   端到端验过就成立;但**一个区都没验到就必须红** —— 否则「本区没夹具就跳过」会静默
        #   退化成「这条机制从来没验过」(本仓的元 bug:机制装上了,而守它的那条路径没人走)。
        if not a.skip_verify and targets:
            ok_ui = bool(_DRIFT_UI["verified_on"])
            rep.add(targets[0]["targetId"],
                    "2d-UI 🔴🔴 载体落后呈现面端到端验过(落后⇒显示需重发且无绿标 → 点出路 → 回最新 → 收口)",
                    ok_ui,
                    (f"已在 {_DRIFT_UI['verified_on']} 端到端验过(平台级逻辑,不随区变)" if ok_ui else
                     "🔴 **一个区都没验到** —— 需要至少一个区有「可安全改动的验收残留工作流」"
                     "(绑该区 + 已发布 + 有 cron)。刻意不用示范对象当夹具:那会留副作用"))

            # 🔴🔴该缺陷的**总判据**:同 `2d-UI` —— 陈旧响应竞态是平台级前端逻辑,至少一个区
            #   端到端验过就成立;**一个区都没验到就必须红**,否则「本区没夹具就跳过」会静默
            #   退化成「这条机制从来没验过」。
            ok_race = bool(_CLASS_RACE["verified_on"])
            rep.add(targets[0]["targetId"],
                    "5h-UI 🔴🔴 陈旧响应竞态端到端验过(人为延迟先点的那张表 ⇒ 最终显示的必须是后一次)",
                    ok_race,
                    (f"已在 {_CLASS_RACE['verified_on']} 端到端验过(平台级逻辑,不随区变)" if ok_race else
                     "🔴 **一个区都没验到** —— 需要某个区的目录里有两张「字段集互有差异」的表当夹具;"
                     f"最后一次的原因={_CLASS_RACE['why'][:200] or '(压根没跑到)'}"))

        # 🔴 实时计算的 dispatch 是**一次提交填所有区**的一相(不是逐区),所以放在逐区循环之后。
        #   它不启动任何应用 ⇒ 零 AWS 成本,所以不挂在 --run-dispatch 后面(那个开关是给「真烧一轮 cron」的)。
        if not a.skip_verify:
            try:
                await verify_realtime_dispatch(pg, base, targets, rep, a.shots, all_targets=all_targets)
            except Exception as e:
                for t in targets:
                    rep.add(t["targetId"], "8d 实时下发执行整体异常", False, str(e)[:200],
                            cap="realtime", mode="dispatch")
        if a.run_dispatch:
            # 🔴 先把**所有区**装上弹再一起收:cron 是墙上时间,串行等两轮就是双倍 wall-clock。
            armed: dict[str, dict] = {}
            for t in targets:
                try:
                    armed[t["targetId"]] = await dispatch_arm(pg, base, t, rep, a.shots)
                except Exception as e:
                    rep.add(t["targetId"], "下发执行装弹整体异常", False, str(e)[:200])
                    armed[t["targetId"]] = {}
            for t in targets:
                try:
                    await dispatch_harvest(pg, base, t, armed.get(t["targetId"]) or {}, rep, a.shots,
                                           a.dispatch_budget)
                except Exception as e:
                    rep.add(t["targetId"], "下发执行收弹整体异常", False, str(e)[:200])
            for t in targets:
                # 还原放在**最后且不设判据**:它是卫生动作,失败要吼出来(日志里有 🔴),但不改判决
                try:
                    await dispatch_restore(pg, base, t, armed.get(t["targetId"]) or {})
                except Exception as e:
                    log(f"[restore] 🔴 {t['targetId']} 还原整体异常:{str(e)[:150]}")
            # 🔴 定时造数放在**全部收弹 + 还原之后**单独一相:主控区造数会 DROP 重建源库,
            #   与同步的定时收弹并行就会让同步读到半截表(假红)。各区先全部装弹(一次性 cron)再逐区收,收完删。
            if _deploy_mode(a.home_region) == "production":
                for t in targets:
                    rep.add(t["targetId"], "1c 造数据的**下发执行**(定时):生产模式部署不造数 ⇒ 不建定时(立即造数那格已验如实拒)",
                            True, "部署模式 production", cap="seed", mode="dispatch")
            else:
                seed_st = {}
                try:
                    for t in targets:
                        seed_st[t["targetId"]] = await seed_dispatch_arm(pg, base, t, a.home_region)
                    for t in targets:
                        try:
                            await seed_dispatch_harvest(pg, base, t, seed_st[t["targetId"]], rep, a.shots, a.dispatch_budget)
                        except Exception as e:
                            rep.add(t["targetId"], "1c 定时造数整体异常", False, str(e)[:200], cap="seed", mode="dispatch")
                finally:
                    await seed_dispatch_cleanup(pg, base)
        await ctx.close()
        await b.close()
    if a.emit_matrix:
        rep.emit_matrix(a.emit_matrix, [t["targetId"] for t in targets], SOURCE)
    return rep.finish()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
