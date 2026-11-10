#!/usr/bin/env node
// 命名 SSOT 双侧 parity 门禁 —— `npm run test:naming-parity`(在 platform 下跑)。
//
// 【为什么必须真执行两侧,而不是"读源码断言长得像"】
//   命名规则被【运行时侧 platform/src/lib/aws/naming.ts】和【部署期侧 infra/lib/shared/naming.ts】
//   各实现一次(跨构建边界,无法共享 TS —— 同 ai-model.json 先例)。两份手写实现必然漂移,
//   而命名漂移的后果是「部署期建的桶叫 A、运行期去读桶 B」:不报错、不红、要到线上才发现。
//   文本级断言挡不住"两侧都改了但改得不一样"这类漂移 ⇒ 只有拿同一 fixture 矩阵**真跑两侧、逐字节比**才算钉住。
//
// 机制:infra 侧经它自己的 ts-node(CJS,__dirname 可用)跑一个 driver,打印 JSON;
//       platform 侧用 tsx/vitest 环境直接 import;两份结果逐条比对。
//       任一侧抛错也算结果的一部分(错误"是否抛"必须一致,不然一侧 fail-closed 一侧放行)。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = resolve(HERE, ".."); // .../platform
const REPO = resolve(PLATFORM, "..");
const INFRA = resolve(REPO, "infra");

// ── fixture 矩阵:home / 非 home / 同区第二个 / 最长合法 / 非法 各类输入都要过一遍
const ACCOUNT = "123456789012";
const TARGETS = [
  "tgt_home",
  "tgt_usw2_a",
  "tgt_usw2_b",
  "tgt_eu1",
  "tgt_" + "a".repeat(16), // 最长合法
  // ↓ 非法输入:两侧必须**都抛**(一侧抛一侧放行 = 一侧 fail-closed 一侧建出垃圾资源名)
  "tgt-usw2-a",
  "tgt_a_",
  "TGT_A",
  "usw2",
  "tgt_" + "a".repeat(17),
  "",
];
const COMPONENTS = ["core", "redshift", "mwaa"];
// 未登记 kind 也进矩阵:两侧都必须抛。
const EXTRA_KINDS = ["somethingNew"];

const DRIVER = `
const n = require(${JSON.stringify(resolve(INFRA, "lib/shared/naming.ts"))});
const ACCOUNT = ${JSON.stringify(ACCOUNT)};
const TARGETS = ${JSON.stringify(TARGETS)};
const COMPONENTS = ${JSON.stringify(COMPONENTS)};
const KINDS = n.RESOURCE_KINDS.concat(${JSON.stringify(EXTRA_KINDS)});
const out = { version: n.NAMING_VERSION, dimension: n.NON_HOME_DIMENSION, kinds: n.RESOURCE_KINDS, rows: {} };
for (const kind of KINDS) {
  for (const targetId of TARGETS) {
    for (const component of COMPONENTS) {
      const key = kind + "|" + targetId + "|" + component;
      try {
        out.rows[key] = { ok: n.resourceName(kind, { targetId, account: ACCOUNT, component, region: "us-west-2" }) };
      } catch (e) {
        out.rows[key] = { err: String((e && e.message) || e) };
      }
    }
  }
}
process.stdout.write(JSON.stringify(out));
`;

