// @kf-batch 50-WP4ter-coverage
// 🔴🔴 **落点入参两侧必须一致**(2026-09-10 真环境抓到的静默跨区执行的门禁)。
//
// ── 那个 bug 长什么样 ────────────────────────────────────────────────────────
// 容器(`infra/agent/genbi/agent.js`)在唯一漏斗里给**每次**工具调用并进
// `rsRegion/rsWorkgroup/rsDatabase/rsSecretArn`;技能 Lambda(`infra/lambda/genbi-skills/rs.js`)
// 的 `placeOf(args)` 读这四个,读不到就回落自己的 env(= 主控区)。
// 中间还有一层:**AgentCore Gateway 按工具的 `InputSchema.Properties` 过滤入参** ——
// 没声明的属性**直接被丢掉**,两端代码都对、也不报错。
//
// 实测症状(最坏的组合):`introspect_redshift_schema` 的 schema 是**空 Properties**(不过滤)⇒
// 表结构正确地从 us-west-2 取回;而 `run_redshift_sql` 声明了 `{sql}` ⇒ 落点被过滤 ⇒
// 取数落回主控区 ⇒ 模型看到的是那个区的表、查的却是主控区,报「relation does not exist」
// **看起来像数据问题**,没有任何一处提到「区」。
//
// ⇒ 本门禁:Lambda 读的每一个落点入参,必须出现在**所有会执行 SQL 的工具**的 InputSchema 里。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../../..");
const RS_JS = resolve(REPO, "infra/lambda/genbi-skills/rs.js");
const AGENT_JS = resolve(REPO, "infra/agent/genbi/agent.js");
const STACK_TS = resolve(REPO, "infra/lib/agentcore-stack.ts");

/** 函数体(从 `function <name>(` 到下一个顶层 `\n}`)。 */
function fnBody(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\n}", i);
  return src.slice(i, j < 0 ? undefined : j);
}

/**
 * Lambda 侧真正读的落点入参(从 `wireOf` 的实现里抽,不写死清单)。
 * @kf-batch 50-WP31-place-first-class —— 序 4(L6):rs* / ath* 八个平面字段已合并成一个 `place`(PlaceWire v1)。
 *   抽取器仍按「Lambda 读了哪些 `a.<键>`」抽 —— 谁再往回加一个平面落点字段,下面「只许一个」那条就红。
 */
function placeArgsReadByLambda(): string[] {
  const src = readFileSync(RS_JS, "utf8");
  const body = fnBody(src, "wireOf"); // 唯一读工具入参的函数(placeOf / athPlaceOf 只从它的结果里取腿)
  return Array.from(new Set(Array.from(body.matchAll(/\ba\.([A-Za-z]+)\b/g)).map((m) => m[1]))).sort();
}

/** 容器侧真正注入的落点入参(`placeArgs` 对象字面量里的键)。 */
function placeArgsInjectedByContainer(): string[] {
  const src = readFileSync(AGENT_JS, "utf8");
  const m = /const placeArgs = \{([^}]*)\}/.exec(src);
  if (!m) return [];
  return Array.from(m[1].matchAll(/(\w+)\s*:/g)).map((x) => x[1]).sort();
}

