// @kf-batch 50-WP5-rungroup
// 步 5 接线门禁:定时确定性组键**真的被注进产物、算在正确的时刻、且 Python 语法是对的**
// (50 SPEC v3.44 §3.17.2;ACCEPTANCE 段 `o2` ② 的三条门禁)。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BGP_RUNTIME_PY, BGP_RUNTIME_VERSION } from "@/lib/scheduler/serverless/runtime-py";
import { pythonScheduledRunGroupSource } from "@/lib/monitor/scheduled-run-group";
import { pythonRunGroupOpenSource, runGroupsTableName } from "@/lib/monitor/run-groups";
import { isResourceType } from "@/lib/versions/version-service";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

describe("🔴🔴 注入的 Python 必须真的能编译(WP-17 那一批缺陷全是「产物到了服务侧才炸」)", () => {
  it("BGP_RUNTIME_PY 过 python3 -m py_compile", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-rt-compile-"));
    const f = join(dir, "bgp_runtime.py");
    writeFileSync(f, BGP_RUNTIME_PY, "utf8");
    // 编译失败会以非零退出并把 SyntaxError 打在 stderr 上 ⇒ 这里直接抛出来给人看
    execFileSync("python3", ["-m", "py_compile", f], { encoding: "utf8", stdio: "pipe" });
  });

  it("模块里 import 了 hashlib(确定性键要用;漏了它是运行期 NameError,本地一个字看不出来)", () => {
    // @kf-batch 37-emr-run-date —— 判据钉事实(hashlib 在模块级 import 行里)而不钉整行形状:序 37 给这行追加了 re, sys
    expect(BGP_RUNTIME_PY).toMatch(/^import os, time, uuid, random, hashlib(, [a-z_, ]+)?$/m);
  });

  it("运行时版本是**内容哈希** ⇒ 改了 Python 就自动换 S3 key(不必手工升版本号)", () => {
    expect(BGP_RUNTIME_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("🔴 单一作者:两段 Python 必须是**发射出来的同一份字节**,不许手抄", () => {
  it("确定性键那一段", () => {
    const py = pythonScheduledRunGroupSource();
    expect(BGP_RUNTIME_PY).toContain(py);
    // 手抄的迹象:出现第二个 `def _cron_slot_iso`
    expect((BGP_RUNTIME_PY.match(/def _cron_slot_iso\(/g) ?? []).length).toBe(1);
    expect((BGP_RUNTIME_PY.match(/def _scheduled_run_group_id\(/g) ?? []).length).toBe(1);
  });
  it("建组行那一段", () => {
    expect(BGP_RUNTIME_PY).toContain(pythonRunGroupOpenSource());
    expect((BGP_RUNTIME_PY.match(/def _ensure_run_group\(/g) ?? []).length).toBe(1);
  });
  it("🔴 时间源不许来自 Airflow(那个字段在 Serverless 下是常量)—— 剥掉 Python 注释再判", () => {
    // 🔴 **必须剥注释**:这一段的头注释本身就在解释「刻意不用 logical_date」,
    //    不剥就是让门禁对着自己的散文报红(同一类错本轮已犯两次:TS 注释那次在 run-groups.test.ts)。
    const py = pythonScheduledRunGroupSource()
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .map((l) => l.replace(/\s{2}#.*$/, ""))
      .join("\n");
    for (const bad of ["logical_date", "AIRFLOW_CTX_DAG_ID", 'ctx["run_id"]', "dag_run"]) {
      expect(py.includes(bad), `确定性键的实现里出现了 ${bad} ⇒ 时间源又回到 Airflow 了`).toBe(false);
    }
    // 反向控制:剥注释这一步真的剥掉了东西(否则上面几条可能只是「本来就没有」)
    expect(pythonScheduledRunGroupSource()).toContain("logical_date");
    expect(py.length).toBeLessThan(pythonScheduledRunGroupSource().length);
  });
});

describe("🔴 算键的时刻:必须在**抢锁之前**", () => {
  const src = BGP_RUNTIME_PY;
  it("run_job 里 `_scheduled_group_id` 早于 `_acquire_run_lock`", () => {
    const at = src.indexOf("run_group_id = _scheduled_group_id(spec, time.time())");
    const lock = src.indexOf("if not _acquire_run_lock(spec, token)");
    expect(at, "没找到算键那一行").toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    // 抢锁最多等 300s;等过一个 cron 槽位边界再算就会与另一个区分叉(而且不报错)
    expect(at, "🔴 算键必须在抢锁之前").toBeLessThan(lock);
    expect(src.indexOf("_ensure_run_group(spec, run_group_id)")).toBeLessThan(lock);
  });
  it("成功与失败两条台账写入都带上组键(少一支 = 失败的那个区归不了组,而组恰恰是为了看失败)", () => {
    const withRg = src.match(/_record\(spec, run_id, "(succeeded|failed)"[^\n]*run_group_id=run_group_id\)/g) ?? [];
    expect(withRg.length).toBe(2);
  });
  it("🔴 定时那条路径也要记 accepted(否则定时组的「定义版本」永远是「-」= E-168 的载体缺一半)", () => {
    // 🔴 **断计数,不断存在**:`def _run_group_accept(spec, run_group_id, run_id):` 这行定义
    //    本身就含同样的子串 ⇒ 只写 toContain 时把调用删掉照样绿(变异 V4 实测存活)。
    const occ = src.match(/_run_group_accept\(spec, run_group_id, run_id\)/g) ?? [];
    expect(occ.length, "必须是「1 个定义 + 1 个调用」= 2 处;只剩 1 处说明调用被删了").toBe(2);
    expect(src).toMatch(/\n {4}_run_group_accept\(spec, run_group_id, run_id\)\n/);
    expect(src).toContain('ExpressionAttributeNames={"#a": "accepted", "#t": target}');
    // 版本从发布期注入的 scheduledGroup 取(不是运行期猜)
    expect(src).toContain('if g.get("definitionVersion") is not None:');
  });

  it("`runGroupId` 只在算出来时才落到 run 行上(单区定时不许落一个空属性)", () => {
    expect(src).toContain('if run_group_id:\n        # @kf-batch 50-WP5-rungroup');
    expect(src).toContain('item["runGroupId"] = run_group_id');
  });
});

describe("🔴 两个 fanout 生成器:分组判据是**全部绑定**而不是本次发布的子集", () => {
  const FANOUTS: Array<[string, string]> = [
    ["lib/etl/dag-fanout.ts", "etl-job"],
    ["lib/engines/emr/schedule-fanout.ts", "engine-job"],
  ];
  for (const [rel, kind] of FANOUTS) {
    it(`${rel}(definitionKind = ${kind})`, () => {
      const src = strip(read(rel));
      expect(isResourceType(kind), "definitionKind 必须落在模块 14 的 ResourceType 值域里").toBe(true);
      expect(src).toContain(`const DEFINITION_KIND = "${kind}";`);
      expect(src).toContain("scheduledGroup: {");
      expect(src).toContain("definitionKind: DEFINITION_KIND,");
      // 🔴 `all` = 全部绑定;写成 `targets`(本次发布的子集)⇒ 子集重发那个区会没有组,另一个区还有 ⇒ 分出两个组
      expect(src).toContain("...(all.length > 1");
      expect(src).toContain("requestedTargets: all,");
      expect(src, "🔴 用本次发布的子集判 = 子集重发时静默分裂成两个组").not.toContain("...(targets.length > 1");
      // 表名走单一出口
      expect(src).toContain("table: runGroupsTableName(),");
      expect(src, "别处不许再写 TABLES.RUN_GROUPS").not.toContain("TABLES.RUN_GROUPS");
    });
  }
  it("组表名单一出口回的就是那张表", () => {
    expect(runGroupsTableName()).toBe("bgp-run-groups");
  });
});