const driverPath = resolve(INFRA, "_naming_parity_driver.ts");
let infraSide;
try {
  writeFileSync(driverPath, DRIVER, "utf8");
  const stdout = execFileSync(
    resolve(INFRA, "node_modules/.bin/ts-node"),
    ["--transpile-only", "-P", resolve(INFRA, "tsconfig.json"), driverPath],
    { cwd: INFRA, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );
  infraSide = JSON.parse(stdout);
} finally {
  try {
    unlinkSync(driverPath);
  } catch {
    /* 已不在就算了 */
  }
}

// ── 运行时侧:用 vitest 的 esbuild 管道跑同一矩阵(直接 import TS + json)
const RUNNER = `
import { resourceName, RESOURCE_KINDS, NAMING_VERSION, NON_HOME_DIMENSION } from "@/lib/aws/naming";
import { it, expect } from "vitest";
import { writeFileSync as emit } from "node:fs";
it("emit", () => {
  const ACCOUNT = ${JSON.stringify(ACCOUNT)};
  const TARGETS = ${JSON.stringify(TARGETS)};
  const COMPONENTS = ${JSON.stringify(COMPONENTS)};
  const KINDS = (RESOURCE_KINDS as string[]).concat(${JSON.stringify(EXTRA_KINDS)});
  const out: any = { version: NAMING_VERSION, dimension: NON_HOME_DIMENSION, kinds: RESOURCE_KINDS, rows: {} };
  for (const kind of KINDS) {
    for (const targetId of TARGETS) {
      for (const component of COMPONENTS) {
        const key = kind + "|" + targetId + "|" + component;
        try {
          out.rows[key] = { ok: resourceName(kind as never, { targetId, account: ACCOUNT, component, region: "us-west-2" }) };
        } catch (e: any) {
          out.rows[key] = { err: String((e && e.message) || e) };
        }
      }
    }
  }
  emit(${JSON.stringify(resolve(PLATFORM, ".naming-parity-runtime.json"))}, JSON.stringify(out));
  expect(Object.keys(out.rows).length).toBeGreaterThan(0);
});
`;

const runnerPath = resolve(PLATFORM, "src/lib/aws/__tests__/.naming-parity-emit.test.ts");
const emitPath = resolve(PLATFORM, ".naming-parity-runtime.json");
let runtimeSide;
try {
  writeFileSync(runnerPath, RUNNER, "utf8");
  execFileSync("npx", ["vitest", "run", "src/lib/aws/__tests__/.naming-parity-emit.test.ts", "--no-cache"], {
    cwd: PLATFORM,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "ignore", "pipe"],
  });
  runtimeSide = JSON.parse(readFileSync(emitPath, "utf8"));
} finally {
  for (const p of [runnerPath, emitPath]) {
    try {
      unlinkSync(p);
    } catch {
      /* 已不在就算了 */
    }
  }
}

// ── 逐条比对
// 可诊断错误的白名单:两侧抛出的必须是我们**自己写的**那几类错,而不是意外的运行时错。
const DIAGNOSABLE = /命名 SSOT|非法 targetId|targetSlug 不是合法 DNS label|targetId 非法|不是合法/;
const problems = [];
if (infraSide.version !== runtimeSide.version) {
  problems.push(`naming.json 版本不一致:infra=${infraSide.version} runtime=${runtimeSide.version}`);
}
if (infraSide.dimension !== runtimeSide.dimension) {
  problems.push(`派生键不一致:infra=${infraSide.dimension} runtime=${runtimeSide.dimension}`);
}
if (JSON.stringify(infraSide.kinds) !== JSON.stringify(runtimeSide.kinds)) {
  problems.push(`kind 清单不一致:\n  infra=${infraSide.kinds}\n  runtime=${runtimeSide.kinds}`);
}

const keys = new Set([...Object.keys(infraSide.rows), ...Object.keys(runtimeSide.rows)]);
let compared = 0;
let bothThrew = 0;
for (const k of [...keys].sort()) {
  const a = infraSide.rows[k];
  const b = runtimeSide.rows[k];
  if (!a || !b) {
    problems.push(`矩阵缺格 ${k}:infra=${JSON.stringify(a)} runtime=${JSON.stringify(b)}`);
    continue;
  }
  compared++;
  if (a.err && b.err) {
    bothThrew++;
    // 🔴 两侧都抛还不够 —— 必须都是**可诊断**的错。变异实测:把 `if (!rule)` 的 throw 短路掉,
    //    后面会撞出 `Cannot read properties of undefined` 这种 TypeError,parity 只比"是否抛"就放行了。
    //    CDK synth 里冒出一条 TypeError 与冒出"未登记的资源类别 xxx"的排查成本差一个量级。
    for (const [side, r] of [["infra", a], ["runtime", b]]) {
      if (!DIAGNOSABLE.test(r.err)) {
        problems.push(`${side} 侧 ${k} 抛的是不可诊断的错(疑似 TypeError):${r.err}`);
      }
    }
    continue;
  }
  if (Boolean(a.err) !== Boolean(b.err) || a.ok !== b.ok) {
    problems.push(`不一致 ${k}:infra=${JSON.stringify(a)} runtime=${JSON.stringify(b)}`);
  }
}

