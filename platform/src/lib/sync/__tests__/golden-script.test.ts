// @kf-batch 37-sync-capability —— 🔴 序 37 的「别改坏其他功能」判据(A3 先钉现状)。
// `__golden__/*.py` 是**改动前**的生成器对 GOLDEN_SHAPES 每个存量形态的产物(d6dea1a 录制,之后不许重录)。
// 断言:不带任何序 37 新字段的存量任务,除「覆盖」写入外,生成的脚本与改动前**逐字节相同**。
// 「覆盖」形态是 B-53 要改的那一处,不在这里断(新行为由 sync-overwrite-atomic.test.ts 断)。
// 🔴 唯二两次有意重录(序 37 第五路,2026-10-12;重录前的副本在 /tmp/kf_golden_before_*,diff 已逐条写进报告):
//   · B-60:写 S3 Tables 的 4 个非覆盖形态各改**一行**(CREATE TABLE 的 TBLPROPERTIES 多了平台标记 bgp.created-by);
//   · B-61:`jdbc-both-merge` 整份重录 —— merge 原来静默退化成 append,这正是修复本身;改动前的那份保留为
//     `__golden__/jdbc-both-merge.pre-b61.py`(不在矩阵里),专供 sync-capability-behavior.test.ts 的判别力组证明「旧脚本重复行」。
// 🔴 第三次有意重录(序 44 B-86,2026-10-15;副本 /tmp/kf_golden_before_s44):9 个 JDBC 非覆盖形态各改**一行** ——
//   `jdbc_url = "jdbc:mysql://…/db"` ⇒ `…/db?zeroDateTimeBehavior=CONVERT_TO_NULL`(MySQL 方言默认参数:零值日期 / 时间戳按 NULL 读入,
//   不让整个作业因 `0000-00-00 00:00:00` 失败;唯一作者 lib/datasource-spi/jdbc/jdbc-params.ts)。4 个覆盖形态不在矩阵里,原样未动。
// 🔴 第四次有意重录(B-126,2026-10-26;副本 /tmp/kf_golden_before_b126):10 个非覆盖形态的 Redshift Data API 助手段整段重录 ——
//   run_stmt / run_batch / 探测只对连接层瞬态签名有界重试;建表与打平台标记进**同一个事务**(batch_execute_statement),
//   「平台建的表一定带标记」成为不变量。4 个覆盖形态仍不在矩阵里、原样未动(它们是 sync-capability-behavior.test.ts 判别力组的
//   「改动前脚本」夹具 ⇒ 下面的录制分支从此**跳过覆盖形态**,不再把它们一起覆写)。
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { GOLDEN_BINDINGS, GOLDEN_SHAPES } from "./golden-shapes";

const DIR = join(__dirname, "__golden__");

describe("序 37:存量同步任务的脚本逐字节不变", () => {
  if (process.env.BGP_WRITE_GOLDEN === "1") {
    it("录制基线(只在改动前跑一次)", () => {
      mkdirSync(DIR, { recursive: true });
      // 覆盖形态是判别力组的「改动前脚本」夹具,录制时跳过(B-126 重录时真把它们覆写过一次)。
      for (const s of GOLDEN_SHAPES.filter((x) => !x.overwrite)) {
        writeFileSync(join(DIR, `${s.name}.py`), generateGlueScript(s.task, s.ds, GOLDEN_BINDINGS));
      }
    });
    return;
  }
  it("矩阵里每个形态都有基线文件(防漏录)", () => {
    for (const s of GOLDEN_SHAPES) expect(existsSync(join(DIR, `${s.name}.py`)), s.name).toBe(true);
  });
  it("非覆盖形态至少 10 个(矩阵不许被悄悄缩小)", () => {
    expect(GOLDEN_SHAPES.filter((s) => !s.overwrite).length).toBeGreaterThanOrEqual(10);
  });
  for (const s of GOLDEN_SHAPES.filter((x) => !x.overwrite)) {
    it(`${s.name}:与改动前逐字节相同`, () => {
      const want = readFileSync(join(DIR, `${s.name}.py`), "utf8");
      const got = generateGlueScript(s.task, s.ds, GOLDEN_BINDINGS);
      expect(got).toBe(want);
    });
  }
});
