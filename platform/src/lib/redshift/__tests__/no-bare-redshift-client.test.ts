// 🔴 门票 T0:**裸 `new RedshiftDataClient(...)` 门禁**(50 ROADMAP §2octies.17 ⑧)。
//
// 【为什么现在就要有它】W3-f 的主体是把 21 处「按 home 的 AWS_REGION 建 Redshift 客户端」的站点
// 收编到 `redshiftDataClientFor(region)` / `redshiftClientForTarget(targetId)`。收编排队期间,
// 那 21 处**还能继续长**(仓里此前 **0 条**门禁)。这条门禁做两件事:
//   ① 新增即红:任何白名单之外的文件出现裸构造、或白名单文件里数量**变多**,当场红;
//   ② 收敛可度量:白名单里每一项的数量必须**恰好**等于登记值 —— W3-f 每收编一处就删一行 / 减一个数,
//      名单腐烂成永久豁免这件事在结构上不可能(与 warehouse-location 的反向覆盖同一手法)。
//
// 🔴 唯一合法的构造点是工厂 `lib/exec-env/target-clients.ts`(按 region 缓存;缓存键只有 region,
//    客户端不承载任何项目 / 权限语义)。别的地方要客户端,一律从工厂拿。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const INFRA = resolve(SRC, "../../infra");

/**
 * 唯一允许构造 Redshift Data 客户端的地方(工厂本身)。
 * L3:构造收到数据面客户端的唯一工厂 `lib/aws/clients.ts`;
 * `target-clients.ts` 的 `redshiftDataClientFor` 变成薄委托(下面另有一条钉它不许再自己 new)。
 */
const FACTORY = "lib/aws/clients.ts";

/**
 * 🔴 **冻结名单:文件 → 现存裸构造数**。
 *
 * ✅ **2026-09-收编完成:清零。** 全仓唯一的构造点是工厂 `lib/exec-env/target-clients.ts`。
 * 名单留在这里(而不是把整段删掉)是**有意的**:它是那条「新增即红」判据的载体 ——
 * 任何文件重新长出裸构造,census 与名单对不上,当场红。往里加一行需要写理由。
 */
const BARE_ALLOWLIST: Record<string, number> = {};

/**
 * 🔴 **合同规定只能在主控区跑的清单**(「home-only 清单必须恰好命中」)。
 *
 * 为什么要逐条冻结:`redshiftClientForHomeOnly(reason)` 与「忘了按 target 取 region」在**行为上
 * 完全一样**(都打到主控区)—— 区别只在于前者是合同。若不把清单钉住,这个函数就会变成
 * 一个方便的后门:下一个人赶时间时写一句 `redshiftClientForHomeOnly("sync-no-target-dim")`,
 * 于是一条本该按 target 走的路径悄悄退回主控区,而且**读代码的人会以为那是合同**。
 *
 * ⇒ 文件 → 该文件里出现的理由(重复次数按出现次数计)。加一处必须同时改这张表 = 一次合同评审。
 */
const HOME_ONLY_CENSUS: Record<string, string[]> = {
  // sync/execute-ddl 与 sync/generate-ddl 两行已删
  // 理由值 `sync-no-target-dim` 退役(两路由改走 resolveRedshiftBinding 按 targetId 落点)。棘轮只减。
  // 2026-11-04(2026-11-04)—— lib/backfill/execute.ts 一行已删:理由值 `workflow-no-target-dim` 退役(补数 SQL 节点按实例的区走
  // resolveRedshiftBinding + redshiftDataClientFor(binding.region);「只支持主控区」守卫同笔删除)。棘轮只减:清单从 4 个文件 6 处 → 3 个文件 5 处。
  // lib/modeling/redshift.ts 一行已删(理由值退役:非 home 建模落地交付)。
  "lib/projects/project-resources.ts": ["project-inventory"],
  "lib/realtime/redshift-target.ts": ["dms-bootstrap-home"],
  "lib/realtime/zeroetl-service.ts": [
    "zeroetl-home-namespace",
    "zeroetl-home-namespace",
    "zeroetl-home-namespace",
  ],
  // 出口自己(声明 + 实现),不是调用点
  "lib/exec-env/target-clients.ts": [],
};

/** infra 侧的裸构造(Lambda 跑在 home,按其部署 region 建客户端是它的语义;同样冻结,新增即红)。 */
const INFRA_ALLOWLIST: Record<string, number> = {
  "lambda/genbi-skills/rs.js": 1,
};

const BARE = /new\s+RedshiftDataClient\s*\(/g;

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "cdk.out", "__tests__", ".next", "core-dist"].includes(e.name)) continue;
      walk(p, exts, out);
    } else if (exts.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 🔴 先剥注释:说明文字里引用被禁形状是正当的(工厂文件头就写着它),不剥就把说明当违规。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
}

function countBare(file: string): number {
  return (stripComments(readFileSync(file, "utf8")).match(BARE) ?? []).length;
}

function census(root: string, files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const n = countBare(f);
    if (n > 0) out[relative(root, f).split("\\").join("/")] = n;
  }
  return out;
}

