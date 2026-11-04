#!/usr/bin/env python3
"""IAM 模拟门的**三态裁决**离线判据(`scripts/iam-simulate-gate.py` 的 `classify` / `org_blocked_of` / `sim_regions_for` / `verdict_code`)。

🔴 (2026-10-22 测试账号 all-enabled 升级真撞):放行清单覆盖了所有固定备选探测区 ⇒ redeploy 第 4 步 die。修后门认
  `--probe-region none`:any-region 轴只在 home 模拟、「放行集之外也 allowed」这一半记未验、退 4 —— 本文件钉的是
  「未验绝不许退 0」与「none 时不在 home 之外的任何区模拟」这两条(纯函数,离线打)。

    python3 infra/test/iam-gate-classify/test_classify.py     # 退出码 0 = 全过

🔴 **为什么必须有这一层**(用户 2026-09-19 原话:「不能永久拒绝某一个区域,因为这只是在现有临时账号
  受到限制,后续别人的真实账号还是没有限制的。所以这个要注意。」):
  那道门原来只有两态,于是「账号所在组织的 SCP 拦住了某个 region」与「平台自己缺权」长成同一种红 ——
  结论就会沉淀成「那个区不可用」,而那是**账号的属性**,不是区的属性、更不是平台的属性。
  新加的第三态(⛔ 本账号验不了)有个天然风险:它可以退化成**万能免检**。所以判据钉的正是那四道收窄:
    ① 只有 `explicitDeny` 才可能是 ⛔ —— `implicitDeny`(我们没给权)不许借 SCP 遮掉;
    ② `AllowedByOrganizations` 必须**显式为 False** —— 缺失 / null 都算红(不知道 ≠ 被组织拦);
    ③ 我方策略**一条都不许命中** —— 一旦命中就说不清是谁拒的,按红;
    ④ 模拟本身失败永远是红。
  这四条只能离线驱动:真账号只会产出它恰好有的那几种形状(实测 6 天里只见过 ① 和 ③ 的反面各一次)。

🔴 本文件**不 import boto3、不发任何网络请求**:被测的两个函数是纯函数,这正是把它们抽出来的理由。
"""
from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GATE = os.path.join(REPO, "scripts", "iam-simulate-gate.py")


