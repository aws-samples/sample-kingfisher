// @kf-batch 50-WP31-place-first-class
// WP-31 序 4(L6)—— **PlaceWire 五运行时契约**:同一组夹具喂给五个运行时的读取函数,结果必须逐条相同。
//
//   ① Node 平台             lib/genbi/core/place-wire.ts(经 lib/place/wire.ts 用)
//   ② AgentCore 容器        infra/agent/genbi/core-dist/place-wire.js(core-prebuild 编出来的**提交入库的产物**)
//   ③ 技能 Lambda           infra/lambda/genbi-skills/core-dist/place-wire.js + rs.js 的 placeOf / athPlaceOf(取腿后的形状)
//   ④ 调度运行时(Python)   从 BGP_RUNTIME_PY(MWAA Serverless 代码包的 .py **全文**)里抠出读取函数真跑
//   ⑤ Spark 脚本(Python)   从 generateGlueScript 生成的同步脚本**全文**里抠出读取函数真跑
//
// 🔴 ②③④⑤ 都从**产物**取,不从源取:产物没重编 / 生成器没嵌进去 ⇒ 这里红(「写了」≠「接上了」)。
// 🔴 夹具一半是**按 schema 机械派生**的(每个必填字段删掉一次、每个模式 / 最小长度 / 常量各违反一次、每层加一个未知字段)
//    ⇒ 任一运行时漏校验 / 读错字段 / 校验顺序不同(第一处错误的路径不同)都会红;schema 加字段而读取函数没跟上也会红。
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readPlaceWire,
  PLACE_WIRE_REGION_PATTERN,
  PLACE_WIRE_S3_LOCATION_PATTERN,
  PLACE_WIRE_SECRET_ARN_PATTERN,
  PLACE_WIRE_TARGET_ID_PATTERN,
} from "@/lib/genbi/core/place-wire";
import { buildPlaceWire, PlaceWireInvalid } from "@/lib/place/wire";
import { PLACE_WIRE_PY_BEGIN, PLACE_WIRE_PY_END } from "@/lib/place/wire-py";
import { BGP_RUNTIME_PY } from "@/lib/scheduler/serverless/runtime-py";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import type { DataSource } from "@/types/datasource";

const PLATFORM = resolve(__dirname, "../../../..");
const REPO = resolve(PLATFORM, "..");
const SCHEMA = JSON.parse(readFileSync(join(PLATFORM, "place-wire.schema.json"), "utf8"));
const CONTAINER_DIST = join(REPO, "infra/agent/genbi/core-dist/place-wire.js");
const LAMBDA_DIST = join(REPO, "infra/lambda/genbi-skills/core-dist/place-wire.js");
const LAMBDA_RS = join(REPO, "infra/lambda/genbi-skills/rs.js");

type Outcome = { ok: unknown } | { error: string };
interface Case { name: string; input: unknown; /** 输入以 JSON 文本给(而不是对象)—— 文本里的 `1.0` 之类只有文本能表达 */ text?: boolean }

const ACCT = "123456789012";
const RS = { workgroup: "bgp-exec-usw2a-wg", database: "dev", secretArn: `arn:aws:secretsmanager:us-west-2:${ACCT}:secret:x-AbC` };
const ATH = { workgroup: "bgp-athena-tgt-usw2-a", outputLocation: "s3://bgp-datalake-x/athena-results/", catalogRef: "s3tablescatalog/bgp-table-bucket-usw2a" };
const BASE = { v: 1, targetId: "tgt_usw2_a", region: "us-west-2" };
const FULL = { ...BASE, redshift: RS, athena: ATH };

