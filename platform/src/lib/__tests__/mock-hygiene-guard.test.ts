// @kf-batch 54-genbi-session-cards
// 🔴🔴 **Mock 卫生棘轮(2026-09-13 立)** —— 用户当天的原话是「那么多 hook 都不生效吗?拦不住你写bug」。
//
// 【为什么现有门禁一个都拦不住那一类】同一天我自己埋了 4 个缺陷,**全部长在两个模块的接缝上**,
// 而 `tsc` 自洽、`vitest` 3000+ 条全绿、**60 个变异全红**:
//   · `tsc`:store 自己 `ulid()` 是合法代码,类型系统无从知道它必须等于写 S3 key 用的那个;
//   · `vitest`:测 A 时把 B 整个 `vi.mock` 掉 ⇒ 接缝**根本没有被观察**;
//   · 🔴 **变异测试也拦不住** —— 它只验证「判据能不能察觉代码变化」,而变异打在同样被 mock 隔开的
//     单元上;**变异不能创造判据本来没有的观察力**。这一条最反直觉,也最贵。
//   · 唯一能逮住的是末端的真环境硬门 ⇒ 每次发现赔一次 15 分钟部署。
//
// 【本门禁怎么把这条缝焊上】两个只减不增的棘轮:
//   ① 「测试 mock 掉**同目录兄弟模块**」的对数不许增加(新增跨 mock 必须先想清楚);
//   ② 凡有跨 mock 的目录,**必须有一个装配层测试**(`*-assembly.test.ts`)——
//     它只 mock 真外部(DDB/S3/注册表/模型侧),兄弟模块之间**一律不 mock**。
//   豁免名单是历史欠账,同样只减不增。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");           // …/platform/src

/** 🔴 只减不增:当前全仓「测试 mock 掉同目录兄弟模块」的对数。新增跨 mock 会让本门禁红。 */
const CROSS_MOCK_LIMIT = 36;

/**
 * 🔴 只减不增:**还没有装配层**的目录(历史欠账)。
 * 每给一个目录补上 `*-assembly.test.ts`,就从这里删一行 —— 绝不许往里加。
 * `lib/genbi` **刻意不在此列**:2026-09-13 已补(`cards-assembly.test.ts`),它是这条纪律的样板。
 * `lib/exec-env` 2026-10-01 已补(`discard-assembly.test.ts`:弃置 ↔ CFN 处置 ↔ 会话收口 ↔ 唯一写通道,只 mock DDB/CFN/CodeBuild)。
 */
// `lib/modeling` 2026-10-10 已补(`shared-writer-assembly.test.ts`:建模落地 ↔ admin 执行器 ↔ 模板 ↔ 落点 SSOT ↔ 台账,
//   只 mock DDB / 注册表 / Data API + Secrets Manager / 审计;@kf-batch 50-WP11b-shared-writer)。
// `lib/finops` 2026-10-11 已补(`cost-by-region-assembly.test.ts`:CE 采集 ↔ v2 存储 ↔ 区卡片 / 对账 ↔ 异常 ↔ 签名 ↔ 读路由,
//   只 mock DDB / CE / 注册表 / 项目守卫 / 告警与知识库写入;@kf-batch 50-WP6-cost-by-region)。
const ASSEMBLY_DEBT: readonly string[] = [
  "lib/scheduler/serverless",
];

function walkTestDirs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (e === "__tests__") out.push(p);
    else if (e !== "node_modules") walkTestDirs(p, out);
  }
  return out;
}

interface CrossMock { feature: string; testFile: string; mocked: string }

function scanCrossMocks(): CrossMock[] {
  const out: CrossMock[] = [];
  for (const tdir of walkTestDirs(SRC)) {
    const feature = dirname(tdir);                       // 被测模块所在目录
    const featureRel = feature.slice(SRC.length + 1).split("\\").join("/");
    for (const fn of readdirSync(tdir)) {
      if (!/\.test\.tsx?$/.test(fn)) continue;
      const src = readFileSync(join(tdir, fn), "utf8");
      for (const m of src.matchAll(/vi\.mock\("(@\/[^"]+)"/g)) {
        const modRel = m[1].replace("@/", "");
        if (dirname(modRel).split("\\").join("/") === featureRel) {
          out.push({ feature: featureRel, testFile: fn, mocked: modRel });
        }
      }
    }
  }
  return out;
}

describe("🔴🔴 Mock 卫生棘轮:不许再靠 mock 把接缝抹平", () => {
  const cross = scanCrossMocks();

  it(`「测试 mock 掉同目录兄弟模块」的对数只减不增(上限 ${CROSS_MOCK_LIMIT})`, () => {
    const detail = cross.map((c) => `${c.feature}/__tests__/${c.testFile} → ${c.mocked}`).sort();
    expect(
      cross.length,
      `跨 mock 从 ${CROSS_MOCK_LIMIT} 增到 ${cross.length}。\n` +
        `🔴 mock 掉兄弟模块 = 那条接缝没有被任何测试观察(而 tsc / 变异都拦不住)。\n` +
        `要么不 mock,要么在同目录补一条装配层判据,再把上限**降下来**。\n当前清单:\n` +
        detail.join("\n")
    ).toBeLessThanOrEqual(CROSS_MOCK_LIMIT);
  });

  it("🔴 有跨 mock 的目录必须有装配层(`*-assembly.test.ts`),欠账名单只减不增", () => {
    const dirs = [...new Set(cross.map((c) => c.feature))].sort();
    const missing: string[] = [];
    for (const d of dirs) {
      const tdir = join(SRC, d, "__tests__");
      const has = readdirSync(tdir).some((f) => /-assembly\.test\.tsx?$/.test(f));
      if (!has) missing.push(d);
    }
    // ① 欠账不许变多
    for (const d of missing) {
      expect(ASSEMBLY_DEBT, `🔴 ${d} 有跨 mock 却没有装配层,且不在欠账名单里 —— 新目录必须一开始就有`).toContain(d);
    }
    // ② 名单里已经补上的必须从名单里删掉(防止名单变成永久豁免)
    const stale = ASSEMBLY_DEBT.filter((d) => !missing.includes(d));
    expect(stale, `这些目录已经有装配层了,请从 ASSEMBLY_DEBT 里删掉(名单只减不增)`).toEqual([]);
  });

  it("🔴 lib/genbi 的装配层必须存在,且**不许**再 mock 兄弟模块(它是这条纪律的样板)", () => {
    const tdir = join(SRC, "lib/genbi/__tests__");
    const f = readdirSync(tdir).find((x) => /-assembly\.test\.ts$/.test(x));
    expect(f, "lib/genbi 的装配层不见了").toBeTruthy();
    const src = readFileSync(join(tdir, f!), "utf8");
    for (const sib of ["cards-store", "cards-body-store", "cards-service"]) {
      expect(src, `🔴 装配层 mock 掉了兄弟模块 ${sib} —— 那就又把接缝抹平了`)
        .not.toContain(`vi.mock("@/lib/genbi/${sib}"`);
    }
    // 真外部**必须**被 mock(否则它会去打真 AWS —— 本仓事故 E1 的形状)
    for (const ext of ["@/lib/aws/dynamodb", "@aws-sdk/client-s3", "@/lib/exec-env/registry"]) {
      expect(src, `装配层没有 mock 真外部 ${ext}`).toContain(`vi.mock("${ext}"`);
    }
  });
});
