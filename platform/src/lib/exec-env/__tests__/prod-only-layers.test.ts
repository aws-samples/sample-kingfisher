// 🔴🔴 **「只有真部署才会执行的层」的覆盖面门禁**(台账 `infra/prod-only-layers.json`)。
//
// 【为什么存在 —— 用户 2026-09-15:「这些最关键的环节一定要做到万无一失…你每次都是边修边产生 bug」】
//   同日实证:执行环境初始化的 buildspec **build 段**从来没有任何东西执行过它 ⇒
//   `read -r a b c < file`(文件无行尾换行时返回非 0)让 `set -euo pipefail` 当场杀掉整个 build,
//   而 tsc 0 / 3305 单测 / 全量 synth 门禁**全绿**。缺陷不长在代码里,长在**没有离线执行者的那一层**。
//   这类层每暴露一个缺陷 = 一次真部署(40–60 分钟)。
//
// 【本门禁做四件事】
//   ① **自己发现**候选层(4 条机械规则)⇒ 未登记即红 —— 清单不许退化成「我手工维护的名单」
//      (记忆 manifest-gate-coverage-is-the-criterion:覆盖面就是判据本身);
//   ② 每层要么有 harness、要么有**封闭理由**(枚举内);
//   ③ harness 指针必须**指得到真东西**(文件存在 + 里面真有那个 marker);
//   ④ 棘轮:`reason === "blind"` 的层数 **恰好等于** `limit`,只减不增。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

interface Harness { kind: string; where: string; marker: string; cases?: number }
interface Layer { id: string; what: string; executor?: string; harness?: Harness; reason?: string; note?: string }
interface Ledger { limit: number; reasons: Record<string, string>; harnessKinds: Record<string, string>; layers: Layer[] }

const ledger = JSON.parse(read("infra/prod-only-layers.json")) as Ledger;
const byId = new Map(ledger.layers.map((l) => [l.id, l]));

/** 规则 ①:每个 buildspec 的每个 phase 都是一层(它们只由 CodeBuild 的 bash 执行)。 */
function discoverBuildspecPhases(): string[] {
  const dir = "infra/buildspec";
  const out: string[] = [];
  for (const f of readdirSync(resolve(REPO, dir)).filter((x) => x.endsWith(".yml"))) {
    const name = f.replace(/\.yml$/, "");
    for (const line of read(`${dir}/${f}`).split("\n")) {
      const m = /^ {2}([a-z_]+):\s*$/.exec(line);
      if (m && ["pre_build", "build", "post_build", "install"].includes(m[1])) out.push(`buildspec:${name}:${m[1]}`);
    }
  }
  return out;
}

