// 🔴 恢复**判定**门禁(SPEC §3.5b ③④):`assessRecovery` + `describeStackDisposition` + 结构性安全窗算术。
//
// 【本文件的三条承重】
// ① **判据只有一份**:页面(GET)与真恢复(POST)共用 `assessRecovery` ⇒ 不可能"页面说能恢复、接口却拒"。
// ② **CFN 闸绝不降级**:`describeStackDisposition` 与进度页 `fetchStackStatuses` 口径**相反** ——
//    describe/ListChangeSets 失败在进度页降级成 UNKNOWN 继续显示,在恢复闸里是 **blocker**(看不清 = 不安全)。
//    栈清单取 `base ∪ 顶层 components ∪ spec.desiredComponents` 并集:失败的往往是**新组件**那个栈,
//    只查 observed 会漏掉正在创建/回滚中的它 = fail-open。
// ③ **无 buildId 的安全窗是结构性论证**:CodeBuild 到项目超时必杀 build ⇒ 超过它那次会话不可能还有 build 在跑。
import { describe, it, expect, beforeEach, vi } from "vitest";

const { readPhaseMock, absenceMock } = vi.hoisted(() => ({ readPhaseMock: vi.fn(), absenceMock: vi.fn() }));

vi.mock("@aws-sdk/client-cloudformation", () => {
  class CloudFormationClient {
    constructor(public config: { region?: string }) {}
    async send(cmd: { __kind: string; input?: { StackName?: string } }) {
      const name = cmd?.input?.StackName ?? "";
      const stacks = (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks ?? {};
      const sets = (globalThis as { __cfnChangeSets?: Record<string, unknown> }).__cfnChangeSets ?? {};
      if (cmd.__kind === "ListChangeSets") {
        if (sets[name] === "THROW") throw new Error("AccessDenied (fixture)");
        return { Summaries: (sets[name] as Array<Record<string, string>> | undefined) ?? [] };
      }
      if (!(name in stacks)) throw new Error(`Stack with id ${name} does not exist`);
      if (stacks[name] === "THROW") throw new Error("cfn unavailable (fixture)");
      if (stacks[name] === "EMPTY") return { Stacks: [] };
      return { Stacks: [{ StackName: name, StackStatus: stacks[name] }] };
    }
  }
  class DescribeStacksCommand {
    readonly __kind = "DescribeStacks";
    constructor(public input: { StackName?: string }) {}
  }
  class ListChangeSetsCommand {
    readonly __kind = "ListChangeSets";
    constructor(public input: { StackName?: string }) {}
  }
  return { CloudFormationClient, DescribeStacksCommand, ListChangeSetsCommand };
});

// readExactBuildPhase 走 mock(不打真 CodeBuild);describeStackDisposition/窗口算术保持**真实实现**。
vi.mock("@/lib/exec-env/deploy-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/deploy-control")>();
  // verifyNoBuildForOperation 也走 mock(不打真 CodeBuild);缺省「找不到证据」= 旧行为
  return { ...actual, readExactBuildPhase: readPhaseMock, verifyNoBuildForOperation: absenceMock };
});

import { assessRecovery } from "@/lib/exec-env/recovery";
import {
  describeStackDisposition,
  noBuildRecoveryWindow,
  sanitizeAwsErrorMessage,
  EXEC_ENV_BUILD_TIMEOUT_MS,
  RECOVERY_NO_BUILD_MARGIN_MS,
  BUILD_NOT_FOUND,
  STABLE_STACK_STATUSES,
} from "@/lib/exec-env/deploy-control";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

