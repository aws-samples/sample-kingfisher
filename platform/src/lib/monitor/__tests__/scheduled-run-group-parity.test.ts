// 定时确定性组键的 **TS ↔ Python 逐字节 parity**(50 SPEC v3.44 §3.17.2;判据 门禁 scheduled-key-parity)。
//
// 🔴 为什么必须真的跑 python:两个语言各写一份的下场本仓记过 ——「只改执行侧挡不住生成侧」。
//    这里把 `pythonScheduledRunGroupSource()` 产出的源码写进临时文件、用 python3 真跑,
//    再与 TS 的结果**逐字节**比。任一侧改了分隔符 / 时间格式 / 截断长度 / 周字段换算,这里必红。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduledRunGroupId,
  scheduledRunGroupIdFromSlot,
  scheduledRunGroupCanonical,
  pythonScheduledRunGroupSource,
  SCHEDULED_RUN_GROUP_HEX,
} from "@/lib/monitor/scheduled-run-group";
import { cronSlotIso, parseCron, cronMatchesUtc, CronExprInvalid, CronSlotNotFound } from "@/lib/monitor/cron-slot";
import { isScheduledRunGroupId, SCHEDULED_RUN_GROUP_PREFIX } from "@/lib/monitor/run-group";

/** (cron, 触发时刻 ISO) 用例集 —— 覆盖各种字段写法与边界。 */
const CASES: Array<[string, string]> = [
  ["0 3 * * *", "2026-09-14T03:00:00Z"],        // 恰好落在触发点
  ["0 3 * * *", "2026-09-14T03:00:07Z"],        // 触发点之后 7 秒(两个区的现实情形)
  ["0 3 * * *", "2026-09-14T02:59:59Z"],        // 触发点之前 ⇒ 上一天
  ["*/5 * * * *", "2026-09-14T03:07:31Z"],
  ["*/5 * * * *", "2026-09-14T00:00:00Z"],
  ["30 2 * * 1", "2026-09-14T02:30:00Z"],        // 周一(2026-09-14 是周一)
  ["30 2 * * 1", "2026-09-15T09:00:00Z"],        // 周二上午 ⇒ 回到周一
  ["0 0 1 * *", "2026-09-14T12:00:00Z"],         // 每月 1 号
  ["0 0 1 * 1", "2026-09-14T12:00:00Z"],         // 🔴 日与周都限定 ⇒「或」语义
  ["15,45 * * * *", "2026-09-14T03:50:00Z"],
  ["0 9-17 * * 1-5", "2026-09-14T20:10:00Z"],
  ["0 0 * * 7", "2026-09-14T12:00:00Z"],         // 7 = 周日
  ["0 0 * * 0", "2026-09-14T12:00:00Z"],         // 0 = 周日(与上一条必须同结果)
  ["7 4 */2 * *", "2026-09-15T05:00:00Z"],
  ["0 0 29 2 *", "2028-02-29T00:00:03Z"],        // 闰日:恰好在触发点(日+月字段)
  ["0 0 29 2 *", "2026-09-14T00:00:00Z"],        // 🔴 闰日 + 非触发日 ⇒ 要往回翻两年多(上界 366 天时两侧一起失败)
];

function runPython(): Array<{ slot: string; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kf-rgs-parity-"));
  const py = join(dir, "twin.py");
  const cases = JSON.stringify(CASES.map(([cron, iso]) => [cron, Date.parse(iso) / 1000]));
  writeFileSync(
    py,
    `import time, hashlib, json, sys, calendar
${pythonScheduledRunGroupSource()}

out = []
for cron, epoch in json.loads(sys.argv[1]):
    out.append({"slot": _cron_slot_iso(cron, epoch), "id": _scheduled_run_group_id("etl-job", "job-\\u00e4-1", cron, epoch)})
print(json.dumps(out))
`,
    "utf8"
  );
  return JSON.parse(execFileSync("python3", [py, cases], { encoding: "utf8" }));
}

describe("🔴🔴 定时确定性组键:TS 与 Python 逐字节一致", () => {
  const fromPy = runPython();

  it(`${CASES.length} 个用例的槽位与组键两侧完全相同`, () => {
    const fromTs = CASES.map(([cron, iso]) => ({
      slot: cronSlotIso(cron, new Date(iso)),
      id: scheduledRunGroupId({ definitionKind: "etl-job", definitionId: "job-ä-1", cron, at: new Date(iso) }),
    }));
    // 逐条对照(不只比整体,便于定位是哪一条 cron 分叉)
    for (let i = 0; i < CASES.length; i++) {
      expect(fromPy[i], `用例 ${JSON.stringify(CASES[i])} 两侧分叉`).toEqual(fromTs[i]);
    }
    expect(fromPy).toEqual(fromTs);
  });

  it("键形态合法且带 `rgs_` 前缀(写通道守卫认它)", () => {
    for (const r of fromPy) {
      expect(isScheduledRunGroupId(r.id), r.id).toBe(true);
      expect(r.id.startsWith(SCHEDULED_RUN_GROUP_PREFIX)).toBe(true);
      expect(r.id).toHaveLength(SCHEDULED_RUN_GROUP_PREFIX.length + SCHEDULED_RUN_GROUP_HEX);
    }
  });

  it("🔴 `0 0 * * 7` 与 `0 0 * * 0` 结果相同(7 归一成周日),而两侧都这么认", () => {
    const i7 = CASES.findIndex(([c]) => c === "0 0 * * 7");
    const i0 = CASES.findIndex(([c]) => c === "0 0 * * 0");
    expect(fromPy[i7]).toEqual(fromPy[i0]);
  });
});

