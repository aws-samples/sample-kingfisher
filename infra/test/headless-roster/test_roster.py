#!/usr/bin/env python3
"""无头验收底座的**口令表 / 名册 / 「能承接」口径**离线判据(`scripts/kf_headless_lib.py` 的纯函数)。

    python3 infra/test/headless-roster/test_roster.py     # 退出码 0 = 全过

🔴 **为什么必须有这一层**(2026-09-20 第三轮硬门的六条红,合起来只有两个根因):

  **根因 A —— 口令与名册各有第二份**:`vlib.USER_PW` 自己维护一张表,把 admin 的口令套给五个用户,
  而那五个名字里有三个(`data-engineer` / `data-analyst` / `developer`)在 Cognito 里根本不存在
  (真名册是 `scripts/10-bootstrap-cognito.sh` 的 `USERS=(admin pm-tester rbac-tester ops-analyst biz-tester)`,
  每人一个**随机**口令)。代价:段 `w3e`(W3e-14 用 `biz-tester` 验「viewer 就能看」)与段 `gbc` 直接
  💥 段中断、段 `p51`(M10 用非 admin 登录)判红 —— 三条红看着像三个独立问题。
  更毒的一半:每次错密码都被 Cognito 记账,攒够就把用户**临时锁掉**,于是**口令正确的那一相也登不进去**。

  **根因 B —— 拿「占位口径」去挑载体**:`tgt_euw1_a` 状态是 `registered`(注册了、部署被组织 SCP 拦住、
  **从来没装出来**)。段 `net0` 的 N0-1 遍历「所有非死的非 home 目标」⇒ 报「描述符缺 resources.vpcId」;
  段 `journey` 的 J22 **正控制**取 `others[0]`(字典序 ⇒ euw1)⇒ 报「BgpExecEnv-* 栈数=0」判红,
  而它要证的那件事(home 抽屉不说假话)**页面完全是对的**。

🔴 这两个根因是**同一个元模式**:「有第二条获取路 / 有第二份口径」。修法都是复用仓内单一作者,
  而单一作者一旦成立,判据就只能建在**纯函数**上 —— 真账号只会产出它恰好有的那几种形状
  (实测:六天里注册表从来没同时出现过 `registered` + `deleting` + `active` 三种状态)。

🔴 本文件不 import boto3、不发网络请求、不读 /tmp:被测的四个函数都是纯函数,这正是把它们抽出来的理由。
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "scripts"))

import kf_headless_lib as L  # noqa: E402

# ── 口令表合成:三个来源 + 优先级 ────────────────────────────────────────────────
# (名字, 落盘文件, BGP_USER_PW_JSON, BGP_ADMIN_PASSWORD, 期望表)
CASES_PW = [
    ("只有落盘文件 ⇒ 逐字照用(每人各自的随机口令)",
     {"admin": "A1", "biz-tester": "B1", "pm-tester": "P1"}, "", "",
     {"admin": "A1", "biz-tester": "B1", "pm-tester": "P1"}),
    ("🔴 BGP_ADMIN_PASSWORD 只准盖 admin —— 不许套给别人(根因 A 的核心)",
     {"admin": "A1", "biz-tester": "B1"}, "", "ADMIN-ENV",
     {"admin": "ADMIN-ENV", "biz-tester": "B1"}),
    ("BGP_USER_PW_JSON 逐用户覆盖(换账号时的交接通道)",
     {"admin": "A1", "biz-tester": "B1"}, '{"biz-tester":"B2"}', "",
     {"admin": "A1", "biz-tester": "B2"}),
    ("优先级:admin 上 env 最高、逐用户 json 次之、文件垫底",
     {"admin": "A1", "biz-tester": "B1"}, '{"admin":"A2","biz-tester":"B2"}', "A3",
     {"admin": "A3", "biz-tester": "B2"}),
    ("json 里的新用户会进表(文件早于加人时的补救)",
     {"admin": "A1"}, '{"ops-analyst":"O1"}', "",
     {"admin": "A1", "ops-analyst": "O1"}),
    ("🔴 json 坏了不许静默换个口令登:忽略它,只用文件(错口令 ⇒ Cognito 锁用户)",
     {"admin": "A1", "biz-tester": "B1"}, "{不是json", "",
     {"admin": "A1", "biz-tester": "B1"}),
    ("空值/非字符串一律丢掉(空口令去登 = 必然失败 + 一次错密码记账)",
     {"admin": "A1", "biz-tester": "", "x": None, "y": 7}, "", "",
     {"admin": "A1"}),
    ("三个来源都空 ⇒ 空表(调用者必须响亮退出,不许猜)", {}, "", "", {}),
]

# ── 名册里挑非 admin ──────────────────────────────────────────────────────────
CASES_NON_ADMIN = [
    ("五人名册 ⇒ 字典序第一个非 admin(可复现,不靠字典顺序的偶然)",
     ["admin", "pm-tester", "rbac-tester", "ops-analyst", "biz-tester"], "biz-tester"),
    ("只有 admin ⇒ 空串(调用者据此响亮退出)", ["admin"], ""),
    ("空名册 ⇒ 空串", [], ""),
    ("None ⇒ 空串(不许抛)", None, ""),
    ("名册里带空字符串 ⇒ 跳过它", ["admin", "", "zz-user"], "zz-user"),
    ("🔴 顺序不同的同一名册必须挑出同一个人(否则两轮判据在验不同的用户)",
     ["biz-tester", "admin", "pm-tester"], "biz-tester"),
]

# ── 「能承接」口径 ────────────────────────────────────────────────────────────
ROWS = [
    {"targetId": "tgt_home", "region": "us-east-1", "status": "active", "isHome": True},
    {"targetId": "tgt_usw2_a", "region": "us-west-2", "status": "active"},
    {"targetId": "tgt_euw1_a", "region": "eu-west-1", "status": "registered"},
    {"targetId": "tgt_apse1_a", "region": "ap-southeast-1", "status": "deleting"},
    {"targetId": "tgt_use1_z", "region": "us-east-1", "status": "ready"},
]


def ids(rows) -> list:
    return [r["targetId"] for r in rows]


def main() -> int:
    fails: list[str] = []
    n = 0

    print("【口令表合成 merge_pw】")
    for name, fm, ej, ea, want in CASES_PW:
        n += 1
        got = L.merge_pw(fm, ej, ea)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} {name} ⇒ {got}")
        if got != want:
            fails.append(name)
            print(f"      期望 {want}")

    print("\n【名册挑非 admin pick_non_admin】")
    for name, names, want in CASES_NON_ADMIN:
        n += 1
        got = L.pick_non_admin(names)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} {name} ⇒ {got!r}(期望 {want!r})")
        if got != want:
            fails.append(name)

    print("\n【能承接口径 serviceable_rows】")
    checks = [
        ("🔴 registered(注册了但从没装出来)**不是**载体 —— 根因 B 就是它被当成了载体",
         ids(L.serviceable_rows(ROWS)), ["tgt_use1_z", "tgt_usw2_a"]),
        ("死状态排除(deleting)",
         "tgt_apse1_a" in ids(L.serviceable_rows(ROWS)), False),
        ("默认排掉 home(按 isHome 标)",
         "tgt_home" in ids(L.serviceable_rows(ROWS)), False),
        ("drop_home=False ⇒ home 也算(有的判据要连 home 一起遍历)",
         ids(L.serviceable_rows(ROWS, drop_home=False)), ["tgt_home", "tgt_use1_z", "tgt_usw2_a"]),
        ("没有 isHome 字段时按 targetId 认 home(注册表扫表回来的行就是这个形状)",
         ids(L.serviceable_rows([{"targetId": "tgt_home", "status": "active"},
                                 {"targetId": "tgt_x", "status": "active"}])), ["tgt_x"]),
        ("ready / in-service / running / legacy-seeded 都算能承接(与 ACTIVE 同一口径)",
         ids(L.serviceable_rows([{"targetId": f"tgt_{i}", "status": s}
                                 for i, s in enumerate(L.ACTIVE)])),
         [f"tgt_{i}" for i in range(len(L.ACTIVE))]),
        ("缺 status 视为不能承接(缺字段 = 不知道,不知道不许当能用)",
         ids(L.serviceable_rows([{"targetId": "tgt_x"}])), []),
        ("缺 targetId / 不是 dict 的行直接丢(不许抛)",
         ids(L.serviceable_rows([{"status": "active"}, "垃圾", None, {"targetId": "tgt_y", "status": "active"}])),
         ["tgt_y"]),
        ("None / 空表 ⇒ 空(不许抛)", ids(L.serviceable_rows(None)) + ids(L.serviceable_rows([])), []),
        ("🔴 结果按 targetId 排序:`others[0]` 这种写法必须每轮拿到同一个区(J22 就是被顺序咬的)",
         ids(L.serviceable_rows(list(reversed(ROWS)))), ["tgt_use1_z", "tgt_usw2_a"]),
        ("🔴 判据里不许出现区域名:同样的状态换任何 region 都照收(用户:不能永久拒绝某一个区域)",
         ids(L.serviceable_rows([{"targetId": "tgt_euw1_a", "region": "eu-west-1", "status": "active"}])),
         ["tgt_euw1_a"]),
    ]
    for name, got, want in checks:
        n += 1
        mark = "✅" if got == want else "❌"
        print(f"  {mark} {name} ⇒ {got}")
        if got != want:
            fails.append(name)
            print(f"      期望 {want}")

    # 🔴 判据自己的覆盖面棘轮:三个形状每一个都必须被至少一个用例**要求过**,
    #   否则「把 serviceable_rows 改成恒回空」「把 merge_pw 改成恒回文件」这类变异会被放过。
    print("\n【判据自己的覆盖面】")
    ratchets = [
        ("有用例要求 merge_pw 真的**用到** env_admin", any(c[3] for c in CASES_PW)),
        ("有用例要求 merge_pw 真的**用到** env_json", any(c[2] for c in CASES_PW)),
        ("有用例要求 pick_non_admin 回**非空**", any(c[2] for c in CASES_NON_ADMIN)),
        ("有用例要求 serviceable_rows 回**非空**", bool(L.serviceable_rows(ROWS))),
        ("有用例要求 serviceable_rows 把 registered 挡掉",
         "tgt_euw1_a" not in ids(L.serviceable_rows(ROWS))),
    ]
    for name, ok in ratchets:
        n += 1
        print(f"  {'✅' if ok else '❌'} {name}")
        if not ok:
            fails.append(f"coverage:{name}")

    print(f"\n{'❌' if fails else '✅'} 口令表/名册/能承接口径:{n - len(fails)}/{n} 通过"
          + (f";失败 {fails}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
