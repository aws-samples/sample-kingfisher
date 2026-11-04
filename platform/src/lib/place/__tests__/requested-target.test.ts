// 「落点必须点名」的三个作者 + 入口路由
//   · requestedTargetId:请求里点名的落点(缺 / 空 / 非法 ⇒ 400,不默认主控区)
//   · targetOfStamp:记录上的章(无章 = 存量主控区,章非法 ⇒ 抛)
//   · landingOfScope:前端按视角算新建 / 取区域资源的落点(单区 = 那个区;分组 / 全部 = 主控区,显式)
// 路由层只替换真外部(EC2 客户端工厂 / 身份 / 指标计算的数仓边界),落点解析不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({ ec2Regions: [] as string[], computeCalls: [] as unknown[][], bindings: [] as unknown[], bindables: [] as unknown[][], lakeLists: [] as string[], asks: [] as string[] }));

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    ec2ClientFor: async (region: string) => {
      h.ec2Regions.push(region);
      return { send: async () => ({}) };
    },
  };
});
vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => ({ username: "admin", sub: "s", isPlatformAdmin: true })) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
// 建模指标计算 / 同步向导两条建表入口经 submitLongOp ⇒ 任务表 bgp-long-ops 是真外部(内存夹具真求值条件写);其余表这里不碰
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
  return {
    ...real,
    docClient: {
      send: async (cmd: { input?: Record<string, unknown> }) => {
        if (cmd.input?.TableName === "bgp-long-ops") return mem.docClient.send(cmd);
        throw new Error(`requested-target 判据:意外的 DynamoDB 表 ${String(cmd.input?.TableName)}`);
      },
    },
  };
});
// 入口点名改为「已注册且装好」(requestedRegisteredPlace)⇒ 注册表是真外部(DDB 边界),给夹具描述符
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  const mk = (targetId: string, region: string) => ({ targetId, region, accountId: "000000000000", partition: "aws", status: "active", ready: true, components: ["core"], resources: {} });
  const known: Record<string, unknown> = { tgt_home: mk("tgt_home", "us-east-1"), tgt_usw2_a: mk("tgt_usw2_a", "us-west-2") };
  return { ...real, getTargetRaw: vi.fn(async (id: string) => known[id] ?? null), descriptorViolation: vi.fn(() => null) };
});
vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ projectId: "p1", identity: { username: "u", sub: "s" } })),
  getActiveProjectId: () => "p1",
  getActiveEnv: () => "dev",
}));
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (a: unknown) => { h.bindings.push(a); throw new Error("数仓边界(测试不打)"); }),
    // 绑定校验读注册表(真外部)⇒ 记下「交给它的绑定列表」后停在落库之前
    assertBindableTargetsForEngine: vi.fn(async (engine: string, targets: unknown) => {
      h.bindables.push([engine, targets]);
      throw new real.TargetBindingRejected("not-ready", "测试在落库前停下");
    }),
  };
});
vi.mock("@/lib/athena/s3tables", async (orig) => {
  const real: any = await orig();
  return { ...real, listNamespaceTree: vi.fn(async (place: { targetId: string }) => { h.lakeLists.push(place.targetId); return []; }) };
});
vi.mock("@/lib/genbi/execute", () => ({
  executeGenBiAsk: vi.fn(async (input: { targetId: string }) => { h.asks.push(input.targetId); throw new Error("问数执行体边界(测试不打)"); }),
  persistGenBiSideEffects: vi.fn(),
}));
vi.mock("@/lib/genbi/tasks", () => ({ createTask: vi.fn(async (input: { targetId: string }) => { h.asks.push(input.targetId); return "t1"; }) }));
vi.mock("@/lib/modeling/model-metrics", () => ({
  computeModelMetric: vi.fn(async (...args: unknown[]) => {
    h.computeCalls.push(args);
    return { modelMetricId: String(args[0]), value: 1, computedAt: "t", sql: "", targetId: String(args[1]) };
  }),
}));

