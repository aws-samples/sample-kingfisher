// 🔴🔴 平台动作节点的**运行期**判据:python 真跑 `_exec_platform_action`(假的主控区 DDB 表,真的执行器字节)。
//
//   ① 投的命令行属性 ⊆ 合同 `ACTION_COMMAND_ATTRS`,状态 = pending,表名 / TTL 与 TS 侧同源;
//   ② 消费端写 succeeded ⇒ 返回 "ok";写 failed ⇒ **raise 且带真因**(task 失败,不许静默成功);
//   ③ 一直 pending 超过「抢单时限」⇒ raise 说清「没有消费端」;running 超租约 ⇒ raise;
//   ④ 两份运行时产物(经典 runtime-lib / serverless 代码包)都把 `platform-action` 分派到这个执行器;
//   ⑤ 节点登记:只由载体合成、不进画布面板;validate 走白名单 + 参数校验。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_EXEC_PY } from "@/lib/workflow/node-exec-py";
import { RUNTIME_LIB_SOURCE, RUNTIME_LIB_VERSION } from "@/lib/workflow/runtime-lib";
import { BGP_RUNTIME_PY } from "@/lib/scheduler/serverless/runtime-py";
import { NODE_REGISTRY, PALETTE_NODE_TYPES } from "@/lib/workflow/node-registry";
import {
  ACTION_COMMAND_ATTRS,
  ACTION_COMMAND_LEASE_MINUTES,
  ACTION_COMMAND_PICKUP_MINUTES,
  ACTION_COMMAND_TTL_DAYS,
  ACTION_COMMAND_STATUSES,
} from "@/lib/scheduler/action-commands";

/** 跑一个场景:`script` = 消费端在第 N 次轮询时把行改成什么(JSON)。 */
function runScenario(script: Array<Record<string, unknown>>, opts: { ageS?: number } = {}): { ok: boolean; out?: string; err?: string; item: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), "kf-pa-"));
  const py = join(dir, "pa.py");
  writeFileSync(
    py,
    `${NODE_EXEC_PY}
import json, sys
time.sleep = lambda s: None
SCRIPT = json.loads(sys.argv[1])
AGE = float(sys.argv[2])
if AGE >= 0:
    _iso_age_s = lambda iso: AGE

class FakeTable:
    def __init__(self):
        self.row = None
        self.polls = 0
        self.name = None
    def put_item(self, Item=None, ConditionExpression=None):
        assert ConditionExpression == "attribute_not_exists(commandId)"
        self.row = dict(Item)
        self.first = dict(Item)
    def get_item(self, Key=None, ConsistentRead=None):
        assert Key == {"commandId": self.row["commandId"]}
        assert ConsistentRead is True
        step = SCRIPT[min(self.polls, len(SCRIPT) - 1)]
        self.polls += 1
        self.row.update(step)
        return {"Item": dict(self.row)}

TBL = FakeTable()
class FakeDdb:
    def Table(self, name):
        TBL.name = name
        return TBL

env = {"ddb": FakeDdb(), "target_id": "tgt_usw2_a", "project_id": "proj-x", "workflow_id": "gov_01T", "ledger_task_id": "gov_01T"}
res = {"table": None}
try:
    r = _exec_platform_action(env, "governance.quality-check", {"fqns": ["a.b.c.d"]}, run_id="ex_9#tgt_usw2_a")
    res.update({"ok": True, "out": r})
except Exception as e:
    res.update({"ok": False, "err": str(e)})
res["table"] = TBL.name
res["item"] = TBL.first
print(json.dumps(res, default=str))
`,
    "utf8"
  );
  // 执行器自己会 print 日志行(运行期日志进 CloudWatch,是有意的)⇒ 结果取最后一行
  const out = execFileSync("python3", [py, JSON.stringify(script), String(opts.ageS ?? -1)], { encoding: "utf8" }).trim().split("\n");
  return JSON.parse(out[out.length - 1]);
}