/** 手写夹具:正例 + 两种语言真不一样的坑。 */
const HAND: Case[] = [
  { name: "最小(只有身份与区)", input: BASE },
  { name: "两条腿都有", input: FULL },
  { name: "数仓腿无凭证", input: { ...BASE, redshift: { workgroup: "wg", database: "db" } } },
  { name: "数据湖腿结果位置为空(工作组强制配置)", input: { ...BASE, athena: { ...ATH, outputLocation: "" } } },
  { name: "主控区", input: { v: 1, targetId: "tgt_home", region: "us-east-1", redshift: { workgroup: "bgp-workgroup", database: "dev" } } },
  { name: "JSON 文本输入", input: JSON.stringify(FULL), text: true },
  { name: "JSON 文本里 v 写成 1.0(两侧都读成 1)", input: '{"v":1.0,"targetId":"tgt_usw2_a","region":"us-west-2"}', text: true },
  { name: "坏 JSON 文本", input: "{not json", text: true },
  { name: "null", input: null },
  { name: "数组", input: [BASE] },
  { name: "v = true(Python 里 True == 1 的坑)", input: { ...BASE, v: true } },
  { name: "v = 2", input: { ...BASE, v: 2 } },
  { name: "区名带结尾换行(Python 的 $ 会匹配换行前)", input: { ...BASE, region: "us-west-2\n" } },
  { name: "区名带非 ASCII 数字(Python 的 \\d 默认认 Unicode)", input: { ...BASE, region: "us-west-٢" } },
  { name: "targetId 以下划线结尾", input: { ...BASE, targetId: "tgt_a_" } },
  { name: "secretArn 不是 Secrets Manager 的", input: { ...BASE, redshift: { ...RS, secretArn: "arn:aws:iam::1:role/x" } } },
  { name: "数仓腿是 null", input: { ...BASE, redshift: null } },
  { name: "字段是数字而不是字符串", input: { ...BASE, region: 7 } },
  { name: "字段是 null", input: { ...BASE, targetId: null } },
  { name: "两处错:先报顶层未知字段(校验顺序一致)", input: { ...BASE, zzz: 1, region: "bad" } },
];

/** 按 schema 机械派生的夹具(schema 改了这里自动跟着变)。 */
function derived(): Case[] {
  const out: Case[] = [];
  const objects: Array<[string, Record<string, any>, Record<string, unknown>]> = [
    ["$", SCHEMA, FULL],
    ["$.redshift", SCHEMA.properties.redshift, RS],
    ["$.athena", SCHEMA.properties.athena, ATH],
  ];
  const put = (path: string, mutate: (o: any) => void, name: string) => {
    const o = JSON.parse(JSON.stringify(FULL));
    const keys = path === "$" ? [] : path.slice(2).split(".");
    let cur = o;
    for (const k of keys) cur = cur[k];
    mutate(cur);
    out.push({ name, input: o });
  };
  for (const [path, schema, sample] of objects) {
    for (const req of schema.required as string[]) put(path, (c) => delete c[req], `[派生] 删必填 ${path}.${req}`);
    put(path, (c) => (c.__unknown = "x"), `[派生] ${path} 加未知字段`);
    for (const [k, p] of Object.entries(schema.properties as Record<string, any>)) {
      if (p.type === "string") put(path, (c) => (c[k] = 42), `[派生] ${path}.${k} 不是字符串`);
      if (p.pattern) put(path, (c) => (c[k] = "@@not-matching@@"), `[派生] ${path}.${k} 违反模式`);
      if (p.minLength) put(path, (c) => (c[k] = ""), `[派生] ${path}.${k} 空串`);
      if ("const" in p) put(path, (c) => (c[k] = "1"), `[派生] ${path}.${k} 不等于常量`);
      if (p.type === "object") put(path, (c) => (c[k] = "x"), `[派生] ${path}.${k} 不是对象`);
    }
    expect(Object.keys(sample).length, `${path} 的样本缺字段`).toBeGreaterThan(0);
  }
  return out;
}

const CASES: Case[] = [...HAND, ...derived()];

// ── 五个运行时的执行器 ────────────────────────────────────────────────────────
function tsOutcome(c: Case): Outcome {
  try {
    return { ok: readPlaceWire(c.input) };
  } catch (e) {
    if (e instanceof PlaceWireInvalid) return { error: e.path };
    throw e;
  }
}

