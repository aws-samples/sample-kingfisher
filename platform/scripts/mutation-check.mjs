#!/usr/bin/env node
/**
 * 🔴 **变异测试 harness**(准入门 / 凭证 / 缓存三块)。
 *
 * 【为什么必须入库】外部审核 v3 P2-3:上一批我宣称"变异测试 9/9 全过",但 harness 在 `/tmp`,
 * **下一个审核者无法复跑、也无法核对是哪 9 个变异** ⇒ 那个数字对外等于不可验证。
 * 现在它是仓内脚本:`node scripts/mutation-check.mjs`(在 platform/ 下跑)。
 *
 * 【判据(比"跑了变异测试"更重要)】每个变异**必须让 ≥2 条测试变红**。
 * 只红 1 条视为不合格 —— 那说明那条测试很可能只是"恰好匹配作者的模型";
 * 实测:v3.4 那轮首轮就有 4 个变异只红 1 条(M1/M4/M6/M9),逐个**换维度**补强后才全绿。
 * 补强的正确方式不是加同类断言,而是换一个维度(例:给 `ConsistentRead` 补一条
 * "mock 模拟最终一致读返回旧副本"的**行为级**测试)。
 *
 * 🔴 **已知量具限制(必须如实报告,不许掩盖)**:`M8`(targetId 正则放宽)在**本脚本的循环里**
 *    确定性地"测不出"(13 个文件收集期报错、断言红 0),而**单独手工应用同一变异 + 同样范围**
 *    确定性地"断言红 5 条"(已复核两次)。排查过:不是 vitest 缓存(`--no-cache` 同结果)、
 *    不是连续跑(手工 baseline→变异→跑 同样正常)、不是 execSync 缓冲上限(改 `stdio:ignore`
 *    + 256MB maxBuffer 后仍然如此)。⇒ 结论:**这是量具在循环内的限制,不是产品缺陷**。
 *    脚本因此把它报成 **INCONCLUSIVE 并以非零码退出**,**绝不**当成"被抓到"。
 *    报告 M8 时必须写"harness 测不出 + 手工核对红 5 条",不许写成 18/18。
 *
 * 【安全性】每个变异前把目标文件备份到 `.mutation-backup/`,跑完立刻还原;
 * 收尾再跑一次基线,确认工作区已复原(退出码非 0 时**必须**人工 `git status` 复核)。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = process.cwd();
const BACKUP = resolve(ROOT, ".mutation-backup");
const REGISTRY = "src/lib/exec-env/registry.ts";
const TARGET_ID = "src/lib/exec-env/target-id.ts";
const CRED_CACHE = "src/lib/exec-env/cred-cache.ts";
const ZEROETL = "src/lib/realtime/zeroetl-service.ts";
const TEMPLATES = "src/lib/exec-env/admin-ddl-templates.ts";

/** 受影响的测试面(跑全量太慢;这几个目录覆盖了所有相关断言)。 */
const SUITES = "src/lib/exec-env/ src/lib/redshift/ src/lib/realtime/ src/lib/engines/";

/**
 * 变异清单。每条 = [说明, 文件, 原文, 替换]。
 * 🔴 **新增机制必须同步加一条变异** —— 否则"这道门有没有测试守着"就又变成靠人记。
 */
