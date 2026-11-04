// 🔴🔴 (2026-10-01 新账号无头实测):在 us-west-2 视角选「数据湖 (Athena)」问数 ⇒ **10 条 Athena 查询全部
//   打在主控区工作组 `bgp-athena`,us-west-2 工作组 `bgp-athena-tgt-usw2-a` 0 条**(那个工作组自建成以来一条都没跑过),
//   页面横幅照样写「当前在 us-west-2 提问」,答案是主控区的数据。
//
// 根因是**一类**,不是一处 —— 数据湖层的落点参数都是「可省 = 主控区」:
//   · 问数主循环两处 `introspectS3Tables(ns)` / `runSelectAthena(sql)` 没传 targetId(参数位早就开了,没人接);
//   · 目录引用、工具描述、核心提示词示例写死主控区的 `s3tablescatalog/bgp-table-bucket`(模型会照抄);
//   · AgentCore 那条路:容器只并 `rs*` 落点、Gateway 没声明 Athena 落点、技能 Lambda 用模块级主控区客户端;
//   · 实时计算 S3 Tables sink 的 `${TABLE_BUCKET_ARN}` 恒填主控区表桶,「查询结果」也读主控区;
//   · 编译器还逮到 3 处 grep 漏掉的(动态 import):BI 字段配置器、Copilot 规划发现工具、AI 代码生成。
// ⇒ 根治 = 落点改成**必填**(不给就编译不过)+ 本文件钉住「唯一合法形态」+ 执行层回报真落点(`_meta.ranIn`)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const h = vi.hoisted(() => {
  process.env.GENBI_POLL_MS = "1";
  return {
    sends: [] as { region: string; name: string; input: any }[],
    // 打到联邦目录的查询前先 GetCatalog(区级资源)—— 记下 Glue 客户端的区,证明它也跟着落点走
    glue: [] as { region: string; name: string }[],
    converseInputs: [] as any[],
    turn: 0,
  };
});

// ── 只 mock 真外部:Athena SDK 客户端 / 注册表(DDB)/ 模型侧 ──────────────────────
vi.mock("@aws-sdk/client-athena", async (orig) => {
  const real: any = await orig();
  class FakeAthena {
    region: string;
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(cmd: any) {
      const name = cmd.constructor.name;
      h.sends.push({ region: this.region, name, input: cmd.input });
      if (name === "StartQueryExecutionCommand") return { QueryExecutionId: `q-${h.sends.length}` };
      if (name === "GetQueryExecutionCommand") return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
      if (name === "GetQueryResultsCommand") {
        const start = [...h.sends].reverse().find((s) => s.name === "StartQueryExecutionCommand");
        const isSchema = /information_schema/.test(String(start?.input?.QueryString || ""));
        const rows = isSchema
          ? [["table_name", "column_name", "data_type"], ["orders", "amount", "double"]]
          : [["n"], ["42"]];
        return {
          ResultSet: {
            ResultSetMetadata: { ColumnInfo: rows[0].map((n) => ({ Name: n, Type: "varchar" })) },
            Rows: rows.map((r) => ({ Data: r.map((v) => ({ VarCharValue: v })) })),
          },
        };
      }
      return {};
    }
  }
  return { ...real, AthenaClient: FakeAthena };
});

// Glue SDK 也是真外部 —— startQuery 对联邦目录查询先 GetCatalog(目录已在 ⇒ 不建)。只记区与命令名。
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

// 外部表桶登记表(bgp-settings,真外部 DDB)—— 本判据不登记任何外部桶,落点仍只有平台表桶
vi.mock("@/lib/lake/external-table-buckets", () => ({ listExternalTableBuckets: vi.fn(async () => []) }));

vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (id: string) => ({
    targetId: id,
    region: "us-west-2",
    resources: { athenaWorkgroup: "bgp-athena-tgt-usw2-a", datalakeBucket: "bgp-datalake-x-usw2", tableBucket: "bgp-table-bucket-tgt-usw2-a" },
  })),
}));

