#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs_restructure.py —— 把「整段历史堆进一个单元格 / 一行」的 Markdown **机械、无损**地改成可读结构。

用户 2026-11-04:「所有文档都没有换行,都堆到一起」。台账 `docs/BUG-LEDGER.md`(最长行 17003 字符)与排期
`docs/design/DEV-SCHEDULE.md`(最长行 14910 字符)把一条缺陷 / 一个功能包的整部历史塞进一个表格单元格,
全仓 134 份 .md 里 71 份有同样的问题。本工具只做**结构**上的事:不改写、不概括、每个字符都保留。

三种 kind:
  generic   任意 .md:① 围栏代码块 / HTML 块原样不动;② 普通段落 > 300 字符 ⇒ 按「;」「。」「⇒」「 · 」切成
            一句一个 `- ` 项(列表项的后续句子成为子项;引用块的后续句子成为 `> ` 续行);③ 表格单元格 > 200 字符 ⇒
            表内留前 ≤ 120 字符 + 「…(见下)」,全文移到该表之后的 `- <行首单元格> · <列名>:` 注记列表里按句切行;
            ④ 标题行、链接、图片、表格分隔行不动。
  ledger    generic + 文件头 `> 版本:` 历史搬进 `## 0. 版本记录` + 「条目表」(每行首格 `B-<n>`)改成
            `## 0bis. 条目索引`(短格:编号 | 标题 | 状态 | 发现 | 修复 / 发版 | 详情)+ 每条一个小节
            (`### <标题>`,每个源列一个 `**<列名>**:` 字段,长格按句切成 `- ` 项;必有 `**状态**:` 行,
            `.claude/skills/multi-region-gate/ledger_sync.py` 读它)。
  schedule  同 ledger,条目表 = 表头首格为「序」的表;索引列:序 | 标题 | 状态 | 版本 | 工期 | 详情;小节 `### <标题>`。

用法(Python 3.9+,只用标准库,`python3 -I` 可跑):
  python3 -I scripts/lib/docs_restructure.py restructure docs/BUG-LEDGER.md --kind ledger --out docs/BUG-LEDGER.md
  python3 -I scripts/lib/docs_restructure.py restructure docs/design/DEV-SCHEDULE.md --kind schedule --out docs/design/DEV-SCHEDULE.md
  python3 -I scripts/lib/docs_restructure.py restructure docs/design/50-multi-region-execution/SPEC.md --kind generic --out docs/design/50-multi-region-execution/SPEC.md
  python3 -I scripts/lib/docs_restructure.py check docs/BUG-LEDGER.md docs/design/DEV-SCHEDULE.md      # 任一行 > 300 或任一单元格 > 200 ⇒ 退 1
  python3 -I scripts/lib/docs_restructure.py verify /tmp/kf_docs_orig/BUG-LEDGER.md docs/BUG-LEDGER.md  # 无损判据:旧文每个文本片段都要在新文里逐字找到
  python3 -I scripts/lib/docs_restructure.py stats docs/BUG-LEDGER.md                                  # 行数 / 最长行 / 超长单元格数
  python3 -I scripts/lib/docs_restructure.py --self-test