import { NextRequest } from "next/server";
import { requestedTargetId, requestedTargets, requestedSubset, hasTargetsPatch } from "../resolve";
import { PlaceUndecidable } from "../types";
import { targetOfStamp } from "@/lib/exec-env/target-id";
import { landingOfScope } from "@/lib/scope/scope";
import { GET as networkGET } from "@/app/api/flink/network/route";
import { POST as modelComputePOST } from "@/app/api/modeling/model-metrics/[id]/compute/route";
import { POST as genDdlPOST } from "@/app/api/sync/generate-ddl/route";
import { POST as execDdlPOST } from "@/app/api/sync/execute-ddl/route";
import { POST as etlCreatePOST } from "@/app/api/etl-jobs/route";
import { POST as engineCreatePOST } from "@/app/api/engines/[engine]/route";
import { POST as flinkCreatePOST } from "@/app/api/flink/jobs/route";
import { GET as lakeTablesGET } from "@/app/api/athena/tables/route";
import { POST as athenaQueryPOST } from "@/app/api/athena/query/route";
import { POST as askPOST } from "@/app/api/genbi/ask/route";
import { GET as biSchemaGET } from "@/app/api/bi/schema/route";
import { POST as biQueryPOST } from "@/app/api/bi/query/route";
import { biLandingOf } from "@/lib/bi/query";

beforeEach(() => {
  h.ec2Regions.length = 0;
  h.computeCalls.length = 0;
  h.bindings.length = 0;
  h.bindables.length = 0;
  h.lakeLists.length = 0;
  h.asks.length = 0;
  process.env.AWS_REGION = "us-east-1";
});

describe("三个作者", () => {
  it("requestedTargetId:缺 / 空 / 空白 / 非法 ⇒ PlaceUndecidable;合法原样返回", () => {
    for (const bad of [undefined, null, "", "   ", "us-west-2", 7]) {
      expect(() => requestedTargetId(bad, "测试"), JSON.stringify(bad)).toThrow(PlaceUndecidable);
    }
    expect(requestedTargetId("tgt_usw2_a", "测试")).toBe("tgt_usw2_a");
    expect(requestedTargetId(" tgt_home ", "测试")).toBe("tgt_home");
  });

  it("requestedTargets:列表 / 单值都收、去重;都没有 / 全空 / 含非法 ⇒ PlaceUndecidable", () => {
    expect(requestedTargets({ targets: ["tgt_usw2_a", "tgt_usw2_a", "tgt_home"] }, "t")).toEqual(["tgt_usw2_a", "tgt_home"]);
    expect(requestedTargets({ targetId: "tgt_usw2_a" }, "t")).toEqual(["tgt_usw2_a"]);
    for (const bad of [{}, null, { targets: [] }, { targets: [""] }, { targetId: "" }, { targets: ["us-west-2"] }]) {
      expect(() => requestedTargets(bad as never, "t"), JSON.stringify(bad)).toThrow(PlaceUndecidable);
    }
  });

  it("requestedSubset:不是数组 ⇒ undefined(= 对象的全部绑定,不是主控区);数组 ⇒ 去空白(空列表原样交给调用方判)", () => {
    expect(requestedSubset({})).toBeUndefined();
    expect(requestedSubset(null)).toBeUndefined();
    expect(requestedSubset({ targets: "tgt_usw2_a" } as never)).toBeUndefined();
    expect(requestedSubset({ targets: [" tgt_usw2_a ", "", null] })).toEqual(["tgt_usw2_a"]);
    expect(requestedSubset({ targets: [] })).toEqual([]);
  });

  it("targetOfStamp:有章用章;无章 = 存量主控区;章非法 ⇒ 抛", () => {
    expect(targetOfStamp("tgt_usw2_a")).toBe("tgt_usw2_a");
    for (const none of [undefined, null, ""]) expect(targetOfStamp(none)).toBe("tgt_home");
    expect(() => targetOfStamp("us-west-2")).toThrow();
  });

  it("landingOfScope:单区 = 那个区;全部 / 对比 = 主控区", () => {
    expect(landingOfScope({ kind: "target", targetId: "tgt_usw2_a" })).toBe("tgt_usw2_a");
    expect(landingOfScope({ kind: "global" })).toBe("tgt_home");
    expect(landingOfScope({ kind: "compare", targetIds: ["tgt_home", "tgt_usw2_a"] } as never)).toBe("tgt_home");
  });
});

