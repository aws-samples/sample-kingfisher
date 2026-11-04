// B-120 守卫 —— core-dist(三个 AgentCore 容器 + genbi 技能 Lambda **入库**的 CJS 产物)必须与它的 TS 源同步。
//
// 【缺陷原形(2026-10-24,台账 B-120)】序 46 给厂商档案 vendors.ts 加的 probeTimeoutMs 从没回写进入库的 core-dist/ai/vendors.js ⇒
//   用入库副本部署的智能体按旧档案探测模型;tsc / vitest / 红线全绿 —— 产物是构建快照,此前没有任何「与源同步」的守卫
//   (10-24 三条全新安装链起跑前 deploy-all 的 core-prebuild 重生成才在 git status 里看到 6 个文件有差)。
// 【守卫】scripts/core-prebuild.sh 每次生成时把 tsc **真正吃进去**的源(--listFilesOnly 的 platform/src 子集)及 sha256 写进
//   <core-dist>/.source-manifest.json。这里按脚本里的能力注册表(CAP_TSCONFIG / CAP_DESTS,单一作者,不另抄一份)逐个 core-dist:
//   ① 清单在、capability / tsconfig 对得上;② 清单里每个源现在的 sha256 == 记录值(改源没重跑 ⇒ 红);
//   ③ tsconfig include 展开的每个源都在清单里(新增源文件没重跑 ⇒ 红);
//   ④ rootDir 下每个源都有同路径 .js 产物、每个 .js 都对得上源(删 / 改名没重跑 ⇒ 红)。
// 修法永远只有一条:bash scripts/core-prebuild.sh <能力>(或 all),把重生成的产物连同清单一起提交。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(process.cwd(), "..");
const PLATFORM = path.join(ROOT, "platform");
const script = fs.readFileSync(path.join(ROOT, "scripts/core-prebuild.sh"), "utf8");

/** 读脚本里 `declare -A NAME=( [key]="value" … )` 的键值(注册表的唯一作者是脚本) */
function assocBlock(name: string): Record<string, string> {
  const block = new RegExp(`declare -A ${name}=\\(([\\s\\S]*?)\\n\\)`).exec(script);
  if (!block) throw new Error(`scripts/core-prebuild.sh 里没有 declare -A ${name}`);
  const out: Record<string, string> = {};
  for (const entry of block[1].matchAll(/^\s*\[(\w+)\]="([^"]*)"/gm)) out[entry[1]] = entry[2];
  return out;
}
const CAP_TSCONFIG = assocBlock("CAP_TSCONFIG");
const CAP_DESTS = assocBlock("CAP_DESTS");
const expandVars = (value: string) => value.replace(/\$ROOT/g, ROOT).replace(/\$PLATFORM/g, PLATFORM);
const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const stripJsonComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, "");
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

function walk(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) return ent.name === "node_modules" ? [] : walk(full, ext);
    return ent.name.endsWith(ext) ? [full] : [];
  });
}

/** tsconfig include 的两种写法(本仓只有这两种):显式文件 / `dir/**\/*.ts`;别的通配写法直接抛,不许静默漏判 */
function includedSources(tsconfigRel: string): { files: string[]; rootDir: string } {
  const cfg = JSON.parse(stripJsonComments(fs.readFileSync(path.join(PLATFORM, tsconfigRel), "utf8")));
  const files = (cfg.include as string[]).flatMap((pattern) => {
    const globDir = /^(.*)\/\*\*\/\*\.ts$/.exec(pattern);
    if (globDir) return walk(path.join(PLATFORM, globDir[1]), ".ts");
    if (/[*?[\]{}]/.test(pattern)) throw new Error(`${tsconfigRel} 的 include 用了本守卫不认的通配写法:${pattern}`);
    return [path.join(PLATFORM, pattern)];
  });
  return { files, rootDir: path.resolve(PLATFORM, cfg.compilerOptions.rootDir) };
}