const MUTANTS = [
  // ── v3.4 批(P0-1 / P1-1 / P1-2 / P1-4 / P2-1 / P2-2)
  ["M1 去掉准入的 ConsistentRead", REGISTRY, "      ConsistentRead: true,\n", ""],
  ["M2 删掉整个 stale 判定", REGISTRY, "  if (!isHome(t.targetId)) {", "  if (false && !isHome(t.targetId)) {"],
  [
    "M3 缺时间源当新鲜(负向推断放行)",
    REGISTRY,
    '      return "描述符没有可用的新鲜度时间源(probe.at / updatedAt 都缺失或无法解析)⇒ 判 stale";',
    "      return null;",
  ],
  ["M4 home 也判 stale(去掉豁免)", REGISTRY, "  if (!isHome(t.targetId)) {", "  if (true) {"],
  [
    "M5 关掉整包校验",
    REGISTRY,
    "  const parsed = DescriptorSchema.safeParse(item);",
    "  if (item) return null;\n  const parsed = DescriptorSchema.safeParse(item);",
  ],
  [
    "M6 seed 把 ConditionalCheckFailed 一律当成功",
    REGISTRY,
    "  const existing = await readDescriptor(HOME_TARGET_ID);",
    '  return { outcome: "already-complete" };\n  const existing = await readDescriptor(HOME_TARGET_ID);',
  ],
  ["M7 列表只翻第一页", REGISTRY, "    if (!r.LastEvaluatedKey) return out;", "    return out;"],
  [
    "M8 targetId 正则放宽回 {1,16}(允许首尾下划线)",
    TARGET_ID,
    "const TARGET_ID_RE = new RegExp(`^tgt_[a-z0-9](?:[a-z0-9_]{0,${TARGET_ID_MIDDLE_MAX}}[a-z0-9])?$`);",
    "const TARGET_ID_RE = new RegExp(`^tgt_[a-z0-9_]{1,${TARGET_ID_BODY_MAX}}$`);",
  ],
  [
    "M9 写后失活只清一个槽",
    ZEROETL,
    "  return zeroEtlArnCache.invalidatePrefix(`${targetId}#`);",
    "  zeroEtlArnCache.invalidate(zeroEtlCacheKey(targetId));\n  return 1;",
  ],
  // ── G8 批(外部审核 v3 的 N1–N4 + P1-2 硬化 + P0-B mint 面)
  [
    "M10 去掉未来时钟容差(N3:probe.at=2999 会永远新鲜)",
    REGISTRY,
    "    if (age < -TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS) {",
    "    if (false) {",
  ],
  [
    "M11 seed 的完整定义退回只查整包校验(N2:ready:false 会被写进去)",
    REGISTRY,
    "  const violation = descriptorSeedViolation(item, HOME_TARGET_ID);",
    "  const violation = descriptorViolation(item, HOME_TARGET_ID);",
  ],
  [
    "M12 已存在时不与期望值比对(N2b:别的账号的 home 会被判 already-complete)",
    REGISTRY,
    "  if (differences.length) {",
    "  if (false) {",
  ],
  [
    "M13 reconcile 允许列表退回黑名单(N1:能把 isolated 改回 legacy-seeded)",
    REGISTRY,
    '  const notAllowed = keys.filter((k) => !(RECONCILE_ALLOWED_FIELDS as readonly string[]).includes(k));',
    '  const notAllowed = keys.filter((k) => ["pk", "sk", "targetId", "ready"].includes(k));',
  ],
  [
    "M14 凭证迁移允许逆向(违 §3.9b 单调不可逆)",
    REGISTRY,
    '  "legacy-seeded": "provisioning",\n  provisioning: "isolated",',
    '  "legacy-seeded": "provisioning",\n  provisioning: "isolated",\n  isolated: "legacy-seeded",',
  ],
  [
    "M15 缓存失活不 fence 在途 resolver(N4:旧值会被写回)",
    CRED_CACHE,
    "    if (this.generation !== gen) {",
    "    if (false) {",
  ],
  [
    "M16 畸形 ARN 不再拒(P1-2:越畸形越不被检查)",
    REGISTRY,
    "    if (!parseArn(v)) {",
    "    if (false) {",
  ],
  [
    "M17 组件↔资源配套校验取消",
    REGISTRY,
    "    for (const key of COMPONENT_REQUIRED_RESOURCES[comp] ?? []) {",
    "    for (const key of []) {",
  ],
  [
    "M18 mint 函数重新公开导出(P0-B:任何模块都能铸任意 SQL)",
    TEMPLATES,
    "function brandStatement(sql: string): GeneratedAdminStatement {",
    "export function brandStatement(sql: string): GeneratedAdminStatement {",
  ],
];