describe("平台动作节点的运行期(python 真跑)", () => {
  it("① 命令行形状与 TS 合同同源;表名 / TTL / 租约 / 抢单时限两侧逐字一致", () => {
    const r = runScenario([{ status: "running", startedAt: new Date().toISOString() }, { status: "succeeded", summary: { n: 1 } }]) as any;
    expect(r.table).toBe("bgp-action-commands");
    const keys = Object.keys(r.item);
    for (const k of keys) expect([...ACTION_COMMAND_ATTRS], `python 写了合同之外的属性 ${k}`).toContain(k);
    expect(r.item).toMatchObject({
      action: "governance.quality-check", targetId: "tgt_usw2_a", projectId: "proj-x",
      taskId: "gov_01T", runId: "ex_9#tgt_usw2_a", status: "pending", params: { fqns: ["a.b.c.d"] },
    });
    expect(ACTION_COMMAND_STATUSES[0]).toBe(r.item.status);
    expect(NODE_EXEC_PY).toContain(`_ACTION_COMMAND_TTL_DAYS = ${ACTION_COMMAND_TTL_DAYS}`);
    expect(NODE_EXEC_PY).toContain(`_ACTION_COMMAND_LEASE_MINUTES = ${ACTION_COMMAND_LEASE_MINUTES}`);
    expect(NODE_EXEC_PY).toContain(`_ACTION_COMMAND_PICKUP_MINUTES = ${ACTION_COMMAND_PICKUP_MINUTES}`);
    // TTL = 现在 + 7 天(秒)
    const ttl = Number(r.item.ttl);
    expect(Math.abs(ttl - (Date.now() / 1000 + ACTION_COMMAND_TTL_DAYS * 86400))).toBeLessThan(120);
  });

  it("② succeeded ⇒ 返回 ok;failed ⇒ raise 且带消费端写下的真因", () => {
    const ok = runScenario([{ status: "pending" }, { status: "running", startedAt: new Date().toISOString() }, { status: "succeeded" }]);
    expect(ok).toMatchObject({ ok: true, out: "ok" });
    const bad = runScenario([{ status: "running", startedAt: new Date().toISOString() }, { status: "failed", error: "该表暂无启用的质量规则" }]);
    expect(bad.ok).toBe(false);
    expect(bad.err).toContain("该表暂无启用的质量规则");
    expect(bad.err).toContain("governance.quality-check");
  });

  it("③ 一直 pending 超过抢单时限 ⇒ raise「没有消费端」;running 超租约 ⇒ raise(不许无限等,也不许当成功)", () => {
    const nobody = runScenario([{ status: "pending" }], { ageS: ACTION_COMMAND_PICKUP_MINUTES * 60 + 1 });
    expect(nobody.ok).toBe(false);
    expect(nobody.err).toMatch(/没有消费端抢单/);
    const stuck = runScenario([{ status: "running", startedAt: "2026-01-01T00:00:00" }], { ageS: ACTION_COMMAND_LEASE_MINUTES * 60 + 1 });
    expect(stuck.ok).toBe(false);
    expect(stuck.err).toMatch(/租约/);
  });

  it("④ 两份运行时产物都把 platform-action 分派到同一个执行器;runtime-lib 已升版本", () => {
    expect(BGP_RUNTIME_PY).toContain('if ntype == "platform-action":');
    expect(BGP_RUNTIME_PY).toContain("_exec_platform_action(e, ");
    expect(BGP_RUNTIME_PY).toContain('e["ledger_run_id"] = run_id');
    expect(RUNTIME_LIB_SOURCE).toContain('if ntype == "platform-action":');
    expect(RUNTIME_LIB_SOURCE).toContain("return _exec_platform_action(_env, _action, _params, run_id=rid)");
    expect(RUNTIME_LIB_VERSION).toBeGreaterThanOrEqual(9);
    // 执行器在每份产物里恰好定义一次(单一作者)
    for (const src of [BGP_RUNTIME_PY, RUNTIME_LIB_SOURCE]) {
      expect(src.split("def _exec_platform_action(").length - 1).toBe(1);
    }
  });

  it("⑤ 节点登记:只由载体合成、不进画布面板;validate 走白名单 + 参数校验", () => {
    const def = NODE_REGISTRY["platform-action"];
    expect(def.serverless).toBe("task");
    expect(def.userPlaceable).toBe(false);
    expect(PALETTE_NODE_TYPES).not.toContain("platform-action");
    expect(def.validate({ action: "admin.delete" })).not.toBeNull();
    expect(def.validate({ action: "governance.quality-check", params: { fqns: [] } })).not.toBeNull();
    expect(def.validate({ action: "governance.quality-check", params: { fqns: ["x"] } })).toBeNull();
  });
});