const CANON = "2026-09-01T00:00:00.000Z";
const START_MS = Date.parse(CANON);
const ACCT = "123456789012";
const OP = "op_2b0001";
const HASH = "c".repeat(64);
const green = { at: CANON, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
const CORE_STACK = "BgpExecEnv-tgt-usw2-a-core";
const BASE_STACK = "BgpExecEnv-tgt-usw2-a-base";

const target = (over: Record<string, unknown> = {}) =>
  ({
    pk: "env",
    sk: "tgt_usw2_a",
    targetId: "tgt_usw2_a",
    version: 11,
    accountId: ACCT,
    region: "us-west-2",
    partition: "aws",
    jurisdiction: "home",
    status: "upgrading",
    ready: true,
    components: ["core"],
    probe: green,
    lockEpoch: 4,
    deployLockToken: OP,
    deployLockOperationId: OP,
    deployLockExpiresAt: 1_800_000_000_000,
    spec: { intent: "serve", desiredComponents: ["core"] },
    observed: {
      phase: "ready",
      health: "healthy",
      components: ["core"],
      probe: green,
      operation: { kind: "deploy", operationId: OP, lockEpoch: 4, openSnapshotHash: HASH, buildId: "b_2b", startedAt: CANON, disruptive: true },
    },
    ...over,
  }) as unknown as ExecutionTarget;

const legacyTarget = (over: Record<string, unknown> = {}) =>
  ({
    pk: "env",
    sk: "tgt_usw2_a",
    targetId: "tgt_usw2_a",
    version: 11,
    accountId: ACCT,
    region: "us-west-2",
    partition: "aws",
    jurisdiction: "home",
    status: "initializing",
    ready: false,
    components: ["core"],
    probe: green,
    lockEpoch: 4,
    deployLockToken: "tok_leg",
    deployLockOperationId: OP,
    deployLockExpiresAt: 1_800_000_000_000,
    lastOperationId: OP,
    lastBuildId: "b_leg",
    ...over,
  }) as unknown as ExecutionTarget;

beforeEach(() => {
  readPhaseMock.mockReset();
  absenceMock.mockReset();
  absenceMock.mockResolvedValue({ absent: false, verifiedAt: 0 });
  (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "UPDATE_COMPLETE", [CORE_STACK]: "UPDATE_ROLLBACK_COMPLETE" };
  (globalThis as { __cfnChangeSets?: unknown }).__cfnChangeSets = {};
});

describe("🔴 assessRecovery:modern 在途会话", () => {
  it("没有 operation ⇒ state=none(无需恢复)", async () => {
    const r = await assessRecovery(target({ observed: { phase: "ready", health: "healthy", components: ["core"], probe: green } }));
    expect(r.state).toBe("none");
  });

  it("build FAILED ⇒ ready,且 fence 逐字取自真 item(exact 会话身份)", async () => {
    readPhaseMock.mockResolvedValue("FAILED");
    const r = await assessRecovery(target(), OP);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.kind).toBe("terminal-build-failure");
    expect(r.buildStatus).toBe("FAILED");
    expect(r.fence).toMatchObject({ mode: "modern", operationId: OP, lockEpoch: 4, openSnapshotHash: HASH, buildId: "b_2b", startedAt: CANON, fromPhase: "ready", expectedVersion: 11, region: "us-west-2" });
    // 🔴 只查 operation 自己的 buildId,绝不用 lastBuildId 补洞
    expect(readPhaseMock).toHaveBeenCalledWith("b_2b");
  });

  it("build SUCCEEDED ⇒ blocked 400 并指向「检测初始化」(恢复端点不得当清锁后门)", async () => {
    readPhaseMock.mockResolvedValue("SUCCEEDED");
    const r = await assessRecovery(target(), OP);
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.httpStatus).toBe(400);
    expect(r.reason).toMatch(/检测初始化/);
  });

  for (const phase of ["IN_PROGRESS", "UNKNOWN"]) {
    it(`build ${phase} ⇒ blocked 409(清锁会放第二次部署去撞同一批栈)且 humanRecovery=false(正常在途,别报警)`, async () => {
      readPhaseMock.mockResolvedValue(phase);
      const r = await assessRecovery(target(), OP);
      expect(r.state).toBe("blocked");
      if (r.state !== "blocked") return;
      expect(r.httpStatus).toBe(409);
      // 🔴 "有会话" ≠ "需人工恢复":每次正常部署期间都弹"需恢复"就是狼来了(会训练运维忽略真告警)。
      expect(r.humanRecovery).toBe(false);
    });
  }

  it("build SUCCEEDED ⇒ humanRecovery=false(点「检测初始化」即可,不是恢复场景)", async () => {
    readPhaseMock.mockResolvedValue("SUCCEEDED");
    const r = await assessRecovery(target(), OP);
    expect(r.state === "blocked" && r.humanRecovery).toBe(false);
  });

  it("expectedOperationId 不符 ⇒ blocked 409,且**不查 build**(点名先过)", async () => {
    const r = await assessRecovery(target(), "op_someoneelse");
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.httpStatus).toBe(409);
    expect(readPhaseMock).not.toHaveBeenCalled();
  });

  it("🔴 modern 描述符 schema 非法 ⇒ blocked 409 + humanRecovery(**不抛异常**;抛了 GET 就变 502,页面拿不到原因)", async () => {
    // observed.phase 非法词 ⇒ classifyDescriptor 判 invalid。只读判定必须返回「不可用 + 原因」而不是抛。
    const r = await assessRecovery(target({ observed: { phase: "bogus", health: "healthy", components: ["core"] } }));
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.httpStatus).toBe(409);
    expect(r.humanRecovery).toBe(true);
    expect(r.reason).toMatch(/形态非法/);
  });

  it("spec/observed 半写 ⇒ blocked 409(fail-closed,不猜)", async () => {
    const r = await assessRecovery(target({ observed: undefined }));
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.reason).toMatch(/半写/);
  });
});

