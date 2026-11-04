// 命名 SSOT **反向覆盖**门禁。
//
// 【为什么必须有反向门禁】
//   正向测试只能证明"我登记的这些 kind 名字对"。它永远证明不了"我没漏登记资源" ——
//   而漏登记的后果正是本模块要解决的病:建第二个 region 时,某个资源名没经 SSOT、
//   在栈里被硬编码成 home 的固定名 ⇒ 要么撞名建不出来,要么两个 target 共用一个资源(跨 target 串数据)。
//   所以这里反过来扫:**infra/lib 里每一个 `bgp-*` 名字面量,都必须有归属** ——
//   要么被某个 kind 以 isHome:true 复现,要么进 naming.json 的 notCovered 并写明原因。
//   🔴 门禁的价值全在"不许留白":不许"就它一个特殊,先不管"。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";
import { resourceName, RESOURCE_KINDS } from "@/lib/aws/naming";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { TABLES } from "@/lib/aws/dynamodb";
import namingConfig from "../../../../naming.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const INFRA_LIB = resolve(REPO, "infra/lib");
const ACCOUNT = "123456789012";

type Rule = { scope: string; vars: string[]; home: string; target: string; maxLength: number };
const KINDS = namingConfig.kinds as unknown as Record<string, Rule>;
const NOT_COVERED = namingConfig.notCovered as unknown as {
  ddbTables: { reason: string; outsideTablesConstant: { absorbedBy: string; names: string[] } };
  controlPlaneOnly: { reason: string; names: string[] };
  // 已下线能力留在 infra 的 RETAIN 表(数据服务三张,50 SPEC §3.9c)
  retired: { reason: string; names: string[]; retiredOn: string };
  agentcore: { reason: string; pattern: string };
  prose: { tokens: string[]; reasons: Record<string, string> };
  pendingRegionalization: { items: { name: string; reason: string; absorbedBy: string; source: string }[] };
};

/** 递归收集 infra/lib 下的 .ts(cdk.out / dist 不在这棵树里,但仍显式排掉以防将来挪动)。 */
function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "cdk.out" || e === "dist" || e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (e.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * 剥注释,但**不许剥错**。
 *
 * 🔴 第一版写的是 `text.replace(/\/\*[\s\S]*?\*\//g, "")` —— 门禁一上就自己打自己:
 *    IAM 策略里满是 `"arn:aws:s3:::bucket/*"` 这种字符串,里面的 `/*` 被当成块注释起点,
 *    一路吃到下一个「块注释结束符」,**整段代码被删掉** ⇒ `bgp-glue-role` 明明在 platform-stack.ts:88,
 *    却被判成"infra 里不存在的幽灵资源"。这正是"门禁假阴性"那一类(AUDIT-SCOPE §1.1 的 A 类 No-Go 之一)。
 * ⇒ 必须做**最小限度的词法扫描**:知道自己在字符串/模板/正则里,就不把 `/*`、`//` 当注释。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";
  let mode: Mode = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        mode = c;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        i += 2;
      } else {
        if (c === "\n") out += c; // 保住行数,便于人工定位
        i++;
      }
      continue;
    }
    // 在字符串/模板里:处理转义,遇到同款引号收尾
    if (c === "\\") {
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    out += c;
    if (c === mode) mode = "code";
    i++;
  }
  return out;
}