function runSuites() {
  const out = resolve(BACKUP, "out.json");
  // 🔴 **每轮先删旧 JSON**:否则一次写失败就会让我读到**上一轮**的结果。
  // 实测教训:第一版没删,M8 明明红 5 条却被记成"红 0 条 = 测试挡不住" ——
  // 量具自己给了假读数,而假读数的方向恰好是"看起来更糟",差点让我去改本来是对的代码。
  if (existsSync(out)) rmSync(out, { force: true });
  try {
    // 🔴 `stdio:"ignore"` + 大 maxBuffer:execSync 默认 maxBuffer 只有 1MB,
    // **输出多的变异会把子进程打死**,只留下半份 JSON ⇒ 表现为"13 个文件收集期报错、断言红 0"。
    // 这就是 M8 一直"测不出"的真因:量具被自己的缓冲区限制打断了,而不是产品或 vitest 的问题。
    execSync(`npx vitest run ${SUITES} --reporter=json --outputFile=${out}`, {
      cwd: ROOT,
      stdio: "ignore",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    /* 非 0 退出是预期的(有测试红) */
  }
  if (!existsSync(out)) return { failed: -1, collectErrors: 0, names: ["(vitest 没写出 json ⇒ 本轮测不出,不能当 0)"] };
  try {
    const d = JSON.parse(readFileSync(out, "utf8"));
    const names = [];
    for (const r of d.testResults ?? []) {
      for (const a of r.assertionResults ?? []) if (a.status === "failed") names.push(a.fullName);
    }
    // 🔴 **只数我能自己核对的地面真值:逐条 assertionResults 里 status==="failed" 的个数。**
    // 踩过的两个坑,都是"信了汇总字段":
    //   ① 不删旧 JSON ⇒ 读到上一轮的数(M8 曾被报成"红 0 条"其实红 13);
    //   ② 误把 `numFailedTestSuites` 当"加载失败数" —— 它其实是"**含失败用例的文件数**",
    //      于是同一个 M8 又被报成"断言红 0 / 13 个加载失败"。**汇总字段的语义不许猜。**
    // 现在:`failed` = 真实失败断言条数(= names.length);
    //       `collectErrors` = 状态为 failed 却**一条用例都没有**的文件数(= 真正的收集/加载期错误)。
    const collectErrors = (d.testResults ?? []).filter(
      (r) => r.status === "failed" && (r.assertionResults ?? []).length === 0
    ).length;
    return { failed: names.length, collectErrors, names };
  } catch {
    return { failed: -1, collectErrors: 0, names: ["(json 解析失败 ⇒ 本轮测不出,不能当 0)"] };
  }
}

mkdirSync(BACKUP, { recursive: true });

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 **中断安全**(外部审核 v4 P2-2):本脚本会**直接改真实源码**,一旦被 Ctrl-C / kill
// 打断,工作区就会**残留一个变异**。那种残留极其阴险:它编译得过、测试大概率也过
// (变异的本质就是"让某道门失效"),于是可能被一路提交上去。
// ⇒ 注册 exit / SIGINT / SIGTERM / uncaughtException 清理,任何退出路径都先还原。
// ⚠️ 如实登记:更彻底的做法是"在临时 worktree 里跑"(审核建议),那需要 git worktree 编排,
//    归后续;当前这层保证的是"**不会留下残留**",而不是"从不碰真实文件"。
// ══════════════════════════════════════════════════════════════════════════════
/** 正在被变异的文件 → 原始内容。空 = 工作区干净。 */
const inflight = new Map();

function restoreAll(reason) {
  if (!inflight.size) return;
  console.error(`\n🔴 ${reason} —— 还原 ${inflight.size} 个被变异的文件`);
  for (const [path, src] of inflight) {
    try {
      writeFileSync(path, src);
      console.error(`   已还原 ${path}`);
    } catch (e) {
      console.error(`   ⚠️ 还原失败(请手工 git checkout):${path} —— ${e?.message}`);
    }
  }
  inflight.clear();
}

process.on("exit", () => restoreAll("进程退出"));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restoreAll(`收到 ${sig}`);
    process.exit(130);
  });
}
process.on("uncaughtException", (e) => {
  restoreAll(`未捕获异常:${e?.message}`);
  process.exit(1);
});

