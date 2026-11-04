// 🔴🔴 「撤不下来就不许动记录」这条不变量,在**三条路**上各自失效过一次:
//   ① `DELETE /api/etl-jobs/[id]`:注释写着「下线失败就不删行」,而 `offlineFanout` **从不抛**
//      (它的教训把失败写成 `failed` 行并刻意保留台账)⇒ 那个 try/catch 一条都拦不住,
//      行照删 ⇒ 那个区的 workflow 继续按 cron 跑,而 workflowArn 随行消失,平台再也找不到它;
//   ② `PUT /api/etl-jobs/[id]`(解绑):`offlineUnboundTargets` 把逐区结果**整个丢掉**只回名字
//      ⇒ 「被摘掉的区其实没撤下来」和成功长得一样(界面上已不绑它,它还在往自己的数仓写数);
//   ③ `DELETE /api/engines/emr-serverless/[id]`:**根本没有**下线这一步(ETL 侧早就有)。
// 🔴 只 mock 真外部(DDB / S3 / 调度器服务调用 / 落点解析),扇出与路由都真跑 —— 接缝正在被测。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ddb: [] as Array<{ ctor: string; input: Record<string, any> }>,
  offlineFail: false,
  offlinedServerless: [] as string[],
  job: {} as Record<string, unknown>,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand { constructor(public input: any) {} }
  class DeleteObjectCommand { constructor(public input: any) {} }
  class S3Client { async send() { return {}; } }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", ENGINE_JOBS: "bgp-engine-jobs", LONG_OPS: "bgp-long-ops" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push({ ctor: cmd.constructor.name, input: cmd.input });
      // 删引擎作业前先核对象租约(读 bgp-long-ops 的 lease 行)⇒ 没有租约 = 空,不能把作业行当租约回去
      if (cmd.input?.TableName === "bgp-long-ops") return {};
      return cmd.constructor.name === "GetCommand" ? { Item: h.job } : {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/etl/job-service", () => ({ deleteGlueJobs: vi.fn(async () => {}) }));
vi.mock("@/lib/scheduler/mwaa-offline", () => ({
  offlineDag: vi.fn(async (dagId: string, targetId: string) => ({ dagId, targetId, paused: true, dagFileDeleted: true })),
}));
vi.mock("@/lib/scheduler/serverless/publish", () => ({
  publishServerlessWorkflow: vi.fn(),
  offlineServerlessWorkflow: vi.fn(async ({ dagId }: { dagId: string }) => {
    if (h.offlineFail) throw new Error("还有 run 在跑,DeleteWorkflow 被拒");
    h.offlinedServerless.push(dagId);
    return { deleted: true, dagFileDeleted: true, stoppedRuns: 0 };
  }),
}));
vi.mock("@/lib/scheduler/mwaa-endpoint", () => ({
  serverlessEndpointFor: vi.fn(async (t: string) => ({ targetId: t, region: "us-west-2", kind: "serverless", workflowBucket: "b" })),
  schedulerEndpointFor: vi.fn(async (t: string) => ({ targetId: t, region: "us-west-2", kind: "serverless", workflowBucket: "b" })),
  isServerlessEndpoint: vi.fn(() => true),
  MwaaNotInstalled: class extends Error {},
  mwaaErrorResponse: vi.fn(),
  mwaaDagBucketOfHome: vi.fn(() => "home-bucket"),
  unpauseWhenLoaded: vi.fn(async () => {}),
}));
vi.mock("@/lib/exec-env/data-plane-target", () => ({
  bindingTargets: (j: { targets?: string[] }) => j.targets ?? [],
  resolveRedshiftBinding: vi.fn(async () => ({ home: true, workgroup: "wg", database: "db", secretArn: "arn:s" })),
  assertBindableTargetsForEngine: vi.fn(async (_engine: string, targets: string[]) => targets),
  assertBindableTargets: vi.fn(async (targets: string[]) => targets),
  TargetBindingRejected: class extends Error {},
}));
vi.mock("@/lib/exec-env/target-region", () => ({ regionOfTarget: vi.fn(async () => "us-west-2") }));
vi.mock("@/lib/exec-env/target-clients", () => ({ s3ClientFor: vi.fn(async () => ({ send: async () => ({}) })) }));

const USW2 = "tgt_usw2_a";
const scheduledJob = (extra: Record<string, unknown> = {}) => ({
  userId: "default-user", jobId: "J1", name: "j1", type: "redshift", projectId: "p1",
  targets: [USW2], scheduleEnabled: true, airflowDagId: "bgp_etl_J1",
  deployments: { [USW2]: { scheduler: "serverless", workflowArn: "arn:w", status: "ok" } },
  ...extra,
});
const deletes = () => h.ddb.filter((x) => x.ctor === "DeleteCommand");

beforeEach(() => { h.ddb.length = 0; h.offlinedServerless.length = 0; h.offlineFail = false; vi.resetModules(); });

describe("撤不下来就不许动记录(三条路)", () => {
  it("🔴 ETL 删作业:那个区撤不下来 ⇒ 502 且**不许删行**(先删行 = 永久孤儿,workflowArn 也没了)", async () => {
    h.job = scheduledJob(); h.offlineFail = true;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(new Request("http://x/api/etl-jobs/J1", { method: "DELETE" }) as never, { params: { id: "J1" } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain(USW2);
    expect(deletes()).toHaveLength(0);
  });

  it("ETL 删作业:都撤下来了 ⇒ 照常删行", async () => {
    h.job = scheduledJob();
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(new Request("http://x/api/etl-jobs/J1", { method: "DELETE" }) as never, { params: { id: "J1" } });
    expect(res.status).toBe(200);
    expect(h.offlinedServerless).toHaveLength(1);
    expect(deletes()).toHaveLength(1);
  });

  it("🔴 ETL 解绑(PUT):被摘掉的区撤不下来 ⇒ 502 且逐区拒因点名(原来静默当成解绑成功)", async () => {
    h.job = scheduledJob({ targets: ["tgt_home", USW2] }); h.offlineFail = true;
    const { PUT } = await import("../[id]/route");
    const res = await PUT(
      new Request("http://x/api/etl-jobs/J1", { method: "PUT", body: JSON.stringify({ targets: ["tgt_home"] }) }) as never,
      { params: { id: "J1" } }
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toContain(USW2);
  });

  it("🔴 引擎作业删除:先撤调度产物再删行(这条路原来完全没有下线这一步)", async () => {
    h.job = scheduledJob({ type: "emr-serverless" });
    const { DELETE } = await import("../../engines/[engine]/[id]/route");
    const res = await DELETE(
      new Request("http://x/api/engines/emr-serverless/J1", { method: "DELETE" }) as never,
      { params: { engine: "emr-serverless", id: "J1" } }
    );
    expect(res.status).toBe(200);
    expect(h.offlinedServerless, "删引擎作业没有撤它的调度产物 ⇒ 孤儿 DAG 继续按 cron 跑").toHaveLength(1);
    expect(deletes()).toHaveLength(1);
  });

  it("🔴 引擎作业删除:撤不下来 ⇒ 502 且**不许删行**", async () => {
    h.job = scheduledJob({ type: "emr-serverless" }); h.offlineFail = true;
    const { DELETE } = await import("../../engines/[engine]/[id]/route");
    const res = await DELETE(
      new Request("http://x/api/engines/emr-serverless/J1", { method: "DELETE" }) as never,
      { params: { engine: "emr-serverless", id: "J1" } }
    );
    expect(res.status).toBe(502);
    expect(deletes()).toHaveLength(0);
  });
});
