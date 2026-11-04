// @kf-batch 56-B127-exec-env-own-table-bucket —— 建任务 / 改任务对「自带 Table Bucket」的准入(路由层行为判据)。
//   mock 形态照抄 s3-overwrite-guard-route.test.ts 的真外部边界(DDB、身份、注册表、审计 / 版本 / 血缘);**不** mock lib/sync/table-bucket
//   与 data-plane-target(落点从注册表描述符真解析)—— 要钉的就是「保存路由真接上了这份判定」。
//   任务都用 writeMode=append(不整表清空 ⇒ 不走 S3 Tables 探表,免得把 B-60 的夹具再搬一份)。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    ddb: [] as string[],
    puts: [] as Record<string, any>[],
    updates: [] as Record<string, any>[],
    registered: new Map<string, string[]>(),
    task: {} as Record<string, unknown>,
    ds: {} as Record<string, unknown>,
    targets: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources", SETTINGS: "bgp-settings", EXECUTION_ENVS: "bgp-execution-envs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name as string;
      h.ddb.push(n);
      if (n === "GetCommand") return { Item: cmd.input?.Key?.datasourceId ? h.ds : h.task };
      if (n === "PutCommand") { h.puts.push(cmd.input.Item); return {}; }
      if (n === "UpdateCommand") { h.updates.push(cmd.input); return { Attributes: { ...h.task } }; }
      if (n === "QueryCommand" && cmd.input.TableName === "bgp-settings") {
        const prefix = String(cmd.input.ExpressionAttributeValues[":prefix"]);
        const tid = prefix.replace(/^lake-ext-bucket#/, "").replace(/#$/, "");
        return { Items: (h.registered.get(tid) ?? []).map((b) => ({ pk: "settings", sk: `${prefix}${b}`, targetId: tid, bucket: b, region: "us-west-2", addedBy: "admin", addedAt: "2026-10-27T00:00:00.000Z" })) };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ identity: { username: "admin", sub: "s" }, projectId: "p1", role: "editor" })),
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
  projectFilter: vi.fn(() => ({ clause: "1=1", values: {} })),
  getActiveEnv: vi.fn(() => "dev"),
  envFilter: vi.fn(() => ({ clause: "1=1", values: {} })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ generateSyncLineage: vi.fn(async () => {}), recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = await orig<typeof import("@/lib/exec-env/registry")>();
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => h.targets.get(id) ?? null),
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets.get(id);
      if (!t) throw new real.TargetNotReadyError(id, "not-registered");
      return t;
    }),
    descriptorViolation: vi.fn(() => null),
  };
});

import { resourceName } from "@/lib/aws/naming";
import { DATASOURCE_OWNER_TARGET_ATTR } from "@/lib/datasource/placement-shared";

const ACCOUNT = "123456789012";
const USW2 = "tgt_usw2_a";
const PLATFORM = resourceName("tableBucket", { targetId: USW2, account: ACCOUNT });

