// 2026-11-03 客户手册截图(2.1.2):离线计算「新建」弹窗建出的 Glue 作业,表单常量是 6.0,打开后版本框却回写 5.1
//   —— 新建请求根本不带 glueConfig,行里「没存版本」,打开时按存量口径(GLUE_VERSION_FOR_UNVERSIONED_RECORDS)回写。
//   修 = 新建落库即写版本(单一作者 lib/sync/glue-version.ts glueVersionForNewRecord):没给 ⇒ 新缺省;给了就校验;非法 ⇒ 400 不落库。
// 只 mock 真外部(DDB / 审计 / 版本 / OM / 血缘 / 表桶路由解析);路由本体与版本单一作者真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GLUE_VERSION_DEFAULT, GLUE_VERSION_FOR_UNVERSIONED_RECORDS } from "@/lib/sync/glue-version";

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
      id === "tgt_home" ? { targetId: "tgt_home", region: "us-east-1", ready: true, status: "active", components: ["core", "redshift", "airflow-serverless"] } : null
    ),
    requireReadyTarget: vi.fn(async (id: string) => ({ targetId: id, region: "us-east-1", ready: true, status: "active" })),
  };
});
// 表桶路由解析读注册表 / 路由表(真外部)⇒ 替身:空声明 = 该区无额外路由、无缺省目录;其余函数真跑(normalize / 预算 / 手写目录判定)。
vi.mock("@/lib/lake/job-declaration", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/lake/job-declaration");
  return { ...real, checkLakeDeclarationForTargets: vi.fn(async () => ({ notices: [] })), resolveJobLakeRoutes: vi.fn(async () => ({ selected: [], defaultAlias: undefined })) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSqlLineageToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/etl/job-service", () => ({ reconcileEtlJob: vi.fn(async (it: unknown) => it) }));

import { POST } from "../route";

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("https://x.test/api/etl-jobs", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const putItem = () => sent.find((s) => s.name === "PutCommand")?.input.Item as Record<string, any> | undefined;

beforeEach(() => {
  sent.length = 0;
});

describe("新建 Glue 作业落库即带 Glue 版本(表单常量与行为一致)", () => {
  it("页面「新建」的请求形态(name / type / script / targets,不带 glueConfig)⇒ 行上 glueConfig.glueVersion == GLUE_VERSION_DEFAULT,不再留「没存版本」的行", async () => {
    const res = await post({ name: "新作业", type: "glue", script: "print(1)", targets: ["tgt_home"] });
    expect(res.status, await res.text().catch(() => "")).toBe(201);
    const item = putItem();
    expect(item?.glueConfig?.glueVersion).toBe(GLUE_VERSION_DEFAULT);
    expect(GLUE_VERSION_DEFAULT, "新缺省不是存量回落值,否则这条判据没有判别力").not.toBe(GLUE_VERSION_FOR_UNVERSIONED_RECORDS);
  });
  it("客户端显式给了清单内版本(5.1)⇒ 照存,不被新缺省顶掉", async () => {
    const res = await post({ name: "旧版作业", type: "glue", script: "print(1)", targets: ["tgt_home"], glueConfig: { workerType: "G.1X", numberOfWorkers: 2, glueVersion: GLUE_VERSION_FOR_UNVERSIONED_RECORDS } });
    expect(res.status).toBe(201);
    expect(putItem()?.glueConfig?.glueVersion).toBe(GLUE_VERSION_FOR_UNVERSIONED_RECORDS);
    expect(putItem()?.glueConfig?.workerType).toBe("G.1X");
  });
  it("清单外版本(9.9)⇒ 400 VALIDATION_FAILED、零落库(不替用户猜)", async () => {
    const res = await post({ name: "坏版本", type: "glue", script: "print(1)", targets: ["tgt_home"], glueConfig: { glueVersion: "9.9" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toContain("9.9");
    expect(sent.filter((s) => s.name === "PutCommand")).toEqual([]);
  });
  it("Redshift 作业不碰 glueConfig(没有 Glue 版本概念)", async () => {
    const res = await post({ name: "sql", type: "redshift", script: "SELECT 1;", targets: ["tgt_home"] });
    expect(res.status).toBe(201);
    expect(putItem()).not.toHaveProperty("glueConfig");
  });
});