/** 规则 ②:`infra/lambda/<name>/` 每个目录都是一个真实的 Lambda 入口。 */
function discoverLambdas(): string[] {
  return readdirSync(resolve(REPO, "infra/lambda"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `lambda:${d.name}`);
}

/**
 * 规则 ③:仓根 `scripts/*.sh` **与 `scripts/*.py`**(2026-11-04 起含 `scripts/lib/`)—— 部署 / 造数 / 加区 / 无头验收的编排全在这里。
 * 🔴 2026-09-19 补上 `.py`:原来只扫 `.sh`,而仓里**一半的编排是 python**
 *   (`31-showcase-region.py` 七类能力真跑、`33-verify-regions-headless.py` 无头验收、
 *    `34-add-region-headless.py` 页面向导加区、三个 seed_*.py 造数)⇒ 这一整类执行者
 *   压根不在台账上。「覆盖面就是判据本身」第 N 次生效:漏掉一类执行者 = 台账在说谎。
 */
function discoverShellScripts(): string[] {
  // 🔴 2026-10-14:只认 **git 跟踪**的脚本。开发机 scripts/ 下有 .gitignore 掉的本机工具
  //   (30-seed-tasks.sh / check_aws_context.sh),原来按目录扫 ⇒ 台账里长出了仓库里**不存在**的层:
  //   在这台机器上绿、在任何全新 clone / 工作树上「台账里不许有已经不存在的层」当场红 —— 台账说的是只有这台机器才有的事实。
  //   仓库里有什么,git 是唯一作者;git 不可用就让它炸出来(不退回目录扫,那是静默回落)。
  const tracked = execSync("git ls-files -- scripts", { cwd: REPO, encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  // 🔴 2026-11-04:加上 `scripts/lib/*.sh|py`。被 deploy-all / redeploy-platform / redeploy-agents `source` 的三份 lib
  //   (放行清单唯一作者 / 智能体映射表 / S3 Tables 联邦目录)此前压根不在台账上 ——「覆盖面就是判据本身」又一例;
  //   新增的本机文档工具 scripts/lib/docs_restructure.py 也靠这条被发现、被要求登记。
  return tracked
    .filter((f) => /^scripts\/(?:lib\/)?[^/]+\.(sh|py)$/.test(f))
    .map((f) => `script:${f.slice("scripts/".length)}`);
}

/**
 * 规则 ④:**产出「别处执行的代码」**的 TS —— 特征 = 文件里出现 `boto3` / `#!/bin/bash` / `spark.sql(`。
 * 🔴 这条规则刻意宽:宁可把「其实是数据」的也发现出来,再由台账用 `not-executed-code` 显式排除
 *    —— 排除本身要写下来,才不会有人悄悄把一条真的代码生成器排掉。
 */
function discoverCodegen(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(resolve(REPO, rel), { withFileTypes: true })) {
      if (d.name === "__tests__" || d.name === "node_modules") continue;
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(child);
      else if (d.name.endsWith(".ts") && /boto3|#!\/bin\/bash|spark\.sql\(/.test(read(child))) out.push(`codegen:${child}`);
    }
  };
  walk("platform/src/lib");
  return out;
}

/**
 * 规则 ⑤:`infra/scripts/*.mjs` —— **只在 CodeBuild 里执行**的 node 脚本(P0-E 闸就住在这里)。
 * 🔴 2026-09-15 补这条规则的直接原因:`p0e-gate.mjs` 压根**不在**这张台账上,而它当天就把
 *    「补装组件」整条路径拒死了(CDK 撞 CloudFormation 最终一致性 ⇒ 预演判失败 ⇒ 闸按最严拒)。
 *    台账漏了一整类执行者 ⇒「覆盖面就是判据本身」这句话第 N 次生效。
 */
function discoverInfraNodeScripts(): string[] {
  return readdirSync(resolve(REPO, "infra/scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `script:infra/scripts/${f}`);
}

/**
 * 规则 ⑥(数据湖表桶路由):`scripts/lib/*.mjs` —— 被安装 / 升级脚本 `node` 调用的数据迁移 / 真值读取脚本
 * (首例 lake-routes-migrate.mjs:redeploy-platform 2c‴ 步 + 02-postdeploy-truth 第 11 条都调它)。
 * 🔴 按目录扫而不是 git 跟踪(与规则 ⑤ 同口径):这类脚本只有真部署才执行,新加一个没登记就该当场红 —— 不等它被 commit。
 */
function discoverScriptLibNodeScripts(): string[] {
  return readdirSync(resolve(REPO, "scripts/lib"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `script:lib/${f}`);
}

describe("🔴🔴 台账必须**闭合**:门禁自己发现的层,一个都不许没登记", () => {
  const discovered = [
    ...discoverBuildspecPhases(),
    ...discoverLambdas(),
    ...discoverShellScripts(),
    ...discoverInfraNodeScripts(),
    ...discoverScriptLibNodeScripts(),
    ...discoverCodegen(),
  ];

  it("发现规则真的发现了东西(否则整条门禁形同不存在)", () => {
    // 反向控制:四类各至少一条 —— 规则写坏了(路径改了 / 特征词改了)会静默发现 0 个
    for (const prefix of ["buildspec:", "lambda:", "script:", "codegen:"]) {
      expect(discovered.filter((x) => x.startsWith(prefix)).length, `发现规则 ${prefix} 一条都没命中`).toBeGreaterThan(0);
    }
    expect(discovered.length).toBeGreaterThan(20);
    // 规则 ⑤ 的反向控制:P0-E 闸必须被发现(它是执行环境初始化/补装的命门)
    expect(discovered).toContain("script:infra/scripts/p0e-gate.mjs");
    // 规则 ⑥ 的反向控制:数据湖路由迁移脚本必须被发现(升级步 2c‴ 的执行者)
    expect(discovered).toContain("script:lib/lake-routes-migrate.mjs");
  });

  it("🔴 每个被发现的层都在台账里(新增一层没登记 ⇒ 红)", () => {
    const missing = discovered.filter((x) => !byId.has(x));
    expect(
      missing,
      `这些「只有真部署才会执行」的层没进 infra/prod-only-layers.json:\n  ${missing.join("\n  ")}\n` +
        `⇒ 要么给它一个能离线真跑的替身,要么写下封闭理由(reason)。别让它成为下一个「日志里只有命令原文」的缺陷`
    ).toEqual([]);
  });

  it("🔴 台账里不许有**已经不存在**的层(删了代码要同批删台账,否则棘轮虚低)", () => {
    const stale = ledger.layers.map((l) => l.id).filter((id) => !discovered.includes(id));
    expect(stale, `台账里这些层已经不存在了:${stale.join(", ")}`).toEqual([]);
  });
});

describe("🔴 每层的判定必须有据:要么 harness 指得到真东西,要么理由在封闭枚举里", () => {
  it("harness / reason 二选一,不许都缺、也不许都有", () => {
    const bad = ledger.layers.filter((l) => (!!l.harness && !!l.reason) || (!l.harness && !l.reason));
    expect(bad.map((l) => l.id), "既没 harness 也没 reason(或两者都有)").toEqual([]);
  });

  it("reason 必须在枚举内(不许现编一个理由)", () => {
    const bad = ledger.layers.filter((l) => l.reason && !ledger.reasons[l.reason]);
    expect(bad.map((l) => `${l.id}:${l.reason}`)).toEqual([]);
  });

  it("🔴🔴 harness 指针必须**指得到真东西**:文件存在,且里面真有那个 marker", () => {
    const bad: string[] = [];
    for (const l of ledger.layers) {
      if (!l.harness) continue;
      if (!ledger.harnessKinds[l.harness.kind]) bad.push(`${l.id}: kind=${l.harness.kind} 不在枚举内`);
      else if (!existsSync(resolve(REPO, l.harness.where))) bad.push(`${l.id}: ${l.harness.where} 不存在`);
      else if (!read(l.harness.where).includes(l.harness.marker)) bad.push(`${l.id}: ${l.harness.where} 里找不到 marker ${l.harness.marker}`);
    }
    expect(bad, `harness 指针失效 = 台账在说谎(比没有台账更糟):\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});

describe("🔴🔴 棘轮:没有替身的层数只减不增", () => {
  it("实数恰好等于 limit(补上一个替身就把数字改小;新长出一个 blind ⇒ 红)", () => {
    const blind = ledger.layers.filter((l) => l.reason === "blind").map((l) => l.id);
    expect(
      blind.length,
      `当前没有离线替身的层(${blind.length} 个,台账 limit=${ledger.limit}):\n  ${blind.join("\n  ")}\n` +
        `⇒ 每补一个替身就把 limit 改小;**新增一个不许**`
    ).toBe(ledger.limit);
  });

  it("limit 不许被悄悄放大(2026-09-15 立账时是 14)", () => {
    expect(ledger.limit, "只减不增").toBeLessThanOrEqual(14);
  });
});