vi.mock("@/lib/ai/model", () => ({
  resolveModelId: () => "m-test",
  resolveModelRuntime: async () => ({ modelId: "m-test", source: "env" }),
  resolveLayered: async () => [{ modelId: "m-test", source: "env" }],
}));

vi.mock("@/lib/ai/invoke", () => ({
  invokeConverse: async (_cap: string, _t: unknown, _c: unknown, build: (m: string) => any) => {
    const cmd = build("m-test");
    h.converseInputs.push(cmd.input);
    h.turn += 1;
    const response = h.turn % 2 === 1
      ? { stopReason: "tool_use", usage: {}, output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "tu1", name: "run_sql", input: { sql: 'SELECT count(*) AS n FROM "x"."showcase"."orders"' } } }] } } }
      : { stopReason: "end_turn", usage: {}, output: { message: { role: "assistant", content: [{ text: "共 42 行" }] } } };
    return { response, usedModelId: "m-test", usedSource: "env", degraded: false };
  },
}));

import { runGenBiAgent } from "../agent";
import { ranInView } from "../ran-in";
import { mergeRanIn } from "@/lib/ai/meta";

const SRC = resolve(__dirname, "../../..");
const REPO = resolve(SRC, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** 剥注释(块注释 / 行注释)再判,别让注释里的旧写法打红或放行。 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "__tests__" && n !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

const USW2_REF = "s3tablescatalog/bgp-table-bucket-tgt-usw2-a";
const HOME_REF = "s3tablescatalog/bgp-table-bucket";

describe("🔴🔴 装配层:问数主循环(数据湖)真把查询发到**该区**(只 mock 真外部)", () => {
  beforeEach(() => { h.sends.length = 0; h.glue.length = 0; h.converseInputs.length = 0; h.turn = 0; });

  it("us-west-2:探表结构 + 取数两条查询都在 us-west-2 客户端 / 该区工作组 / 该区目录;主控区 0 条;ranIn 如实回报", async () => {
    const out = await runGenBiAgent("有多少行", "", "showcase", [], "athena", { targetId: "tgt_usw2_a" });
    const starts = h.sends.filter((s) => s.name === "StartQueryExecutionCommand");
    expect(starts.length, "探表结构 + 取数 = 2 条").toBe(2);
    expect(starts.map((s) => s.region)).toEqual(["us-west-2", "us-west-2"]);
    expect(starts.map((s) => s.input.WorkGroup)).toEqual(["bgp-athena-tgt-usw2-a", "bgp-athena-tgt-usw2-a"]);
    expect(h.sends.filter((s) => s.region === "us-east-1"), "主控区一条都不许有").toEqual([]);
    // 联邦目录的 GetCatalog 也必须打到该区(目录是区级资源;打主控区 = 看错区的目录)。
    //   只有探表结构那条带目录上下文 ⇒ 1 次;取数那条是假模型写的 "x" 目录,不碰联邦目录 ⇒ 不问 Glue(别的 Athena 查询不碰 Glue 的负向对照)。
    expect(h.glue).toEqual([{ region: "us-west-2", name: "GetCatalogCommand" }]);
    expect(starts[0].input.QueryExecutionContext?.Catalog, "探表结构的目录必须是该区表桶").toBe(USW2_REF);
    // 模型看到的目录 / 工具描述 / 提示词:全是该区的目录引用,不出现主控区的
    const prompt = JSON.stringify(h.converseInputs[0]);
    expect(prompt).toContain(USW2_REF);
    expect(prompt.includes(`${HOME_REF}\\"`) || prompt.includes(`${HOME_REF}"`), "模型提示里出现了主控区目录引用").toBe(false);
    expect(out.ranIn).toEqual([{ engine: "athena", region: "us-west-2", workgroup: "bgp-athena-tgt-usw2-a" }]);
  });

  // 主控区也必须点名(原来 `targetId: undefined` = 主控区)
  it("负向对照(判别力):显式主控区 ⇒ 落在主控区 —— 证明上一条不是「怎么跑都是 us-west-2」", async () => {
    const out = await runGenBiAgent("有多少行", "", "showcase", [], "athena", { targetId: "tgt_home" });
    const starts = h.sends.filter((s) => s.name === "StartQueryExecutionCommand");
    expect(starts.length).toBe(2);
    expect(new Set(starts.map((s) => s.region))).toEqual(new Set(["us-east-1"]));
    expect(starts[0].input.QueryExecutionContext?.Catalog).toBe(HOME_REF);
    expect(new Set(h.glue.map((g) => g.region)), "GetCatalog 跟着落点走:主控区查询 ⇒ 主控区目录").toEqual(new Set(["us-east-1"]));
    expect(out.ranIn).toEqual([{ engine: "athena", region: "us-east-1", workgroup: "bgp-athena" }]);
  });
});

describe("🔴🔴 闭合式:数据湖层的落点**只有必填**这一种合法形态", () => {
  // 每个函数的「唯一合法签名」(参数表原文,去空白)。新增可省的落点参数 = 又开了一条「漏传 = 主控区」的静默路。
  const LEGAL: [string, string, string][] = [
    ["lib/athena/s3tables.ts", "qualifiedName", "catalogRef:string,namespace:string,table:string"],
    ["lib/athena/s3tables.ts", "listNamespaceTree", "place:S3TablesPlace"],
    ["lib/genbi/athena.ts", "introspectS3Tables", "namespace:string,opts:LakeTarget"],
    ["lib/genbi/athena.ts", "runSelectAthena", "modelSql:string,opts:LakeTarget"],
    ["lib/realtime/flink-config.ts", "tableBucketArn", "place:{region:string;account:string;s3tablesBucket:string}"],
    ["lib/realtime/flink-service.ts", "resolveS3TableSink", "sql:string,place:FlinkPlace"],
    ["lib/realtime/flink-service.ts", "readS3TableResults", "sql:string|undefined,limit:number,targetId:string"],
  ];
  for (const [file, fn, sig] of LEGAL) {
    it(`${fn}(${sig})`, () => {
      const s = code(read(file));
      const m = s.match(new RegExp(`export (?:async )?function ${fn}\\(([\\s\\S]*?)\\)\\s*:`));
      expect(m, `${file} 里找不到 export function ${fn}`).not.toBeNull();
      expect(m![1].replace(/\s+/g, "")).toBe(sig);
    });
  }
  // 值也必填:`undefined` 仍是静默默认的一种写法(§⑥ D3 的对照组)
  it("LakeTarget 是**必填键 + 必填值**(主控区也写 tgt_home)", () => {
    // 多了可选的 catalogRef(目录同步逐桶扫时显式给);targetId 仍是必填键 + 必填值
    expect(code(read("lib/genbi/athena.ts"))).toMatch(/export type LakeTarget = \{ targetId: string; catalogRef\?: string \};/);
  });

  it("🔴 显式写主控区的调用点是**封闭名单**(每一处都有理由;新增一处 = 又一个只看主控区的功能)", () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const s = code(readFileSync(f, "utf8"));
      for (const m of s.matchAll(/(introspectS3Tables|runSelectAthena)\([^)]*targetId:\s*HOME_TARGET_ID/g)) hits.push(`${f.slice(SRC.length + 1)}:${m[1]}`);
    }
    expect(hits.sort()).toEqual([
      "lib/openmetadata/om-push.ts:introspectS3Tables", // 主控区表桶 → OM 元数据(参数 bucket 本身就是主控区那只)
      // (那一处已随同批修掉:AI 代码生成改按作业绑定的区,见 requirements/__tests__/codegen-target.test.ts)
    ]);
  });
});

