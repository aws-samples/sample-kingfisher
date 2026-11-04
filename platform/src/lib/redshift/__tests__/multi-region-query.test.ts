// 多 region 直查提交层的门禁 —— 🔴 **全部可执行**(真调 `submitToTargets`,打桩只到 AWS SDK 边界)。
//
// 用户 2026-09-04 定的两条约束就是这里最承重的不变量:
//   ① 「各区快慢不一,不许等所有区再展示」⇒ 提交层**只提交、不等结果**;
//   ② 「某区报错就展示在它自己的 sheet」⇒ 提交层**逐 target 各自 try**,一个区失败不影响其它区。
// 这两条都属于"错了也不报错、只是行为退化",所以只能靠可执行断言钉住。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, any>>,
  handles: [] as Array<Record<string, any>>,
  bindings: {} as Record<string, any>,
  failSubmitFor: "" as string,
}));

vi.mock("@aws-sdk/client-redshift-data", () => {
  class ExecuteStatementCommand {
    constructor(public input: any) {}
  }
  return { ExecuteStatementCommand };
});

vi.mock("@/lib/exec-env/target-clients", () => ({
  redshiftDataClientFor: vi.fn((region: string) => ({
    async send(cmd: any) {
      h.sent.push({ region, ...cmd.input });
      if (h.failSubmitFor && String(cmd.input.WorkgroupName).includes(h.failSubmitFor)) {
        throw new Error("permission denied for relation orders");
      }
      return { Id: `stmt-${region}` };
    },
  })),
}));

vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId?: string }) => {
      const tid = args.targetId || "tgt_home";
      const b = h.bindings[tid];
      if (!b) throw new (real.TargetBindingRejected as any)("missing-component", `目标 ${tid} 没装 redshift 组件`);
      if (b.throwReason) throw new (real.TargetBindingRejected as any)(b.throwReason, b.throwMsg || "拒");
      return { targetId: tid, home: tid === "tgt_home", degradedToLegacyAdmin: true, jurisdiction: "home", ...b };
    }),
  };
});

vi.mock("@/lib/security/query-handle", () => ({
  issueHandle: vi.fn(async (args: Record<string, any>) => {
    h.handles.push(args);
    return `handle-${args.targetId}`;
  }),
}));

vi.mock("@/lib/realtime/zeroetl-service", () => ({
  ZEROETL_WORKGROUP: "bgp-zeroetl-wg",
  getZeroEtlSecretArn: vi.fn(async () => "arn:zeroetl"),
}));

import {
  submitToTargets,
  normalizeQueryTargets,
  classifyEngineError,
  classifySubmitError,
  MAX_QUERY_FANOUT,
} from "@/lib/redshift/multi-region-query";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const EU = "tgt_euw1_a";
const identity = { sub: "u1", username: "admin" } as any;