describe("🔴 T0:裸 `new RedshiftDataClient` 门禁(允许列表冻结,新增即红、收编必删行)", () => {
  const platformFiles = walk(SRC, /\.tsx?$/);

  it("扫描面本身要成立(一个文件都没扫到 = 门禁在测空气)", () => {
    expect(platformFiles.length).toBeGreaterThan(300);
  });

  it("工厂文件**恰好 1 处**构造 —— 它是唯一合法的构造点", () => {
    expect(countBare(resolve(SRC, FACTORY))).toBe(1);
  });

  it("target-clients 的 redshiftDataClientFor 只委托唯一工厂(自己一处都不构造)", () => {
    expect(countBare(resolve(SRC, "lib/exec-env/target-clients.ts"))).toBe(0);
    expect(stripComments(readFileSync(resolve(SRC, "lib/exec-env/target-clients.ts"), "utf8"))).toMatch(
      /export function redshiftDataClientFor\(region: string\): RedshiftDataClient \{\s*return redshiftDataClient\(region\);/
    );
  });

  it("🔴 platform/src:白名单之外零命中;白名单之内数量不许**变多**", () => {
    const got = census(SRC, platformFiles);
    delete got[FACTORY];
    const offenders: string[] = [];
    for (const [rel, n] of Object.entries(got)) {
      const allowed = BARE_ALLOWLIST[rel];
      if (allowed === undefined) offenders.push(`${rel}(新增 ${n} 处)`);
      else if (n > allowed) offenders.push(`${rel}(登记 ${allowed} 处,现 ${n} 处)`);
    }
    expect(
      offenders,
      `这些地方长出了新的裸 Redshift 客户端,应改用 @/lib/exec-env/target-clients 的 redshiftDataClientFor / redshiftClientForTarget:${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("🔴 收敛可度量:白名单每一项必须**恰好**命中登记数(收编了就删行 / 减数,名单不许腐烂)", () => {
    const got = census(SRC, platformFiles);
    const stale: string[] = [];
    for (const [rel, allowed] of Object.entries(BARE_ALLOWLIST)) {
      const n = got[rel] ?? 0;
      if (n !== allowed) stale.push(`${rel}(登记 ${allowed},实测 ${n})`);
    }
    expect(stale, "白名单与实测不一致 ⇒ 更新登记数(收编成功就减,减到 0 删行)").toEqual([]);
  });

  it("✅ 总量对账:平台侧裸构造 == 白名单合计(现为 **0**),再加工厂 1 处 = 1", () => {
    const got = census(SRC, platformFiles);
    const total = Object.values(got).reduce((a, b) => a + b, 0);
    const allowedTotal = Object.values(BARE_ALLOWLIST).reduce((a, b) => a + b, 0);
    expect(total).toBe(allowedTotal + 1);
    // 🔴 T0 的终点(①「名单清零,只剩工厂 1 处」)—— 写成断言而不是注释,
    //    否则将来有人往名单里加一行、总量对账仍然过,清零这件事就悄悄作废了。
    expect(allowedTotal, "BARE_ALLOWLIST 必须保持清零:唯一构造点是工厂").toBe(0);
    expect(total, "全仓裸构造总数 = 1(工厂自己)").toBe(1);
  });

  it("🔴 home-only 清单**恰好命中**(这个函数不许变成绕过 per-target 的后门)", () => {
    const HOME_ONLY = /redshiftClientForHomeOnly\(\s*"([a-z0-9-]+)"\s*\)/g;
    const got: Record<string, string[]> = {};
    for (const f of platformFiles) {
      const code = stripComments(readFileSync(f, "utf8"));
      const hits = [...code.matchAll(HOME_ONLY)].map((m) => m[1]);
      if (hits.length) got[relative(SRC, f).split("\\").join("/")] = hits;
    }
    const expected: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(HOME_ONLY_CENSUS)) if (v.length) expected[k] = v;
    expect(got, "home-only 调用点与冻结清单不一致 ⇒ 要么改回按 target 取 region,要么改这张表(= 一次合同评审)").toEqual(expected);
  });

  it("门禁自检:home-only 探测器真能抓到新增调用点", () => {
    const HOME_ONLY = /redshiftClientForHomeOnly\(\s*"([a-z0-9-]+)"\s*\)/g;
    const fake = 'const c = redshiftClientForHomeOnly("sync-no-target-dim");';
    expect([...fake.matchAll(HOME_ONLY)].map((m) => m[1])).toEqual(["sync-no-target-dim"]);
    // 注释里提到不算(与裸构造探测同一条剥注释纪律)
    expect([...stripComments('// redshiftClientForHomeOnly("x")').matchAll(HOME_ONLY)]).toHaveLength(0);
  });

  it("infra 侧同样冻结(lambda / lib / agent):新增即红", () => {
    const files = walk(INFRA, /\.(m?js|ts)$/).filter((f) => /\/(lambda|lib|agent)\//.test(f));
    const got = census(INFRA, files);
    expect(got).toEqual(INFRA_ALLOWLIST);
  });
});