const req = async (mod: string, body: Record<string, unknown>, method = "POST", params?: Record<string, string>) => {
  const m: any = await import(mod);
  const { NextRequest } = await import("next/server");
  const r = new NextRequest("http://x/api/sync", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await m[method](r, params ? { params } : undefined);
  return { status: res.status, body: await res.json() };
};
const base = { name: "t", datasourceId: "D2", targetType: "s3-tables", channel: "glue", syncMode: "full", writeMode: "append", sourceDatabase: "gamedata", sourceTables: ["Orders"] };

beforeEach(() => {
  h.ddb.length = 0; h.puts.length = 0; h.updates.length = 0; h.registered.clear(); h.targets.clear();
  h.ds = { userId: "default-user", datasourceId: "D2", type: "mysql", database: "gamedata", projectId: "p1", [DATASOURCE_OWNER_TARGET_ATTR]: USW2 };
  h.targets.set(USW2, {
    targetId: USW2, region: "us-west-2", accountId: ACCOUNT, partition: "aws", status: "active", ready: true, components: ["core", "redshift"],
    resources: {
      scriptsBucket: resourceName("scriptsBucket", { targetId: USW2, account: ACCOUNT }),
      glueRoleArn: `arn:aws:iam::${ACCOUNT}:role/${resourceName("glueRole", { targetId: USW2, account: ACCOUNT })}`,
      datalakeBucket: resourceName("datalakeBucket", { targetId: USW2, account: ACCOUNT }),
      tableBucket: PLATFORM,
    },
  });
  h.targets.set("tgt_home", { targetId: "tgt_home", region: "us-east-1", accountId: ACCOUNT, partition: "aws", status: "active", ready: true, components: ["core"], resources: {} });
  vi.resetModules();
});

describe("🔴 B-127 建任务 POST /api/sync:非主控区自带 Table Bucket 的准入", () => {
  it("未登记的自有桶 ⇒ 400 VALIDATION_FAILED,文案点名桶 / 平台表桶 / 去登记;零落库", async () => {
    const r = await req("../route", { ...base, s3Config: { tableBucket: "cust-own" } });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
    expect(r.body.error.message).toContain(`执行环境 ${USW2} 不能写入表桶「cust-own」`);
    expect(r.body.error.message).toContain(`平台表桶「${PLATFORM}」`);
    expect(r.body.error.message).toContain("系统设置 → 数据湖外部表桶");
    expect(h.puts).toHaveLength(0);
  });

  it("已登记的自有桶 ⇒ 201,任务带着该桶落库(章 = 源所在执行环境)", async () => {
    h.registered.set(USW2, ["cust-own"]);
    const r = await req("../route", { ...base, s3Config: { tableBucket: "cust-own" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].s3Config).toEqual({ tableBucket: "cust-own" });
    expect(h.puts[0].targets).toEqual([USW2]);
  });

  it("自带 == 该执行环境的平台表桶 ⇒ 201,且不读登记表(便宜路径)", async () => {
    const r = await req("../route", { ...base, s3Config: { tableBucket: PLATFORM } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.ddb.filter((x) => x === "QueryCommand")).toHaveLength(0);
  });

  it("留空(推荐路径)⇒ 201,不读登记表", async () => {
    const r = await req("../route", { ...base });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.ddb.filter((x) => x === "QueryCommand")).toHaveLength(0);
  });

  it("主控区任务 + 未登记自有桶 ⇒ 201(主控区行为不变)", async () => {
    h.ds = { ...h.ds, [DATASOURCE_OWNER_TARGET_ATTR]: "tgt_home" };
    const r = await req("../route", { ...base, s3Config: { tableBucket: "cust-own" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("不写 S3 Tables(targetType=redshift)的任务带着陈旧的 s3Config.tableBucket ⇒ 不校验、201", async () => {
    const r = await req("../route", { ...base, targetType: "redshift", redshiftConfig: { schema: "public" }, s3Config: { tableBucket: "cust-own" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.ddb.filter((x) => x === "QueryCommand")).toHaveLength(0);
  });
});

describe("🔴 B-127 改任务 PUT /api/sync/[id]", () => {
  it("把 Table Bucket 改成未登记的自有桶 ⇒ 400,不写库;改成已登记 ⇒ 200", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", targets: [USW2] };
    const bad = await req("../[id]/route", { s3Config: { tableBucket: "cust-own" } }, "PUT", { id: "T1" });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(bad.body.error.message).toContain("系统设置 → 数据湖外部表桶");
    expect(h.updates).toHaveLength(0);
    h.registered.set(USW2, ["cust-own"]);
    const ok = await req("../[id]/route", { s3Config: { tableBucket: "cust-own" } }, "PUT", { id: "T1" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(h.updates).toHaveLength(1);
  });

  it("存量任务已带已登记的自有桶,只改名字 ⇒ 200(按改完之后的整条任务判,仍放行)", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", targets: [USW2], s3Config: { tableBucket: "cust-own" } };
    h.registered.set(USW2, ["cust-own"]);
    const r = await req("../[id]/route", { name: "renamed" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("存量任务带自有桶、登记后来被撤销 ⇒ 任何保存都 400 指路(任务本来也跑不起来,不假装保存成功)", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", targets: [USW2], s3Config: { tableBucket: "cust-own" } };
    const r = await req("../[id]/route", { name: "renamed" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(h.updates).toHaveLength(0);
  });
});