describe("🔴 assessRecovery:无 buildId 的结构性安全窗(startUncertain / attach 丢响应)", () => {
  const noBuild = (over: Record<string, unknown> = {}) =>
    target({
      observed: {
        phase: "ready",
        health: "healthy",
        components: ["core"],
        probe: green,
        operation: { kind: "deploy", operationId: OP, lockEpoch: 4, openSnapshotHash: HASH, startedAt: CANON, disruptive: true, ...over },
      },
    });

  it("窗内 ⇒ blocked 409 并给出 earliestRecoverAt(不含糊说「稍后再试」)", async () => {
    const r = await assessRecovery(noBuild(), OP, START_MS + 60_000);
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.httpStatus).toBe(409);
    expect(r.kind).toBe("start-uncertain");
    expect(r.earliestRecoverAt).toBe(new Date(START_MS + EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS).toISOString());
    // 🔴 确实卡住了(完成 fence 永不可能触发),只是还没到安全窗 ⇒ 该报警、按钮先禁用
    expect(r.humanRecovery).toBe(true);
    expect(readPhaseMock).not.toHaveBeenCalled();
  });

  // 真环境:broker open 后 post-image 不匹配即停、根本没起 build,却要等 2h15m 结构窗。
  //    第二证据 = CodeBuild 项目列表里没有该 operation 的 build(会话 ≥ 5min 后可信)⇒ 不必等窗。
  it("🔴 窗内但会话 ≥ 5min 且 CodeBuild 列表里没有该 operation 的 build ⇒ ready(不必等 2h15m)", async () => {
    absenceMock.mockResolvedValue({ absent: true, verifiedAt: START_MS + 6 * 60_000 });
    const r = await assessRecovery(noBuild(), OP, START_MS + 6 * 60_000);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.kind).toBe("start-uncertain");
    expect(r.buildStatus).toBe("no-build");
    expect(absenceMock).toHaveBeenCalledWith(OP, CANON, START_MS + 6 * 60_000);
  });
  it("会话不足 5min ⇒ 不查列表(防与 broker StartBuild 竞态),仍 blocked", async () => {
    absenceMock.mockResolvedValue({ absent: true, verifiedAt: START_MS + 60_000 });
    const r = await assessRecovery(noBuild(), OP, START_MS + 60_000);
    expect(r.state).toBe("blocked");
    expect(absenceMock).not.toHaveBeenCalled();
  });
  it("列表里找到该 operation 的 build 且仍 IN_PROGRESS ⇒ blocked(attach-ambiguous);已 FAILED ⇒ ready 取其真实终态", async () => {
    absenceMock.mockResolvedValue({ absent: false, candidateBuildId: "bgp-exec-env-deploy:found", candidateStatus: "IN_PROGRESS", verifiedAt: START_MS + 6 * 60_000 });
    const r1 = await assessRecovery(noBuild(), OP, START_MS + 6 * 60_000);
    expect(r1.state).toBe("blocked");
    if (r1.state === "blocked") expect(r1.kind).toBe("attach-ambiguous");
    absenceMock.mockResolvedValue({ absent: false, candidateBuildId: "bgp-exec-env-deploy:found", candidateStatus: "FAILED", verifiedAt: START_MS + 6 * 60_000 });
    const r2 = await assessRecovery(noBuild(), OP, START_MS + 6 * 60_000);
    expect(r2.state).toBe("ready");
    if (r2.state === "ready") {
      expect(r2.kind).toBe("attach-ambiguous");
      expect(r2.buildStatus).toBe("FAILED");
    }
  });

  it("过窗 ⇒ ready,buildStatus=no-build,fence 不带 buildId", async () => {
    const r = await assessRecovery(noBuild(), OP, START_MS + EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.kind).toBe("start-uncertain");
    expect(r.buildStatus).toBe("no-build");
    expect(r.fence.mode === "modern" && r.fence.buildId).toBeUndefined();
  });

  it("attach 丢响应:候选 build 已终止 ⇒ ready(不必等窗),buildStatus 取候选真实结局", async () => {
    readPhaseMock.mockResolvedValue("SUCCEEDED");
    const r = await assessRecovery(noBuild({ attachUncertain: { at: CANON, message: "lost", candidateBuildId: "b_cand" } }), OP, START_MS + 60_000);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.kind).toBe("attach-ambiguous");
    expect(r.buildStatus).toBe("SUCCEEDED"); // 🔴 完成 fence 结构上不可能(无 operation.buildId)⇒ 必须放行
    expect(readPhaseMock).toHaveBeenCalledWith("b_cand");
  });

  it("attach 丢响应:候选 build 仍 IN_PROGRESS ⇒ blocked 409,但 humanRecovery=true(buildId 没 attach 上,终将卡死)", async () => {
    readPhaseMock.mockResolvedValue("IN_PROGRESS");
    const r = await assessRecovery(noBuild({ attachUncertain: { at: CANON, message: "lost", candidateBuildId: "b_cand" } }), OP, START_MS + 60_000);
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.httpStatus).toBe(409);
    expect(r.humanRecovery).toBe(true);
  });

  it("startedAt 不可解析 ⇒ 永不放行(fail-closed,不猜)", async () => {
    const r = await assessRecovery(noBuild({ startedAt: "not-a-date" }), OP, START_MS + 10 * EXEC_ENV_BUILD_TIMEOUT_MS);
    expect(r.state).toBe("blocked");
    expect(noBuildRecoveryWindow("not-a-date").recoverable).toBe(false);
  });
});