describe("agentcore-place-schema(落点入参三侧一致)", () => {
  it("门禁自检:三个文件都读得到、且抽取器真抽到了东西(否则下面全是空断言)", () => {
    expect(placeArgsReadByLambda().length).toBeGreaterThanOrEqual(1);
    expect(placeArgsInjectedByContainer().length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(STACK_TS, "utf8").length).toBeGreaterThan(1000);
  });

  it("🔴🔴 序 4(L6):落点只有**一个**入参 `place`(rs* / ath* 已合并);两条腿都经它(B-26:原来数据湖那条腿整条没有落点)", () => {
    expect(placeArgsReadByLambda()).toEqual(["place"]);
    const rs = readFileSync(RS_JS, "utf8");
    expect(fnBody(rs, "placeOf"), "数仓腿必须经 placeWireLeg 取").toMatch(/placeWireLeg\(w, "redshift"\)/);
    expect(fnBody(rs, "athPlaceOf"), "数据湖腿必须经 placeWireLeg 取").toMatch(/placeWireLeg\(w, "athena"\)/);
    expect(fnBody(rs, "wireOf"), "必须经同源读取函数").toMatch(/readPlaceWire\(a\.place\)/);
    // 🔴 负向:平面落点字段 / env 主控区缺省不许复活
    expect(rs).not.toMatch(/\ba\.(?:rs|ath)[A-Z]\w*/);
    expect(rs).not.toMatch(/process\.env\.(?:REDSHIFT_WORKGROUP|REDSHIFT_DATABASE|ATHENA_WORKGROUP)\b/);
  });

  it("🔴 容器注入的 == Lambda 读取的(少一个就是那一样落点被静默丢掉)", () => {
    expect(placeArgsInjectedByContainer()).toEqual(placeArgsReadByLambda());
    const agent = readFileSync(AGENT_JS, "utf8");
    expect(agent, "容器必须用同源读取函数校验 payload 里的 placeWire(缺 / 不合法即拒)").toMatch(/const placeWire = readPlaceWire\(input && input\.placeWire\)/);
    expect(agent).toMatch(/const placeArgs = \{ place: JSON\.stringify\(placeWire\) \}/);
    expect(agent).toMatch(/from "\.\/core-dist\/place-wire\.js"/);
    expect(readFileSync(resolve(REPO, "infra/agent/genbi/index.js"), "utf8"), "入口必须把 placeWire 透传给 runAgent").toMatch(/placeWire: input\.placeWire/);
  });

  it("🔴🔴 Gateway 的 InputSchema 必须声明全部落点入参(没声明 = 被 Gateway 过滤掉 = 静默跨区执行)", () => {
    const stack = readFileSync(STACK_TS, "utf8");
    const missing = placeArgsReadByLambda().filter((a) => !new RegExp(`${a}\\s*:\\s*\\{\\s*Type: "string"`).test(stack));
    expect(
      missing,
      `这些落点入参没在 agentcore-stack 的工具 InputSchema 里声明:${missing.join(", ")} —— ` +
        `Gateway 会把它们丢掉,取数就静默回落到主控区`
    ).toEqual([]);
    expect(stack, "旧的平面落点声明不许留着(留着 = 有人还会往里注入)").not.toMatch(/\b(?:rs|ath)(?:Region|Workgroup|Database|SecretArn|Output|CatalogRef)\s*:\s*\{/);
  });

  it("🔴 会执行 SQL 的工具都必须带上落点声明(逐个工具核对,不许只改一个)", () => {
    const stack = readFileSync(STACK_TS, "utf8");
    // `sqlTool(...)` 工厂共享同一份 schema ⇒ 只要工厂里有 PLACE_PROPS,两个 SQL 工具都覆盖到
    expect(/const sqlTool[\s\S]{0,400}PLACE_PROPS/.test(stack), "sqlTool 工厂没有并进 PLACE_PROPS").toBe(true);
    // 注册技能是另一处**独立**写的 schema,最容易漏
    const skillBlock = stack.slice(stack.indexOf('Name: "run_registered_skill"'), stack.indexOf('Name: "run_registered_skill"') + 900);
    expect(skillBlock.includes("PLACE_PROPS"), "run_registered_skill 的 schema 漏了落点声明(技能路径会静默跨区)").toBe(true);
  });

  it("🔴🔴 落点注入必须在**唯一漏斗**里 —— 全文件对 Gateway 的调用只许有一处", () => {
    const src = readFileSync(AGENT_JS, "utf8");
    // 剥注释再数(注释里写着 `mcp.callTool(` 的说明,不该被算成调用点)
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const sites = Array.from(code.matchAll(/mcp\.callTool\(/g)).length;
    expect(
      sites,
      "🔴 `mcp.callTool(` 出现在多处 —— 2026-09-10 真环境就是这么坏的:落点只在 `tracedCall` 里并进," +
        "而**模型驱动的工具循环**是另一处调用点、没并 ⇒ 探查表结构去了对的区、真正取数的 SQL 落回主控区," +
        "报「relation does not exist」看起来像数据问题。所有调用必须经同一个出口。"
    ).toBe(1);
    // 那个唯一出口必须真的并了落点
    expect(/const callTool = async[\s\S]{0,300}\.\.\.placeArgs/.test(code), "唯一出口没有并进 placeArgs").toBe(true);
    // 模型驱动的循环必须走它(而不是直连 mcp)
    expect(/res = await callTool\(t\.name, args\)/.test(code), "模型驱动的工具循环没走唯一出口").toBe(true);
  });
});
