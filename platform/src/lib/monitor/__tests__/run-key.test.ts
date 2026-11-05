// 台账行键不变量:**一行 = 一次 (作业 × target × 运行)**。四个调度器侧写入方都必须经本文件的口径。
// 真环境反例(2026-09-07 sls):两区 workflow 都 SUCCESS、两区 CTAS 都真跑,而 bgp-task-runs 只剩 1 行
//   —— 因为 runId 用了 raw `scheduled__<logical_date>`(两区完全相同)⇒ 后写盖掉先写。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_KEY_SEPARATOR, composeRunId, composeTaskTargetKey, rawRunIdOf, pyRunKeyFields } from "@/lib/monitor/run-key";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

describe("台账行键(复合 runId + taskTargetKey)", () => {
  it("同一次 cron 的两个 target ⇒ 两个不同的 runId(这就是复合存在的唯一理由)", () => {
    const raw = "scheduled__2026-09-07T00:00:00+00:00";
    const a = composeRunId(raw, "tgt_home");
    const b = composeRunId(raw, "tgt_usw2_a");
    expect(a).not.toBe(b);
    expect(a).toBe(`${raw}${RUN_KEY_SEPARATOR}tgt_home`);
    expect(rawRunIdOf(a)).toBe(raw);
    expect(rawRunIdOf(b)).toBe(raw);
  });

  it("raw 或 targetId 缺失一律抛(缺 target 的行无法按区归因,宁可不写)", () => {
    expect(() => composeRunId("", "tgt_home")).toThrow(/raw/);
    expect(() => composeRunId("x", "")).toThrow(/targetId/);
    expect(() => composeTaskTargetKey("", "tgt_home")).toThrow();
    expect(() => composeTaskTargetKey("job", "")).toThrow();
  });

  it("taskTargetKey = <taskId>#<targetId>(SPEC §1.2 GSI byTaskTarget 分区键)", () => {
    expect(composeTaskTargetKey("01JOB", "tgt_usw2_a")).toBe("01JOB#tgt_usw2_a");
  });

  it("pyRunKeyFields 产出的 Python 片段同时给 runId 与 taskTargetKey,且 target 是字面量", () => {
    const py = pyRunKeyFields({ taskIdExpr: "JOB_ID", rawExpr: "run_id", targetId: "tgt_usw2_a" });
    expect(py).toContain('"runId": run_id + "#" + "tgt_usw2_a"');
    expect(py).toContain('"taskTargetKey": JOB_ID + "#" + "tgt_usw2_a"');
    expect(() => pyRunKeyFields({ taskIdExpr: "JOB_ID", rawExpr: "run_id", targetId: "" })).toThrow(/targetId/);
  });

  it("🔴 四个调度器侧写入方都经本口径,且没人再写裸 runId", () => {
    const files = [
      "lib/etl/dag-generator.ts",
      "lib/engines/emr/dag-generator.ts",
      "lib/workflow/dag-generator.ts",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} 没经 run-key.ts`).toContain("pyRunKeyFields({");
      expect(src, `${f} 仍在写裸 runId`).not.toContain('"runId": run_id');
    }
    // serverless 运行时是 Python 字面量,单独钉
    const rt = read("lib/scheduler/serverless/runtime-py.ts");
    expect(rt).toContain('def _ledger_run_id(spec, ctx)');
    expect(rt).toContain('AIRFLOW_CTX_DAG_ID');
    expect(rt).toContain('"taskTargetKey"');
    // 经典 runtime-lib(v4,尚未在真环境启用)同样不许留裸键
    const lib = read("lib/workflow/runtime-lib.ts");
    expect(lib).toContain("taskTargetKey");
  });

  it("🔴「写不成即拒」:四处都不许把台账写失败吞成 print", () => {
    // 2026-11-04 起台账有两个写入点(开跑 put running 行 / 结束 update 收口,条件不满足退回 put):逐个写入点判 ——
    //   写入点到所在函数末尾(下一个 def)之间若有 except,就必须 raise;没有 except = 异常原样上抛,同样算「不吞」。
    for (const f of ["lib/etl/dag-generator.ts", "lib/engines/emr/dag-generator.ts", "lib/workflow/dag-generator.ts", "lib/workflow/runtime-lib.ts"]) {
      const src = read(f);
      const sites = [...src.matchAll(/Table\("bgp-task-runs"\)\.(put|update)_item/g)].map((m) => m.index!);
      expect(sites.length, `${f} 找不到台账写入点`).toBeGreaterThan(0);
      for (const idx of sites) {
        const end = src.indexOf("\ndef ", idx);
        const tail = src.slice(idx, end > 0 ? end : idx + 2400);
        if (/except/.test(tail)) expect(tail, `${f} 台账写失败被 except 吞掉没有 raise(写入点 ${idx})`).toMatch(/raise/);
        expect(tail, `${f} 台账写失败只 print 不抛(写入点 ${idx})`).not.toMatch(/except[^\n]*:\s*\n\s*print\([^\n]*\n(?!\s*raise)/);
      }
    }
    expect(read("lib/scheduler/serverless/runtime-py.ts")).not.toContain('print("record failed"');
  });
});