describe("🔴 两半:同槽位相同 / 不同槽位不同", () => {
  const args = { definitionKind: "etl-job", definitionId: "job1", cron: "0 3 * * *" };

  it("同一次触发的两个区(差 800ms / 差 9 秒)⇒ **同一个** rgs_", () => {
    const a = scheduledRunGroupId({ ...args, at: new Date("2026-09-14T03:00:00.200Z") });
    const b = scheduledRunGroupId({ ...args, at: new Date("2026-09-14T03:00:09.000Z") });
    expect(a).toBe(b);
  });

  it("🔴 **不同的 cron 槽位 ⇒ 不同的 rgs_**(只验前半句时,一个「返回常量」的实现照样全绿)", () => {
    const d1 = scheduledRunGroupId({ ...args, at: new Date("2026-09-14T03:00:01Z") });
    const d2 = scheduledRunGroupId({ ...args, at: new Date("2026-09-15T03:00:01Z") });
    expect(d1).not.toBe(d2);
  });

  it("不同定义 / 不同种类 ⇒ 不同键(同一时刻两个作业不许撞在一个组里)", () => {
    const at = new Date("2026-09-14T03:00:01Z");
    expect(scheduledRunGroupId({ ...args, at })).not.toBe(scheduledRunGroupId({ ...args, definitionId: "job2", at }));
    expect(scheduledRunGroupId({ ...args, at })).not.toBe(scheduledRunGroupId({ ...args, definitionKind: "engine-job", at }));
  });

  it("🔴 键的输入里**没有** definitionVersion:两个区版本不同也必须归一组", () => {
    // 规范串只由三段组成 —— 多一段就会分叉,这条钉住「版本不进键」
    expect(scheduledRunGroupCanonical("etl-job", "job1", "2026-09-14T03:00:00Z").split("\n")).toHaveLength(3);
    expect(scheduledRunGroupIdFromSlot("etl-job", "job1", "2026-09-14T03:00:00Z")).toBe(
      scheduledRunGroupId({ ...args, at: new Date("2026-09-14T03:00:00Z") })
    );
  });
});

describe("🔴 两侧连「失败」也要一致:压根不存在的 cron", () => {
  it("`0 0 30 2 *`(2 月 30 日)TS 与 Python **都**抛,而不是一侧猜一个时间", () => {
    expect(() => cronSlotIso("0 0 30 2 *", new Date("2026-09-14T00:00:00Z"))).toThrow(CronSlotNotFound);
    const dir = mkdtempSync(join(tmpdir(), "kf-rgs-neg-"));
    const py = join(dir, "neg.py");
    writeFileSync(py, `import time, hashlib\n${pythonScheduledRunGroupSource()}\n\ntry:\n    _cron_slot_iso("0 0 30 2 *", 1789344000)\n    print("NO-RAISE")\nexcept Exception as e:\n    print("RAISED")\n`, "utf8");
    expect(execFileSync("python3", [py], { encoding: "utf8" }).trim()).toBe("RAISED");
  }, 30_000); // 两侧各扫一遍到年底的分钟槽;慢机(CI 2 vCPU)上 5 秒缺省预算会抢跑成假红(2026-11-05)
});

describe("cron 解析:非法一律抛,不猜", () => {
  it("段数不对 / 越界 / 反向 / 步长非法 都抛 CronExprInvalid", () => {
    for (const bad of ["", "0 3 * *", "0 3 * * * *", "60 3 * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "5-1 3 * * *", "*/0 * * * *", "a 3 * * *"]) {
      expect(() => parseCron(bad), bad).toThrow(CronExprInvalid);
    }
  });
  it("找不到触发点 ⇒ 抛(而不是回一个近似时间)", () => {
    // 2 月 30 日永远不存在
    expect(() => cronSlotIso("0 0 30 2 *", new Date("2026-09-14T00:00:00Z"))).toThrow(CronSlotNotFound);
  });
  it("日/周「或」语义:1 号或周一都算命中", () => {
    const c = parseCron("0 0 1 * 1");
    expect(cronMatchesUtc(c, new Date("2026-09-01T00:00:00Z")), "9/1 是周二但是 1 号").toBe(true);
    expect(cronMatchesUtc(c, new Date("2026-09-14T00:00:00Z")), "9/14 是周一但不是 1 号").toBe(true);
    expect(cronMatchesUtc(c, new Date("2026-09-15T00:00:00Z")), "9/15 既不是 1 号也不是周一").toBe(false);
  });
});