beforeEach(() => {
  h.sent.length = 0;
  h.handles.length = 0;
  h.failSubmitFor = "";
  h.bindings = {
    [HOME]: { region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:home" },
    [USW2]: { region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", secretArn: "arn:usw2" },
  };
});

describe("🔴 归一:去重 / 缺省 home / home 排最前", () => {
  it("缺省 = [tgt_home];去重;home 永远第一个 sheet", () => {
    expect(normalizeQueryTargets(undefined)).toEqual([HOME]);
    expect(normalizeQueryTargets([])).toEqual([HOME]);
    expect(normalizeQueryTargets([USW2, HOME, USW2])).toEqual([HOME, USW2]);
    expect(normalizeQueryTargets([USW2])).toEqual([USW2]);
  });
});

describe("🔴 扇出上限:一次点击不许悄悄放大成 N 份扫描与计费", () => {
  it(`超过 ${MAX_QUERY_FANOUT} 个区当场拒`, async () => {
    const many = Array.from({ length: MAX_QUERY_FANOUT + 1 }, (_, i) => `tgt_r${i}x`);
    await expect(submitToTargets({ sql: "SELECT 1", targets: many, projectId: "p1", identity })).rejects.toThrow(
      /最多同时查询/
    );
    expect(h.sent, "超限时不许已经提交了一部分(那会白花钱)").toEqual([]);
  });
});

describe("🔴🔴 提交层:只提交、不等结果;逐 target 各自 try", () => {
  it("两个区各提交一次,各自带自己的 region / workgroup / 凭证", async () => {
    const subs = await submitToTargets({ sql: "SELECT 1", targets: [HOME, USW2], projectId: "p1", identity });
    expect(subs.map((s) => s.targetId)).toEqual([HOME, USW2]);
    expect(subs.every((s) => Boolean(s.statementId)), "有区没拿到 statementId ⇒ 那个 sheet 永远不会有结果").toBe(true);
    expect(h.sent.map((x) => x.region).sort()).toEqual(["us-east-1", "us-west-2"]);
    expect(h.sent.find((x) => x.region === "us-west-2")!.WorkgroupName).toBe("bgp-workgroup-tgt-usw2-a");
    expect(h.sent.find((x) => x.region === "us-west-2")!.SecretArn).toBe("arn:usw2");
  });

  it("🔴 一个区提交失败,**其它区照样提交成功**(与下发的 fail-fast 相反:直查是只读)", async () => {
    h.failSubmitFor = "tgt-usw2-a";
    const subs = await submitToTargets({ sql: "SELECT 1", targets: [HOME, USW2], projectId: "p1", identity });
    expect(subs[0].statementId, "home 被别的区的失败连坐了").toBeTruthy();
    expect(subs[1].statementId).toBeUndefined();
    expect(subs[1].submitError).toContain("permission denied");
    expect(subs[1].errorKind, "提交失败没归类 ⇒ sheet 上只有一句原始报错、没有「去哪修」").toBe("permission-denied");
    expect(subs[1].errorHint).toBeTruthy();
  });

  it("🔴 目标没装组件 ⇒ 该行 `submitError` + 归类 target-not-ready,**不进入轮询**(statementId 为空)", async () => {
    const subs = await submitToTargets({ sql: "SELECT 1", targets: [HOME, EU], projectId: "p1", identity });
    expect(subs[1].statementId).toBeUndefined();
    expect(subs[1].errorKind).toBe("target-not-ready");
  });

  it("🔴🔴 句柄必须带 `targetId` —— 不带的话非 home 的结果永远取不回来(statementId 是 region 内的)", async () => {
    await submitToTargets({ sql: "SELECT 1", targets: [HOME, USW2], projectId: "p1", identity });
    expect(h.handles.map((x) => x.targetId)).toEqual([HOME, USW2]);
    expect(h.handles.every((x) => x.engine === "redshift")).toBe(true);
  });

  it("🔴 返回给浏览器的行**绝不含 secretArn / 用户名**(它会整包回前端)", async () => {
    const subs = await submitToTargets({ sql: "SELECT 1", targets: [HOME, USW2], projectId: "p1", identity });
    const dump = JSON.stringify(subs);
    expect(dump, "凭证 ARN 出站 ⇒ 会落进浏览器历史与截图").not.toContain("arn:");
    for (const s of subs) {
      expect(Object.keys(s)).not.toContain("secretArn");
      expect(["per-project", "shared-admin", "worker-iam"]).toContain(s.credential);
    }
  });

  it("🔴 zero-etl 独立 namespace 仍用它自己的 admin 密钥(既有语义一字不动)", async () => {
    h.bindings[HOME] = { region: "us-east-1", workgroup: "bgp-zeroetl-wg", database: "dev", secretArn: "arn:home" };
    await submitToTargets({ sql: "SELECT 1", targets: [HOME], projectId: "p1", identity });
    expect(h.sent[0].SecretArn, "用主 namespace 的密钥打 zero-etl ⇒ FATAL password authentication failed").toBe(
      "arn:zeroetl"
    );
  });
});

describe("🔴 错误归类:平台自家错误按 `reason` 判,不按文案判", () => {
  it("TargetBindingRejected 的 reason 各自映到对的类(原跨法域专用错误类已删,不设法务门)", () => {
    expect(classifySubmitError(new TargetBindingRejected("missing-component", "x")).kind).toBe("target-not-ready");
    expect(classifySubmitError(new TargetBindingRejected("warehouse-conflict", "x")).kind).toBe("warehouse-conflict");
    expect(classifySubmitError(new TargetBindingRejected("no-credential", "x")).kind).toBe("credential-missing");
    expect(classifySubmitError(new TargetBindingRejected("project-not-allowed", "未授权给项目 p")).kind).toBe("target-not-ready");
    expect(classifySubmitError(new TargetBindingRejected("invalid-target", "属跨法域(jurisdiction=eu)")).kind).toBe("target-not-ready");
  });

  it("🔴 改文案不该改变归类(判据是 reason 字段;文案是给人看的、经常改)", () => {
    const a = classifySubmitError(new TargetBindingRejected("no-credential", "解析不到凭证"));
    const b = classifySubmitError(new TargetBindingRejected("no-credential", "完全不同的文案 xyz"));
    expect(a.kind).toBe(b.kind);
  });

  it("引擎错误按文本归类,而且**匹配不上也要给原文 + hint**(降级安全)", () => {
    expect(classifyEngineError('relation "public.orders" does not exist').kind).toBe("table-missing");
    expect(classifyEngineError("permission denied for relation orders").kind).toBe("permission-denied");
    expect(classifyEngineError("Statement timed out").kind).toBe("timeout");
    expect(classifyEngineError("syntax error at or near SELEC").kind).toBe("syntax");
    const other = classifyEngineError("某种从没见过的错误");
    expect(other.kind).toBe("other");
    expect(other.hint, "归类漏了就连建议都没有 ⇒ 用户只看到一句看不懂的报错").toBeTruthy();
  });

  it("每一类都有一句**可执行**的处置建议(不是复述错误)", () => {
    for (const raw of ['relation "x" does not exist', "permission denied", "timed out", "syntax error"]) {
      const c = classifyEngineError(raw);
      expect(c.hint.length).toBeGreaterThan(8);
      expect(c.hint, "hint 只是把错误重复一遍 ⇒ 等于没有").not.toBe(raw);
    }
  });
});

// 原「跨法域:合并必须被禁」describe 整块**已删**(DESIGN §18 决策 6quinquies:不设法务门;合并对跨法域可用,查询已审计)。
