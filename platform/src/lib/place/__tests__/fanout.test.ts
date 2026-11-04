// @kf-batch 50-WP31-place-first-class
// WP-31 序 3 收尾 —— 多区扇出统一走 `forEachTargetPlace`(L10)的**行为** + **接线**判据。
//
// 行为(装配层:fanout ↔ resolve ↔ context 一律不 mock,只换注册表 = DDB 边界):
//   ① 解析得开的分支各自一个嵌套上下文,并发不串、退出恢复;② 解析不开的分支**照样跑**、不在任何上下文里;
//   ③ fn 的 typed error **原样**透出(instanceof 仍然成立 —— 扇出路由靠它分 409 / 500);④ sequential 严格按序。
// 接线:列出的每个扇出点都在**调用位置**用了 forEachTargetPlace(剥掉 import / 注释再查),且不再有裸的逐区循环。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ targets: new Map<string, Record<string, unknown>>() }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets.get(id);
      if (!t) throw new real.TargetNotReadyError(id, "not ready");
      return t;
    }),
  };
});

import { forEachTargetPlace } from "../fanout";
import { currentPlace, runInPlace } from "../context";
import type { Place } from "../types";

const ACCT = "000000000000";
const desc = (targetId: string, region: string) => ({ targetId, region, accountId: ACCT, partition: "aws", status: "active", ready: true, resources: {} });

beforeEach(() => {
  h.targets.clear();
  h.targets.set("tgt_home", desc("tgt_home", "us-east-1"));
  h.targets.set("tgt_usw2_a", desc("tgt_usw2_a", "us-west-2"));
});

class TypedRejection extends Error {}

describe("forEachTargetPlace:每个分支自己的落点上下文", () => {
  it("并发:每个分支看到的是**自己**的落点(跨 await 不串),结果顺序与入参一致", async () => {
    const seen = await forEachTargetPlace(["tgt_usw2_a", "tgt_home"], async (targetId, place) => {
      await new Promise((r) => setTimeout(r, targetId === "tgt_usw2_a" ? 15 : 1));
      return `${targetId}@${place?.region}|ctx=${currentPlace()?.region}`;
    });
    expect(seen).toEqual(["tgt_usw2_a@us-west-2|ctx=us-west-2", "tgt_home@us-east-1|ctx=us-east-1"]);
  });

  it("解析不开的分支**照样跑**(place = null),且不在任何落点上下文里(由分支自己的解析器去拒)", async () => {
    const seen = await forEachTargetPlace(["tgt_nope_zz", "tgt_usw2_a"], async (targetId, place) => `${targetId}:${place?.region ?? "null"}:${currentPlace()?.targetId ?? "none"}`);
    expect(seen).toEqual(["tgt_nope_zz:null:none", "tgt_usw2_a:us-west-2:tgt_usw2_a"]);
  });

  it("🔴 退出后恢复父上下文(扇出点自己就在一个请求的上下文里时)", async () => {
    const parent = { targetId: "tgt_home", region: "us-east-1" } as Place;
    await runInPlace(parent, async () => {
      await forEachTargetPlace(["tgt_usw2_a"], async () => expect(currentPlace()?.region).toBe("us-west-2"), { sequential: true });
      expect(currentPlace()?.region).toBe("us-east-1");
    });
  });

  it("🔴 typed error 原样透出(instanceof 仍成立),两种模式都一样", async () => {
    for (const sequential of [false, true]) {
      const err = await forEachTargetPlace(["tgt_usw2_a"], async () => { throw new TypedRejection("x"); }, { sequential }).then(() => null, (e) => e);
      expect(err, `sequential=${sequential}`).toBeInstanceOf(TypedRejection);
      const err2 = await forEachTargetPlace(["tgt_nope_zz"], async () => { throw new TypedRejection("y"); }, { sequential }).then(() => null, (e) => e);
      expect(err2, `解析不开的分支 sequential=${sequential}`).toBeInstanceOf(TypedRejection);
    }
  });

  it("sequential:严格按序、一个完了才下一个(保留「第 1 个区已提交、第 2 个区失败」的语义)", async () => {
    const log: string[] = [];
    await forEachTargetPlace(["tgt_usw2_a", "tgt_nope_zz", "tgt_home"], async (t) => {
      log.push(`start ${t}`);
      await new Promise((r) => setTimeout(r, t === "tgt_usw2_a" ? 10 : 1));
      log.push(`end ${t}`);
    }, { sequential: true });
    expect(log).toEqual(["start tgt_usw2_a", "end tgt_usw2_a", "start tgt_nope_zz", "end tgt_nope_zz", "start tgt_home", "end tgt_home"]);
  });
});

describe("🔴 接线:多区扇出点都走 forEachTargetPlace(只查调用位置)", () => {
  const SRC = resolve(__dirname, "../../..");
  const code = (rel: string) =>
    readFileSync(resolve(SRC, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      .replace(/^import [\s\S]*?;$/gm, "");
  // [文件, 至少几处调用, 不许再出现的裸扇出写法]
  const SITES: Array<[string, number, RegExp]> = [
    ["lib/realtime/flink-service.ts", 1, /rows\.map\(async[^)]*\)\s*=>\s*\{\s*try\s*\{\s*const \{ dbStatus \} = await reconcileFlinkStatus/],
    ["app/api/flink/jobs/route.ts", 0, /reconcileFlinkStatus\(/],
    ["lib/redshift/multi-region-query.ts", 1, /Promise\.all\(list\.map\(\(targetId\) => submitOne/],
    ["app/api/etl-jobs/[id]/run/route.ts", 1, /for \(const targetId of runTargets\)/],
    ["lib/engines/long-ops.ts", 1, /for \(const targetId of runTargets\)/], // B-136:引擎运行的扇出点搬进长操作执行体
    ["lib/etl/dag-fanout.ts", 3, /for \(const targetId of (?:bindingTargets\(job\)|targets|list)\)/],
    ["lib/engines/emr/schedule-fanout.ts", 2, /for \(const targetId of (?:targets|list\.length \? list : \[HOME_TARGET_ID\])\)/],
  ];
  for (const [rel, min, bare] of SITES) {
    it(rel, () => {
      const s = code(rel);
      expect((s.match(/\bforEachTargetPlace\(/g) ?? []).length, `${rel} 的扇出没走 forEachTargetPlace`).toBeGreaterThanOrEqual(min);
      expect(s, `${rel} 又出现了裸的逐区扇出`).not.toMatch(bare);
    });
  }
  it("列表路由经 reconcileFlinkJobs(它内部才扇出)", () => {
    expect(code("app/api/flink/jobs/route.ts")).toMatch(/await reconcileFlinkJobs\(rows/);
  });
});
