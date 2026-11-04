// 后一半(2026-10-11 真环境无头坐实):「缺 targetId ⇒ 400」对了,但「**不存在**的 targetId」仍静默回落主控区
//   `/api/flink/meta?targetId=tgt_nope_zz` ⇒ 200 + 主控区 region;模型目录 ⇒ 200 + 主控区 Bedrock 清单;
//   治理规则 / 分级 / 直查任务 / 直查历史 ⇒ 写下 `tgt_nope_zz` 的孤儿记录;列库 ⇒ 回主控区默认库名 `dev`;生成建表语句 ⇒ 200 降级。
// 根治 = 读 / 写元数据的入口点名一个**已注册且装好**的执行环境的唯一作者 `requestedRegisteredPlace`(不存在 ⇒ 409)。
//
// 只 mock 真外部:注册表(DDB 边界)· 身份 / 项目守卫 · DynamoDB(记下有没有写)· 模型目录的 Bedrock 侧(本文件只看落点交给了谁)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  targets: new Map<string, Record<string, unknown>>(),
  writes: [] as string[],
  catalogPlaces: [] as unknown[],
  violations: new Map<string, string>(),
}));

vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => h.targets.get(id) ?? null),
    // 整包校验的细节由 registry 自己的单测钉;这里只看「校验不过 ⇒ 409」这条接线(夹具不必凑齐整个 core 袋)
    descriptorViolation: vi.fn((_t: unknown, id: string) => h.violations.get(id) ?? null),
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets.get(id);
      if (!t) throw new real.TargetNotReadyError(id, "注册表里没有该描述符(未注册 / 已删除)");
      return t;
    }),
  };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: new Proxy({}, { get: (_t, k) => String(k) }),
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string } }) => {
      const n = cmd.constructor.name;
      if (/Put|Update|Delete|TransactWrite/.test(n)) h.writes.push(n);
      return { Items: [] };
    }),
  },
}));
vi.mock("@/lib/auth/identity", async (orig) => ({
  ...((await orig()) as object),
  resolveIdentity: vi.fn(async () => ({ username: "admin", sub: "s", isPlatformAdmin: true, groups: ["bgp-admin"] })),
}));
vi.mock("@/lib/projects/guard", async (orig) => ({
  ...((await orig()) as object),
  requireProject: vi.fn(async () => ({ projectId: "p1", identity: { username: "u", sub: "s" } })),
  getActiveProjectId: () => "p1",
  getActiveEnv: () => "dev",
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}), auditActorFromRequest: () => "admin" }));
vi.mock("@/lib/settings/model-catalog", () => ({
  fetchCatalog: vi.fn(async (opts: { place: unknown }) => {
    h.catalogPlaces.push(opts.place);
    return [];
  }),
}));

import { requestedRegisteredPlace, viewabilityVerdict } from "../resolve";
import { PlaceUnavailable, PlaceUndecidable } from "../types";

