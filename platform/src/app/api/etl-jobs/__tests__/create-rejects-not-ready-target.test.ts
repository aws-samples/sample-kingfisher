// @kf-batch 50-WP31-place-first-class 序 41 验收页面化(2026-10-23)—— 原硬门段 sls S-9neg(绑一个不可承接的区建作业 ⇒ 整体拒绝、
//   拒因点名该区、零产物)与 o1 E-157a-2 的写路径半边转到这里:页面造不出「注册了没装出来 / 缺调度组件」的真实载体(向导注册即部署;
//   产品没有摘组件 / 置 stale 按钮),硬门段原来靠 register API 直建 registered-only target 当载体(违反用户 10-14 红线 ②),现在删条;
//   承重不变量在这里钉。
// 只 mock 真外部(DDB / 审计 / 版本 / OM / 血缘)与注册表的强一致准入(`requireReadyTarget` 对 registered-only 抛 TargetNotReadyError,
//   用的是真实 registry 的同一个类与同一句话);`assertBindableTargetsForEngine` 与路由本体真跑(接缝不 mock)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs", EXECUTION_ENVS: "bgp-execution-envs" },
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: (cmd.input ?? {}) as Record<string, unknown> });
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireProject: vi.fn(async () => ({ identity: { username: "u", sub: "u" }, projectId: "proj-a", role: "editor" })) };
});
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/exec-env/registry");
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) =>
      id === "tgt_home"
        ? { targetId: "tgt_home", region: "us-east-1", ready: true, status: "active", components: ["core", "redshift", "airflow-serverless"] }
        : null
    ),
    // 非 home 走强一致准入:registered-only(resources 为空、未 ready)⇒ 抛 TargetNotReadyError(2026-09-20 真环境拒因原话形态)
    requireReadyTarget: vi.fn(async (id: string) => {
      throw new real.TargetNotReadyError(id, "描述符校验不通过:core 资源缺失:datalakeBucket, scriptsBucket, tableBucket, emrSecurityGroupId, athenaWorkgroup, glueRoleArn");
    }),
  };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/etl/job-service", () => ({ reconcileEtlJob: vi.fn(async (it: unknown) => it) }));

import { POST } from "../route";

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("https://x.test/api/etl-jobs", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  sent.length = 0;
});

describe("新建 ETL 作业绑一个不可承接的区 ⇒ 整体拒绝、拒因点名该区、零产物(原硬门 sls S-9neg / o1 E-157a-2 写路径)", () => {
  it("targets 含 registered-only 的 tgt_usw1_a ⇒ 409 CONFLICT、报文点名 tgt_usw1_a 与缺什么、**没有**往 bgp-etl-jobs 写任何行(不做「能绑的先绑上」)", async () => {
    const res = await post({ name: "s9neg", type: "redshift", script: "SELECT 1;", targets: ["tgt_home", "tgt_usw1_a"] });
    // 真实形态(2026-09-20 真环境勘定同口径):assertBindableTargets 把 TargetNotReadyError 收成 TargetBindingRejected ⇒ 409 CONFLICT,
    //   报文「以下执行目标不可绑定,已整体拒绝(不做"能绑的先绑上"…):tgt_usw1_a(执行目标不可用:… core 资源缺失:…)」
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("tgt_usw1_a");
    expect(body.error.message).toContain("整体拒绝");
    expect(body.error.message).toMatch(/core 资源缺失/);
    expect(sent.filter((s) => s.name === "PutCommand"), "整体拒绝 ⇒ 不许留下作业行").toEqual([]);
  });
  it("正控制:只绑主控区 ⇒ 建成(bgp-etl-jobs 恰一次 PutCommand,targets 归一为 [tgt_home])", async () => {
    const res = await post({ name: "s9pos", type: "redshift", script: "SELECT 1;", targets: ["tgt_home"] });
    expect(res.status).toBe(201);
    const puts = sent.filter((s) => s.name === "PutCommand" && s.input.TableName === "bgp-etl-jobs");
    expect(puts.length).toBe(1);
    expect((puts[0].input.Item as Record<string, unknown>).targets).toEqual(["tgt_home"]);
  });
});