describe("入口路由:落点必须点名", () => {
  it("🔴 /api/flink/network 不带 targetId ⇒ 400 PLACE_UNDECIDABLE,EC2 一次都不调(原来静默列主控区的 VPC)", async () => {
    const r = await networkGET(new NextRequest("http://x/api/flink/network"));
    expect(r.status).toBe(400);
    expect((await r.json()).error?.code).toBe("PLACE_UNDECIDABLE");
    expect(h.ec2Regions).toEqual([]);
  });

  it("负向对照(判别力):带 tgt_home ⇒ 200、在主控区列", async () => {
    const r = await networkGET(new NextRequest("http://x/api/flink/network?targetId=tgt_home"));
    expect(r.status).toBe(200);
    expect(h.ec2Regions[0]).toBe("us-east-1");
  });

  it("🔴 计算建模指标 body 不带 / 带非法 targetId ⇒ 400,不去算(原来非法值静默改成主控区)", async () => {
    for (const body of ["{}", JSON.stringify({ targetId: "us-west-2" })]) {
      const r = await modelComputePOST(new NextRequest("http://x/c", { method: "POST", body }), { params: { id: "m1" } });
      expect(r.status, body).toBe(400);
    }
    expect(h.computeCalls).toEqual([]);
    const ok = await modelComputePOST(
      new NextRequest("http://x/c", { method: "POST", body: JSON.stringify({ targetId: "tgt_usw2_a" }) }),
      { params: { id: "m1" } }
    );
    expect(ok.status).toBe(200);
    expect(h.computeCalls, "落点与项目都要交下去(非主控区凭证按项目取)").toEqual([["m1", "tgt_usw2_a", "p1"]]);
  });
});