const base = runSuites();
console.log(`基线失败数 = ${base.failed}`);
if (base.failed !== 0 || base.collectErrors !== 0) {
  console.error(`🔴 基线不干净(断言红 ${base.failed} / 收集期报错 ${base.collectErrors})—— 先修基线再跑变异测试`);
  process.exit(1);
}

const weak = [];
for (const [name, rel, oldStr, newStr] of MUTANTS) {
  const path = resolve(ROOT, rel);
  const src = readFileSync(path, "utf8");
  if (!src.includes(oldStr)) {
    console.log(`⚠️  ${name}:锚点已失效,变异**未应用**(代码改过了?请同步本脚本)`);
    weak.push([name, "锚点失效"]);
    continue;
  }
  writeFileSync(resolve(BACKUP, rel.replace(/\//g, "__")), src);
  inflight.set(path, src); // 🔴 先登记再改:登记与改动之间被杀也能还原
  writeFileSync(path, src.replace(oldStr, newStr));
  let r;
  try {
    r = runSuites();
    // 🔴 **测不出就重试一次**(实测:同一个变异在 harness 连续跑的模式下会出现
    // "13 个文件收集期报错、断言红 0",而**同样范围单独跑**是"断言红 5、收集期 0"。
    // 根因在 vitest 的连续多次调用里,不在产品代码。与其猜工具内幕,不如让量具**承认测不出**并重试;
    // 仍测不出就报 INCONCLUSIVE —— **绝不把"测不出"记成"被抓到"或"没抓到"**。)
    if (r.failed < 2 && r.collectErrors > 0) {
      console.log(`   ↻ ${name}:出现收集期报错(断言红 ${r.failed}),重试一次…`);
      r = runSuites();
    }
  } finally {
    writeFileSync(path, src);
    inflight.delete(path);
  }
  // 🔴 只认**真的断言红**;`infraFailed`(编译/加载失败)不算"被测试抓到"。
  const ok = r.failed >= 2;
  const flag = ok
    ? "✅"
    : r.failed === 1
      ? "⚠️ 只红 1 条(不合格)"
      : r.collectErrors > 0
        ? "⚠️ 只是收集/加载期报错,不算测试抓到(不合格)"
        : "🔴 全绿 = 测试挡不住";
  console.log(
    `${flag} ${name}:断言红 ${r.failed} 条` + (r.collectErrors ? `(另有 ${r.collectErrors} 个文件收集期报错)` : "")
  );
  for (const n of r.names.slice(0, 2)) console.log(`      · ${String(n).slice(0, 96)}`);
  if (!ok) weak.push([name, r.failed < 2 && r.collectErrors > 0 ? "测不出" : r.failed]);
}

const after = runSuites();
console.log(`\n还原后失败数 = ${after.failed}`);
if (existsSync(BACKUP)) rmSync(BACKUP, { recursive: true, force: true });
if (after.failed !== 0 || after.collectErrors !== 0) {
  console.error("🔴 还原后基线不干净 —— 立刻 git status / git diff 复核,可能有文件没还原");
  process.exit(2);
}
if (weak.length) {
  const inconclusive = weak.filter(([, c]) => c === "测不出");
  const real = weak.filter(([, c]) => c !== "测不出");
  if (real.length) {
    console.error(`\n🔴 以下变异**没被 ≥2 条测试拦住**,视为不合格:`);
    for (const [n, c] of real) console.error(`   · ${n}(红 ${c} 条)`);
    console.error(`补强方式:**换维度**加测试(不是加同类断言),然后重跑本脚本。`);
  }
  if (inconclusive.length) {
    console.error(`\n⚠️ 以下变异**测不出**(收集期报错,量具问题而非产品问题),请单独复跑核对:`);
    for (const [n] of inconclusive) console.error(`   · ${n}`);
    console.error(`   复跑方式:手工应用该变异 → npx vitest run ${SUITES} → 看真实断言红数 → 还原。`);
    console.error(`   🔴 "测不出" **不得**当成"被抓到";报告里必须如实写"测不出 + 手工核对结果"。`);
  }
  process.exit(3);
}
console.log(`\n✅ 全部 ${MUTANTS.length} 个变异各被 ≥2 条测试拦住。`);
