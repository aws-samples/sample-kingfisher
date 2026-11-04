// @kf-batch 50-WP18-flink-multi-region
// 实时计算「一次提交 → 每个区各建一个作业」的**行为**判据。
//
// 🔴 为什么必须是行为而不是文本:第一版只在 `flink-place.test.ts` 里断了源码里有那几个字符串,
//    结果两个变异**当场存活** —— ①「多区退回只建一个」②「把跨区取数守卫整段关掉」都照绿。
//    文本判据看不见行为(见记忆 mock-hides-the-seam / 变异不能创造判据本来没有的观察力)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const puts: Array<Record<string, any>> = [];
const DS: Record<string, Record<string, unknown> | undefined> = {};

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { FLINK_JOBS: "flink", DATASOURCES: "ds" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, any> }) => {
      const input = cmd.input ?? {};
      if (input.Item) { puts.push(input.Item); return {}; }
      if (input.Key?.datasourceId) return { Item: DS[String(input.Key.datasourceId)] };
      return { Items: [] };
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ projectId: "p1", identity: { username: "admin", sub: "s1" } })),
  projectFilter: vi.fn(() => ({ clause: "1=1", values: {} })),
  getActiveEnv: vi.fn(() => "dev"),
  envFilter: vi.fn(() => ({ clause: "1=1", values: {} })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
// @kf-batch 50-WP31-place-first-class —— 新建侧的真解析改走启动侧同一个作者 `resolveFlinkPlace`(主控区也读描述符)
const unresolvable = new Set<string>();
vi.mock("@/lib/realtime/flink-place", () => ({
  resolveFlinkPlace: vi.fn(async (t: string) => {
    if (unresolvable.has(t)) throw new Error(`执行环境 ${t} 没有装 flink 组件`);
    return { targetId: t, region: "us-west-2" };
  }),
}));
vi.mock("@/lib/exec-env/data-plane-target", () => ({
  assertBindableTargets: vi.fn(async () => {}),
}));
vi.mock("@/lib/exec-env/scope", () => ({
  requireScope: vi.fn(async () => ({ kind: "global" })),
  filterRowsByScope: vi.fn((rows: unknown) => rows),
}));

const post = async (body: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/flink/jobs/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://x/api/flink/jobs", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
// 🔴 SQL 必须含 INSERT INTO(否则没有 sink,路由当场 400)—— 判据的夹具也要满足产品规则
const BASE = { name: "j1", sql: "INSERT INTO sink_tbl SELECT 1", sourceType: "kinesis", sinkType: "s3" };

beforeEach(() => { puts.length = 0; unresolvable.clear(); for (const k of Object.keys(DS)) delete DS[k]; vi.clearAllMocks(); });

describe("🔴🔴 实时计算:一次提交 → 每个区各建一个作业(流式应用一区一个)", () => {
  it("给两个区 ⇒ **真的写了两条**作业行,jobId 各不相同,且每条只盖自己那个区的章", async () => {
    const r = await post({ ...BASE, targets: ["tgt_home", "tgt_usw2_a"] });
    expect(r.status).toBe(201);
    expect(puts).toHaveLength(2);
    expect(puts.map((x) => x.targets[0]).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(new Set(puts.map((x) => x.jobId)).size, "两条必须是不同的 jobId").toBe(2);
    // 名字带区后缀,否则列表里两条同名分不出来
    expect(puts.map((x) => x.name).sort()).toEqual(["j1-home", "j1-usw2_a"]);
    expect(r.body.data?.created?.length).toBe(2);
  });

  it("只给一个区 ⇒ 只写一条,响应形状与改动前一致(回那一个作业,不带 created)", async () => {
    const r = await post({ ...BASE, targets: ["tgt_home"] });
    expect(puts).toHaveLength(1);
    expect(puts[0].targets).toEqual(["tgt_home"]);
    expect(puts[0].name).toBe("j1");
    expect(r.body.data?.created).toBeUndefined();
  });

  it("🔴 反例:源数据源属于**另一个区** ⇒ 400 且**一条都不许写**(跨区取数 = 跨法域下的数据出境)", async () => {
    DS["ds-usw2"] = { datasourceId: "ds-usw2", ownerTargetId: "tgt_usw2_a", projectId: "p1" };
    const r = await post({ ...BASE, sourceType: "kinesis", sourceDatasourceId: "ds-usw2", targets: ["tgt_home"] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("不许跨区取数");
    expect(puts, "拒的时候必须零副作用").toHaveLength(0);
  });

  it("🔴 反例:非法 targetId ⇒ 400 且零写入", async () => {
    const r = await post({ ...BASE, targets: ["not-a-target"] });
    expect(r.status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it("🔴 主控区也过同一道真解析(原来 `if (t === HOME_TARGET_ID) continue` ⇒ 主控区没装 flink 也建得出、启动才炸)", async () => {
    const { resolveFlinkPlace } = await import("@/lib/realtime/flink-place");
    unresolvable.add("tgt_home");
    const r = await post({ ...BASE, targets: ["tgt_home", "tgt_usw2_a"] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("不能把实时作业建在 tgt_home");
    expect(puts, "任一个区解析不开 ⇒ 整体拒,零写入").toHaveLength(0);
    expect(vi.mocked(resolveFlinkPlace).mock.calls.map((c) => c[0])).toContain("tgt_home");
  });

  it("源数据源就属于这个区 ⇒ 放行", async () => {
    DS["ds-home"] = { datasourceId: "ds-home", ownerTargetId: "tgt_home", projectId: "p1" };
    const r = await post({ ...BASE, sourceDatasourceId: "ds-home", targets: ["tgt_home"] });
    expect(r.status).toBe(201);
    expect(puts).toHaveLength(1);
  });
});