describe("🔴 新建作业两条入口(段 wp31 W31-E1/E2 坐实:页面不带落点 ⇒ 绑主控区、application 建在主控区)", () => {
  const post = (body: unknown) => new NextRequest("http://x/c", { method: "POST", body: JSON.stringify(body) });
  it("不点名绑定区 ⇒ 400 PLACE_UNDECIDABLE,绑定校验 / 建 application 一次都不走", async () => {
    const a = await etlCreatePOST(post({ name: "n", type: "redshift" }));
    expect(a.status).toBe(400);
    expect((await a.json()).error?.code).toBe("PLACE_UNDECIDABLE");
    const b = await engineCreatePOST(post({ name: "n" }), { params: { engine: "emr-serverless" } });
    expect(b.status).toBe(400);
    expect((await b.json()).error?.code).toBe("PLACE_UNDECIDABLE");
    expect(h.bindables).toEqual([]);
  });
  it("🔴 新建实时作业不点名绑定区 ⇒ 400 PLACE_UNDECIDABLE(原来 = 主控区)", async () => {
    const r = await flinkCreatePOST(post({ name: "n", sql: "INSERT INTO t SELECT 1" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error?.code).toBe("PLACE_UNDECIDABLE");
  });
  it("负向对照:点名 tgt_usw2_a ⇒ 绑定列表原样交给按引擎的绑定校验", async () => {
    await etlCreatePOST(post({ name: "n", type: "redshift", targets: ["tgt_usw2_a"] }));
    await engineCreatePOST(post({ name: "n", targetId: "tgt_usw2_a" }), { params: { engine: "emr-serverless" } });
    expect(h.bindables).toEqual([["redshift", ["tgt_usw2_a"]], ["emr-serverless", ["tgt_usw2_a"]]]);
  });
});

describe("🔴 数据湖 / 问数 / BI 入口缺落点 ⇒ 400(原来 = 主控区)", () => {
  const post = (body: unknown, url = "http://x/q") => new NextRequest(url, { method: "POST", body: JSON.stringify(body) });
  it("列数据湖表:不带 ⇒ 400 且一次都不列;带 tgt_usw2_a ⇒ 列的是该区", async () => {
    const r = await lakeTablesGET(new NextRequest("http://x/api/athena/tables"));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("PLACE_UNDECIDABLE");
    expect(h.lakeLists).toEqual([]);
  });
  it("Athena 查询:body 不带 ⇒ 400(本路由沿用自己的信封,带 code)", async () => {
    const r = await athenaQueryPOST(post({ sql: "SELECT 1" }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("PLACE_UNDECIDABLE");
  });
  it("问数:不带 ⇒ 400 且执行体 / 异步任务一次都不建;带 tgt_usw2_a ⇒ 落点原样交给执行体", async () => {
    const r = await askPOST(post({ question: "多少行", engine: "athena" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error?.code).toBe("PLACE_UNDECIDABLE");
    expect(h.asks).toEqual([]);
    await askPOST(post({ question: "多少行", engine: "athena", targetId: "tgt_usw2_a" }));
    expect(h.asks).toEqual(["tgt_usw2_a"]);
  });
  it("BI 取表结构 / 预览取数:不带 ⇒ 400", async () => {
    const a = await biSchemaGET(new NextRequest("http://x/api/bi/schema?engine=athena"));
    expect(a.status).toBe(400);
    const b = await biQueryPOST(post({ source: { kind: "sql", engine: "athena", sql: "SELECT 1" } }));
    expect(b.status).toBe(400);
    expect((await b.json()).error?.code).toBe("PLACE_UNDECIDABLE");
  });
  it("biLandingOf:已保存的 = 自己的章(无章 = 「全部」视角建的 = 主控区,与请求无关);预览 = 自带 > 请求点名,都没有 ⇒ 拒", () => {
    expect(biLandingOf({ targetId: "tgt_usw2_a" }, "tgt_home", "saved")).toBe("tgt_usw2_a");
    expect(biLandingOf({}, "tgt_usw2_a", "saved"), "已保存视觉对象不许被页面视角改区(跨区仪表盘)").toBe("tgt_home");
    expect(biLandingOf({ targetId: "tgt_usw2_a" }, "tgt_home", "preview")).toBe("tgt_usw2_a");
    expect(biLandingOf({}, "tgt_usw2_a", "preview")).toBe("tgt_usw2_a");
    expect(() => biLandingOf({}, undefined, "preview")).toThrow(PlaceUndecidable);
  });
});

describe("🔴 本来就「缺即拒」的入口收口到点名作者 + 模型目录不再把非法值改成主控区", () => {
  it("模型目录:不带 / 非法 targetId ⇒ 400(原来非法值静默 = 主控区,fail-open)", async () => {
    const { GET } = await import("@/app/api/admin/model-config/catalog/route");
    for (const q of ["", "?targetId=us-west-2"]) {
      const r = await GET(new NextRequest(`http://x/api/admin/model-config/catalog${q}`));
      expect(r.status, q).toBe(400);
    }
  });
});

describe("🔴 实时元数据 / Airflow 控制台 / 数仓连接 —— 不带 / 非法 ⇒ 400(原来非法值也静默 = 主控区)", () => {
  it("三个读接口", async () => {
    const meta = await import("@/app/api/flink/meta/route");
    const conn = await import("@/app/api/redshift/connections/route");
    for (const q of ["", "?targetId=us-west-2"]) {
      expect((await meta.GET(new NextRequest(`http://x/api/flink/meta${q}`))).status, `meta ${q}`).toBe(400);
      expect((await conn.GET(new NextRequest(`http://x/api/redshift/connections${q}`))).status, `connections ${q}`).toBe(400);
    }
  });
  it("hasTargetsPatch:两个字段任一出现 = 要改绑定;都没有 = 不改(不是主控区)", () => {
    expect(hasTargetsPatch({})).toBe(false);
    expect(hasTargetsPatch(null)).toBe(false);
    expect(hasTargetsPatch({ targets: [] })).toBe(true);
    expect(hasTargetsPatch({ targetId: "" })).toBe(true);
  });
});

describe("同步向导建表两条入口", () => {
  const post = (body: unknown) => new NextRequest("http://x/d", { method: "POST", body: JSON.stringify(body) });
  it("🔴 生成 / 执行建表语句不带 targetId ⇒ 400,数仓一次都不碰(原来静默在主控区探测 / 建表)", async () => {
    const g = await genDdlPOST(post({ tableName: "t1", columns: [{ name: "a", type: "int" }] }));
    expect(g.status).toBe(400);
    const x = await execDdlPOST(post({ ddl: "CREATE TABLE t1(a int)" }));
    expect(x.status).toBe(400);
    expect(h.bindings).toEqual([]);
  });
  it("负向对照:点名 tgt_usw2_a ⇒ 落点原样交给解析器", async () => {
    await genDdlPOST(post({ tableName: "t1", columns: [{ name: "a", type: "int" }], targetId: "tgt_usw2_a" }));
    // 生产上线批次 A:execute-ddl 不再收 SQL 文本,收与 generate-ddl 同一份建表参数。
    await execDdlPOST(post({ tableName: "t1", columns: [{ name: "a", type: "int" }], targetId: "tgt_usw2_a" }));
    expect(h.bindings.map((b: any) => b.targetId)).toEqual(["tgt_usw2_a", "tgt_usw2_a"]);
  });
});

// 接线判据(钉调用位置,不钉 import):前端每一处取区域网络清单都必须点名落点。
describe("接线:前端取 /api/flink/network 的每一处都带 ?targetId=", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "__tests__" && n !== "api") walk(p, out); }
      else if (/\.tsx?$/.test(n)) out.push(p);
    }
    return out;
  };
  it("没有一处不带落点", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/fetch\(\s*[`"']\/api\/flink\/network([^`"']*)/g)) {
        sites++;
        if (!m[1].startsWith("?targetId=")) offenders.push(`${relative(SRC, f)}: /api/flink/network${m[1]}`);
      }
    }
    expect(sites, "一处调用点都没扫到 ⇒ 判据自己失明").toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  it("前端新建工作流 / 实时作业 / 数据源:无多选时由 landingOfScope / 页面落点显式给(不靠后端缺省)", () => {
    const rd = (r: string) => readFileSync(join(SRC, r), "utf8");
    expect(rd("app/workflow/page.tsx")).toMatch(/createTargets\.length \? \{ targets: createTargets \} : \{ targetId: landingOfScope\(scope\) \}/);
    expect(rd("app/realtime-compute/page.tsx")).toMatch(/: \{ targetId: landingOfScope\(scope\) \}\)/);
    expect(rd("app/datasources/DataSourceModal.tsx")).toMatch(/if \(!isEdit\) payload = \{ \.\.\.payload, targetId: landingTargetId \}/);
  });

  it("前端:取实时元数据 / Airflow 控制台 / 数仓连接的每一处都在请求里点名 targetId", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/fetch\(\s*[`"'](\/api\/(?:flink\/meta|workflow\/airflow|redshift\/connections))([^`"']*)/g)) {
        sites++;
        if (!/[?&]targetId=/.test(m[2])) offenders.push(`${relative(SRC, f)}: ${m[1]}${m[2].slice(0, 60)}`);
      }
    }
    expect(sites, "一处调用点都没扫到 ⇒ 判据自己失明").toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });

  it("前端:Athena / 问数 / BI 取数请求都恒带落点(由 landingOfScope 给)", () => {
    const rd = (r: string) => readFileSync(join(SRC, r), "utf8");
    const ath = rd("app/athena/page.tsx");
    expect(ath).toMatch(/const tq = `targetId=\$\{encodeURIComponent\(landingOfScope\(scope\)\)\}`;/);
    expect(ath).toMatch(/body: JSON\.stringify\(\{ sql, targetId: landingOfScope\(scope\) \}\)/);
    const gb = rd("app/genbi/page.tsx");
    expect(gb).toMatch(/const askLanding = landingOfScope\(scope\);/);
    expect(gb).toMatch(/conversationId, targetId: askLanding \}\)/);
    expect(gb, "问数页取数类请求不许再按 askTargetId 条件拼落点").not.toMatch(/\$\{askTargetId \? `[?&]targetId=/);
    expect(rd("components/bi/FieldConfigurator.tsx")).toMatch(/const fcTarget = landingOfScope\(fcScope\);/);
    const wb = rd("components/bi/AnalysisWorkbench.tsx");
    expect((wb.match(/targetId: widgetTarget \|\| landingOfScope\(wScope\)/g) || []).length, "两处预览取数").toBe(2);
  });

  it("前端新建作业的每一处请求体都带 targets(由 landingOfScope 给,不靠后端缺省)", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const f of [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/fetch\(\s*[`"'](\/api\/etl-jobs|\/api\/engines\/\$\{[^}]+\})[`"']\s*,\s*\{[\s\S]{0,400}?body:\s*JSON\.stringify\(([^\n]*)\)/g)) {
        sites++;
        if (!/targets:\s*\[landingOfScope\(scope\)\]/.test(m[2])) offenders.push(`${relative(SRC, f)}: ${m[1]} ${m[2].slice(0, 80)}`);
      }
    }
    expect(sites, "一处调用点都没扫到 ⇒ 判据自己失明").toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
