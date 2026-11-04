// Copilot 动作守卫(闸2)单测:确保"可创建·禁执行"边界正确,且默认拒绝。
import { describe, it, expect } from "vitest";
import { guardCopilotAction, allowedCreateActions } from "../action-guard";

describe("copilot action-guard(闸2:可创建·禁执行)", () => {
  it("放行安全创建类动作", () => {
    for (const a of ["sync.create", "etl-job.create", "flink.create", "genbi.context.create", "quality.rule.create", "workflow.create", "datasource.create", "engine.create"]) {
      expect(guardCopilotAction(a).allowed, a).toBe(true);
    }
  });

  it("拦截所有执行/运行/发布/删除类(后缀锚点)", () => {
    for (const a of [
      "sync.start", "sync.stop", "etl-job.run", "etl-job.backfill", "etl-job.rerun", "etl-job.schedule",
      "flink.start", "flink.produce", "workflow.publish", "workflow.trigger", "engine.run",
      "modeling.codetable.land", "modeling.dimension.apply", "metric.compute", "quality.run",
      "sensitive.scan", "alerting.evaluate", "finops.collect", "baseline.learn", "sla.predict",
      "datasource.delete", "flink.delete", "sync.delete",
    ]) {
      expect(guardCopilotAction(a).allowed, a).toBe(false);
    }
  });

  it("拦截对外授信/提权/平台管理/晋升审批/回滚(精确名)", () => {
    for (const a of [
      "data-api-key.issue", "role-advisor.create", "network-advisor.apply",
      "project.create", "promote.request", "promote.execute", "approval.decide", "resource.rollback", "sensitive.adopt",
    ]) {
      expect(guardCopilotAction(a).allowed, a).toBe(false);
    }
  });

  it("默认拒绝:空/未知动作", () => {
    expect(guardCopilotAction("").allowed).toBe(false);
    expect(guardCopilotAction(undefined).allowed).toBe(false);
    expect(guardCopilotAction("some.unknown.action").allowed).toBe(false);
    expect(guardCopilotAction("data-api.create").allowed).toBe(false); // 未在白名单(建对外API需谨慎)→ 默认拒
  });

  it("白名单清单非空且不含危险项", () => {
    const list = allowedCreateActions();
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toContain("data-api-key.issue");
    expect(list).not.toContain("role-advisor.create");
    expect(list.every((a) => a.endsWith(".create"))).toBe(true);
  });
});