def load_gate():
    """按路径加载(文件名带连字符,不是合法模块名 ⇒ 不能 import)。"""
    spec = importlib.util.spec_from_file_location("iam_simulate_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


CASES_CLASSIFY = [
    # (name, decision, matched, org_blocked, err, 期望)
    ("allowed ⇒ 过", "allowed", [], False, "", "ok"),
    ("allowed 但模拟报错 ⇒ 红(④ 不知道≠允许)", "allowed", [], False, "boom", "red"),
    ("组织拦 + 我方零命中 ⇒ ⛔", "explicitDeny", [], True, "", "blocked"),
    ("组织拦但我方策略有命中 ⇒ 红(③ 说不清是谁拒的)", "explicitDeny", ["BgpPlatformStackTaskRolePolicy"], True, "", "red"),
    ("explicitDeny 而组织没拦 ⇒ 红(我方自己拒的)", "explicitDeny", ["SomeDeny"], False, "", "red"),
    ("explicitDeny + 组织字段缺失 ⇒ 红(② 缺失≠被拦)", "explicitDeny", [], False, "", "red"),
    ("implicitDeny + 组织也拦 ⇒ 红(① 缺权不许借 SCP 遮)", "implicitDeny", [], True, "", "red"),
    ("implicitDeny ⇒ 红", "implicitDeny", [], False, "", "red"),
    ("模拟失败 ⇒ 红", "simulate-error", [], False, "aws 调用失败", "red"),
    ("裁决字段读不到(?)⇒ 红", "?", [], False, "", "red"),
    ("allowedByOrg 为 True 的 explicitDeny ⇒ 红", "explicitDeny", [], False, "", "red"),
]

CASES_ORG = [
    ("显式 false ⇒ 被组织拦", {"OrganizationsDecisionDetail": {"AllowedByOrganizations": False}}, True),
    ("显式 true ⇒ 没被拦", {"OrganizationsDecisionDetail": {"AllowedByOrganizations": True}}, False),
    ("字段整个缺失 ⇒ 没被拦(不知道≠被拦)", {"EvalDecision": "implicitDeny"}, False),
    ("字段是 null ⇒ 没被拦", {"OrganizationsDecisionDetail": None}, False),
    ("字段不是字典 ⇒ 没被拦", {"OrganizationsDecisionDetail": "false"}, False),
    ("字典里没那个键 ⇒ 没被拦", {"OrganizationsDecisionDetail": {}}, False),
    ("值是字符串 'false' ⇒ 没被拦(不做真值转换)", {"OrganizationsDecisionDetail": {"AllowedByOrganizations": "false"}}, False),
]

REGIONS = ["us-east-1", "us-west-2", "eu-central-1"]
CASES_SIM = [
    # (name, axis, probe, 期望 regions, 期望 unverified)
    ("any-region + 探测区 ⇒ [探测区, home],已验", "any-region", "af-south-1", ["af-south-1", "us-east-1"], False),
    ("any-region + none ⇒ 只 home,记未验", "any-region", "none", ["us-east-1"], True),
    ("execution ⇒ 放行集每个区(与探测区无关)", "execution", "none", REGIONS, False),
    ("home 轴 ⇒ 只 home(与探测区无关)", "home", "none", ["us-east-1"], False),
    ("home 轴 + 探测区 ⇒ 仍只 home", "home", "af-south-1", ["us-east-1"], False),
]
CASES_VERDICT = [
    # (name, denied, blocked, unverified, 期望退出码)
    ("全 allowed ⇒ 0", False, False, False, 0),
    ("有真红 ⇒ 1(压过一切)", True, True, True, 1),
    ("无真红、有 SCP ⛔ ⇒ 4", False, True, False, 4),
    ("无真红、any-region 轴未验 ⇒ 4,不许退 0", False, False, True, 4),
    ("⛔ 与未验同时有 ⇒ 4", False, True, True, 4),
]


def main() -> int:
    g = load_gate()
    fails = []
    n = 0
    for name, decision, matched, org, err, want in CASES_CLASSIFY:
        n += 1
        got = g.classify(decision, matched, org, err)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} classify:{name} ⇒ {got}(期望 {want})")
        if got != want:
            fails.append(name)
    for name, res, want in CASES_ORG:
        n += 1
        got = g.org_blocked_of(res)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} org_blocked_of:{name} ⇒ {got}(期望 {want})")
        if got != want:
            fails.append(name)
    for name, axis, probe, want_regions, want_unverified in CASES_SIM:
        n += 1
        got = g.sim_regions_for(axis, probe, "us-east-1", REGIONS)
        want = (want_regions, want_unverified)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} sim_regions_for:{name} ⇒ {got}(期望 {want})")
        if got != want:
            fails.append(name)
    for name, denied, blocked, unverified, want in CASES_VERDICT:
        n += 1
        got = g.verdict_code(denied, blocked, unverified)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} verdict_code:{name} ⇒ {got}(期望 {want})")
        if got != want:
            fails.append(name)
    # 🔴该缺陷的字面常量:redeploy-platform.sh 传的就是这个词;两边各写一份就会漂
    n += 1
    if g.PROBE_NONE == "none":
        print("  ✅ PROBE_NONE 字面 = none(与 redeploy-platform.sh 的 IAM_PROBE_REGION=none 同词)")
    else:
        print(f"  ❌ PROBE_NONE 字面漂成 {g.PROBE_NONE!r},redeploy-platform.sh 传的 none 门不认")
        fails.append("probe-none-literal")

    # 🔴 判据自己的覆盖面棘轮:三态每一态都必须被至少一个用例要求过 ——
    #   否则「把 classify 改成恒回 red」这种变异会被一堆只查 red 的用例放过。
    wanted = {c[5] for c in CASES_CLASSIFY}
    for st in ("ok", "blocked", "red"):
        n += 1
        if st in wanted:
            print(f"  ✅ 覆盖面:有用例要求过 {st}")
        else:
            print(f"  ❌ 覆盖面:没有任何用例要求 {st} ⇒ 这一态的变异抓不住")
            fails.append(f"coverage:{st}")

    print(f"\n{'❌' if fails else '✅'} iam-gate 三态裁决:{n - len(fails)}/{n} 通过" + (f";失败 {fails}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
