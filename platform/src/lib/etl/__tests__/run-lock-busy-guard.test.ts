// `RunLockBusy` 分流门禁 —— 「抢不到运行锁」必须是**用户可修的 409**,不是平台故障 500。
//
// 🔴 为什么要门:这个错是**跨四个抢锁点 + 两条运行路由**的约定,而它的失效形态**完全静默** ——
// 少一处抛类型,那一处的并发冲突就悄悄回 500「运行失败」,界面把人引去查平台故障,
// 而真相是「上一次还在跑,等一下再点」。2026-09-09 硬门 w3f 段 W3f-3 就是这么撞到的
// (单区运行紧跟两区运行 ⇒ 同一个 target 的锁还被持着 ⇒ 500)。
// 同类病此前已修过一次(落点冲突报 500,W3a-9),当时只修了绑定那一类 ⇒ 这次用门禁钉住整类。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RunLockBusy } from "../run-lock";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

/** 四个抢锁点(锁的消费者全集;新增消费者必须同时加进这张表 —— 表本身就是清单)。 */
const LOCK_SITES = [
  "lib/etl/job-service.ts",
  "lib/engines/emr/provider.ts",
  "lib/backfill/execute.ts",
];
/** 两条运行路由(做 409 / 500 分流的地方)。 */
// 引擎运行的提交段(含 rejected: 分流)搬进长操作执行体 lib/engines/long-ops.ts,路由里只剩快校验
const RUN_ROUTES = ["app/api/etl-jobs/[id]/run/route.ts", "lib/engines/long-ops.ts"];

describe("RunLockBusy 类型本身", () => {
  it("是 Error 的子类、带可读 name 与 busy 标记", () => {
    const e = new RunLockBusy("该作业正在运行中");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RunLockBusy");
    expect(e.busy).toBe(true);
    expect(e.message).toContain("正在运行中");
  });
});

describe("run-lock-busy-guard", () => {
  it("🔴 每个抢锁点的「抢不到」分支都必须抛 RunLockBusy,不许再出现裸 `throw new Error`", () => {
    const bad: string[] = [];
    for (const f of LOCK_SITES) {
      const src = read(f);
      // 逐行找「抢不到锁」的那几行(`if (!lock) throw ...`),断言用的是类型化错误
      for (const line of src.split("\n")) {
        if (!/if\s*\(!lock\)\s*throw/.test(line)) continue;
        if (!line.includes("new RunLockBusy(")) bad.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(
      bad,
      `这些抢锁点还在抛裸 Error ⇒ 并发冲突会落到 500「运行失败」:${bad.join(" / ")}`
    ).toEqual([]);
  });

  it("门禁自检:探测器真能抓到裸 Error 的写法(否则上一条是空断言)", () => {
    const good = '  if (!lock) throw new RunLockBusy("该作业正在运行中");';
    const bad = '  if (!lock) throw new Error("该作业正在运行中");';
    expect(/if\s*\(!lock\)\s*throw/.test(bad) && !bad.includes("new RunLockBusy(")).toBe(true);
    expect(/if\s*\(!lock\)\s*throw/.test(good) && !good.includes("new RunLockBusy(")).toBe(false);
  });

  it("抢锁点确实**存在**(路径写错会让上面两条变成零次循环)", () => {
    let sites = 0;
    for (const f of LOCK_SITES) sites += (read(f).match(/if\s*\(!lock\)\s*throw/g) || []).length;
    expect(sites).toBeGreaterThanOrEqual(4);
  });

  it("🔴 两条运行路由的 409/500 分流都必须认 RunLockBusy", () => {
    const bad: string[] = [];
    for (const f of RUN_ROUTES) {
      const src = read(f);
      const line = src.split("\n").find((l) => l.trim().startsWith("rejected:"));
      if (!line) bad.push(`${f}: 找不到 rejected: 分流行(形状变了)`);
      else if (!line.includes("RunLockBusy")) bad.push(`${f}: 分流没认 RunLockBusy ⇒ 冲突落 500`);
    }
    expect(bad, bad.join(" / ")).toEqual([]);
  });
});