// 矩阵里必须真的有"两侧都抛"的格子,否则说明非法输入 fixture 没生效(= 假绿)。
if (bothThrew === 0) problems.push("矩阵里没有任何『两侧都抛』的格子 —— 非法输入 fixture 失效,门禁形同虚设");
// 也必须有足够多的成功格子(防"两侧都全抛"这种更蠢的假绿)。
const okCount = compared - bothThrew;
if (okCount < 50) problems.push(`成功格子只有 ${okCount} 个(<50)—— 疑似两侧都在抛,门禁形同虚设`);

// ── 文本级锚点:三条 fail-closed 守卫必须**两侧都在**
//
// 🔴 为什么这里退回文本断言(诚实说明,不装成执行证据):
//    长度守卫 `out.length > maxLength` 对**所有合法输入不可达** —— 输入语法(targetId ≤ 20、
//    account 恰 12 位、component ≤ 32)决定了最长生成名 50 字,而最小 maxLength 是 60。
//    变异实测:把 infra 侧的长度检查改成 `if (false && …)`,693 格 parity **全绿**。
//    ⇒ 真执行测不出的分支,只能靠"守卫还在不在"的锚点钉住。将来若新增长名 kind 使它可达,
//    应把这条升级为真执行 fixture,并在此处删掉说明。
const SHARED_ANCHORS = [
  { name: "残留占位符即抛", re: /out\.includes\("\{"\)\s*\|\|\s*out\.includes\("\}"\)/ },
  { name: "超长即抛", re: /if\s*\(out\.length\s*>\s*rule\.maxLength\)/ },
  { name: "未登记 kind 即抛", re: /未登记的资源类别/ },
  { name: "account 形态必校验", re: /ACCOUNT_RE\.test/ },
];
// 🔴 slug 那条**两侧锚点不同、不能共用**:运行时侧委托给唯一权威 `toTargetSlug`(target-id.ts),
//    自己不该有第二份 DNS 断言;infra 侧跨不过构建边界、有已登记的第二份实现,断言在它自己里。
//    初版把两侧写成同一条锚点 ⇒ 基线直接红,而我差点把这红当成"变异被抓住"(判据不许猜)。
const SIDE_ANCHORS = {
  infra: [{ name: "非法 targetId / 非法 slug 即抛(本地第二份实现)", re: /DNS label/ }],
  runtime: [{ name: "slug 必经唯一权威 toTargetSlug(不许本地再实现一份)", re: /toTargetSlug\(/ }],
};
const sides = [
  ["infra", resolve(INFRA, "lib/shared/naming.ts")],
  ["runtime", resolve(PLATFORM, "src/lib/aws/naming.ts")],
];
let anchorCount = 0;
for (const [label, file] of sides) {
  // 先剥注释,免得"注释里提到守卫"被当成守卫还在(与 cross-module cast 门禁同一教训)。
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const g of [...SHARED_ANCHORS, ...SIDE_ANCHORS[label]]) {
    anchorCount++;
    if (!g.re.test(text)) problems.push(`${label} 侧丢了 fail-closed 守卫【${g.name}】(锚点 ${g.re})`);
  }
}

console.log(`命名 SSOT parity:比对 ${compared} 格(成功 ${okCount} / 两侧都抛 ${bothThrew}),kind ${infraSide.kinds.length} 个`);
console.log(`fail-closed 守卫锚点:${anchorCount} 条全在(🔴 长度守卫对合法输入不可达,只能锚点钉,非执行证据)`);
if (problems.length) {
  console.error(`\n❌ parity FAIL —— ${problems.length} 处:\n` + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log("✅ 双侧逐字节一致");