describe("🔴 assessRecovery:legacy 残留锁", () => {
  it("lastBuildId 已失败终止 ⇒ ready(legacy fence)", async () => {
    readPhaseMock.mockResolvedValue("STOPPED");
    const r = await assessRecovery(legacyTarget(), OP);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.kind).toBe("legacy-terminal-failure");
    expect(r.fence).toMatchObject({ mode: "legacy", lockToken: "tok_leg", operationId: OP, buildId: "b_leg", lockEpoch: 4, status: "initializing" });
  });

  it("没有残留锁 ⇒ none", async () => {
    const r = await assessRecovery(legacyTarget({ deployLockToken: undefined, deployLockOperationId: undefined, deployLockExpiresAt: undefined }));
    expect(r.state).toBe("none");
  });

  it("缺 canonical lastBuildId ⇒ blocked 409(无法证明 build 已终止)", async () => {
    const r = await assessRecovery(legacyTarget({ lastBuildId: undefined }), OP);
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.reason).toMatch(/lastBuildId/);
  });

  it("owner ≠ lastOperationId ⇒ blocked 409(holder 不 exact)", async () => {
    const r = await assessRecovery(legacyTarget({ lastOperationId: "op_other" }), OP);
    expect(r.state).toBe("blocked");
  });

  it("legacy build 已 SUCCEEDED ⇒ blocked 400(走收养/完成路)", async () => {
    readPhaseMock.mockResolvedValue("SUCCEEDED");
    const r = await assessRecovery(legacyTarget(), OP);
    expect(r.state).toBe("blocked");
    if (r.state !== "blocked") return;
    expect(r.httpStatus).toBe(400);
  });
});

