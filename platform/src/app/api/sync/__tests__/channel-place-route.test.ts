// 「通道 × 执行区」规则的三个消费者真的接上了(路由层行为判据):
//   通道推荐路由(向导据此置灰)· 新建 POST /api/sync 与修改 PUT /api/sync/[id] 的保存校验 · Copilot 建同步草稿。
//   2026-11 之前:执行区的数据源选 Zero-ETL 能存、点「启动」才被拒。现在:推荐里标不支持并写明原因,保存即拒、一行不落库。
//   mock 形态与同目录的 table-bucket-guard-route.test.ts 一样,只在真外部边界(DDB、身份、注册表、审计 / 版本 / 血缘);
//   lib/sync/channel-place 与落点绑定(数据源行 → 任务的执行区)真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  return {
    puts: [] as Record<string, any>[],
    updates: [] as Record<string, any>[],
    task: {} as Record<string, unknown>,
    /** 「数据库里」的数据源行(按 datasourceId) */
    datasources: new Map<string, Record<string, unknown>>(),
    targets: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources", SETTINGS: "bgp-settings", EXECUTION_ENVS: "bgp-execution-envs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name as string;
      // 改配置前路由先核这条任务有没有被「停止 / 删除」长操作占着:这里没人占
      if (n === "GetCommand" && String(cmd.input?.Key?.taskId ?? "").startsWith("lease#")) return {};
      if (n === "GetCommand") {
        if (cmd.input?.Key?.datasourceId) return { Item: h.datasources.get(cmd.input.Key.datasourceId) };
        return { Item: h.task };
      }
      if (n === "PutCommand") { if (cmd.input.TableName === "bgp-sync-tasks") h.puts.push(cmd.input.Item); return {}; }
      if (n === "UpdateCommand") { if (cmd.input.TableName === "bgp-sync-tasks") h.updates.push(cmd.input); return { Attributes: { ...h.task } }; }
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

import { DATASOURCE_OWNER_TARGET_ATTR } from "@/lib/datasource/placement-shared";

const ACCOUNT = "123456789012";
const WEST = "tgt_usw2";

