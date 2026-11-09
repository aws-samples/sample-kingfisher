// 🔴🔴 AI 代码生成(作业开发 / EMR / 需求)的 grounding **只看主控区** —— 仓目录
//   `introspectSchema(GENBI.workgroup, GENBI.database)`、湖目录、以及 Glue 提示词里写死的 `workgroup=bgp-workgroup、database=dev`
//   全是主控区 ⇒ 给 us-west-2 的作业生成代码,模型看到的是主控区的表,写进代码的是那个区根本不存在的工作组实名。
// 装配层:只 mock 真外部(数仓直查出口 = Redshift Data API 边界 / Athena SDK / 注册表 / 模型侧),codegen ↔ schema ↔ athena 之间不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const h = vi.hoisted(() => {
  process.env.GENBI_POLL_MS = "1";
  // 联邦目录查询前的 GetCatalog(Glue 真外部)也记区 —— 湖目录 grounding 的目录探测必须跟着作业绑定的区走
  return { dq: [] as { region: string; workgroup: string }[], athena: [] as { region: string; input: any }[], glue: [] as { region: string; name: string }[], system: "" };
});

vi.mock("@/lib/redshift/direct-query", () => ({
  // 🔴 mock 必须**忠实**于真实契约(记忆 mock-hides-the-seam):真实解析器对非主控区缺 projectId 当场拒(§3.9b)。
  //   原来这里不看 projectId ⇒ 非主控区 AI 生成在真环境一律 500,而本文件全绿(2026-10-03 段 wp31 W31-R1 无头坐实)。
  resolveDirectQueryPlace: vi.fn(async (s: { targetId?: string; projectId?: string }) => {
    if (s.targetId && s.targetId !== "tgt_home" && !s.projectId) {
      throw new Error(`在非 home 目标 ${s.targetId} 上执行必须带 projectId(§3.9b:project-context 不接受缺 projectId)`);
    }
    return !s.targetId || s.targetId === "tgt_home"
      ? { targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", home: true }
      : { targetId: s.targetId, region: "us-west-2", workgroup: "bgp-wg-tgt-usw2-a", database: "dev_usw2", home: false };
  }),
  directQueryRaw: vi.fn(async (place: { region: string; workgroup: string }) => {
    h.dq.push({ region: place.region, workgroup: place.workgroup });
    const tag = place.region === "us-west-2" ? "usw2_only_orders" : "home_only_orders";
    return { columns: [], records: [[{ stringValue: "showcase" }, { stringValue: tag }, { stringValue: "amount" }, { stringValue: "double" }]] };
  }),
}));

vi.mock("@aws-sdk/client-athena", async (orig) => {
  const real: any = await orig();
  class FakeAthena {
    region: string;
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name === "StartQueryExecutionCommand") { h.athena.push({ region: this.region, input: cmd.input }); return { QueryExecutionId: "q" }; }
      if (name === "GetQueryExecutionCommand") return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
      if (name === "GetQueryResultsCommand") {
        const rows = [["table_name", "column_name", "data_type"], [this.region === "us-west-2" ? "usw2_lake_t" : "home_lake_t", "c", "int"]];
        return { ResultSet: { ResultSetMetadata: { ColumnInfo: rows[0].map((n) => ({ Name: n })) }, Rows: rows.map((r) => ({ Data: r.map((v) => ({ VarCharValue: v })) })) } };
      }
      return {};
    }
  }
  return { ...real, AthenaClient: FakeAthena };
});

// Glue SDK 是真外部 —— startQuery 对联邦目录查询先 GetCatalog(目录已在 ⇒ 不建)。只记区与命令名。
vi.mock("@aws-sdk/client-glue", async (orig) => {
  const real: any = await orig();
  class FakeGlue {
    region: string;
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(cmd: any) {
      const name = cmd.constructor.name;
      h.glue.push({ region: this.region, name });
      if (name === "GetCatalogCommand") return { Catalog: { Name: "s3tablescatalog" } };
      throw new Error(`FakeGlue: 本判据不该发出 ${name}`);
    }
  }
  return { ...real, GlueClient: FakeGlue };
});

vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (id: string) => ({
    targetId: id, region: "us-west-2",
    resources: { athenaWorkgroup: "bgp-athena-tgt-usw2-a", datalakeBucket: "dl-usw2", tableBucket: "bgp-table-bucket-tgt-usw2-a" },
  })),
}));
// 数据湖路由表(bgp-settings,真外部 DDB)—— 本判据不登记外部路由,湖目录仍只有该区平台表桶;路由作者 lib/lake/routes.ts 直读 DDB(不再经薄壳 external-table-buckets,mock 那层拦不到)
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return { ...real, docClient: { send: async (cmd: any) => (cmd.constructor.name === "QueryCommand" ? { Items: [] } : {}) } };
});

vi.mock("@/lib/ai/model", () => ({
  resolveModelId: () => "m-test",
  resolveModelRuntime: async () => ({ modelId: "m-test", source: "env" }),
  resolveLayered: async () => [{ modelId: "m-test", source: "env" }],
}));

vi.mock("@/lib/ai/invoke", () => ({
  invokeConverse: async (_c: string, _t: unknown, _cl: unknown, build: (m: string) => any) => {
    h.system = JSON.stringify(build("m-test").input.system);
    return { response: { usage: {}, output: { message: { content: [{ text: "```python\nprint(1)\n```\n说明" }] } } }, usedModelId: "m-test", usedSource: "env" };
  },
}));

import { generateEtlCode } from "../codegen";

const SRC = resolve(__dirname, "../../..");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("🔴🔴 装配层:AI 代码生成按**作业绑定的区**做 grounding", () => {
  beforeEach(() => { h.dq.length = 0; h.athena.length = 0; h.system = ""; });

  it("us-west-2(Glue):仓目录 / 湖目录都从 us-west-2 取;提示词里的工作组 = 该区实名;回显 groundedOn", async () => {
    const r = await generateEtlCode({ intent: "算渠道 ROI" }, "glue", undefined, "tgt_usw2_a", "proj-default");
    expect(r.groundedOn).toEqual({ targetId: "tgt_usw2_a", region: "us-west-2", workgroup: "bgp-wg-tgt-usw2-a", database: "dev_usw2" });
    expect(h.dq.map((x) => x.region)).toEqual(["us-west-2"]);
    expect(h.athena.map((x) => x.region)).toEqual(["us-west-2"]);
    expect(h.glue, "湖目录探测前的 GetCatalog 也打到该区,且目录已在就不建").toEqual([{ region: "us-west-2", name: "GetCatalogCommand" }]);
    expect(h.system).toContain("usw2_only_orders");
    expect(h.system).toContain("usw2_lake_t");
    expect(h.system).toContain("bgp-wg-tgt-usw2-a");
    expect(h.system, "提示词里还写着主控区工作组实名").not.toContain("bgp-workgroup");
    expect(h.system).not.toContain("home_only_orders");
  });

  it("负向对照(判别力):点名主控区 ⇒ 主控区(证明上一条不是「怎么跑都是 us-west-2」)", async () => {
    const r = await generateEtlCode({ intent: "算渠道 ROI" }, "glue", undefined, "tgt_home", "proj-default");
    expect(r.groundedOn.region).toBe("us-east-1");
    expect(h.dq.map((x) => x.region)).toEqual(["us-east-1"]);
    expect(h.athena.map((x) => x.region)).toEqual(["us-east-1"]);
    expect(h.system).toContain("home_only_orders");
    expect(h.system).toContain("bgp-workgroup");
  });

});

