// 🔴🔴 平台动作调度对象的**载体**(照抄):单节点 platform-action 工作流 → 该区 MWAA Serverless。
//
//   ① 形状:恰好一个节点、类型 platform-action、带动作 + 参数;DAG id 一眼可追溯;
//   ② 归属的**值**真从 ledger 进 YAML(taskType = governance / genbi-card,不回写 workflow 行);
//   ③ 生成链真能编出来(buildDagSpec + YAML 不 mock),serverless 下是一个 run_node task;
//   ④ 行级不变量 fail-closed:白名单外 / 空参数 / 多个或非法 target ⇒ 拒;
//   ⑤ 启停 / 删除的「先办载体再改记录」「撤不下来不动记录」顺序(锚定到各自的函数体再比)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionCarrierDagId,
  actionScheduleInvalidReason,
  buildActionCarrierWorkflow,
  isCarrierArmed,
  ledgerOf,
  type ActionScheduleRow,
} from "@/lib/scheduler/action-schedules";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { buildWorkflowTasksYaml } from "@/lib/scheduler/serverless/workflow-yaml";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (rel: string) =>
  readFileSync(resolve(SRC, rel), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const ROW: ActionScheduleRow = {
  userId: "default-user",
  taskId: "gov_01TESTGOVTASK000000000000",
  kind: "governance",
  name: "每日质量检查",
  projectId: "proj-default",
  targets: ["tgt_usw2_a"],
  action: "governance.quality-check",
  params: { fqns: ["bgp-redshift.dev.public.orders"] },
  cronExpression: "0 3 * * *",
  scheduleEnabled: false,
  ownerSub: "sub-1",
  ownerUsername: "admin",
  createdAt: "2026-10-10T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
};

describe("平台动作调度对象的载体", () => {
  it("① 载体 = 单节点 platform-action 工作流,带动作与参数;DAG id 带 act_ 段", () => {
    const wf = buildActionCarrierWorkflow(ROW, "0 3 * * *");
    expect(wf.dagDefinition.nodes).toHaveLength(1);
    const n = wf.dagDefinition.nodes[0];
    expect(n.type).toBe("platform-action");
    expect(n.data).toMatchObject({ action: "governance.quality-check", params: { fqns: ["bgp-redshift.dev.public.orders"] } });
    expect(wf.airflowDagId).toBe(actionCarrierDagId(ROW.taskId));
    expect(wf.airflowDagId).toBe(`bgp_act_${ROW.taskId}`);
    expect((wf as unknown as { targets: string[] }).targets).toEqual(["tgt_usw2_a"]);
    expect(wf.cronExpression).toBe("0 3 * * *");
  });

  it("② ③ 归属的值从 ledger 进 YAML;serverless 下是一个 run_node task(真走生成链,不 mock)", () => {
    for (const kind of ["governance", "genbi-card"] as const) {
      const row = { ...ROW, kind };
      const place = {
        targetId: "tgt_usw2_a",
        execRegion: "us-west-2",
        workgroup: "bgp-workgroup-usw2",
        database: "dev",
        redshiftSecretArn: null as unknown as string,
        ledger: ledgerOf(row),
      };
      const spec = buildDagSpec(buildActionCarrierWorkflow(row, "0 3 * * *"), place);
      expect(spec.ledger_task_type).toBe(kind);
      expect(spec.ledger_task_id).toBe(ROW.taskId);
      expect(spec.writes_workflow_row, "合成载体回写 bgp-workflows ⇒ 造幽灵工作流").toBe(false);
      expect(spec.exec_region).toBe("us-west-2");
      expect(spec.target_id).toBe("tgt_usw2_a");
      const yaml = buildWorkflowTasksYaml({ spec, cron: "0 3 * * *" });
      expect(yaml).toMatch(new RegExp(`ledger_task_type"?:\\s*"?${kind}`));
      expect(yaml).toMatch(/writes_workflow_row"?:\s*false/);
      expect(yaml).toContain("bgp_runtime.run_node");
      expect(yaml).toContain("platform-action");
      expect(yaml).toContain("governance.quality-check");
    }
  });

  it("④ 行级不变量 fail-closed", () => {
    expect(actionScheduleInvalidReason(ROW)).toBeNull();
    expect(actionScheduleInvalidReason({ ...ROW, action: "admin.delete" })).toMatch(/白名单/);
    expect(actionScheduleInvalidReason({ ...ROW, params: { fqns: [] } })).toMatch(/至少一张表/);
    expect(actionScheduleInvalidReason({ ...ROW, targets: [] })).toMatch(/恰好绑定一个/);
    expect(actionScheduleInvalidReason({ ...ROW, targets: ["tgt_home", "tgt_usw2_a"] })).toMatch(/恰好绑定一个/);
    expect(actionScheduleInvalidReason({ ...ROW, targets: ["us-west-2"] })).toMatch(/恰好绑定一个/);
    expect(actionScheduleInvalidReason({ ...ROW, taskId: "a/b" })).toMatch(/taskId/);
    expect(actionScheduleInvalidReason({ ...ROW, projectId: "" })).toMatch(/projectId/);
  });

  it("④b 「真有载体」看产物不看愿望字段", () => {
    expect(isCarrierArmed({ ...ROW, scheduleEnabled: true })).toBe(false);
    expect(isCarrierArmed({ ...ROW, scheduleEnabled: true, deployments: { tgt_usw2_a: { workflowArn: "arn:x" } } })).toBe(true);
    expect(isCarrierArmed({ ...ROW, scheduleEnabled: false, deployments: { tgt_usw2_a: { workflowArn: "arn:x" } } })).toBe(false);
  });

  it("⑤ 先办载体再改记录;撤不下来不动记录;删除先撤载体再删行", () => {
    const src = code("lib/scheduler/action-schedules.ts");
    const fn = (name: string) => {
      const i = src.indexOf(`export async function ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      const j = src.indexOf("\nexport ", i + 10);
      return src.slice(i, j < 0 ? undefined : j);
    };
    const en = fn("setActionScheduleEnabled");
    const enOn = en.slice(en.indexOf("if (opts.enabled)"), en.indexOf("const off ="));
    expect(enOn.indexOf("await publishWorkflowDag(")).toBeGreaterThan(-1);
    expect(enOn.indexOf("await publishWorkflowDag(")).toBeLessThan(enOn.indexOf("await updateScheduleFlags(row.taskId, true"));
    const enOff = en.slice(en.indexOf("const off ="));
    expect(enOff.indexOf("if (!off.allRemoved) throw")).toBeGreaterThan(-1);
    expect(enOff.indexOf("if (!off.allRemoved) throw")).toBeLessThan(enOff.indexOf("await updateScheduleFlags(row.taskId, false"));
    const del = fn("deleteActionSchedule");
    expect(del.indexOf("if (!off.allRemoved) throw")).toBeGreaterThan(-1);
    expect(del.indexOf("if (!off.allRemoved) throw")).toBeLessThan(del.indexOf("new DeleteCommand("));
    // 发布 / 下线都带 ledger(否则 deployments 写到 bgp-workflows、run 行记成 workflow)
    expect(en).toContain("{ ledger: ledgerOf(row) }");
    expect(fn("actionCarrierDrift")).toContain("{ ledger: ledgerOf(row) }");
  });
});
