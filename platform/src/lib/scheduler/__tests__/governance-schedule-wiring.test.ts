// @kf-batch 50-WP28-platform-action-node(WP-29 治理)
// 🔴 接线判据(「写了」≠「接上了」):定时治理任务从建 → 启用 → 监控页出行 → 日志,每一段都要接上。
//   查的是**调用位置**(先剥 import 与注释),不是「文件里出现过这个名字」。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function code(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return "";
      return l;
    })
    .join("\n");
}

describe("定时治理任务的接线", () => {
  it("建任务:平台管理员才行;落点经点名作者;建前确认那个区能承接;taskType=governance 的行", () => {
    const r = code("app/api/governance/schedules/route.ts");
    const post = r.slice(r.indexOf("export async function POST"));
    expect(post).toContain("if (!ctx.identity.isPlatformAdmin)");
    expect(post.indexOf("if (!ctx.identity.isPlatformAdmin)")).toBeLessThan(post.indexOf("createActionSchedule("));
    expect(post).toContain('requestedTargetId(body.targetId, "建定时治理任务")');
    expect(post.indexOf("await requireReadyTarget(targetId)")).toBeLessThan(post.indexOf("createActionSchedule("));
    expect(post).toContain('kind: "governance"');
    expect(post).toContain("GOVERNANCE_ACTION_IDS");
    const get = r.slice(r.indexOf("export async function GET"), r.indexOf("export async function POST"));
    expect(get).toContain("requireScope(req, ctx.projectId)");
    expect(get).toContain("filterRowsByScope(");
    expect(get).toContain("r.projectId === ctx.projectId");
  });

  it("启停:统一入口 /api/schedule/enable 的平台动作分支 —— 管理员 / 卡片作者;走唯一作者 setActionScheduleEnabled;在 sync 分支之前", () => {
    const r = code("app/api/schedule/enable/route.ts");
    const i = r.indexOf("ACTION_SCHEDULE_TASK_TYPES as readonly string[]");
    const j = r.indexOf("TABLES.SYNC_TASKS");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
    const br = r.slice(i, j);
    expect(br).toContain('row.kind === "governance" && !actx.identity.isPlatformAdmin');
    expect(br).toContain('row.kind === "genbi-card" && actx.identity.sub !== row.ownerSub');
    expect(br).toContain("await setActionScheduleEnabled(row,");
    expect(br.indexOf("guardResourceAccess(")).toBeLessThan(br.indexOf("if (!row || row.kind !== taskType)"));
    expect(br).not.toContain("UpdateCommand"); // 记录只由唯一作者改
  });

  it("删除:先撤载体(唯一作者 deleteActionSchedule),平台管理员才行", () => {
    const r = code("app/api/governance/schedules/[taskId]/route.ts");
    const del = r.slice(r.indexOf("export async function DELETE"));
    expect(del).toContain("await deleteActionSchedule(r.row)");
    expect(del.indexOf("isPlatformAdmin")).toBeLessThan(del.indexOf("await deleteActionSchedule("));
  });

  it("监控页:run 行名字能反查到调度对象;类型下拉 / 类型标签 / 跳转都认 governance 与 genbi-card", () => {
    const runs = code("app/api/monitor/runs/route.ts");
    expect(runs).toContain('nameIndex(TABLES.ACTION_SCHEDULES, "taskId", pf)');
    expect(runs).toContain("actionNames");
    const page = code("app/monitor/page.tsx");
    expect(page).toContain('value: "governance"');
    expect(page).toContain('value: "genbi-card"');
    expect(page).toContain('data-testid="run-type-governance"');
    expect(page).toContain('data-testid="run-type-genbi-card"');
    expect(page).toContain('tt === "governance" ? `/governance`');
  });

  it("日志:监控页「日志」能落到平台动作的调度对象(给出该区日志组 + 消费端写回的真因),不掉进「找不到任务」", () => {
    const r = code("app/api/monitor/tasks/[id]/logs/route.ts");
    const i = r.indexOf("const sched = await getActionSchedule(params.id)");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(r.indexOf("TABLES.ETL_JOBS"));
    const br = r.slice(i, r.indexOf("TABLES.ETL_JOBS"));
    expect(br).toContain('guardResourceAccess(req, sched, "viewer")');
    expect(br).toContain("logGroupOf(arn)");
    expect(br).toContain("run?.error");
  });

  it("调度中心:拉定时治理任务(带范围 + 查载体落后);类型 Tag;绿标看产物;启停 / 重发 taskType 照实传", () => {
    const p = code("components/monitor/SchedulePanel.tsx");
    expect(p).toContain("fetch(`/api/governance/schedules${actionQs}`)");
    expect(p).toContain("scope: scopeParam");
    expect(p).toContain('withDrift: "1"');
    expect(p).toContain('data-testid="schedule-type-governance"');
    expect(p).toContain("taskType: r.itemType");
    expect(p).toContain('value: "governance"');
  });

  it("治理页:有「定时治理任务」页签;目录同步勾数仓目录时明示计费;弹框复述执行范围", () => {
    expect(code("app/governance/page.tsx")).toContain("<GovernanceSchedules isAdmin={isAdmin} />");
    const c = code("components/governance/GovernanceSchedules.tsx");
    expect(c).toContain('sources.includes("redshift") && (');
    expect(c).toContain('data-testid="gov-schedule-warehouse-billing"');
    expect(c).toContain('data-testid="gov-schedule-target-restate"');
    expect(c).toContain("disabled={!targetId}"); // 「全部 / 对比」视角不给建
  });
});