describe("🔴 接线:三个生成路由 + 两个页面都把区带到生成处(调用位置)", () => {
  const read = (rel: string) => code(readFileSync(join(SRC, rel), "utf8")).replace(/^import .*$/gm, "");
  // 原来 `targetIdOf(body)` 把缺 / 空回成 undefined(= 主控区);现在缺即 400
  // → —— 生成主体搬进 lib/ai/long-op-executors.ts(路由只做点名 + 提交任务);点名仍在路由,区经任务 params.targetId
  //   落库带到执行体(异步任务可能由另一次请求接管,不落库 = 接手那一刻忘了在哪个区)。判据改盯「路由点名 → params.targetId → 执行体传区」整条链。
  it("三个生成路由都经点名作者 requestedTargetId 取区(缺 / 非法 ⇒ 400)并落进任务 params;执行体按 params.targetId 生成,都回 groundedOn", () => {
    const ex = read("lib/ai/long-op-executors.ts");
    for (const [f, kind] of [["app/api/etl-jobs/generate/route.ts", "codegen-etl"], ["app/api/engines/generate/route.ts", "codegen-emr"]] as const) {
      const s = read(f);
      expect(s, f).toMatch(/const targetId = requestedTargetId\(body\?\.targetId, "[^"]+"\);/);
      expect(s, f).toMatch(new RegExp(`kind: "${kind}", params: \\{[^}]*\\btargetId\\b[^}]*projectId: ctx\\.projectId`));
      expect(s, f).toMatch(/placeErrorResponse\(e\)/);
      expect(s, `${f} 不该再自己调生成器(主体在执行体)`).not.toMatch(/generateEtlCode\(/);
    }
    expect(ex.match(/generateEtlCode\([^;]*params\.targetId, params\.projectId\)/g)?.length, "两条 codegen 执行体都按 params.targetId / params.projectId 生成").toBe(2);
    expect(ex.match(/groundedOn: gen\.groundedOn/g)?.length, "三条 codegen 执行体都回 groundedOn").toBeGreaterThanOrEqual(3);
    const rq = read("app/api/requirements/[id]/generate/route.ts");
    expect(rq).toMatch(/const tid = requestedTargetId\(body\?\.targetId, "[^"]+"\);/);
    expect(rq).toMatch(/kind: "codegen-requirement", params: \{[^}]*targetId: tid/);
    expect(rq, "路由不该再自己调生成器(主体在执行体)").not.toMatch(/generateImplementation\(/);
    expect(ex).toMatch(/generateImplementation\([^;]*, params\.targetId, requirement\.projectId\)/);
    expect(ex, "没把「按哪个区生成」记到实现上 ⇒ 创建作业无从核对").toMatch(/groundedTargetId: gen\.groundedOn\.targetId/);
    expect(rq).toMatch(/placeErrorResponse\(e\)/);
    expect(rq, "需求生成又写死主控区").not.toMatch(/HOME_TARGET_ID/);
    expect(ex, "执行体写死主控区").not.toMatch(/HOME_TARGET_ID/);
  });

  it("🔴 需求创建作业:绑定区点名 + 与 /api/etl-jobs 同一套绑定校验 + 必须含生成区 + 不再写死主控区工作组", () => {
    const cj = read("app/api/requirements/[id]/create-job/route.ts");
    expect(cj).toMatch(/assertBindableTargetsForEngine\(targetType, requestedTargets\(body, "[^"]+"\), "redshift", \{/);
    expect(cj).toMatch(/const grounded = targetOfStamp\(r\.implementation\?\.groundedTargetId\);/);
    expect(cj).toMatch(/if \(!boundTargets\.includes\(grounded\)\) \{\s*return apiError\([\s\S]{0,300}?409/);
    expect(cj).toMatch(/targets: boundTargets,/);
    expect(cj, "仍把主控区工作组写进作业").not.toMatch(/homeWorkgroup\(|workgroupName:/);
    const page = read("app/requirements/page.tsx");
    expect(page).toMatch(/const reqLanding = landingOfScope\(scope\);/);
    expect(page).toMatch(/body: JSON\.stringify\(\{ targetType: genTarget, targetId: reqLanding \}\)/);
    expect(page).toMatch(/body: JSON\.stringify\(\{ targets: \[reqLanding\] \}\)/);
  });
  it("作业开发 / EMR 两处页面:请求体带作业的章 targets[0],结果区渲染 CodegenGroundedOn", () => {
    for (const f of ["app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx"]) {
      const s = read(f);
      expect(s, f).toMatch(/targetId: targets\[0\] \}\)/);
      expect(s, f).toMatch(/<CodegenGroundedOn value=\{aiResult\.groundedOn\} boundTargets=\{targets\} \/>/);
      expect(s, f).toMatch(/groundedOn: d\.data\.groundedOn/);
    }
  });
  it("codegen 里不再有主控区字面量 / 主控区缺省", () => {
    const s = read("lib/requirements/codegen.ts");
    expect(s).not.toContain("bgp-workgroup");
    expect(s).not.toMatch(/HOME_TARGET_ID/);
    expect(s).toMatch(/introspectS3Tables\(S3TABLES_NAMESPACE, \{ targetId \}\)/);
  });
});

describe("🔴🔴 配方库:数仓事实只有「读本区注入值」一种教法(唯一作者 seed/warehouse-facts.ts)", () => {
  const seed = (f: string) => code(readFileSync(join(SRC, "lib/cookbook/seed", f), "utf8"));
  it("Glue / EMR 两份配方里不再出现主控区工作组实名,也不再教「直接写死」", () => {
    for (const f of ["glue.ts", "emr.ts"]) {
      const s = seed(f);
      expect(s, f).not.toContain("bgp-workgroup");
      expect(s, f).not.toMatch(/直接写死/);
      expect(s, f).not.toMatch(/平台固定真实值/);
    }
  });
  it("EMR 模板读 spark.bgp.redshift* 时**不给缺省值**(缺省值 = 把某个区写死)", () => {
    const s = seed("emr.ts");
    expect(s).toMatch(/spark\.conf\.get\('spark\.bgp\.redshiftWorkgroup'\)/);
    expect(s).not.toMatch(/spark\.conf\.get\('spark\.bgp\.redshift\w+',/);
  });
  it("Glue 模板经 getResolvedOptions 读 bgp_redshift_* 三事实,client 带 region_name", () => {
    const s = seed("glue.ts");
    expect(s).toMatch(/getResolvedOptions\(sys\.argv, \['JOB_NAME', 'ds', 'bgp_region', 'bgp_redshift_workgroup', 'bgp_redshift_database', 'bgp_redshift_secret_arn'\]\)/);
    expect(s).toMatch(/boto3\.client\('redshift-data', region_name=args\['bgp_region'\]\)/);
  });
  it("两引擎都挂上 no-hardcoded-warehouse(warn:标出不拦截;存量主控区作业照常跑)", async () => {
    const { guard } = await import("@/lib/cookbook");
    for (const eng of ["glue", "emr"] as const) {
      const bad = guard(eng, "rs.execute_statement(WorkgroupName='bgp-workgroup', Database='dev', Sql=q)");
      expect(bad.violations.map((v) => v.ruleId), eng).toContain(`${eng}.no-hardcoded-warehouse`);
      expect(bad.blocked, `${eng}:warn 级不许拦截`).toBe(false);
      const good = guard(eng, "rs.execute_statement(WorkgroupName=args['bgp_redshift_workgroup'], Sql=q)");
      expect(good.violations.map((v) => v.ruleId), eng).not.toContain(`${eng}.no-hardcoded-warehouse`);
    }
  });
  it("Glue 生成提示词用同一句教法(GLUE_WAREHOUSE_HOWTO),不再自写工作组名", () => {
    const s = code(readFileSync(join(SRC, "lib/requirements/codegen.ts"), "utf8"));
    expect(s).toMatch(/\$\{GLUE_WAREHOUSE_HOWTO\}/);
  });
});
