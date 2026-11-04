// `startWorkflowRun` 的**重试判据**:刚 CreateWorkflow 完就触发会撞 airflow-serverless 侧的角色传播窗口。
//
// 🔴 2026-09-19 全新账号首装真撞:角色信任策略完全正确(栈里写死 `airflow-serverless.amazonaws.com`
//   + `sts:AssumeRole`)、`CreateWorkflow` 也回了 READY,但紧接着的 StartWorkflowRun 被拒;
//   几十秒后用 CLI 直接 StartWorkflowRun **一次就成功** ⇒ 瞬态,不是配置错。
//   而产品当时把它当硬失败抛成 500,用户在页面上看到「编排触发失败」。
//
// 🔴 这组判据的**判别力**在于「不许把真配错也一起吞掉」:
//   同一族的 AccessDenied / 「role ... cannot be assumed」若来自真正配错的信任策略,必须**立刻红**,
//   不能被重试掩盖成「慢」。所以判据既要证明「那一句会重试」,也要证明「别的错一次都不重试」。
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-mwaa-serverless", () => {
  class Cmd {
    constructor(public input: unknown) {}
  }
  return {
    MWAAServerlessClient: class {
      send = send;
    },
    CreateWorkflowCommand: Cmd,
    UpdateWorkflowCommand: Cmd,
    DeleteWorkflowCommand: Cmd,
    GetWorkflowCommand: Cmd,
    StartWorkflowRunCommand: Cmd,
    StopWorkflowRunCommand: Cmd,
    GetWorkflowRunCommand: Cmd,
    ListWorkflowRunsCommand: Cmd,
    ListWorkflowsCommand: Cmd,
    ListTaskInstancesCommand: Cmd,
    GetTaskInstanceCommand: Cmd,
  };
});

const ROLE_PROP = "ValidationException: Workflow execution role could not be assumed by the airflow-serverless service";

describe("startWorkflowRun:角色传播窗口可重试,其余一次都不重试", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("判据函数只认那一句(真配错的同族错误必须判成不可重试)", async () => {
    const { isTransientRoleNotAssumable } = await import("@/lib/scheduler/serverless/workflow-client");
    expect(isTransientRoleNotAssumable(new Error(ROLE_PROP))).toBe(true);
    // 负向:真配错 / 其它权限错一律不可重试 —— 否则重试只是把红灯拖成 60 秒后的红灯
    expect(isTransientRoleNotAssumable(new Error("AccessDeniedException: User is not authorized to perform airflow-serverless:StartWorkflowRun"))).toBe(false);
    expect(isTransientRoleNotAssumable(new Error("ValidationException: Workflow execution role could not be assumed by the glue service"))).toBe(false);
    expect(isTransientRoleNotAssumable(new Error("ResourceNotFoundException: workflow not found"))).toBe(false);
    expect(isTransientRoleNotAssumable(undefined)).toBe(false);
  });

  it("撞到传播窗口 ⇒ 重试直到成功(返回值来自真正成功的那一次)", async () => {
    const { startWorkflowRun } = await import("@/lib/scheduler/serverless/workflow-client");
    send
      .mockRejectedValueOnce(new Error(ROLE_PROP))
      .mockRejectedValueOnce(new Error(ROLE_PROP))
      .mockResolvedValueOnce({ RunId: "RUN-OK", Status: "STARTING" });
    const r: any = await startWorkflowRun("us-west-2", "arn:aws:airflow-serverless:us-west-2:1:workflow/w-x", { intervalMs: 0 });
    expect(r.RunId).toBe("RUN-OK");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("其它错误 ⇒ **一次都不重试**,原样抛出(不许把真故障拖成慢)", async () => {
    const { startWorkflowRun } = await import("@/lib/scheduler/serverless/workflow-client");
    send.mockRejectedValue(new Error("ResourceNotFoundException: workflow not found"));
    await expect(
      startWorkflowRun("us-west-2", "arn:aws:airflow-serverless:us-west-2:1:workflow/w-x", { intervalMs: 0 })
    ).rejects.toThrow(/ResourceNotFoundException/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("窗口用完仍是同一句 ⇒ 抛人话,且**点明信任策略没问题**(免得下一个人去查信任策略)", async () => {
    const { startWorkflowRun } = await import("@/lib/scheduler/serverless/workflow-client");
    send.mockRejectedValue(new Error(ROLE_PROP));
    await expect(
      startWorkflowRun("us-west-2", "arn:aws:airflow-serverless:us-west-2:1:workflow/w-x", { attempts: 3, intervalMs: 0 })
    ).rejects.toThrow(/信任策略本身没问题/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("🔴 重试放在 startWorkflowRun 里(单一作者):三个调用点都不许自己再写一套重试", async () => {
    // 「写了 ≠ 接上了」:重试落在任一调用点 = 另外两条路径照旧假红。
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const callers = [
      // 手动触发的 StartWorkflowRun 调用点在执行体(路由只 submitLongOp)
      "lib/workflow/long-ops.ts",
      "lib/scheduler/trigger.ts",
      "lib/scheduler/dependency.ts",
    ];
    for (const rel of callers) {
      const body = readFileSync(resolve(SRC, rel), "utf8");
      expect(body).toContain("startWorkflowRun");
      // 调用点里不许出现这句判据(出现 = 有人又抄了一份重试逻辑)
      expect(body).not.toContain("isTransientRoleNotAssumable");
    }
  });
});
