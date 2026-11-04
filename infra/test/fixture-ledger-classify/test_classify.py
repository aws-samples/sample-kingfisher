#!/usr/bin/env python3
# @kf-batch 50-WP27-9cap-matrix
"""验收夹具台账的**分类与删除守卫**离线判据(`scripts/36-fixture-ledger.py`)。

    python3 infra/test/fixture-ledger-classify/test_classify.py     # 退出码 0 = 全过

🔴 **为什么必须离线钉**:这个脚本唯一的危险面就是「删错东西」,而那一面在真环境上没法安全地试
  (试一次就真删了)。两个纯函数正是为此抽出来的:
    · `classify(name)`   —— 示范对象(长期保留)/ 验收夹具 / 说不清;
    · `reject_reason()`  —— 通配符拒、示范对象拒、空名字拒。
  本仓的两个对偶毛病都靠它们分开:「夹具删不净 ⇒ 页面上是脏数据」与「示范对象被删 ⇒ 用户眼里
  这个区什么都没做」(记忆 `all-capabilities-visible-in-every-region`)。
"""
from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TARGET = os.path.join(REPO, "scripts", "36-fixture-ledger.py")


def load():
    spec = importlib.util.spec_from_file_location("fixture_ledger", TARGET)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


CLASSIFY = [
    ("示范对象(主控区)", "Showcase-home-GameSync-7tables", "keep"),
    ("示范对象(第二区)", "Showcase-usw2-a-RT-OrderAmount1m", "keep"),
    ("示范对象(问数卡片标题前缀)", "Showcase-home-Ask-渠道 ROAS Top3", "keep"),
    ("实时扇出验收夹具", "fk2r-0919095841-home", "fixture"),
    ("编排扇出验收夹具", "wf2r-0919095841", "fixture"),
    ("实时下发自检夹具", "DispatchCheck-RT-09191230", "fixture"),
    ("硬门段夹具(w3*)", "w3c1_big_0919101136", "fixture"),
    ("无名对象(半截创建失败)", "", "fixture"),
    ("只有空白的名字", "   ", "fixture"),
    ("用户自己建的东西", "我的渠道日报", "unknown"),
    ("名字里**含**但不以 Showcase- 开头", "copy-of-Showcase-home-x", "unknown"),
]

REJECT = [
    # (说明, token, 分类, 是否应当被拒)
    ("普通夹具名 ⇒ 放行", "fk2r-0919095841-home", "fixture", False),
    ("说不清的对象也放行(人已经点名了)", "我的渠道日报", "unknown", False),
    ("🔴 示范对象 ⇒ 拒", "Showcase-home-RT-OrderAmount1m", "keep", True),
    ("🔴 星号通配 ⇒ 拒", "fk2r-*", "fixture", True),
    ("🔴 问号通配 ⇒ 拒", "fk2r-09190958?1-home", "fixture", True),
    ("🔴 SQL 风格通配 ⇒ 拒", "fk2r-%", "fixture", True),
    ("🔴 空 token ⇒ 拒(多打一个逗号)", "", "fixture", True),
    ("🔴 只有空白 ⇒ 拒", "   ", "fixture", True),
    ("🔴 通配符优先于分类:示范对象 + 星号,照样拒", "Showcase-*", "keep", True),
]


def main() -> int:
    m = load()
    fails = []
    n = 0
    for name, arg, want in CLASSIFY:
        n += 1
        got = m.classify(arg)
        mark = "✅" if got == want else "❌"
        print(f"  {mark} classify:{name} ⇒ {got}(期望 {want})")
        if got != want:
            fails.append(name)
    for name, token, kls, should_reject in REJECT:
        n += 1
        why = m.reject_reason(token, kls)
        got = why is not None
        mark = "✅" if got == should_reject else "❌"
        print(f"  {mark} reject:{name} ⇒ {'拒(' + str(why)[:40] + ')' if got else '放行'}")
        if got != should_reject:
            fails.append(name)

    # 🔴 覆盖面自检:三种分类、两种裁决都必须被用例要求过,否则「恒回某一个值」的变异抓不住
    for st in ("keep", "fixture", "unknown"):
        n += 1
        if st in {c[2] for c in CLASSIFY}:
            print(f"  ✅ 覆盖面:有用例要求过 classify={st}")
        else:
            print(f"  ❌ 覆盖面:没有用例要求 classify={st}")
            fails.append(f"coverage:{st}")
    for b in (True, False):
        n += 1
        if b in {c[3] for c in REJECT}:
            print(f"  ✅ 覆盖面:有用例要求过 reject={b}")
        else:
            print(f"  ❌ 覆盖面:没有用例要求 reject={b}")
            fails.append(f"coverage:reject={b}")

    # 示范对象前缀本身是台账的承重结构:它一空,所有 Showcase 对象都会被判成可删
    n += 1
    if getattr(m, "KEEP_PREFIXES", ()) and "Showcase-" in m.KEEP_PREFIXES:
        print("  ✅ KEEP_PREFIXES 含 'Showcase-'(示范对象的护栏在)")
    else:
        print("  ❌ KEEP_PREFIXES 里没有 'Showcase-' ⇒ 示范对象会被判成可删")
        fails.append("KEEP_PREFIXES")

    print(f"\n{'❌' if fails else '✅'} 夹具台账守卫:{n - len(fails)}/{n} 通过" + (f";失败 {fails}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