const ACCT = "000000000000";
const desc = (targetId: string, region: string, extra: Record<string, unknown> = {}) => ({
  pk: "env", sk: targetId, targetId, region, accountId: ACCT, partition: "aws", version: 1,
  status: "active", ready: true, components: ["core", "redshift", "flink"],
  resources: {
    scriptsBucket: `bgp-glue-scripts-${ACCT}-x`, datalakeBucket: `bgp-datalake-${ACCT}-x`, tableBucket: "tb-x",
    flinkRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-${targetId.replace(/_/g, "-")}-flink-role`, emrSubnetIds: ["subnet-w1"], emrSecurityGroupId: "sg-w",
  },
  ...extra,
});

beforeEach(() => {
  h.targets.clear();
  h.writes.length = 0;
  h.catalogPlaces.length = 0;
  h.violations.clear();
  h.targets.set("tgt_usw2_a", desc("tgt_usw2_a", "us-west-2"));
});

describe("requestedRegisteredPlace:点名 + 已注册 + 装好(唯一作者)", () => {
  it("缺 / 非法 ⇒ 400 PlaceUndecidable;不存在 / 已删除 / 没装好 ⇒ 409 PlaceUnavailable", async () => {
    await expect(requestedRegisteredPlace(undefined, "t")).rejects.toBeInstanceOf(PlaceUndecidable);
    await expect(requestedRegisteredPlace("us-west-2", "t")).rejects.toBeInstanceOf(PlaceUndecidable);
    await expect(requestedRegisteredPlace("tgt_nope_zz", "t")).rejects.toBeInstanceOf(PlaceUnavailable);
    h.targets.set("tgt_gone_a", desc("tgt_gone_a", "us-west-2", { status: "deleted" }));
    await expect(requestedRegisteredPlace("tgt_gone_a", "t")).rejects.toThrow(/已删除/);
    h.targets.set("tgt_half_a", desc("tgt_half_a", "us-west-2", { ready: false, status: "initializing" }));
    await expect(requestedRegisteredPlace("tgt_half_a", "t")).rejects.toThrow(/尚未装好/);
    h.violations.set("tgt_usw2_a", "core 资源缺失:athenaWorkgroup");
    await expect(requestedRegisteredPlace("tgt_usw2_a", "t")).rejects.toThrow(/描述符不合格/);
  });

  it("存在且装好 ⇒ 位置事实全部来自描述符", async () => {
    const p = await requestedRegisteredPlace("tgt_usw2_a", "t");
    expect(p).toMatchObject({ targetId: "tgt_usw2_a", region: "us-west-2", home: false, source: "descriptor" });
  });

  it("🔴 「能看」不是「能承接」:装好了但暂不承接(排空)仍然能看", async () => {
    h.targets.set("tgt_drain_a", desc("tgt_drain_a", "us-west-2", { status: "draining" }));
    expect(viewabilityVerdict(h.targets.get("tgt_drain_a") as any, null)).toBeNull();
  });

  it("「能看」只有一个作者:顶栏下拉(listScopeTargets)用的是同一个函数", () => {
    const src = readFileSync(resolve(__dirname, "../../exec-env/data-plane-target.ts"), "utf8");
    expect(src).toMatch(/\.filter\(\(t\) => viewabilityVerdict\(t, descriptorViolation\(t, t\.targetId\)\) === null\)/);
  });
});

describe("🔴🔴 入口:不存在的 targetId ⇒ 409,不回主控区的值、不写孤儿记录", () => {
  const NOPE = "tgt_nope_zz";
  const post = (path: string, body: unknown, method = "POST") =>
    new NextRequest(`http://x${path}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

  it("/api/flink/meta:不存在 ⇒ 409(原来 200 + 主控区 region);存在 ⇒ region / 子网来自那个区的描述符", async () => {
    const { GET } = await import("@/app/api/flink/meta/route");
    const bad = await GET(new NextRequest(`http://x/api/flink/meta?targetId=${NOPE}`));
    expect(bad.status).toBe(409);
    const badBody = await bad.json();
    expect(badBody.error?.code).toBe("PLACE_UNAVAILABLE");
    expect(JSON.stringify(badBody), "失败信封里不许出现任何区域事实").not.toMatch(/"region"|subnetIds/);
    const ok = await GET(new NextRequest(`http://x/api/flink/meta?targetId=tgt_usw2_a`));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ region: "us-west-2", targetId: "tgt_usw2_a", subnetIds: ["subnet-w1"] });
  });

  it("/api/flink/meta:存在但 Flink 落点解析不开(没装 flink)⇒ 409,不回主控区子网", async () => {
    h.targets.set("tgt_noflink_a", desc("tgt_noflink_a", "us-west-2", { components: ["core"] }));
    const { GET } = await import("@/app/api/flink/meta/route");
    const r = await GET(new NextRequest(`http://x/api/flink/meta?targetId=tgt_noflink_a`));
    expect(r.status).toBe(409);
  });

  it("/api/admin/model-config/catalog:不存在 ⇒ 409 且不拉目录;存在 ⇒ 目录拿到**那个区**的落点", async () => {
    const { GET } = await import("@/app/api/admin/model-config/catalog/route");
    const bad = await GET(new NextRequest(`http://x/api/admin/model-config/catalog?targetId=${NOPE}`));
    expect(bad.status).toBe(409);
    expect(h.catalogPlaces).toEqual([]);
    const ok = await GET(new NextRequest(`http://x/api/admin/model-config/catalog?targetId=tgt_usw2_a`));
    expect(ok.status).toBe(200);
    expect(h.catalogPlaces).toEqual([expect.objectContaining({ targetId: "tgt_usw2_a", region: "us-west-2" })]);
  });

  it("/api/redshift/databases:不存在 ⇒ 409(原来回主控区默认库名 dev)", async () => {
    const { GET } = await import("@/app/api/redshift/databases/route");
    const r = await GET(new NextRequest(`http://x/api/redshift/databases?targetId=${NOPE}`));
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain('"dev"');
  });

  it("写元数据的四个入口:不存在 ⇒ 409 且**零写入**(原来写下孤儿记录)", async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ["治理规则", async () => (await import("@/app/api/governance/quality-rules/route")).POST(post("/api/governance/quality-rules", { fqn: "svc.db.s.t", type: "not_null", column: "a", targetId: NOPE }))],
      ["数据分级", async () => (await import("@/app/api/governance/classification/route")).PUT(post("/api/governance/classification", { fqn: "svc.db.s.t", level: "L2", targetId: NOPE }, "PUT"))],
      ["直查任务", async () => (await import("@/app/api/redshift/tasks/route")).POST(post("/api/redshift/tasks", { name: "t", sql: "select 1", targetId: NOPE }))],
      ["直查历史", async () => (await import("@/app/api/redshift/history/route")).POST(post("/api/redshift/history", { sql: "select 1", status: "ok", targetId: NOPE }))],
    ];
    for (const [what, call] of cases) {
      h.writes.length = 0;
      const r = await call();
      expect(r.status, what).toBe(409);
      expect(h.writes, `${what} 不许写`).toEqual([]);
    }
  });

  it("/api/sync/generate-ddl:不存在 ⇒ 409(原来 200 降级、不说为什么)", async () => {
    const { POST } = await import("@/app/api/sync/generate-ddl/route");
    const r = await POST(post("/api/sync/generate-ddl", { targetId: NOPE, table: "t", columns: [{ name: "a", type: "int" }] }));
    expect(r.status).toBe(409);
  });
});