describe("🔴 接线:问数两条后端都把落点带到执行处(调用位置,不是只 import)", () => {
  it("inprocess:两处 Athena 原子都传 { targetId },目录引用取该区(不再引用 ATHENA_CATALOG_REF)", () => {
    const s = code(read("lib/genbi/agent.ts")).replace(/^import .*$/gm, "");
    expect(s).toMatch(/introspectS3Tables\(effectiveDb, \{ targetId \}\)/);
    expect(s).toMatch(/runSelectAthena\(sql, \{ targetId \}\)/);
    // 目录引用按用户选的命名空间找所在表桶(平台表桶 / 已登记外部表桶),仍按同一个 targetId
    expect(s).toMatch(/resolveS3TablesPlaceForNamespace\(targetId, effectiveDb\)\)\.catalogRef/);
    expect(s).not.toMatch(/ATHENA_CATALOG_REF/);
    expect(s, "工具描述写死了主控区目录").not.toContain(HOME_REF + '"');
  });
  it("核心提示词不再举主控区目录名当例子(模型会照抄)", () => {
    expect(code(read("lib/genbi/core/prompt.ts"))).not.toContain(HOME_REF);
  });
  it("AgentCore:落点按引擎解析(唯一作者 resolveGenBiPlace),execute 不再自己拼 Redshift 落点", () => {
    const s = code(read("lib/genbi/execute.ts")).replace(/^import .*$/gm, "");
    // 第四参 = Athena 引擎用户选的命名空间(找所在表桶);Redshift 引擎传 undefined
    expect(s).toMatch(/resolveGenBiPlace\(engine, targetId, projectId, /);
    expect(s).not.toMatch(/resolveDirectQueryPlace/);
    expect(s).toMatch(/ranIn \}\);/);
  });
  it("容器:Athena 落点经 PlaceWire 并进(合并成一个 place)、目录引用取数据湖腿的 catalogRef、唯一漏斗里收集 ranIn", () => {
    const s = readFileSync(join(REPO, "infra/agent/genbi/agent.js"), "utf8");
    // ath* 四样合并进 PlaceWire;目录引用从数据湖腿取,缺这条腿即拒(不回落 S3T_REF)
    // 🔴 钉完整派生式(第一版只查子串 `input.place.catalogRef`,被变异 `catalogRefX` 放行 —— 子串判据的老坑)
    expect(s).toMatch(/const athenaRef = isAthena \? placeWireLeg\(placeWire, "athena"\)\.catalogRef : S3T_REF;/);
    expect(s).toMatch(/buildCatalogText\(catTables, db, \{ engine, athenaRef \}\)/);
    expect(s).toMatch(/athenaRef: isAthena \? athenaRef : undefined/);
    expect(s).toMatch(/const res = await mcp\.callTool\(name, argsWithPlace\);[\s\S]{0,600}_meta\.ranIn\.push/);
  });
  it("技能 Lambda:Athena 不再用模块级客户端;`new AthenaClient` 只在工厂里出现一次;两个 Athena 工具都把 args 传下去", () => {
    const idx = code(readFileSync(join(REPO, "infra/lambda/genbi-skills/index.js"), "utf8"));
    const rs = code(readFileSync(join(REPO, "infra/lambda/genbi-skills/rs.js"), "utf8"));
    expect(idx).not.toMatch(/H\.athena\./);
    expect((rs.match(/new AthenaClient\(/g) || []).length).toBe(1);
    expect(rs).toMatch(/function athenaClientFor\(region\)[\s\S]{0,200}new AthenaClient\(\{ region: r \}\)/);
    expect(idx).toMatch(/athenaQuery\(args\.sql \|\| "", args\.namespace \|\| args\.database, args\)/);
    expect(idx).toMatch(/introspectS3Tables\(args\.namespace \|\| args\.database, args\)/);
    expect(idx).toMatch(/H\.athPlaceOf\(args\)/);
    // 🔴 四样都必须用落点里的(只换 region 而工作组/目录还是主控区的 ⇒ 不报错、在别的区跑一条打不到数据的查询)
    expect(idx).toMatch(/WorkGroup: place\.workgroup/);
    expect(idx).toMatch(/Catalog: place\.catalogRef/);
    expect(idx).toMatch(/athenaClientFor\(place\.region\)/);
    expect(idx).toMatch(/const ref = `"\$\{H\.athPlaceOf\(args\)\.catalogRef\}"`/);
  });
  it("技能 Lambda:两条腿都回报真落点(ranIn 取自真正发请求的那份 place)", () => {
    const idx = code(readFileSync(join(REPO, "infra/lambda/genbi-skills/index.js"), "utf8"));
    const rs = code(readFileSync(join(REPO, "infra/lambda/genbi-skills/rs.js"), "utf8"));
    expect(rs).toMatch(/const ranIn = \{ engine: "redshift", region: place\.region, workgroup: place\.workgroup \}/);
    expect((rs.slice(rs.indexOf("async function runRedshiftSql"), rs.indexOf("async function introspectRedshift")).match(/ranIn/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(idx).toMatch(/const ranIn = \{ engine: "athena", region: place\.region, workgroup: place\.workgroup \}/);
    expect((idx.slice(idx.indexOf("async function athenaQuery"), idx.indexOf("async function introspectS3Tables")).match(/ranIn/g) || []).length).toBeGreaterThanOrEqual(4);
  });
  it("实时计算:tableBucketArn 真用落点里的 region / 表桶(行为,不是只看签名)", async () => {
    const { tableBucketArn } = await import("@/lib/realtime/flink-config");
    expect(tableBucketArn({ region: "us-west-2", account: "ACCT", s3tablesBucket: "bgp-table-bucket-tgt-usw2-a" }))
      .toBe("arn:aws:s3tables:us-west-2:ACCT:bucket/bgp-table-bucket-tgt-usw2-a");
  });
  it("实时计算:sink 表桶取 ctx(该区落点),「查询结果」带作业行上的章", () => {
    expect(code(read("lib/realtime/flink-service.ts"))).toMatch(/resolveS3TableSink\(finalSql, ctx\)/);
    expect(code(read("app/api/flink/jobs/[id]/results/route.ts"))).toMatch(/readS3TableResults\(job\.sql, 200, flinkJobTarget\(job\)\)/);
  });
});

describe("呈现:执行层回报 vs 视角(封闭三态)", () => {
  const A = { engine: "athena" as const, region: "us-west-2", workgroup: "w" };
  const H = { engine: "athena" as const, region: "us-east-1", workgroup: "bgp-athena" };
  it("没回报 ⇒ unreported(不许拿视角顶上)", () => {
    expect(ranInView([], "us-west-2").kind).toBe("unreported");
    expect(ranInView(undefined, "us-west-2").kind).toBe("unreported");
  });
  it("一致 ⇒ match", () => { expect(ranInView([A], "us-west-2").kind).toBe("match"); });
  it("🔴 原状:视角 us-west-2、实际主控区 ⇒ mismatch", () => {
    const v = ranInView([H], "us-west-2");
    expect(v.kind).toBe("mismatch");
    expect(v.kind === "mismatch" && v.regions).toEqual(["us-east-1"]);
  });
  it("🔴 混了别的区也算 mismatch(一条落错就不是该区的答案)", () => { expect(ranInView([A, H], "us-west-2").kind).toBe("mismatch"); });
  it("视角未知 ⇒ 只呈现事实,不判一致也不判不一致", () => { expect(ranInView([H], null).kind).toBe("match"); });
  it("mergeRanIn:去重、丢弃形状不对的条目", () => {
    expect(mergeRanIn([], [A, A, null, { engine: "x", region: "r", workgroup: "w" } as any, { ...H, region: "" }, H])).toEqual([A, H]);
  });
  it("页面:答案区渲染 genbi-ran-in(data-kind / data-regions)与不一致红字 genbi-ran-in-mismatch", () => {
    const s = code(read("app/genbi/page.tsx"));
    expect(s).toMatch(/const ran = ranInView\(result\._meta\?\.ranIn, expectRegion\)/);
    expect(s).toContain('data-testid="genbi-ran-in"');
    expect(s).toMatch(/data-kind=\{ran\.kind\}/);
    expect(s).toContain('data-testid="genbi-ran-in-mismatch"');
    expect(s).toMatch(/<TurnResult result=\{turn\.result\} expectRegion=\{expectRegion\}/);
  });
});
