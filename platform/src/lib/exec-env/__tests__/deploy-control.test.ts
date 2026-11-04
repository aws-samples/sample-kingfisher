// deploy-control 单测(SPEC §2.1 deploy/build-status;DESIGN §12.4)。
//
// 【本文件的三条承重】
// ① **broker 拒绝码 → HTTP 的映射是合同**:locked 映射错(如 200)会让前端把"并发部署被锁挡下"
//    当成功展示 —— 那正是 §12.2 部署锁要防的事故被 UI 亲手掩盖;
// ② **broker 响应形状 fail-closed**:缺 ok / 报成功没 buildId ⇒ 抛"契约漂移",不猜;
// ③ **逐栈进度只认本 target 的栈**(前缀过滤)+ **降级不失联**(CFN 拉不到 → stacks:[],
//    日志拉不到 → logsTail:"",但 phase 仍在 —— 进度页不因辅助信息失败而整体 500)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// vi.hoisted:deploy-control.ts 在**模块顶层**就 new LambdaClient/CodeBuildClient(单例惯例),
// mock 工厂在 import 阶段执行 —— 普通顶层 const 那时还在 TDZ,必须 hoisted。
const { lambdaSend, cbSend, cfnSend, logsSend } = vi.hoisted(() => ({
  lambdaSend: vi.fn(),
  cbSend: vi.fn(),
  cfnSend: vi.fn(),
  logsSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = lambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  GetFunctionConfigurationCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock("@aws-sdk/client-codebuild", () => ({
  CodeBuildClient: class {
    send = cbSend;
  },
  BatchGetBuildsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  BatchGetProjectsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock("@aws-sdk/client-cloudformation", () => {
  // 起 deploy-control 改「按命名 SSOT 推定栈名、逐栈指名 DescribeStacks」(资源级授权下
  // 无参列举会被拒)。mock 语义随之:__cfnStacks = { 栈名 → StackStatus },指名查不存在 ⇒ 抛
  // "does not exist"(与真 CFN 一致);__cfnStacks 未设 ⇒ 一律抛通用错误(模拟 region 不可达)。
  class CloudFormationClient {
    constructor(public config: { region?: string }) {
      cfnSend((this as { config: unknown }).config); // 记录用哪个 region 建的 client
    }
    async send(cmd: { input?: { StackName?: string } }) {
      const stacks = (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks;
      if (stacks === undefined) throw new Error("cfn unavailable (fixture)");
      const name = cmd?.input?.StackName ?? "";
      if (!(name in stacks)) throw new Error(`Stack with id ${name} does not exist`);
      return { Stacks: [{ StackName: name, StackStatus: stacks[name] }] };
    }
  }
  class DescribeStacksCommand {
    constructor(public input: { StackName?: string }) {}
  }
  return { CloudFormationClient, DescribeStacksCommand };
});
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class {
    send = logsSend;
  },
  GetLogEventsCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import {
  invokeDeployBroker,
  describeBrokerInvokeFailure,
  probeDeployMechanism,
  DEPLOY_MECHANISM_MISSING_CODE,
  brokerCodeToHttp,
  readBuildStatus,
  EXEC_ENV_BROKER_NAME,
  EXEC_ENV_PROJECT_NAME,
  EXEC_ENV_BUILD_TIMEOUT_MS,
  RECOVERY_NO_BUILD_MARGIN_MS,
  TERMINAL_FAILED_BUILD_STATUSES,
  BUILD_STATUS_PLACE_VIA,
} from "@/lib/exec-env/deploy-control";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
// 账本走真实现(请求存储用最小替身)
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");

const TARGET = { targetId: "tgt_usw2_a", region: "us-west-2", lastBuildId: "bgp-exec-env-deploy:abc" } as unknown as ExecutionTarget;

function payload(obj: unknown) {
  return { Payload: Buffer.from(JSON.stringify(obj)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks;
});

describe("🔴 契约:两侧字面量逐字一致(平台 ↔ infra 跨构建边界,无法共享常量)", () => {
  it("EXEC_ENV_BROKER_NAME / EXEC_ENV_PROJECT_NAME 与 infra/lib/exec-env/deploy-stack.ts 的导出一致", () => {
    const src = readFileSync(resolve(REPO, "infra/lib/exec-env/deploy-stack.ts"), "utf8");
    expect(src).toContain(`EXEC_ENV_PROJECT_NAME = "${EXEC_ENV_PROJECT_NAME}"`);
    expect(src).toContain(`EXEC_ENV_BROKER_NAME = "${EXEC_ENV_BROKER_NAME}"`);
  });

  it("平台栈给 TaskRole 的 broker ARN / 项目 ARN 用的也是同两个名字(改名必须三处一起)", () => {
    const plat = readFileSync(resolve(REPO, "infra/lib/platform-stack.ts"), "utf8");
    expect(plat).toContain(`function:${EXEC_ENV_BROKER_NAME}`);
    expect(plat).toContain(`project/${EXEC_ENV_PROJECT_NAME}`);
  });

  // 🔴 「代码用了的动作,角色必须给」跨构建边界钉死
  //   deploy-control.ts 每个 `XxxCommand`(client-codebuild)⇒ platform-stack.ts 必须出现 `codebuild:Xxx`。
  //   真环境撞过:verifyNoBuildForOperation 用 ListBuildsForProject、TaskRole 只给 BatchGet* ⇒ 查询失败被 fail-closed 吞成「无法查列表」,
  //   恢复照旧等 2h15m,页面上看不出是权限问题。同类教训见 memory cognito-taskrole-missing-disable-enable。
  it("🔴 deploy-control 用到的每个 CodeBuild 命令都在 platform-stack.ts 的 TaskRole 授权里", () => {
    const src = readFileSync(resolve(REPO, "platform/src/lib/exec-env/deploy-control.ts"), "utf8");
    const plat = readFileSync(resolve(REPO, "infra/lib/platform-stack.ts"), "utf8");
    const importBlock = src.match(/import \{([^}]*)\} from "@aws-sdk\/client-codebuild";/);
    expect(importBlock, "deploy-control.ts 找不到 client-codebuild 的 import").toBeTruthy();
    const cmds = Array.from((importBlock as RegExpMatchArray)[1].matchAll(/(\w+)Command/g)).map((m) => m[1]);
    expect(cmds.length).toBeGreaterThanOrEqual(3);
    for (const c of cmds) {
      expect(plat, `TaskRole 没给 codebuild:${c},而 deploy-control.ts 在用 ${c}Command`).toContain(`"codebuild:${c}"`);
    }
  });

  it("🔴 2b:EXEC_ENV_BUILD_TIMEOUT_MS 与 infra 的 CodeBuild 项目超时逐字一致", () => {
    // 【为什么是承重】它是 `startUncertain`(无 buildId 可查)恢复窗的**结构性依据**:
    // CodeBuild 到 timeoutInMinutes 必杀 build ⇒ 超过它,那次会话不可能还有 build 在跑(SPEC §3.5b ③)。
    // 若 infra 把超时改大而这里没跟上,恢复窗就会**早于**build 真正被杀 ⇒ 清锁后可能撞上还在跑的部署。
    const src = readFileSync(resolve(REPO, "infra/lib/exec-env/deploy-stack.ts"), "utf8");
    const m = src.match(/timeout:\s*cdk\.Duration\.hours\((\d+)\)/);
    expect(m, "infra 里找不到 CodeBuild 项目 timeout 字面量(改写法了就要同步本门禁)").not.toBeNull();
    expect(EXEC_ENV_BUILD_TIMEOUT_MS).toBe(Number(m![1]) * 60 * 60 * 1000);
  });

  it("🔴 2b:broker LOCK_LEASE_MS ≥ 项目超时 + 裕度(诊断量不得比合法长 build 还短)", () => {
    // 90min < 2h 的原值正是隐患:合法的 100 分钟 build 会显示成"已过期",
    // 诱使后人把 `OR deployLockExpiresAt < :now` 那条 fail-open 条件加回来(DESIGN §20.25)。
    const broker = readFileSync(resolve(REPO, "infra/lambda/exec-env-broker/index.mjs"), "utf8");
    const m = broker.match(/LOCK_LEASE_MS\s*=\s*(\d+)\s*\*\s*60_000/);
    expect(m, "broker 里找不到 LOCK_LEASE_MS 字面量").not.toBeNull();
    const leaseMs = Number(m![1]) * 60_000;
    expect(leaseMs).toBeGreaterThanOrEqual(EXEC_ENV_BUILD_TIMEOUT_MS + RECOVERY_NO_BUILD_MARGIN_MS);
  });

  it("🔴 2b:TERMINAL_FAILED_BUILD_STATUSES = broker 终态集 去掉 SUCCEEDED(跨边界同源)", () => {
    const v = readFileSync(resolve(REPO, "infra/lambda/exec-env-broker/validate.mjs"), "utf8");
    const m = v.match(/TERMINAL_BUILD_STATUS\s*=\s*new Set\(\[([^\]]+)\]\)/);
    expect(m, "broker 里找不到 TERMINAL_BUILD_STATUS").not.toBeNull();
    const brokerSet = m![1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(new Set(brokerSet)).toEqual(new Set(["SUCCEEDED", ...TERMINAL_FAILED_BUILD_STATUSES]));
  });
});

describe("brokerCodeToHttp(拒绝码 → HTTP 是合同,映射错 = UI 掩盖锁冲突)", () => {
  it.each([
    ["needs-finalize", 409],
    ["needs-legacy-finalize", 409],
    ["needs-failure-reconcile", 409],
    ["needs-fresh-probe", 409],
    ["locked", 409],
    ["bad-status", 409],
    ["not-registered", 404],
    ["rejected", 400],
    ["bad-descriptor", 500],
    ["error", 502],
    ["some-future-code", 502], // 没见过的码 = broker 契约漂移,一律 502 不猜 4xx
  ])("%s → %d", (code, want) => {
    expect(brokerCodeToHttp(code)).toBe(want);
  });
});

describe("invokeDeployBroker", () => {
  it("成功:透传 broker 的 {ok,buildId,lockEpoch}", async () => {
    lambdaSend.mockResolvedValueOnce(payload({ ok: true, buildId: "b-1", lockEpoch: 3, targetId: "tgt_usw2_a", region: "us-west-2" }));
    const r = await invokeDeployBroker("tgt_usw2_a", ["core"], "op_0123456789abcdef");
    expect(r).toMatchObject({ ok: true, buildId: "b-1", lockEpoch: 3 });
    // 🔴 只发三个白名单字段(broker 对未知字段是拒;这里断我们自己没多传)
    const sent = JSON.parse(Buffer.from(lambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(Object.keys(sent).sort()).toEqual(["components", "operationId", "targetId"]);
  });

  it("broker 业务拒绝:返回 {ok:false,code}(不抛 —— 让 route 按 code 定状态码)", async () => {
    lambdaSend.mockResolvedValueOnce(payload({ ok: false, code: "locked", message: "正在部署中" }));
    const r = await invokeDeployBroker("tgt_usw2_a", ["core"], "op_0123456789abcdef");
    expect(r).toEqual({ ok: false, code: "locked", message: "正在部署中" });
  });

  it("🔴 FunctionError(broker 未捕获异常)⇒ 抛,与业务拒绝分开", async () => {
    lambdaSend.mockResolvedValueOnce({ FunctionError: "Unhandled", Payload: Buffer.from("{}") });
    await expect(invokeDeployBroker("t", ["core"], "op_x")).rejects.toThrow(/broker 本身故障/);
  });

  it("🔴 响应非 JSON ⇒ 抛(带前 200 字定位)", async () => {
    lambdaSend.mockResolvedValueOnce({ Payload: Buffer.from("<html>oops") });
    await expect(invokeDeployBroker("t", ["core"], "op_x")).rejects.toThrow(/不是 JSON/);
  });

  it("🔴 缺 ok 字段 ⇒ 抛契约漂移(不猜成功也不猜失败)", async () => {
    lambdaSend.mockResolvedValueOnce(payload({ buildId: "b-1" }));
    await expect(invokeDeployBroker("t", ["core"], "op_x")).rejects.toThrow(/契约漂移/);
  });

  it("🔴 报成功但没 buildId ⇒ 抛(否则进度页拿空 id 永远查不到)", async () => {
    lambdaSend.mockResolvedValueOnce(payload({ ok: true, lockEpoch: 1 }));
    await expect(invokeDeployBroker("t", ["core"], "op_x")).rejects.toThrow(/没给 buildId/);
  });

  it("🔴 broker Lambda 不存在(ResourceNotFoundException / Function not found)⇒ 抛「部署机制未就位」+ 修法(2026-09-06 新账号真撞)", async () => {
    const err = Object.assign(new Error("Function not found: arn:aws:lambda:us-east-1:123456789012:function:bgp-exec-env-broker"), { name: "ResourceNotFoundException" });
    lambdaSend.mockRejectedValueOnce(err);
    const p = invokeDeployBroker("tgt_usw2_a", ["core"], "op_0123456789abcdef");
    await expect(p).rejects.toThrow(/部署机制未就位/);
    await expect(p).rejects.toThrow(/BgpExecEnvDeployStack/);
    await expect(p).rejects.toThrow(/redeploy-platform\.sh/);
    const e2 = describeBrokerInvokeFailure(Object.assign(new Error("Function not found: x"), { name: "ResourceNotFoundException" })) as Error & { code?: string };
    expect(e2.code).toBe(DEPLOY_MECHANISM_MISSING_CODE);
    // 其它不可达形态原样透出(不猜成"没装")
    const e3 = describeBrokerInvokeFailure(Object.assign(new Error("Rate Exceeded"), { name: "TooManyRequestsException" }));
    expect(e3.message).toBe("Rate Exceeded");
  });
});

describe("probeDeployMechanism(接线健康卡 ⑦:只读、不 invoke)", () => {
  it("broker 与 CodeBuild 项目都在 ⇒ ok", async () => {
    lambdaSend.mockResolvedValueOnce({ Runtime: "nodejs20.x", LastModified: "2026-09-06T03:00:00.000+0000" });
    cbSend.mockResolvedValueOnce({ projects: [{ name: "bgp-exec-env-deploy" }] });
    const r = await probeDeployMechanism();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/bgp-exec-env-broker 在/);
    expect(r.detail).toMatch(/bgp-exec-env-deploy 在/);
    expect(lambdaSend.mock.calls[0][0].input).toEqual({ FunctionName: "bgp-exec-env-broker" });
    expect(cbSend.mock.calls[0][0].input).toEqual({ names: ["bgp-exec-env-deploy"] });
  });
  it("🔴 broker 不存在 ⇒ down,且文案脱敏(不带账号号 / ARN)", async () => {
    lambdaSend.mockRejectedValueOnce(Object.assign(new Error("Function not found: arn:aws:lambda:us-east-1:123456789012:function:bgp-exec-env-broker"), { name: "ResourceNotFoundException" }));
    cbSend.mockResolvedValueOnce({ projects: [] });
    const r = await probeDeployMechanism();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/不可达/);
    expect(r.detail).toMatch(/不存在/);
    expect(r.detail).not.toMatch(/123456789012/);
    expect(r.detail).not.toMatch(/arn:aws:lambda/);
  });
});

describe("readBuildStatus(§12.4:phase 粗粒度 + 逐栈来自目标 region CFN)", () => {
  it("正常:按命名 SSOT 推定栈名逐栈指名查(base+components);别的 target/控制面根本不会被查", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "IN_PROGRESS", logs: { groupName: "g", streamName: "s" } }] });
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {
      "BgpExecEnv-tgt-usw2-a-base": "CREATE_COMPLETE",
      "BgpExecEnv-tgt-usw2-a-core": "CREATE_IN_PROGRESS",
      // 故意放别的 target 与控制面栈:指名查询下它们不在候选清单里,永远不会出现在结果中
      "BgpExecEnv-tgt-eu1-core": "CREATE_COMPLETE",
      "BgpPlatformStack": "UPDATE_COMPLETE",
    };
    logsSend.mockResolvedValueOnce({ events: [{ message: "line1\n" }, { message: "line2" }, { message: "  " }] });

    const r = await readBuildStatus(TARGET);
    expect(r.phase).toBe("IN_PROGRESS");
    expect(r.stacks).toEqual([
      { name: "BgpExecEnv-tgt-usw2-a-base", status: "CREATE_COMPLETE" },
      { name: "BgpExecEnv-tgt-usw2-a-core", status: "CREATE_IN_PROGRESS" },
    ]);
    expect(r.logsTail).toBe("line1\nline2");
  });

  it("🔴 栈还不存在(部署刚开始)⇒ 指名查询抛 does not exist,按「尚未创建」跳过而不是 UNKNOWN", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "IN_PROGRESS" }] });
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {
      "BgpExecEnv-tgt-usw2-a-base": "CREATE_IN_PROGRESS", // core 还没建出来
    };
    const r = await readBuildStatus(TARGET);
    expect(r.stacks).toEqual([{ name: "BgpExecEnv-tgt-usw2-a-base", status: "CREATE_IN_PROGRESS" }]);
  });

  it("🔴 W5a-11(2026-09-05 真环境):补充部署期间新组件只在 spec.desiredComponents、还没进 observed components ⇒ 进度页也必须列出它的栈", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "SUCCEEDED" }] });
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {
      "BgpExecEnv-tgt-usw2-a-base": "CREATE_COMPLETE",
      "BgpExecEnv-tgt-usw2-a-core": "CREATE_COMPLETE",
      "BgpExecEnv-tgt-usw2-a-redshift": "CREATE_COMPLETE",
      "BgpExecEnv-tgt-usw2-a-residency-api": "CREATE_IN_PROGRESS",
    };
    const t = { ...TARGET, components: ["core", "redshift"], spec: { intent: "serve", desiredComponents: ["core", "redshift", "residency-api"] } } as unknown as ExecutionTarget;
    const r = await readBuildStatus(t);
    expect(r.stacks.map((x) => x.name)).toEqual([
      "BgpExecEnv-tgt-usw2-a-base",
      "BgpExecEnv-tgt-usw2-a-core",
      "BgpExecEnv-tgt-usw2-a-redshift",
      "BgpExecEnv-tgt-usw2-a-residency-api",
    ]);
    // 变异自检:去掉 desired 并集(只按 observed 推名)⇒ 新栈消失 ⇒ 本用例必红
    const { candidateStackNames } = await import("@/lib/exec-env/deploy-control");
    expect(candidateStackNames({ ...t, spec: undefined } as unknown as ExecutionTarget)).not.toContain("BgpExecEnv-tgt-usw2-a-residency-api");
  });

  it("显式 buildId 覆盖 lastBuildId", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "SUCCEEDED" }] });
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {};
    const r = await readBuildStatus(TARGET, "bgp-exec-env-deploy:xyz");
    expect(cbSend.mock.calls[0][0].input.ids).toEqual(["bgp-exec-env-deploy:xyz"]);
    expect(r.phase).toBe("SUCCEEDED");
  });

  it("无 buildId(未部署过)⇒ phase='none',但仍查 CFN(栈现状值得看)", async () => {
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {};
    const r = await readBuildStatus({ ...TARGET, lastBuildId: undefined } as never);
    expect(r.phase).toBe("none");
    expect(cbSend).not.toHaveBeenCalled();
  });

  it("🔴 region 不可达(未 bootstrap / IAM 未扩)⇒ 候选栈标 UNKNOWN 留痕,phase 仍在(不再静默空)", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "IN_PROGRESS" }] });
    // __cfnStacks 未设 ⇒ mock 一律抛通用错误(非 does not exist)
    const r = await readBuildStatus(TARGET);
    expect(r.phase).toBe("IN_PROGRESS");
    expect(r.stacks).toEqual([
      { name: "BgpExecEnv-tgt-usw2-a-base", status: "UNKNOWN" },
      { name: "BgpExecEnv-tgt-usw2-a-core", status: "UNKNOWN" },
    ]);
  });

  it("🔴 拉日志失败 ⇒ logsTail:'' 降级(辅助信息不拖垮进度接口)", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "FAILED", logs: { groupName: "g", streamName: "s" } }] });
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {};
    logsSend.mockRejectedValueOnce(new Error("AccessDenied"));
    const r = await readBuildStatus(TARGET);
    expect(r.logsTail).toBe("");
    expect(r.phase).toBe("FAILED");
  });

  it("build 没有 logs 元数据 ⇒ 不发日志请求,logsTail:''", async () => {
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "IN_PROGRESS" }] });
    (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {};
    const r = await readBuildStatus(TARGET);
    expect(logsSend).not.toHaveBeenCalled();
    expect(r.logsTail).toBe("");
  });

  // 逐栈进度查**目标区** CloudFormation(控制面服务但客户端不在主控区
  //   ⇒ 观测器不豁免),GET build-status 路由原来一笔决策都没有 ⇒ 第四十轮 observe 未归因榜「cloudformation build-status」。
  it("🔴 readBuildStatus 在第一个 await 之前记落点决策 {targetId}(请求外调用无账本 ⇒ 不记不抛)", async () => {
    const store = { headers: new Headers() };
    __setRequestStoreProvider(() => store);
    try {
      cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "IN_PROGRESS" }] });
      (globalThis as { __cfnStacks?: Record<string, string> }).__cfnStacks = {};
      await readBuildStatus(TARGET);
      expect(decisionsOfCurrentRequest().decisions.filter((d) => d.via === BUILD_STATUS_PLACE_VIA)).toEqual([
        { targetId: "tgt_usw2_a", via: BUILD_STATUS_PLACE_VIA },
      ]);
    } finally {
      __setRequestStoreProvider(null);
    }
    // 请求外(reconciler)照常
    cbSend.mockResolvedValueOnce({ builds: [{ buildStatus: "IN_PROGRESS" }] });
    const r = await readBuildStatus(TARGET);
    expect(r.phase).toBe("IN_PROGRESS");
    expect(decisionsOfCurrentRequest().decisions).toEqual([]);
  });
});