const req = async (mod: string, body: Record<string, unknown>, method = "POST", params?: Record<string, string>) => {
  const m: any = await import(mod);
  const { NextRequest } = await import("next/server");
  const r = new NextRequest("http://x/api/sync", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await m[method](r, params ? { params } : undefined);
  return { status: res.status, body: await res.json() };
};
/** 向导建一条写数仓的增量任务时发来的最小请求体。 */
const base = { name: "orders-cdc", datasourceId: "D_WEST", targetType: "redshift", syncMode: "incremental", writeMode: "append", sourceDatabase: "gamedata", sourceTables: ["orders"] };

beforeEach(() => {
  h.puts.length = 0; h.updates.length = 0; h.datasources.clear(); h.targets.clear(); h.task = {};
  // 数据源行:执行区的带归属章;主控区的存量行没有章
  h.datasources.set("D_WEST", { userId: "default-user", datasourceId: "D_WEST", type: "mysql", database: "gamedata", projectId: "p1", [DATASOURCE_OWNER_TARGET_ATTR]: WEST });
  h.datasources.set("D_HOME", { userId: "default-user", datasourceId: "D_HOME", type: "mysql", database: "gamedata", projectId: "p1" });
  h.targets.set(WEST, { targetId: WEST, region: "us-west-2", accountId: ACCOUNT, partition: "aws", status: "active", ready: true, components: ["core", "redshift", "dms"], resources: {} });
  h.targets.set("tgt_home", { targetId: "tgt_home", region: "us-east-1", accountId: ACCOUNT, partition: "aws", status: "active", ready: true, components: ["core"], resources: {} });
  vi.resetModules();
});

describe("通道推荐 POST /api/sync/recommend-channel:带上数据源就按它所在的执行区过一遍", () => {
  const ask = (body: Record<string, unknown>) => req("../recommend-channel/route", { sourceType: "mysql", targetType: "redshift", syncMode: "incremental", ...body });

  it("不带数据源 ⇒ 只按源 / 目标 / 模式给(不替它假设一个区):推荐 Zero-ETL", async () => {
    const r = await ask({});
    expect(r.status).toBe(200);
    expect(r.body.data.recommended).toBe("zero-etl");
  });

  it("主控区的数据源 ⇒ 与不带时相同", async () => {
    const plain = await ask({});
    const home = await ask({ datasourceId: "D_HOME" });
    expect(home.body.data).toEqual(plain.body.data);
  });

  it("执行区的数据源 ⇒ Zero-ETL 不支持并写明原因(向导置灰用的就是这句),推荐改成 DMS", async () => {
    const r = await ask({ datasourceId: "D_WEST" });
    expect(r.status).toBe(200);
    expect(r.body.data.recommended).toBe("dms");
    const z = r.body.data.options.find((o: { channel: string }) => o.channel === "zero-etl");
    expect(z.supported).toBe(false);
    expect(z.reason).toContain("只在主控区提供");
    expect(z.reason).toContain(WEST);
    expect(r.body.data.options.find((o: { channel: string }) => o.channel === "dms")).toMatchObject({ supported: true, recommended: true });
  });

  it("落点由服务端读数据源行得出,不信请求体里自报的执行区", async () => {
    const r = await ask({ datasourceId: "D_WEST", targetId: "tgt_home", targets: ["tgt_home"] });
    expect(r.body.data.recommended).toBe("dms");
  });

  it("数据源不存在 ⇒ 404;数据源的执行环境标记非法 ⇒ 400(都不回一份按主控区算的推荐)", async () => {
    const missing = await ask({ datasourceId: "D_NOPE" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    h.datasources.set("D_BAD", { userId: "default-user", datasourceId: "D_BAD", type: "mysql", [DATASOURCE_OWNER_TARGET_ATTR]: "not a target" });
    const bad = await ask({ datasourceId: "D_BAD" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("新建 POST /api/sync:选的通道在任务所在的执行区不提供 ⇒ 保存即拒", () => {
  it("🔴 执行区的数据源 + Zero-ETL ⇒ 400 CHANNEL_NOT_AVAILABLE_IN_REGION,说明改用哪个通道;一行不落库(改动前:能存,点启动才被拒)", async () => {
    const r = await req("../route", { ...base, channel: "zero-etl" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe("CHANNEL_NOT_AVAILABLE_IN_REGION");
    expect(r.body.error.message).toContain("只在主控区提供");
    expect(r.body.error.message).toContain("DMS");
    expect(r.body.error.message).toContain("任务未保存");
    expect(r.body.error.detail).toEqual({ channel: "zero-etl", targetId: WEST });
    expect(h.puts).toHaveLength(0);
  });

  it("执行区的数据源 + DMS ⇒ 201,任务绑定在数据源所在的执行区", async () => {
    const r = await req("../route", { ...base, channel: "dms" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]).toMatchObject({ channel: "dms", targets: [WEST] });
  });

  it("主控区的数据源 + Zero-ETL ⇒ 201(主控区照旧提供)", async () => {
    const r = await req("../route", { ...base, datasourceId: "D_HOME", channel: "zero-etl" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.puts[0]).toMatchObject({ channel: "zero-etl", targets: ["tgt_home"] });
  });
});

describe("修改 PUT /api/sync/[id]:只在这次把通道改成了该区不提供的那一种时才拒", () => {
  const stored = (over: Record<string, unknown> = {}) => ({ ...base, userId: "default-user", taskId: "T1", projectId: "p1", status: "draft", channel: "dms", targets: [WEST], ...over });

  it("🔴 执行区的任务把通道改成 Zero-ETL ⇒ 400「任务未改」,不写库", async () => {
    h.task = stored();
    const r = await req("../[id]/route", { channel: "zero-etl" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe("CHANNEL_NOT_AVAILABLE_IN_REGION");
    expect(r.body.error.message).toContain("任务未改");
    expect(r.body.error.detail).toEqual({ channel: "zero-etl", targetId: WEST });
    expect(h.updates).toHaveLength(0);
  });

  it("执行区的任务把通道从 Glue 改成 DMS ⇒ 200", async () => {
    h.task = stored({ channel: "glue", syncMode: "full" });
    const r = await req("../[id]/route", { channel: "dms", syncMode: "incremental" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.updates).toHaveLength(1);
  });

  it("存量:执行区里早就存下的 Zero-ETL 任务,这次只改名字(通道没动,或原样带回)⇒ 200,不因它保存不了", async () => {
    h.task = stored({ channel: "zero-etl" });
    const rename = await req("../[id]/route", { name: "renamed" }, "PUT", { id: "T1" });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
    const same = await req("../[id]/route", { name: "renamed-2", channel: "zero-etl" }, "PUT", { id: "T1" });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(h.updates).toHaveLength(2);
  });

  it("主控区的任务改成 Zero-ETL ⇒ 200", async () => {
    h.task = stored({ datasourceId: "D_HOME", targets: ["tgt_home"] });
    const r = await req("../[id]/route", { channel: "zero-etl" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe("Copilot 建同步草稿:与页面新建同一条规则", () => {
  const caller = { projectId: "p1", env: "dev", username: "admin", targetId: "tgt_home" } as never;

  it("🔴 执行区的数据源 + Zero-ETL ⇒ 抛出同一句原因,不落草稿", async () => {
    const { createSyncDraft } = await import("@/lib/copilot/tools/create-service");
    await expect(createSyncDraft({ name: "d1", datasourceId: "D_WEST", channel: "zero-etl", syncMode: "incremental" }, caller)).rejects.toThrow(/只在主控区提供/);
    expect(h.puts).toHaveLength(0);
  });

  it("执行区的数据源 + DMS / 缺省通道 ⇒ 草稿落库,绑定在数据源所在的执行区(不是调用方视角的那个区)", async () => {
    const { createSyncDraft } = await import("@/lib/copilot/tools/create-service");
    await createSyncDraft({ name: "d2", datasourceId: "D_WEST", channel: "dms", syncMode: "incremental" }, caller);
    await createSyncDraft({ name: "d3", datasourceId: "D_WEST" }, caller);
    expect(h.puts.map((p) => [p.channel, p.targets])).toEqual([["dms", [WEST]], ["glue", [WEST]]]);
  });

  it("拿不到数据源行 ⇒ 按调用方面向的执行区判:面向执行区时 Zero-ETL 同样被拒", async () => {
    const { createSyncDraft } = await import("@/lib/copilot/tools/create-service");
    const west = { projectId: "p1", env: "dev", username: "admin", targetId: WEST } as never;
    await expect(createSyncDraft({ name: "d4", channel: "zero-etl", syncMode: "incremental" }, west)).rejects.toThrow(/只在主控区提供/);
    await createSyncDraft({ name: "d5", channel: "zero-etl", syncMode: "incremental" }, caller);
    expect(h.puts.map((p) => [p.channel, p.targets])).toEqual([["zero-etl", ["tgt_home"]]]);
  });
});