const cases = Object.entries(CAP_DESTS).flatMap(([cap, dests]) =>
  expandVars(dests).split(/\s+/).filter(Boolean).map((dest) => ({ cap, dest, name: `${cap} → ${rel(dest)}` }))
);
const readManifest = (dest: string) => JSON.parse(fs.readFileSync(path.join(dest, ".source-manifest.json"), "utf8")) as {
  capability: string;
  tsconfig: string;
  sources: Record<string, string>;
};

describe("🔴 B-120 core-dist 与源同步守卫(能力注册表 = scripts/core-prebuild.sh)", () => {
  it("注册表抽取没失效:5 个能力 / 8 个 core-dist 目标(加能力时同步改这里 —— 这是防抽取空转,不是上限)", () => {
    expect(Object.keys(CAP_TSCONFIG).sort()).toEqual(["ai", "cookbook", "genbi", "netadvisor", "paramadvisor"]);
    expect(cases.length).toBe(8);
    for (const { cap } of cases) expect(CAP_TSCONFIG[cap], `${cap} 没有 tsconfig`).toBeTruthy();
  });

  it.each(cases)("$name:清单在、capability / tsconfig 对、每个源 sha256 未变", ({ cap, dest }) => {
    const manifestPath = path.join(dest, ".source-manifest.json");
    expect(fs.existsSync(manifestPath), `${rel(dest)} 没有 .source-manifest.json —— 跑 bash scripts/core-prebuild.sh ${cap}`).toBe(true);
    const manifest = readManifest(dest);
    expect(manifest.capability).toBe(cap);
    expect(manifest.tsconfig).toBe(`platform/${CAP_TSCONFIG[cap]}`);
    expect(Object.keys(manifest.sources).length).toBeGreaterThan(0);
    const stale: string[] = [];
    for (const [src, recorded] of Object.entries(manifest.sources)) {
      const abs = path.join(ROOT, src);
      if (!fs.existsSync(abs)) stale.push(`${src}(源已不存在)`);
      else if (sha256(abs) !== recorded) stale.push(src);
    }
    expect(stale, `🔴 B-120:下列源改了但 ${rel(dest)} 没重生成 —— 跑 bash scripts/core-prebuild.sh ${cap} 并把产物一起提交:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it.each(cases)("$name:include 展开的每个源都在清单里;rootDir 下的源与 .js 产物一一对应", ({ cap, dest }) => {
    const manifest = readManifest(dest);
    const sources = new Set(Object.keys(manifest.sources));
    const { files, rootDir } = includedSources(CAP_TSCONFIG[cap]);
    expect(files.length).toBeGreaterThan(0);
    const missing = files.map(rel).filter((file) => !sources.has(file));
    expect(missing, `🔴 B-120:新增源没进 ${rel(dest)} —— 跑 bash scripts/core-prebuild.sh ${cap}:\n  ${missing.join("\n  ")}`).toEqual([]);
    // 子能力的 core-dist 是本目录的子目录(genbi/core-dist/{cookbook,ai} 等)⇒ 那些 .js 属于别的能力,跳过
    const childDests = cases.filter((other) => other.dest !== dest && other.dest.startsWith(dest + path.sep)).map((other) => other.dest);
    const jsFiles = walk(dest, ".js").filter((file) => !childDests.some((child) => file.startsWith(child + path.sep)));
    const srcUnderRoot = [...sources].map((src) => path.join(ROOT, src)).filter((abs) => abs.startsWith(rootDir + path.sep) && !abs.endsWith(".d.ts"));
    const expectedJs = new Set(srcUnderRoot.map((abs) => path.join(dest, path.relative(rootDir, abs)).replace(/\.ts$/, ".js")));
    const noJs = [...expectedJs].filter((js) => !fs.existsSync(js)).map(rel);
    const orphanJs = jsFiles.filter((js) => !expectedJs.has(js)).map(rel);
    expect(noJs, `源有、产物没有(改名 / 新增后没重跑):${noJs.join(", ")}`).toEqual([]);
    expect(orphanJs, `产物有、源没有(源删了产物还在):${orphanJs.join(", ")}`).toEqual([]);
  });
});