describe("🔴 describeStackDisposition:与进度页降级口径【相反】—— 看不清 = 不安全", () => {
  it("全终态 + 无 change set ⇒ stable", async () => {
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(true);
    expect(d.blockers).toEqual([]);
    expect(d.stacks.map((s) => s.name)).toEqual([BASE_STACK, CORE_STACK]);
  });

  it("任一栈 *_IN_PROGRESS ⇒ 不 stable", async () => {
    (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "UPDATE_COMPLETE", [CORE_STACK]: "UPDATE_ROLLBACK_IN_PROGRESS" };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(false);
    expect(d.blockers.join()).toMatch(/进行中动作/);
  });

  it("REVIEW_IN_PROGRESS(change set 建了未执行的空栈)⇒ 不 stable", async () => {
    (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "REVIEW_IN_PROGRESS", [CORE_STACK]: "UPDATE_COMPLETE" };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(false);
  });

  it("存在未执行 change set(ExecutionStatus=AVAILABLE)⇒ 不 stable", async () => {
    (globalThis as { __cfnChangeSets?: unknown }).__cfnChangeSets = { [CORE_STACK]: [{ Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" }] };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(false);
    expect(d.blockers.join()).toMatch(/未执行 change set/);
  });

  it("已执行完的 change set 不算 blocker", async () => {
    (globalThis as { __cfnChangeSets?: unknown }).__cfnChangeSets = { [CORE_STACK]: [{ Status: "CREATE_COMPLETE", ExecutionStatus: "EXECUTE_COMPLETE" }] };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(true);
  });

  it("🔴 DescribeStacks 失败(非「不存在」)⇒ **blocker**(进度页会降级成 UNKNOWN,恢复闸不许)", async () => {
    (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "UPDATE_COMPLETE", [CORE_STACK]: "THROW" };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(false);
    expect(d.blockers.join()).toMatch(/看不清 ⇒ 视为不安全/);
  });

  it("🔴 ListChangeSets 失败 ⇒ blocker(同理)", async () => {
    (globalThis as { __cfnChangeSets?: unknown }).__cfnChangeSets = { [CORE_STACK]: "THROW" };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(false);
    expect(d.blockers.join()).toMatch(/ListChangeSets/);
  });

  it("DescribeStacks 返回空 Stacks(形态异常)⇒ blocker,不当「不存在」", async () => {
    (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "UPDATE_COMPLETE", [CORE_STACK]: "EMPTY" };
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(false);
  });

  it("栈尚未创建(does not exist)⇒ 跳过,不是 blocker(初装在建栈前就失败的正常形态)", async () => {
    (globalThis as { __cfnStacks?: unknown }).__cfnStacks = {};
    const d = await describeStackDisposition(target());
    expect(d.stable).toBe(true);
    expect(d.stacks).toEqual([]);
  });

  it("🔴 栈清单取并集:desiredComponents 里的新组件栈也必须被查(否则漏掉正在回滚的那个 = fail-open)", async () => {
    (globalThis as { __cfnStacks?: unknown }).__cfnStacks = {
      [BASE_STACK]: "UPDATE_COMPLETE",
      [CORE_STACK]: "UPDATE_COMPLETE",
      "BgpExecEnv-tgt-usw2-a-redshift": "CREATE_IN_PROGRESS", // 只在 spec.desiredComponents 里
    };
    const d = await describeStackDisposition(
      target({ components: ["core"], spec: { intent: "serve", desiredComponents: ["core", "redshift"] } })
    );
    expect(d.stable).toBe(false);
    expect(d.blockers.join()).toMatch(/redshift/);
  });
});

describe("🔴 结构性安全窗算术(唯一一处,页面与接口共用)", () => {
  it("earliest = startedAt + 项目超时 + 裕度;边界即可恢复", () => {
    const w = noBuildRecoveryWindow(CANON, START_MS);
    expect(w.earliestRecoverAt).toBe(new Date(START_MS + EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS).toISOString());
    expect(w.recoverable).toBe(false);
    expect(noBuildRecoveryWindow(CANON, START_MS + EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS).recoverable).toBe(true);
    expect(noBuildRecoveryWindow(CANON, START_MS + EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS - 1).recoverable).toBe(false);
  });
});

describe("🔴 build 记录已不存在(CodeBuild 查不到)—— 必须可恢复,否则又是一个永久卡死门", () => {
  it("modern 有 buildId 但 CodeBuild 查不到 ⇒ ready(记录都没了 ⇒ 结构上不可能有 build 在跑)", async () => {
    readPhaseMock.mockResolvedValue(BUILD_NOT_FOUND);
    const r = await assessRecovery(target(), OP);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.buildStatus).toBe(BUILD_NOT_FOUND);
    expect(r.fence.mode === "modern" && r.fence.buildId).toBe("b_2b");
    expect(r.before.buildRecordMissing).toBe(true);
  });

  it("legacy lastBuildId 查不到 ⇒ 同样可恢复", async () => {
    readPhaseMock.mockResolvedValue(BUILD_NOT_FOUND);
    const r = await assessRecovery(legacyTarget(), OP);
    expect(r.state).toBe("ready");
  });
});

describe("🔴 CFN **已终止但未成功回滚** 必须拦(白名单口径;黑名单写法会放行 = fail-open)", () => {
  for (const bad of ["UPDATE_ROLLBACK_FAILED", "ROLLBACK_FAILED", "CREATE_FAILED", "DELETE_FAILED"]) {
    it(`栈处于 ${bad} ⇒ 不 stable(CFN 明确说没回滚成功,清锁不安全)`, async () => {
      (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "UPDATE_COMPLETE", [CORE_STACK]: bad };
      const d = await describeStackDisposition(target());
      expect(d.stable).toBe(false);
      expect(d.blockers.join()).toMatch(/非稳定终态/);
    });
  }

  for (const good of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "ROLLBACK_COMPLETE"]) {
    it(`栈处于 ${good} ⇒ stable(白名单内)`, async () => {
      (globalThis as { __cfnStacks?: unknown }).__cfnStacks = { [BASE_STACK]: "UPDATE_COMPLETE", [CORE_STACK]: good };
      const d = await describeStackDisposition(target());
      expect(d.stable).toBe(true);
    });
  }

  it("白名单常量与实现同源(改实现忘改白名单会被这条咬)", () => {
    expect([...STABLE_STACK_STATUSES]).toContain("UPDATE_ROLLBACK_COMPLETE");
    expect([...STABLE_STACK_STATUSES]).not.toContain("UPDATE_ROLLBACK_FAILED");
  });
});

describe("🔴 AWS 报错脱敏(账号号红线)—— blockers 会经 HTTP 响应 + 审计外泄", () => {
  it("抹掉 12 位账号号与完整 ARN", () => {
    const raw =
      "User: arn:aws:sts::123456789012:assumed-role/BgpPlatformStack-TaskRole/abc is not authorized to perform: cloudformation:ListChangeSets on 123456789012";
    const clean = sanitizeAwsErrorMessage(raw);
    expect(clean).not.toMatch(/\d{12}/);
    expect(clean).not.toContain("arn:aws");
    expect(clean).toContain("<account>");
    expect(clean).toContain("<arn>");
  });

  it("describeStackDisposition 的 blocker 文案里不含账号号", async () => {
    (globalThis as { __cfnChangeSets?: unknown }).__cfnChangeSets = { [CORE_STACK]: "THROW" };
    const d = await describeStackDisposition(target());
    expect(d.blockers.join()).not.toMatch(/\d{12}/);
  });
});