/** 在子进程里跑一段 JS(NODE_PATH 指向平台的 node_modules:技能 Lambda 的 SDK 由 Lambda 运行时提供,本机借平台的)。 */
function runNode(script: string, input: unknown): any {
  const dir = mkdtempSync(join(tmpdir(), "kf-pw-node-"));
  const f = join(dir, "run.cjs");
  writeFileSync(f, script, "utf8");
  const out = execFileSync(process.execPath, [f], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: join(PLATFORM, "node_modules"), AWS_REGION: "eu-north-1" },
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

const JS_RUNNER = (modPath: string) => `
const m = require(${JSON.stringify(modPath)});
const cases = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = cases.map((c) => { try { return { ok: m.readPlaceWire(c.input) }; } catch (e) { if (e && e.code === "PLACE_WIRE_INVALID") return { error: e.path }; return { crash: String(e) }; } });
console.log(JSON.stringify(out));
`;

function extractPy(text: string, where: string): string {
  const i = text.indexOf(PLACE_WIRE_PY_BEGIN);
  const j = text.indexOf(PLACE_WIRE_PY_END);
  if (i < 0 || j < 0) throw new Error(`${where} 里没有嵌 PlaceWire 读取函数`);
  // 产物里它可能带缩进(本仓两处都在顶层,但抠的时候按首行缩进去掉,防将来挪进函数体后误判)
  const block = text.slice(i, j);
  const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", i) + 1, i))![0];
  return block.split("\n").map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
}

function runPy(src: string, cases: Case[]): Outcome[] {
  const dir = mkdtempSync(join(tmpdir(), "kf-pw-py-"));
  const f = join(dir, "run.py");
  writeFileSync(
    f,
    `${src}
import json as _j, sys as _s
_cases = _j.loads(_s.stdin.read())
_out = []
for _c in _cases:
    try:
        _out.append({"ok": bgp_read_place(_c["input"])})
    except BgpPlaceWireInvalid as _e:
        _out.append({"error": _e.path})
print(_j.dumps(_out))
`,
    "utf8"
  );
  const out = execFileSync("python3", [f], { input: JSON.stringify(cases), encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}

const glueScript = () =>
  generateGlueScript(
    { taskId: "t_pw", targetType: "redshift", sourceDatabase: "db", sourceTables: ["t"], redshiftConfig: { schema: "public" }, syncMode: "full", writeMode: "append" },
    { datasourceId: "ds", name: "s", type: "x-fixture", secretArn: `arn:aws:secretsmanager:us-west-2:${ACCT}:secret:s-AbC`, database: "db" } as unknown as DataSource,
    {
      landing: { targetId: "tgt_usw2_a", region: "us-west-2", datalakeBucket: "bgp-datalake-x", tableBucket: "tb" },
      rsb: { region: "us-west-2", workgroup: RS.workgroup, database: RS.database, secretArn: RS.secretArn },
    }
  );

let RESULTS: Record<string, Outcome[]> = {};

beforeAll(() => {
  RESULTS = {
    "① Node 平台": CASES.map(tsOutcome),
    "② AgentCore 容器(core-dist 产物)": runNode(JS_RUNNER(CONTAINER_DIST), CASES),
    "③ 技能 Lambda(core-dist 产物)": runNode(JS_RUNNER(LAMBDA_DIST), CASES),
    "④ 调度运行时(BGP_RUNTIME_PY 全文)": runPy(extractPy(BGP_RUNTIME_PY, "BGP_RUNTIME_PY"), CASES),
    "⑤ Spark 脚本(生成的 Glue 同步脚本全文)": runPy(extractPy(glueScript(), "Glue 同步脚本"), CASES),
  };
});

describe("🔴🔴 WP-31 L6:PlaceWire 五运行时同夹具同结果", () => {
  it("夹具面成立(派生夹具覆盖 schema 的每个必填 / 模式 / 未知字段;正反例都有)", () => {
    expect(CASES.length).toBeGreaterThan(40);
    const ref = RESULTS["① Node 平台"];
    expect(ref.filter((o) => "ok" in o).length, "正例太少").toBeGreaterThanOrEqual(7);
    expect(ref.filter((o) => "error" in o).length, "反例太少").toBeGreaterThanOrEqual(30);
  });

  for (const rt of [
    "② AgentCore 容器(core-dist 产物)",
    "③ 技能 Lambda(core-dist 产物)",
    "④ 调度运行时(BGP_RUNTIME_PY 全文)",
    "⑤ Spark 脚本(生成的 Glue 同步脚本全文)",
  ]) {
    it(`${rt} == ① Node 平台(逐条)`, () => {
      const ref = RESULTS["① Node 平台"];
      const got = RESULTS[rt];
      const diffs = CASES.map((c, i) => ({ c: c.name, want: ref[i], got: got[i] })).filter((d) => JSON.stringify(d.want) !== JSON.stringify(d.got));
      expect(diffs, JSON.stringify(diffs, null, 1)).toEqual([]);
    });
  }

  it("手写夹具的期望值(不只是「五者一致」—— 一致地错也要红)", () => {
    const ref = Object.fromEntries(CASES.map((c, i) => [c.name, RESULTS["① Node 平台"][i]]));
    expect(ref["两条腿都有"]).toEqual({ ok: FULL });
    expect(ref["JSON 文本里 v 写成 1.0(两侧都读成 1)"]).toEqual({ ok: BASE });
    expect(ref["v = true(Python 里 True == 1 的坑)"]).toEqual({ error: "$.v" });
    expect(ref["区名带结尾换行(Python 的 $ 会匹配换行前)"]).toEqual({ error: "$.region" });
    expect(ref["区名带非 ASCII 数字(Python 的 \\d 默认认 Unicode)"]).toEqual({ error: "$.region" });
    expect(ref["两处错:先报顶层未知字段(校验顺序一致)"]).toEqual({ error: "$.zzz" });
    expect(ref["数仓腿是 null"]).toEqual({ error: "$.redshift" });
    expect(ref["坏 JSON 文本"]).toEqual({ error: "$" });
  });
});

describe("🔴 schema 是单一真值:读取函数的模式与 schema 文件逐字相同,targetId 模式与注册表同一判据", () => {
  it("四个模式", () => {
    expect(SCHEMA.properties.targetId.pattern).toBe(PLACE_WIRE_TARGET_ID_PATTERN);
    expect(SCHEMA.properties.region.pattern).toBe(PLACE_WIRE_REGION_PATTERN);
    expect(SCHEMA.properties.redshift.properties.secretArn.pattern).toBe(PLACE_WIRE_SECRET_ARN_PATTERN);
    expect(SCHEMA.properties.athena.properties.outputLocation.pattern).toBe(PLACE_WIRE_S3_LOCATION_PATTERN);
    expect(SCHEMA.additionalProperties).toBe(false);
    expect(SCHEMA.properties.redshift.additionalProperties).toBe(false);
    expect(SCHEMA.properties.athena.additionalProperties).toBe(false);
  });
  it("targetId 模式 == isValidTargetId(判别样本)", () => {
    const re = new RegExp(PLACE_WIRE_TARGET_ID_PATTERN);
    for (const s of ["tgt_home", "tgt_usw2_a", "tgt_a", "tgt_a_", "tgt__a", "TGT_A", "tgt_a-b", "tgt_abcdefghijklmnop", "tgt_abcdefghijklmnopq", "tgt_"]) {
      expect(re.test(s), s).toBe(isValidTargetId(s));
    }
  });
  it("生产者自校验:坏值在平台这侧就拒(不让读取方去兜)", () => {
    expect(() => buildPlaceWire({ targetId: "tgt_usw2_a", region: "us-west-2", redshift: { workgroup: "", database: "dev" } })).toThrow(PlaceWireInvalid);
    expect(buildPlaceWire({ targetId: "tgt_usw2_a", region: "us-west-2", redshift: { workgroup: "w", database: "d", secretArn: null } })).toEqual({
      v: 1, targetId: "tgt_usw2_a", region: "us-west-2", redshift: { workgroup: "w", database: "d" },
    });
  });
});

describe("🔴 技能 Lambda 取腿后的形状(rs* / ath* 合并之后,工具实现拿到的仍是改动前那四样)", () => {
  it("placeOf / athPlaceOf:有腿 ⇒ 四样来自 PlaceWire;没有 place / 缺腿 ⇒ 拒,**不回落 env**(子进程 AWS_REGION 故意是别的区)", () => {
    const r = runNode(
      `
const H = require(${JSON.stringify(LAMBDA_RS)});
const run = (f, a) => { try { return { ok: H[f](a) }; } catch (e) { return { error: e.path || String(e) }; } };
const full = ${JSON.stringify(JSON.stringify(FULL))};
const onlyRs = ${JSON.stringify(JSON.stringify({ ...BASE, redshift: RS }))};
console.log(JSON.stringify([
  run("placeOf", { sql: "select 1", place: full }),
  run("athPlaceOf", { sql: "select 1", place: full }),
  run("placeOf", { sql: "select 1" }),
  run("athPlaceOf", { sql: "select 1", place: onlyRs }),
  run("placeOf", { sql: "select 1", rsRegion: "us-west-2", rsWorkgroup: "wg", rsDatabase: "dev" }),
]));
`,
      null
    );
    expect(r[0]).toEqual({ ok: { region: "us-west-2", workgroup: RS.workgroup, database: RS.database, secretArn: RS.secretArn } });
    expect(r[1]).toEqual({ ok: { region: "us-west-2", workgroup: ATH.workgroup, outputLocation: ATH.outputLocation, catalogRef: ATH.catalogRef } });
    expect(r[2], "没有 place ⇒ 拒(原来回落 env 的主控区)").toEqual({ error: "$" });
    expect(r[3], "缺数据湖腿 ⇒ 拒").toEqual({ error: "$.athena" });
    expect(r[4], "旧的平面字段不再被认(合并后只有 place)").toEqual({ error: "$" });
  });
});

describe("🔴 接线:跨运行时传落点的生产者都经 buildPlaceWire(只查调用位置,剥 import / 注释)", () => {
  const code = (rel: string) =>
    readFileSync(join(PLATFORM, "src", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      .replace(/^import [\s\S]*?;$/gm, "");
  it("调度 spec:ETL / EMR 两个生产者都写 place,且 spec 类型里没有旧的平面落点字段", () => {
    // 序 73 模块 57:spec 字面量(含 place)搬进两个 spec 单一作者 lib/etl/job-spec.ts / lib/engines/emr/job-spec.ts;
    //   扇出(dag-fanout / schedule-fanout)与工作流离线作业节点都只调它们 ⇒ 判据钉到作者 + 调用点两头
    expect(code("lib/etl/dag-fanout.ts")).toMatch(/serverlessJobSpecFor\(job, targetId, \{/);
    expect(code("lib/etl/job-spec.ts")).toMatch(/place: serverlessPlaceOf\(targetId, facts\.endpointRegion, job\.type === "redshift" \? facts\.binding : undefined\)/);
    expect(code("lib/etl/job-spec.ts")).toMatch(/return buildPlaceWire\(\{/);
    expect(code("lib/engines/emr/schedule-fanout.ts")).toMatch(/emrJobSpecFor\(job, targetId, \{/);
    expect(code("lib/engines/emr/job-spec.ts")).toMatch(/place: buildPlaceWire\(\{ targetId, region: facts\.region \}\)/);
    expect(code("lib/workflow/job-node-spec.ts")).toMatch(/serverlessJobSpecFor\(job, wfTarget, \{/);
    expect(code("lib/workflow/job-node-spec.ts")).toMatch(/emrJobSpecFor\(job, wfTarget, \{/);
    const spec = code("lib/scheduler/serverless/yaml-generator.ts");
    expect(spec).toMatch(/\bplace: PlaceWire;/);
    expect(spec, "旧的平面落点字段不许回来").not.toMatch(/\b(?:execRegion|workgroup|database|secretArn)\??:\s*string/);
  });
  it("问数 payload:placeWire 由 placeWireOfGenBi 产出并交给容器", () => {
    expect(code("lib/genbi/execute.ts")).toMatch(/const placeWire = placeWireOfGenBi\(place\);/);
    expect(code("lib/genbi/execute.ts")).toMatch(/invokeGenBiAgent\(sid, \{[^}]*placeWire \}/);
  });
  it("Spark 脚本:数仓落点以 PlaceWire 进脚本(生成期 buildPlaceWire 自校验)", () => {
    expect(code("lib/sync/glue-script-generator.ts")).toMatch(/const rsWire = writeRedshift && rsb\s*\?\s*buildPlaceWire\(/);
    expect(glueScript()).toMatch(/^_BGP_PLACE = bgp_read_place\("/m);
  });
});