/** 找出所有 `"bgp-xxx"` 定值字面量 与 `` `bgp-xxx${…}` `` 模板前缀。 */
function collectNames(): {
  literals: Map<string, string[]>;
  templates: Map<string, string[]>;
  /** 🔴 v2 加宽:`bgp-` 出现在字符串**中部**的整条字面量(如 `alias/bgp-data`、`redshift!bgp-namespace-admin`)。 */
  midString: Map<string, string[]>;
} {
  const literals = new Map<string, string[]>();
  const templates = new Map<string, string[]>();
  const midString = new Map<string, string[]>();
  for (const f of tsFiles(INFRA_LIB)) {
    const rel = relative(REPO, f);
    // 注释里提到某个名字不算"代码在用它"(与 cross-module cast 门禁同一教训:先剥注释再扫)。
    const text = stripComments(readFileSync(f, "utf8"));
    for (const m of text.matchAll(/"(bgp-[a-z0-9-]*)"/g)) {
      const arr = literals.get(m[1]) ?? [];
      if (!arr.includes(rel)) arr.push(rel);
      literals.set(m[1], arr);
    }
    for (const m of text.matchAll(/`(bgp-[a-z0-9-]*?)-\$\{/g)) {
      const arr = templates.get(m[1]) ?? [];
      if (!arr.includes(rel)) arr.push(rel);
      templates.set(m[1], arr);
    }
    // 🔴 v2:`bgp-` 不在开头的字面量 —— v1 只扫 /"(bgp-…)"/,于是 `"alias/bgp-data"`(KMS 别名,
    //    region 级唯一名、同区两 target 必撞)整条溜过去。切片 a 自建 KMS 时才发现,已补登记。
    for (const m of Array.from(text.matchAll(/"([^"\n]*bgp-[^"\n]*)"/g))) {
      const arr = midString.get(m[1]) ?? [];
      if (!arr.includes(rel)) arr.push(rel);
      midString.set(m[1], arr);
    }
  }
  return { literals, templates, midString };
}

const { literals, templates, midString } = collectNames();

/** kind → home 名(定值);带 {account} 的 kind 另算前缀。 */
function homeNames(): { exact: Set<string>; prefixes: Set<string> } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const kind of RESOURCE_KINDS) {
    const rule = KINDS[kind];
    const vars: Record<string, string> = { targetId: HOME_TARGET_ID };
    if (rule.vars.includes("account")) vars.account = ACCOUNT;
    if (rule.vars.includes("component")) vars.component = "core";
    const name = resourceName(kind, vars as never);
    if (rule.home.includes("{account}")) prefixes.add(rule.home.replace("-{account}", ""));
    else exact.add(name);
  }
  return { exact, prefixes };
}

const HOME = homeNames();
const DDB_NAMES = new Set<string>([
  ...(Object.values(TABLES) as string[]),
  // 既有缺口:这 6 张表在 CDK/platform 各写一份字面量、不在 TABLES 里(见 naming.json 的说明)。
  ...NOT_COVERED.ddbTables.outsideTablesConstant.names,
]);
const CONTROL_PLANE = new Set(NOT_COVERED.controlPlaneOnly.names);
// 已下线能力的 RETAIN 表:infra 保留定义、platform 已不再认识(TABLES 常量删了),归属由这里给。
const RETIRED = new Set(NOT_COVERED.retired.names);
/** 将来要带 target 维、只是排在后面批次的名字(推迟 ≠ 免除:必须写明由哪一批吸收)。 */
const PENDING = new Set(NOT_COVERED.pendingRegionalization.items.map((i) => i.name));
const AGENTCORE_RE = /^bgp-[a-z0-9-]+-(agent|gateway|skills|memory-role|runtime-role|gateway-role)$/;

/** 一个名字的归属;null = 无归属(门禁要红)。 */
function classify(name: string): string | null {
  if (HOME.exact.has(name)) return "naming.json kind(定值 home 名)";
  if (DDB_NAMES.has(name)) return "notCovered.ddbTables(TABLES 常量)";
  if (CONTROL_PLANE.has(name)) return "notCovered.controlPlaneOnly";
  if (RETIRED.has(name)) return "notCovered.retired(已下线能力的 RETAIN 表)";
  if (PENDING.has(name)) return "notCovered.pendingRegionalization(已登记吸收批次)";
  if (AGENTCORE_RE.test(name)) return "notCovered.agentcore";
  return null;
}

describe("🔴 反向覆盖:infra/lib 里每个 bgp-* 名字面量都必须有归属", () => {
  /**
   * 🔴 通用兜底:剥注释**不许吃掉真代码**。
   *
   * 具体那个 `"…bucket/<星>"` 的坑已用词法扫描修掉,但"剥注释吃掉真代码"是一**整类**假阴性
   * (正则字面量含 `//`、模板串含块注释起点、……)。判据取**精确**的那一条,不猜比例:
   *   凡"原文里出现、剥完不见了、而它所在的原文行**不是注释行**"的 `bgp-*` 名 = 代码被吃了。
   * (注释行 = trim 后以 `//` 或 `*` 开头,覆盖行注释与标准 JSDoc 续行;
   *  非标准写法的块注释内容会被判成可疑 —— 方向安全,宁可红。)
   * ⚠️ 比例式阈值试过,不成立:`infra/lib/shared/model.ts` 本身 65% 是注释,会误报。
   */
  it("🔴 剥注释不许吃掉真代码(整类假阴性的精确兜底)", () => {
    const eaten: string[] = [];
    for (const f of tsFiles(INFRA_LIB)) {
      const raw = readFileSync(f, "utf8");
      const kept = stripComments(raw);
      raw.split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) return; // 注释行,本就该被剥掉
        for (const m of Array.from(line.matchAll(/"(bgp-[a-z0-9-]*)"/g))) {
          if (!kept.includes(m[0])) eaten.push(`${relative(REPO, f)}:${i + 1} 的 ${m[0]} 被剥没了`);
        }
      });
    }
    expect(eaten, "剥注释把非注释行的名字吃掉了 ⇒ 反向覆盖会漏扫(门禁假阴性):\n" + eaten.join("\n")).toEqual([]);
  });

  it("扫到的字面量数量合理(扫空了说明正则/路径坏了 = 假绿)", () => {
    expect(literals.size, "infra/lib 下 bgp-* 定值字面量").toBeGreaterThan(80);
    expect(templates.size, "infra/lib 下 bgp-* 模板前缀").toBeGreaterThan(3);
  });

  it("🔴 定值字面量:零个无归属", () => {
    const orphans: string[] = [];
    for (const [name, files] of [...literals].sort()) {
      if (classify(name) === null) orphans.push(`${name}  ←  ${files.join(", ")}`);
    }
    expect(
      orphans,
      "这些名字既不在 naming.json 的 kind 里、也不在 notCovered 里 ⇒ " +
        "要么补进 naming.json(它有 target 维),要么补进 notCovered 并写原因。不许留白。\n" +
        orphans.join("\n")
    ).toEqual([]);
  });

  it("🔴 模板前缀(`bgp-xxx-${…}`):零个无归属", () => {
    const orphans: string[] = [];
    for (const [prefix, files] of [...templates].sort()) {
      if (HOME.prefixes.has(prefix)) continue;
      // CloudTrail 桶等控制面桶:前缀形态但归控制面
      if (CONTROL_PLANE.has(prefix) || PENDING.has(prefix)) continue;
      if (prefix === "bgp") continue; // `bgp-${capabilityId}-…`(AgentCore 派生)
      orphans.push(`${prefix}-\${…}  ←  ${files.join(", ")}`);
    }
    expect(orphans, "模板前缀无归属:\n" + orphans.join("\n")).toEqual([]);
  });

  it("🔴 反向的反向:naming.json 里登记的 home 定值名,必须真的在 infra/lib 出现过(防登记幽灵资源)", () => {
    const ghosts: string[] = [];
    for (const kind of RESOURCE_KINDS) {
      const rule = KINDS[kind];
      if (rule.home.includes("{")) continue; // 带变量的另有 naming.test.ts 的出处断言
      if (kind === "stackName") continue; // 执行环境栈组是全新栈,infra 里还没有(才建)
      const name = resourceName(kind, { targetId: HOME_TARGET_ID });
      // 不是 `bgp-` 开头的名字(如 Redshift 默认库 `dev`)不在 literals 索引里 —— 单独去它登记的出处文件里找。
      // infra 侧若已改为**从命名 SSOT 派生**(resourceName("<kind>", …)),则"名字存在"由构造保证,
      // 不该再要求源码里出现字面量(要求字面量反而会逼人把刚收编掉的硬编码写回去)。
      const homeSrc = (namingConfig.kinds as never as Record<string, { homeSource?: string }>)[kind]?.homeSource;
      const homeText = homeSrc?.startsWith("infra/") ? readFileSync(resolve(REPO, homeSrc.split(":")[0]), "utf8") : "";
      if (new RegExp(`resourceName\\(\\s*["'\`]${kind}["'\`]`).test(homeText)) continue;
      if (name.startsWith("bgp-")) {
        if (!literals.has(name)) ghosts.push(`${kind} → "${name}"`);
      } else {
        const src = (namingConfig.kinds as never as Record<string, { homeSource?: string }>)[kind]?.homeSource;
        const text = src?.startsWith("infra/") ? readFileSync(resolve(REPO, src.split(":")[0]), "utf8") : "";
        if (!text.includes(`"${name}"`)) ghosts.push(`${kind} → "${name}"(出处 ${src ?? "未登记"})`);
      }
    }
    expect(ghosts, "naming.json 登记了 infra 里根本不存在的名字:\n" + ghosts.join("\n")).toEqual([]);
  });

  it("🔴 v2 加宽:每条字面量里的**每个 `bgp-` token** 都必须有归属(v1 只扫开头 ⇒ 漏掉 alias/bgp-data)", () => {
    // 🔴 判据是 **token 级精确匹配**,不是"整条字面量"、也不是"包含关系":
    //   · 整条比对挡不住 `om-ingestion-stack.ts` 里嵌入的 Python(一整段配置里混着好几个名字);
    //   · "包含关系"太松 —— OM 的逻辑 service 名 `bgp-glue` 会被 kind 的 `bgp-glue-role` 一口吞掉,
    //     于是"OM service 名还没 target 维"这个真缺口被静默放过。
    const accepted = new Set<string>();
    for (const name of [...HOME.exact]) {
      accepted.add(name);
      const at = name.indexOf("bgp-");
      if (at > 0) accepted.add(name.slice(at)); // `alias/bgp-data` → 也接受裸 token `bgp-data`
    }
    for (const n of DDB_NAMES) accepted.add(n);
    for (const n of CONTROL_PLANE) accepted.add(n);
    for (const n of RETIRED) accepted.add(n);
    for (const n of PENDING) accepted.add(n);
    for (const p of HOME.prefixes) accepted.add(p); // 带 {account} 的桶前缀
    const proseTokens = new Set(NOT_COVERED.prose.tokens);

    const orphans: string[] = [];
    for (const [lit, files] of [...midString].sort()) {
      for (const m of Array.from(lit.matchAll(/bgp-[a-z0-9-]*/g))) {
        const tok = m[0];
        if (accepted.has(tok) || proseTokens.has(tok) || AGENTCORE_RE.test(tok)) continue;
        orphans.push(`${tok}  ←  "${lit.slice(0, 60)}"  @ ${files.join(", ")}`);
      }
    }
    expect(
      [...new Set(orphans)].sort(),
      "这些 bgp- token 没有归属 ⇒ 是资源名就补 naming.json 的 kind / 要晚点做就进 pendingRegionalization / " +
        "是文案或正则就进 notCovered.prose.tokens 并写原因。不许留白。\n" +
        [...new Set(orphans)].sort().join("\n")
    ).toEqual([]);
  });

  it("🔴 prose 白名单:每个 token 都要写原因,且必须真的还在代码里(过期条目要删,不当免罪符)", () => {
    const all = [...midString.keys()].join("\n");
    for (const tok of NOT_COVERED.prose.tokens) {
      expect((NOT_COVERED.prose.reasons[tok] ?? "").length, `${tok} 没写原因`).toBeGreaterThan(10);
      expect(all.includes(tok), `${tok} 已不在代码里 —— 请从 prose 白名单删掉`).toBe(true);
    }
  });

  it("notCovered 的三类都写了原因(不许只列名单不写为什么)", () => {
    expect(NOT_COVERED.ddbTables.reason.length).toBeGreaterThan(10);
    expect(NOT_COVERED.controlPlaneOnly.reason.length).toBeGreaterThan(10);
    expect(NOT_COVERED.retired.reason.length).toBeGreaterThan(10);
    expect(NOT_COVERED.retired.retiredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 已下线的表**不许**再回到 TABLES 常量(回来 = 有代码又认识它 = 能力没真下线)。
    expect(NOT_COVERED.retired.names.filter((n) => (Object.values(TABLES) as string[]).includes(n))).toEqual([]);
    expect(NOT_COVERED.agentcore.reason.length).toBeGreaterThan(10);
  });

  it("🔴 既有缺口不许悄悄变长:不在 TABLES 常量里的表名,名单必须与实测一致且写明吸收去向", () => {
    const gap = NOT_COVERED.ddbTables.outsideTablesConstant;
    expect(gap.absorbedBy).toMatch(/^multi-region-execution\/[a-z-]+$/);
    // 实测:名单里的每一张,现在确实不在 TABLES 里(修好了就该从名单里删,而不是留着当免罪符)。
    const inTables = gap.names.filter((n) => (Object.values(TABLES) as string[]).includes(n));
    expect(inTables, "这些已经进 TABLES 了,请从 outsideTablesConstant 名单里删掉").toEqual([]);
    expect(gap.names.length, "缺口只许缩短").toBeLessThanOrEqual(6);
  });

  it("🔴 推迟 ≠ 免除:pendingRegionalization 每条都必须写明由哪一项吸收 + 原因 + 出处", () => {
    const items = NOT_COVERED.pendingRegionalization.items;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.absorbedBy, `${it.name} 没写吸收去向`).toMatch(/^multi-region-execution\/[a-z-]+$/);
      expect(it.reason.length, `${it.name} 没写原因`).toBeGreaterThan(10);
      expect(it.source.startsWith("infra/"), `${it.name} 没写出处`).toBe(true);
    }
  });
});