🔴 判据口径(与 platform/src/lib/__tests__/docs-format-guard.test.ts 同一份):
  · 非表格行 ≤ 300 字符;表格**单元格** ≤ 200 字符(表格行本身不按 300 判:4 列 × 合法的 200 字符必然 > 300);
  · 围栏代码块(``` / ~~~)里的行与 HTML 块行不判(规则 ① 它们原样不动)。

🔴 无损判据(verify)的实现:把旧文按 `|` 与换行切成「最大文本片段」,剥掉 Markdown 语法字符
  (`|` `#` `*` `-` `>` 反引号、空白)后,每个片段必须逐字出现在同样剥过的新文里;整段找不到时再按
  「;」「。」「⇒」「·」切细找。另加一条字符多重集判据:新文(剥后)每个字符的个数 ≥ 旧文。
  工具自己插入的只有:索引表、小节标题、字段标签、`- ` 项目符、`**` 粗体再平衡、「…(见下)」与锚点。

🔴 幂等:重构过的文件带标记注释,再跑 restructure 会拒绝(退 2)—— 之后靠 check 守住;新增条目直接按小节写。
"""
from __future__ import annotations

import argparse
import collections
import os
import re
import sys
import tempfile

LINE_LIMIT = 300
CELL_LIMIT = 200
CELL_KEEP = 120
TITLE_MAX = 40
MARKER = "<!-- docs_restructure: generated -->"

# ── 句界 ───────────────────────────────────────────────────────────────────────
L1 = ("。", ";", "\uff1b")    # 句子级:总是切(括号深度 0);本仓文档用 ASCII `;` 当中文分号,全角 `;`(U+FF1B)也认
L2 = ("⇒",)                   # 只在仍超长时切;符号归到右片开头
L3 = (" · ",)                  # 只在仍超长时切;「·」留在左片末
L4 = (",", "\uff0c")
L5 = ("、", " ")
OPEN = {"(": ")", "\uff08": "\uff09", "[": "]", "「": "」", "【": "】", "《": "》", "{": "}"}
CLOSE = {v: k for k, v in OPEN.items()}
#: 逐级降格:先句子级(认括号深度),再 ⇒ / ·,再忽略深度,最后逗号 / 顿号 / 空格;都不成才硬切。
LEVELS = [(L1, True), (L2, True), (L3, True), (L1, False), (L2, False), (L3, False),
          (L4, True), (L4, False), (L5, False)]

GLYPHS = "🆕🔴🟡🟢🔵✅❌🔧⚠️⏳📋📝🚧⤵🎉⏸️"
_G = "".join(sorted(set(GLYPHS)))
STATUS_WORDS = ("已修", "已验", "已做", "已改判", "已落地", "已完成", "已收官", "已解除", "待修", "待开工",
                "待定性", "待验", "进行中", "定性", "设计", "环境阻塞", "合同已落", "已写码", "待发版")

FENCE_RE = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
TABLE_RE = re.compile(r"^(\s*(?:>\s*)?)\|")
DELIM_RE = re.compile(r"^\s*(?:>\s*)?\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$")
HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", re.S)
QUOTE_RE = re.compile(r"^(\s*>\s?)(.*)$", re.S)
HTML_RE = re.compile(r"^\s*<[A-Za-z!/]")
VERSION_RE = re.compile(r"^>\s*版本:\s*(\*\*v[0-9.]+\*\*)(.*)$", re.S)
DATE_RE = re.compile(r"20\d\d-\d\d-\d\d")
REL_RE = re.compile(r"release-\d{4}-\d\d-\d\d(?:-[A-Za-z0-9]+)?|(?<![\w.])v?2\.\d+\.\d+(?![\w.])")
LEDGER_ID_RE = re.compile(r"^[\s%s]*(?:\*\*|`)?\s*(B-\d+[a-z]?)\b(?:\*\*|`)?\s*(.*)$" % _G, re.S)
SCHED_ID_RE = re.compile(r"^\s*\**\s*(\d+)\s*\**\s*$")
TITLE_CUT_RE = re.compile("\\(|\uff08|——|;|\uff1b|:|\uff1a")   # ASCII 与全角的括号 / 分号 / 冒号都算
TITLE_MIN = 6   # 截断点太靠前(如「客户(2.1.2)…」)就跳过它找下一个,免得标题只剩两个字
STRIP_CHARS = set("|#*->`") | set("…")


# ══════════════════════════════════════════════════════════════════════════════
# 文本切分(无损:片段只在空白处分开;分隔符全部保留)
# ══════════════════════════════════════════════════════════════════════════════
def _scan(s: str):
    """每个字符:是否在反引号代码段内、所在括号深度。"""
    n = len(s)
    in_code = [False] * n
    depth = [0] * n
    i = 0
    d = 0
    while i < n:
        ch = s[i]
        if ch == "`":
            j = i
            while j < n and s[j] == "`":
                j += 1
            run = s[i:j]
            k = s.find(run, j)
            # 找到同长度的闭合反引号串才算代码段;找不到就当普通字符
            while k != -1 and k + len(run) < n and s[k + len(run)] == "`":
                k = s.find(run, k + 1)
            if k != -1:
                for t in range(i, k + len(run)):
                    in_code[t] = True
                    depth[t] = d
                i = k + len(run)
                continue
            for t in range(i, j):
                depth[t] = d
            i = j
            continue
        if ch in OPEN:
            depth[i] = d
            d += 1
        elif ch in CLOSE:
            d = max(0, d - 1)
            depth[i] = d
        else:
            depth[i] = d
        i += 1
    return in_code, depth


def _split_once(s: str, bounds, depth_aware: bool) -> list:
    in_code, depth = _scan(s)
    pieces = []
    start = 0
    i = 0
    n = len(s)
    while i < n:
        hit = None
        for b in bounds:
            if s.startswith(b, i) and not any(in_code[i:i + len(b)]) and (not depth_aware or depth[i] == 0):
                hit = b
                break
        if hit is None:
            i += 1
            continue
        if hit == "⇒":
            if s[start:i].strip():
                pieces.append(s[start:i])
                start = i
            i += 1
        elif hit == " · ":
            pieces.append(s[start:i + 2])
            start = i + 3
            i += 3
        else:
            pieces.append(s[start:i + len(hit)])
            start = i + len(hit)
            i += len(hit)
    if s[start:].strip():
        pieces.append(s[start:])
    return [p.strip() for p in pieces if p.strip()]


def _hard_wrap(p: str, limit: int) -> list:
    out = []
    while len(p) > limit:
        in_code, _ = _scan(p)
        cut = None
        for i in range(limit, limit // 2, -1):
            if i < len(p) and not in_code[i] and p[i] == " ":
                cut = i
                break
        if cut is None:
            for i in range(limit, limit // 2, -1):
                if i < len(p) and not in_code[i]:
                    cut = i
                    break
        if cut is None:
            cut = limit
        out.append(p[:cut].rstrip())
        p = p[cut:].lstrip()
    if p:
        out.append(p)
    return out


def _fit(p: str, limit: int, level: int) -> list:
    if len(p) <= limit:
        return [p]
    for lv in range(level, len(LEVELS)):
        parts = _split_once(p, *LEVELS[lv])
        if len(parts) >= 2:
            res = []
            for q in parts:
                res.extend(_fit(q, limit, lv + 1))
            return res
    return _hard_wrap(p, limit)


def _bold_count(p: str) -> int:
    return len(re.findall(r"\*\*", re.sub(r"`[^`]*`", "", p)))


def _rebalance_bold(parts: list) -> list:
    """切开的片段若把 `**…**` 一分为二,左片补闭、右片补开 —— 渲染不变,verify 剥 `*` 后无差。"""
    out = []
    open_ = False
    for p in parts:
        q = ("**" + p) if open_ else p
        if _bold_count(p) % 2 == 1:
            open_ = not open_
        if open_:
            q = q + "**"
        out.append(q)
    return out


def split_fragments(s: str, limit: int = LINE_LIMIT) -> list:
    """句子级总是切;每片仍 > limit 时逐级降格再切。返回 ≥ 1 个片段,拼接(去空白)== 原文(去空白)。"""
    s = s.strip()
    if not s:
        return []
    out = []
    for p in _split_once(s, L1, True):
        out.extend(_fit(p, limit - 4, 1))   # 粗体再平衡最多补 4 个字符,先留出来
    return _rebalance_bold(out)


# ══════════════════════════════════════════════════════════════════════════════
# 表格
# ══════════════════════════════════════════════════════════════════════════════
def split_row(line: str) -> list:
    s = line.strip()
    s = re.sub(r"^>\s*", "", s)
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]


def render_row(indent: str, cells: list) -> str:
    return indent + "| " + " | ".join(cells) + " |"


def safe_prefix(c: str, n: int) -> str:
    p = c[:n]
    if p.count("`") % 2:
        p = p[:p.rfind("`")]
    if _bold_count(p) % 2:
        p = p[:p.rfind("**")]
    if p.count("[") > p.count("]"):
        p = p[:p.rfind("[")]
    elif "](" in p and p.count("(") > p.count(")"):
        p = p[:p.rfind("[")]
    return p.rstrip()


def short_cell(c: str, n: int = TITLE_MAX) -> str:
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", c)
    t = re.sub(r"\*+", "", t).strip()
    if len(t) > n:
        t = t[:n].rstrip() + "…"
    if t.count("`") % 2:
        t = t[:t.rfind("`")].rstrip() + "…"
    return t


def short_title(cell: str) -> str:
    """标题 = 原标题格去粗体、去首部状态符号后,到第一个 `(` / `——` / `;` / `:` 为止的前 ≤ 40 字符。"""
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)
    t = re.sub(r"\*+", "", t)
    t = re.sub(r"^[\s%s]+" % _G, "", t)
    in_code, _ = _scan(t)
    for m in TITLE_CUT_RE.finditer(t):
        if m.start() >= TITLE_MIN and not in_code[m.start()]:   # 反引号里的 `(` / `:` 不算截断点
            t = t[:m.start()]
            break
    t = t.strip(" :\uff1a·—-,\uff0c")
    if len(t) > TITLE_MAX:
        t = t[:TITLE_MAX].rstrip() + "…"
    if t.count("`") % 2:
        t = t[:t.rfind("`")].rstrip() + "…"
    return t or "(无标题)"


def short_status(cell: str) -> str:
    t = re.sub(r"\*+", "", cell).strip()
    m = TITLE_CUT_RE.search(t)
    if m and m.start() > 0:
        t = t[:m.start()]
    t = t.strip(" :\uff1a·—-,\uff0c")
    if len(t) > TITLE_MAX:
        t = t[:TITLE_MAX].rstrip() + "…"
    if t.count("`") % 2:
        t = t[:t.rfind("`")].rstrip() + "…"
    return t or "—"


def _is_status_text(rest: str) -> bool:
    r = re.sub(r"^[\s*`]+", "", rest)
    if not r:
        return False
    if r[0] in GLYPHS:
        return True
    return any(r.startswith(w) for w in STATUS_WORDS)


class Table:
    def __init__(self, indent, header_line, delim_line, row_lines):
        self.indent = indent
        self.header_line = header_line
        self.delim_line = delim_line
        self.row_lines = row_lines
        self.headers = split_row(header_line)
        self.rows = [split_row(r) for r in row_lines]
        self.pipeless = set()   # 没有 `|` 的单格续行(GFM 语义)的行号

    def subset(self, idxs):
        t = Table(self.indent, self.header_line, self.delim_line, [self.row_lines[i] for i in idxs])
        t.rows = [self.rows[i] for i in idxs]
        t.pipeless = {k for k, i in enumerate(idxs) if i in self.pipeless}
        return t


def _block_start(ln: str) -> bool:
    return bool(HEADING_RE.match(ln) or FENCE_RE.match(ln) or LIST_RE.match(ln) or QUOTE_RE.match(ln)
                or HTML_RE.match(ln) or re.match(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$", ln))


def parse_blocks(lines: list) -> list:
    """('code', [lines]) | ('table', Table) | ('line', text)

    🔴 表格中间夹空行(台账主表用空行分「批」、排期主表同形):GFM 里空行会结束表格,后面的 `|` 行就成了
      没有表头的孤儿行(渲染成一段竖线文字)。这里把「紧跟在一张表后面、中间只有空行」的 `|` 行并回那张表
      (空行丢掉 —— 它们没有文字,无损判据不受影响),既让条目表完整,也顺手修好渲染。
    """
    blocks = []
    i = 0
    n = len(lines)
    last_table = None      # 上一张表(中间只隔了空行时可续接)
    pending_blank = []     # 表后暂存的空行
    while i < n:
        ln = lines[i]
        if last_table is not None:
            if not ln.strip():
                pending_blank.append(ln)
                i += 1
                continue
            tm0 = TABLE_RE.match(ln)
            starts_new = tm0 and i + 1 < n and DELIM_RE.match(lines[i + 1]) and not DELIM_RE.match(ln)
            if tm0 and not starts_new and not DELIM_RE.match(ln):
                last_table.row_lines.append(ln)
                last_table.rows.append(split_row(ln))
                pending_blank = []
                i += 1
                continue
            if not pending_blank and not _block_start(ln):
                # 🔴 表格行后面紧跟一行没有 `|` 的文字:GFM 把它渲染成只有一格的表行。
                #   后面还有 `|` 行 ⇒ 它确实在表中间,按 GFM 吸收为单格行(补上竖线让它显式);
                #   后面没有 `|` 行 ⇒ 作者本意是表后的文字(漏了空行),补一个空行结束表格(只加空白,无损)。
                j = i
                while j < n and lines[j].strip() and not TABLE_RE.match(lines[j]) and not _block_start(lines[j]):
                    j += 1
                if j < n and TABLE_RE.match(lines[j]) and not DELIM_RE.match(lines[j]):
                    for k in range(i, j):
                        last_table.row_lines.append(lines[k])
                        last_table.rows.append([lines[k].strip()])
                        last_table.pipeless.add(len(last_table.rows) - 1)
                    i = j
                    continue
                blocks.append(("line", ""))
            blocks.extend(("line", b) for b in pending_blank)
            pending_blank = []
            last_table = None
        fm = FENCE_RE.match(ln)
        if fm:
            fence_ch, fence_len = fm.group(2)[0], len(fm.group(2))
            buf = [ln]
            i += 1
            while i < n:
                buf.append(lines[i])
                m2 = FENCE_RE.match(lines[i])
                i += 1
                if m2 and m2.group(2)[0] == fence_ch and len(m2.group(2)) >= fence_len and not m2.group(3).strip():
                    break
            blocks.append(("code", buf))
            continue
        tm = TABLE_RE.match(ln)
        if tm and i + 1 < n and DELIM_RE.match(lines[i + 1]) and not DELIM_RE.match(ln):
            indent = tm.group(1)
            header, delim = ln, lines[i + 1]
            i += 2
            rows = []
            while i < n and TABLE_RE.match(lines[i]) and lines[i].strip():
                rows.append(lines[i])
                i += 1
            last_table = Table(indent, header, delim, rows)
            blocks.append(("table", last_table))
            continue
        blocks.append(("line", ln))
        i += 1
    blocks.extend(("line", b) for b in pending_blank)
    return blocks


# ══════════════════════════════════════════════════════════════════════════════
# generic:行与普通表格
# ══════════════════════════════════════════════════════════════════════════════
def transform_line(ln: str, limit: int = LINE_LIMIT) -> list:
    if len(ln) <= limit or not ln.strip():
        return [ln]
    if HEADING_RE.match(ln) or HTML_RE.match(ln) or TABLE_RE.match(ln):
        return [ln]
    if re.match(r"^\s*!?\[[^\]]*\]\([^)]*\)\s*$", ln):
        return [ln]
    qm = QUOTE_RE.match(ln)
    if qm:
        prefix, body = qm.group(1), qm.group(2)
        frags = split_fragments(body, limit - len(prefix))
        if len(frags) <= 1 and len(ln) <= limit:
            return [ln]
        return [prefix + f for f in frags]
    lm = LIST_RE.match(ln)
    if lm:
        indent, marker, body = lm.group(1), lm.group(2), lm.group(3)
        sub = indent + " " * (len(marker) + 1)
        frags = split_fragments(body, limit - len(sub) - 2)
        if not frags:
            return [ln]
        return [f"{indent}{marker} {frags[0]}"] + [f"{sub}- {f}" for f in frags[1:]]
    indent = re.match(r"^(\s*)", ln).group(1)
    frags = split_fragments(ln.strip(), limit - len(indent) - 2)
    if len(frags) == 1 and len(ln) <= limit:
        return [ln]
    return [f"{indent}- {f}" for f in frags]


def render_generic_table(t: Table) -> list:
    out = [t.header_line, t.delim_line]
    notes = []
    for ri, (raw, cells) in enumerate(zip(t.row_lines, t.rows)):
        cells = list(cells) + [""] * (len(t.headers) - len(cells))
        changed = ri in t.pipeless
        for j, c in enumerate(cells):
            if len(c) > CELL_LIMIT:
                col = t.headers[j] if j < len(t.headers) else f"列 {j + 1}"
                notes.append((cells[0] if cells else "", col, c))
                cells[j] = safe_prefix(c, CELL_KEEP) + "…(见下)"
                changed = True
        out.append(render_row(t.indent, cells) if changed else raw)
    if notes:
        ind = t.indent
        out.append("")
        out.append(f"{ind}超长单元格全文(表内只留前 {CELL_KEEP} 字符):")
        out.append("")
        for head, col, full in notes:
            label = f"**{short_cell(head)}** · {re.sub(r'[*]+', '', col).strip()}:"
            frags = split_fragments(full, LINE_LIMIT - len(ind) - 4)
            if len(frags) == 1 and len(ind) + 2 + len(label) + 1 + len(frags[0]) <= LINE_LIMIT:
                out.append(f"{ind}- {label} {frags[0]}")
            else:
                out.append(f"{ind}- {label}")
                out.extend(f"{ind}  - {f}" for f in frags)
    return out


# ══════════════════════════════════════════════════════════════════════════════
# ledger / schedule:条目表 ⇒ 索引 + 小节
# ══════════════════════════════════════════════════════════════════════════════
class Entry:
    def __init__(self, ident, anchor, heading_level, title, status, cells, headers, section, fields):
        self.ident = ident
        self.anchor = anchor
        self.heading_level = heading_level
        self.title = title
        self.status = status
        self.cells = cells
        self.headers = headers
        self.section = section
        self.fields = fields   # 索引用的派生短格


def entry_mask(kind: str, t: Table):
    """条目表判定:返回每行是否条目的掩码;不是条目表 ⇒ None。

    ledger:首格以 `B-<n>` 开头的行是条目;≥ 2 行且 ≥ 50% 的行是条目才算条目表(§21.16 那张表夹着 3 行
           判据轮次行,不是条目,留成一张小「残表」放在条目前面)。
    schedule:表头首格为「序」⇒ 每行都是条目。
    生成的索引表首格是 `[…](#…)` 链接 ⇒ 永不被当成条目表(幂等)。
    """
    if not t.rows or any(r and r[0].startswith("[") for r in t.rows):
        return None
    if kind == "ledger":
        mask = [bool(r and i not in t.pipeless and LEDGER_ID_RE.match(r[0])) for i, r in enumerate(t.rows)]
        return mask if sum(mask) >= 2 and sum(mask) * 2 >= len(mask) else None
    if kind == "schedule":
        if t.headers and t.headers[0] == "序":
            return [i not in t.pipeless for i in range(len(t.rows))]
    return None


def _col(t: Table, names) -> int:
    for j, h in enumerate(t.headers):
        hh = re.sub(r"\*+", "", h).strip()
        if hh in names:
            return j
    return -1


LEDGER_TITLE_COLS = ("一句话", "缺陷", "现象", "问题", "判据", "修法(唯一作者)", "我先写下的「根因」", "段", "功能包")
LEDGER_STATUS_COLS = ("状态",)
LEDGER_SKIP_TITLE = ("严重度", "状态", "结果", "ID", "编号", "#", "红", "条目", "项")


def build_entries(kind: str, t: Table, level: int, section: str, anchors: dict) -> list:
    entries = []
    status_j = _col(t, LEDGER_STATUS_COLS)
    for cells in t.rows:
        cells = list(cells)
        if 1 < len(cells) < len(t.headers) and re.sub(r"\*+", "", t.headers[-1]).strip() == "状态":
            # 🔴 残缺行(台账行少了「严重度」格):状态列在表尾时把最后一格对齐到状态列,中间补空
            cells = cells[:-1] + [""] * (len(t.headers) - len(cells)) + cells[-1:]
        cells = cells + [""] * (len(t.headers) - len(cells))
        first = cells[0]
        if kind == "ledger":
            m = LEDGER_ID_RE.match(first)
            ident, rest = m.group(1), m.group(2).strip()
            rest_status = _is_status_text(rest)
            if status_j >= 0:
                status_cell = cells[status_j]
            elif rest_status:
                status_cell = rest
            else:
                status_cell = ""
            title_src = ""
            if rest and not rest_status:
                title_src = rest
            else:
                tj = _col(t, LEDGER_TITLE_COLS)
                if tj < 0:
                    for j, h in enumerate(t.headers):
                        if j and re.sub(r"\*+", "", h).strip() not in LEDGER_SKIP_TITLE:
                            tj = j
                            break
                if tj < 0 and len(cells) > 1:
                    tj = 1
                title_src = cells[tj] if tj >= 0 else ""
                if not title_src.strip():   # 标题列空(残缺行)⇒ 取编号后第一个非空、非状态的格
                    title_src = next((c for j, c in enumerate(cells) if j and j != status_j and c.strip()), "")
            others = [c for j, c in enumerate(cells) if j != status_j and j != 0]
            d_found = next(iter(DATE_RE.findall(" ".join(others))), "") or next(iter(DATE_RE.findall(" ".join(cells))), "") or "—"
            d_fix = next(iter(DATE_RE.findall(status_cell)), "")
            rel = next(iter(REL_RE.findall(" ".join(cells))), "")
            fix = " · ".join(x for x in (d_fix, rel) if x) or "—"
            fields = {"发现": d_found, "修复 / 发版": fix}
            base = ident.lower()
            heading = f"{ident} · {short_title(title_src)}"
        else:
            m = SCHED_ID_RE.match(first)
            ident = m.group(1) if m else re.sub(r"\*+", "", first).strip()
            sj = _col(t, ("状态",))
            status_cell = cells[sj] if sj >= 0 else ""
            tj = _col(t, ("功能包", "标题", "内容"))
            if tj < 0:
                tj = 1 if len(cells) > 1 else 0
            title_src = cells[tj]
            ej = _col(t, ("预估工时", "工时", "工期"))
            effort = short_cell(cells[ej]) if ej >= 0 and cells[ej] else "—"
            rel = next(iter(REL_RE.findall(" ".join(cells))), "") or "—"
            fields = {"版本": rel, "工期": effort}
            base = f"seq-{ident.lower()}"
            heading = f"序 {ident} · {short_title(title_src)}"
        anchor = base
        k = 2
        while anchor in anchors:
            anchor = f"{base}-{k}"
            k += 1
        anchors[anchor] = True
        entries.append(Entry(ident, anchor, level, heading, short_status(status_cell) if status_cell else "—",
                             cells, t.headers, section, fields))
        entries[-1].has_status_col = status_j >= 0 if kind == "ledger" else True
    return entries


def render_field(label: str, cell: str) -> list:
    label = re.sub(r"\*+", "", label).strip() or "列"
    head = f"**{label}**:"
    if not cell.strip():
        return [f"{head} (空)"]
    frags = split_fragments(cell, LINE_LIMIT - 2)
    if len(frags) == 1 and len(head) + 1 + len(frags[0]) <= LINE_LIMIT:
        return [f"{head} {frags[0]}"]
    return [head] + [f"- {f}" for f in frags]


def render_entry(kind: str, e: Entry) -> list:
    out = [f'<a id="{e.anchor}"></a>', f"{'#' * e.heading_level} {e.title}", ""]
    if kind == "ledger" and not e.has_status_col:
        out += [f"**状态**: {e.status}", ""]
    for j, cell in enumerate(e.cells):
        label = e.headers[j] if j < len(e.headers) else f"列 {j + 1}"
        out += render_field(label, cell) + [""]
    return out


def _sort_key(kind: str, e: Entry, order: int):
    if kind == "ledger":
        m = re.match(r"B-(\d+)([a-z]?)", e.ident)
        return (0, int(m.group(1)), m.group(2), order)
    if e.ident.isdigit():
        return (0, int(e.ident), "", order)
    return (1, 0, e.ident, order)


def render_index(kind: str, entries: list) -> list:
    if kind == "ledger":
        head = ["编号", "标题", "状态", "发现", "修复 / 发版", "详情"]
    else:
        head = ["序", "标题", "状态", "版本", "工期", "详情"]
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for e in sorted(enumerate(entries), key=lambda p: _sort_key(kind, p[1], p[0])):
        e = e[1]
        link = f"[{e.ident}](#{e.anchor})"
        title = e.title.split(" · ", 1)[1] if " · " in e.title else e.title
        cells = [link, title, e.status] + list(e.fields.values()) + [e.section]
        out.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
    return out


def _section_label(heading_text: str) -> str:
    t = re.sub(r"\*+", "", heading_text).strip()
    m = re.match(r"^(\d+(?:\.\d+)*|\d+[a-z]+(?:\.\d+)*)[.\s::]", t + " ")
    if m:
        return "§" + m.group(1)
    m = re.match(r"^(B-\d+[a-z]?)\b", t)
    if m:
        return m.group(1)
    return short_cell(t, 14)


def restructure(text: str, kind: str) -> str:
    if MARKER in text:
        raise SystemExit("🔴 文件已含 docs_restructure 标记(已重构过)⇒ 拒绝再跑;新增条目请直接按小节写,靠 check 守住。")
    lines = text.split("\n")
    trailing_nl = text.endswith("\n")
    if trailing_nl:
        lines = lines[:-1]

    pre, head_block, body = [], [], lines
    if kind in ("ledger", "schedule"):
        vi = next((i for i, l in enumerate(lines) if VERSION_RE.match(l)), -1)
        if vi < 0:
            raise SystemExit("🔴 找不到 `> 版本: **vX.Y**` 文件头 ⇒ 这不是台账 / 排期的形状;generic 请用 --kind generic")
        a = vi
        while a > 0 and lines[a - 1].startswith(">"):
            a -= 1
        b = vi
        while b + 1 < len(lines) and lines[b + 1].startswith(">"):
            b += 1
        pre, head_block, body = lines[:a], lines[a:b + 1], lines[b + 1:]

    out: list = list(pre)
    entries: list = []
    anchors: dict = {}
    index_at = -1
    if kind in ("ledger", "schedule"):
        cur = VERSION_RE.match(head_block[next(i for i, l in enumerate(head_block) if VERSION_RE.match(l))])
        out.append(f"> 版本: {cur.group(1)} —— 历次版本记录见 §0「版本记录」(本行只保留当前版本号;改版本时在 §0 顶部加一条)。")
        nver = sum(1 for l in head_block if VERSION_RE.match(l))
        out += ["", MARKER, "", "## 0. 版本记录", "",
                "> 由 `scripts/lib/docs_restructure.py` 从文件头历次 `> 版本:` 行机械搬入:一个版本一条,按句(`;` / `。`)切成子项,原文一字不改;默认折叠,点开即全文。", "",
                "<details>", f"<summary>历次版本记录({nver} 条,最新在前)</summary>", ""]
        for l in head_block:
            vm = VERSION_RE.match(l)
            if vm:
                frags = split_fragments(f"版本: {vm.group(1)}{vm.group(2)}", LINE_LIMIT - 4)
                out.append(f"- {frags[0]}")
                out.extend(f"  - {f}" for f in frags[1:])
            else:
                body_txt = re.sub(r"^>\s?", "", l)
                if not body_txt.strip():
                    continue
                frags = split_fragments(body_txt, LINE_LIMIT - 4)
                out.extend(f"  - {f}" for f in frags)
        out += ["", "</details>", "", "## 0bis. 条目索引", "",
                ("> 机械生成:标题取原标题格前 40 字符;状态取状态格首句;"
                 + ("发现 = 条目正文里第一个日期、修复 / 发版 = 状态格里第一个日期与行内第一个发版 tag,"
                    if kind == "ledger" else "版本 = 行内第一个发版 tag / 2.x.y 版本号,")
                 + "**以条目正文为准**;详情列 = 条目所在章节,编号列可点击跳到条目。"), ""]
        index_at = len(out)
        out.append("@@INDEX@@")
        out.append("")

    level = 2
    section = "§0"
    for kindb, payload in parse_blocks(body):
        if kindb == "code":
            out.extend(payload)
            continue
        if kindb == "line":
            hm = HEADING_RE.match(payload)
            if hm:
                level = len(hm.group(1))
                section = _section_label(hm.group(2))
            out.extend(transform_line(payload))
            continue
        t: Table = payload
        mask = entry_mask(kind, t) if kind in ("ledger", "schedule") else None
        if mask:
            rest = [i for i, m in enumerate(mask) if not m]
            if rest:
                out.extend(render_generic_table(t.subset(rest)))
                out.append("")
            es = build_entries(kind, t.subset([i for i, m in enumerate(mask) if m]), max(3, min(6, level + 1)), section, anchors)
            entries.extend(es)
            for e in es:
                out.extend(render_entry(kind, e))
            continue
        out.extend(render_generic_table(t))

    if index_at >= 0:
        out[index_at:index_at + 1] = render_index(kind, entries) if entries else ["(本文件没有条目表)"]
    res = "\n".join(out)
    return res + ("\n" if trailing_nl else "")


# ══════════════════════════════════════════════════════════════════════════════
# check / verify / stats
# ══════════════════════════════════════════════════════════════════════════════
def code_lines(text: str) -> set:
    """围栏代码块里的行(含围栏行本身)。"""
    out = set()
    for kind, payload in parse_blocks(text.split("\n")):
        if kind == "code":
            out.update(payload)
    return out


def check_text(text: str, line_limit: int = LINE_LIMIT, cell_limit: int = CELL_LIMIT) -> list:
    """返回违规清单 [(行号, 描述)]。规则与 docs-format-guard.test.ts 同一份。"""
    bad = []
    in_code = None
    for i, ln in enumerate(text.split("\n"), 1):
        fm = FENCE_RE.match(ln)
        if in_code:
            if fm and fm.group(2)[0] == in_code[0] and len(fm.group(2)) >= in_code[1] and not fm.group(3).strip():
                in_code = None
            continue
        if fm:
            in_code = (fm.group(2)[0], len(fm.group(2)))
            continue
        if HTML_RE.match(ln):
            continue
        if TABLE_RE.match(ln):
            if DELIM_RE.match(ln):
                continue
            for j, c in enumerate(split_row(ln), 1):
                if len(c) > cell_limit:
                    bad.append((i, f"单元格(第 {j} 列){len(c)} 字符 > {cell_limit}:{c[:60]}…"))
            continue
        if len(ln) > line_limit:
            bad.append((i, f"行 {len(ln)} 字符 > {line_limit}:{ln.strip()[:60]}…"))
    return bad


def stats_text(text: str) -> dict:
    lines = text.split("\n")
    if text.endswith("\n"):
        lines = lines[:-1]
    longest = max((len(l) for l in lines), default=0)
    cells = 0
    for ln in lines:
        if TABLE_RE.match(ln) and not DELIM_RE.match(ln):
            cells += sum(1 for c in split_row(ln) if len(c) > CELL_LIMIT)
    over = sum(1 for l in lines if len(l) > LINE_LIMIT and not TABLE_RE.match(l))
    return {"lines": len(lines), "longest": longest, "cells_over": cells, "lines_over": over}


def _norm(s: str) -> str:
    return "".join(ch for ch in s if ch not in STRIP_CHARS and not ch.isspace())


def _fragments(text: str) -> list:
    out = []
    for ln in text.split("\n"):
        for part in re.split(r"(?<!\\)\|", ln):
            p = part.strip()
            if p and _norm(p):
                out.append(p)
    return out


def verify_texts(old: str, new: str) -> list:
    """旧文每个最大文本片段(按 | 与换行切)剥语法后必须逐字出现在新文里;整段找不到再按句界切细找。"""
    nn = _norm(new)
    missing = []
    for f in _fragments(old):
        if _norm(f) in nn:
            continue
        subs = [p for p in re.split(r"[;;。⇒·]", f) if _norm(p)]
        lost = [p for p in subs if _norm(p) not in nn]
        if lost:
            missing.append(f if len(lost) == len(subs) else " ⟂ ".join(lost))
    co, cn = collections.Counter(_norm(old)), collections.Counter(nn)
    for ch, k in co.items():
        if cn.get(ch, 0) < k:
            missing.append(f"[字符多重集] {ch!r} 旧 {k} 次 > 新 {cn.get(ch, 0)} 次")
    return missing


def _read(p: str) -> str:
    with open(p, encoding="utf-8") as f:
        return f.read()


def cmd_restructure(a) -> int:
    text = _read(a.file)
    res = restructure(text, a.kind)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(res)
    s0, s1 = stats_text(text), stats_text(res)
    print(f"✅ restructure({a.kind}) {a.file} → {a.out}:行 {s0['lines']} → {s1['lines']},最长行 {s0['longest']} → {s1['longest']},"
          f"超长单元格 {s0['cells_over']} → {s1['cells_over']},超长行 {s0['lines_over']} → {s1['lines_over']}")
    return 0


def cmd_check(a) -> int:
    rc = 0
    for p in a.files:
        bad = check_text(_read(p), a.line_limit, a.cell_limit)
        if bad:
            rc = 1
            print(f"🔴 {p}:{len(bad)} 处超限")
            for ln, why in bad[:a.max_print]:
                print(f"   {p}:{ln}: {why}")
            if len(bad) > a.max_print:
                print(f"   … 还有 {len(bad) - a.max_print} 处")
        else:
            print(f"✅ {p}:非表格行 ≤ {a.line_limit} 字符、单元格 ≤ {a.cell_limit} 字符")
    return rc


def cmd_verify(a) -> int:
    miss = verify_texts(_read(a.old), _read(a.new))
    if miss:
        print(f"🔴 verify:{len(miss)} 个旧文片段在新文里找不到(前 {min(len(miss), a.max_print)} 个):")
        for m in miss[:a.max_print]:
            print("   · " + m[:200])
        return 1
    print(f"✅ verify:{a.old} 的 {len(_fragments(_read(a.old)))} 个文本片段全部逐字出现在 {a.new};字符多重集新 ⊇ 旧")
    return 0


def cmd_stats(a) -> int:
    for p in a.files:
        s = stats_text(_read(p))
        print(f"{p}: 行 {s['lines']} · 最长行 {s['longest']} · 非表格超长行(>300) {s['lines_over']} · 超长单元格(>200) {s['cells_over']}")
    return 0


# ══════════════════════════════════════════════════════════════════════════════
# 自检:合成的小台账 / 小排期 / generic 样例,正向 + 负向(变异)
# ══════════════════════════════════════════════════════════════════════════════
def _mk(n: int, seed: str) -> str:
    return (seed * (n // len(seed) + 1))[:n]


_LEDGER = """# 台账(合成)

> 版本: **v1.2**(🆕 2026-11-04 **B-2 已修**:第一句;第二句 `a;b` 不切;第三句。末句)
> 版本: **v1.1**(2026-11-03 立 B-1)
> 续行(用户原话)

## 1. 当前清单

| ID | 严重度 | 一句话 | 状态 |
|---|---|---|---|
| **B-1** | 高 | 同步丢行(含「;」在括号里) | 待开工:%s;**粗体跨句 ⇒ 第二段**;%s |
| **B-2** | 中 | 第二条 | ✅ 已修已验(feat/1 `abc1234`;2026-11-04) |

| **B-4** | 低 | 空行之后的孤儿行 | ⏳ 待开工 |

## 2. 批次

- **页面级验收结果**:
  | 红 | 现象 | 定性 | 修法 |
  |---|---|---|---|
  | S1-7a | 判据轮次行(不是条目) | 量具 | 改判据 |
  续行没有竖线(GFM 当单格行)
  | 🆕 B-3 ✅ **已修已验(…1234 页面驱动 5/5;合回 design `deadbee`)** | 列表不刷新 | 竞态 | 唯一作者 `lib/x.ts` |
  | B-1 🔴 | 再次出现 | 同根因 | 同上 |
  表后紧跟的文字(作者漏了空行)

  | 段 | 结论 |
  |---|---|
  | s1 | %s |

%s

- 列表项:%s

> 引用:%s

```text
%s
| 代码块里的 | 超长单元格 | %s |
```

<div>%s</div>
""" % (_mk(260, "甲乙丙丁"), _mk(120, "戊己"), _mk(260, "庚辛"), _mk(700, "段落句。"), _mk(650, "项目句;"),
       _mk(400, "引文。"), _mk(400, "x"), _mk(300, "y"), _mk(400, "z"))

_SCHED = """# 排期(合成)

> 版本: **v2.0**(🆕 序 2 收口;序 1 待验)

## 2. 主排期表

| 序 | 功能包 | 状态 | 已交付 / 剩余工作 | 预估工时 | 硬门段 |
|---|---|---|---|---|---|
| 1 | **WP-1** 第一包(括号) | ✅ **已收官**(段 `a` 3/3) | 进 2.2.0;%s | 4–6h | `a` |
| 2 | 🆕 **WP-2** 第二包 | 🔧 | release-2026-10-29 上线;剩:x | 8h | — |
| B | 🔴 **台账在办项** | — | B-1 | — | — |

## 4. 索引

| 模块 / 层 | 文件 | 版本 |
|---|---|---|
| 50 合同 | `SPEC.md` | **v3.54** |
""" % _mk(500, "交付句;")


def self_test() -> int:
    fails = []

    def ok(cond, msg):
        print(("  ✅ " if cond else "  🔴 ") + msg)
        if not cond:
            fails.append(msg)

    with tempfile.TemporaryDirectory() as d:
        # ── ledger ──
        p_old = os.path.join(d, "L.md")
        with open(p_old, "w", encoding="utf-8") as f:
            f.write(_LEDGER)
        new = restructure(_LEDGER, "ledger")
        ok(not check_text(new), "ledger:重构后 check 0 违规")
        ok(not verify_texts(_LEDGER, new), "ledger:verify 无损(每个旧片段都在新文里)")
        ok("> 版本: **v1.2**" in new.split("\n")[2], "ledger:文件头保留 `> 版本: **v1.2**` 前缀(head_version 读它)")
        ok("## 0. 版本记录" in new and "- 版本: **v1.1**(2026-11-03 立 B-1)" in new, "ledger:§0 版本记录逐版一条")
        ok("| [B-1](#b-1) |" in new and "| [B-3](#b-3) |" in new and "[B-1](#b-1-2)" in new, "ledger:索引表含每条(重复编号锚点 -2)")
        ok('<a id="b-3"></a>\n### B-3 · 列表不刷新' in new, "ledger:§2 列表里的缩进条目表 ⇒ 父级(##)+1 的 ### 小节,标题取现象格")
        ok("  | S1-7a | 判据轮次行(不是条目) | 量具 | 改判据 |\n  | 续行没有竖线(GFM 当单格行) |  |  |  |\n\n<a id=" in new,
           "ledger:非条目行留成残表(含补竖线的 GFM 单格续行),放在条目前")
        ok("\n\n  表后紧跟的文字(作者漏了空行)" in new, "ledger:表后紧跟的文字前补空行(结束表格)")
        ok("### B-1 · 同步丢行" in new, "ledger:主表条目 ⇒ ### 小节,标题在第一个「(」前截断")
        ok("### B-4 · 空行之后的孤儿行" in new and "| [B-4](#b-4) |" in new, "ledger:表中空行之后的孤儿 `|` 行并回同一张表")
        ok("**状态**: ✅ 已修已验" in new, "ledger:无状态列的表合成 `**状态**:` 行(首格状态首句)")
        ok("**状态**:\n- 待开工:" in new, "ledger:状态格多句 ⇒ 字段标签 + `- ` 项")
        ok("第二段**;" in new and "- **粗体跨句" in new, "ledger:粗体跨句切开时两侧补 ** 再平衡")
        ok("`a;b` 不切" in new, "ledger:反引号里的「;」不切")
        prose = [l for l in new.split("\n") if not TABLE_RE.match(l) and not HTML_RE.match(l) and l not in code_lines(new)]
        ok(prose and all(len(l) <= LINE_LIMIT for l in prose), "ledger:代码块 / HTML 之外的所有非表格行 ≤ 300")
        ok("…(见下)" in new and "**s1** · 结论:" in new, "ledger:普通表格超长格 ⇒ 前 120 字符 + (见下) + 表后注记")
        code_old = _LEDGER[_LEDGER.index("```text"):_LEDGER.index("```\n", _LEDGER.index("```text") + 7) + 3]
        ok(code_old in new, "ledger:围栏代码块逐字节不动(含超长行与伪表格行)")
        ok("<div>" + _mk(400, "z") + "</div>" in new, "ledger:HTML 块不动")
        ok("- 列表项:项目句;" in new and "\n  - 项目句;" in new, "ledger:列表项按句切成子项")
        ok("> 引文。" in new and new.count("> 引文。") >= 2, "ledger:引用块按句切成 `> ` 续行")
        ok(new.count("\n- 段落句。") >= 2, "ledger:普通段落 ⇒ 一句一个 `- ` 项")
        # 变异 ① 删一个片段 ⇒ verify 必红
        mut = new.replace("列表不刷新", "")
        ok(bool(verify_texts(_LEDGER, mut)), "ledger 变异:删掉一个片段 ⇒ verify 红")
        # 变异 ② 改一个字 ⇒ verify 必红
        mut2 = new.replace("第二条", "第三条")
        ok(bool(verify_texts(_LEDGER, mut2)), "ledger 变异:改一个字 ⇒ verify 红")
        # 变异 ③ 一行 301 字符 ⇒ check 红;单元格 201 ⇒ check 红;代码块里不判
        ok(bool(check_text(new + "\n" + "x" * 301)), "check 变异:301 字符行 ⇒ 红")
        ok(bool(check_text("| a | %s |\n|---|---|\n" % ("y" * 201))), "check 变异:201 字符单元格 ⇒ 红")
        ok(not check_text("```\n%s\n```\n" % ("x" * 500)), "check:围栏代码块里的 500 字符行不判")
        ok(not check_text("<div>%s</div>\n" % ("z" * 500)), "check:HTML 块行不判(规则 ① 它原样不动)")
        # 幂等:再跑拒绝
        try:
            restructure(new, "ledger")
            ok(False, "ledger:重构过的文件再跑应拒绝")
        except SystemExit:
            ok(True, "ledger:重构过的文件再跑拒绝(标记)")
        # ── schedule ──
        snew = restructure(_SCHED, "schedule")
        ok(not check_text(snew) and not verify_texts(_SCHED, snew), "schedule:check 0 违规 + verify 无损")
        ok("| 序 | 标题 | 状态 | 版本 | 工期 | 详情 |" in snew, "schedule:索引表列头")
        ok("| [1](#seq-1) | WP-1 第一包 | ✅ 已收官 | 2.2.0 | 4–6h | §2 |" in snew, "schedule:索引行(标题截断 / 状态首句 / 版本抽取 / 工期 / 章节)")
        ok("| [2](#seq-2) | WP-2 第二包 | 🔧 | release-2026-10-29 | 8h | §2 |" in snew, "schedule:release tag 优先作版本")
        ok("### 序 1 · WP-1 第一包" in snew and "### 序 B · 台账在办项" in snew, "schedule:每行一个小节(含非数字序)")
        ok("| 50 合同 | `SPEC.md` | **v3.54** |" in snew, "schedule:非条目短表原样保留(contract-drift 读它)")
        # ── generic ──
        gnew = restructure(_LEDGER, "generic")
        ok("## 0. 版本记录" not in gnew and "| **B-1** | 高 |" in gnew, "generic:不动文件头、不建索引、条目表只按超长格处理")
        ok(not check_text(gnew) and not verify_texts(_LEDGER, gnew), "generic:check 0 违规 + verify 无损")
        ok(code_old in gnew, "generic:代码块不动")
    print("  ⇒ " + ("自检全过" if not fails else f"🔴 {len(fails)} 条自检失败"))
    return 1 if fails else 0


def main(argv=None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if "--self-test" in argv:
        return self_test()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("restructure", help="机械无损重构")
    r.add_argument("file")
    r.add_argument("--kind", required=True, choices=("ledger", "schedule", "generic"))
    r.add_argument("--out", required=True)
    r.set_defaults(fn=cmd_restructure)
    c = sub.add_parser("check", help="任一行 > 300 或任一单元格 > 200 ⇒ 退 1")
    c.add_argument("files", nargs="+")
    c.add_argument("--line-limit", type=int, default=LINE_LIMIT)
    c.add_argument("--cell-limit", type=int, default=CELL_LIMIT)
    c.add_argument("--max-print", type=int, default=40)
    c.set_defaults(fn=cmd_check)
    v = sub.add_parser("verify", help="无损判据:旧文每个片段逐字在新文里")
    v.add_argument("old")
    v.add_argument("new")
    v.add_argument("--max-print", type=int, default=40)
    v.set_defaults(fn=cmd_verify)
    s = sub.add_parser("stats", help="行数 / 最长行 / 超长数")
    s.add_argument("files", nargs="+")
    s.set_defaults(fn=cmd_stats)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
