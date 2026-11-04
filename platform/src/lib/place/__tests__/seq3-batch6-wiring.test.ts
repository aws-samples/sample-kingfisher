// @kf-batch 50-WP31-place-first-class
// WP-31 序 3 第六批:指标计算 / 治理写入 / 数仓直查页 / 问数卡片 —— 「没给 = 主控区」整类拆掉之后的接线判据。
//
// 🔴 只查**调用位置**(剥掉 import 与注释再查):token 出现在 import 行不算接上(记忆 wiring-criteria-must-check-call-site)。
// 行为侧(缺 / 非法 ⇒ 拒、不回落主控区)由 `redshift/__tests__/direct-query.test.ts` 的 resolver 判据承担;
// 本文件钉「每个入口都经点名作者 + 每个页面都把落点带上」,两半缺一半都会让漏传重新静默落主控区。
// @kf-batch 50-WP31-place-first-class —— B-35 后一半:写治理元数据 / 直查任务 / 直查历史 / 列库这五处改用 `requestedRegisteredPlace`
//   (点名 + 已注册且装好;不存在 ⇒ 409,原来只验格式 ⇒ 写下 `tgt_nope_zz` 的孤儿记录 / 回主控区默认库名 `dev`)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^import [\s\S]*?;$/gm, "");
const read = (rel: string) => code(readFileSync(join(SRC, rel), "utf8"));

describe("🔴 后端:每个入口都经点名作者(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE),且落点错误不被兜底 catch 吞掉", () => {
  const CASES: Array<[string, RegExp]> = [
    ["app/api/metrics/[id]/compute/route.ts", /requestedTargetId\(body\?\.targetId, "[^"]+"\)/],
    ["app/api/metrics/compute-all/route.ts", /requestedTargetId\(body\?\.targetId, "[^"]+"\)/],
    ["app/api/governance/quality-run/route.ts", /requestedTargetId\(body\?\.targetId, "[^"]+"\)/],
    ["app/api/governance/sensitive-scan/route.ts", /targetId: requestedTargetId\(body\?\.targetId, "[^"]+"\)/],
    ["app/api/governance/quality-rules/route.ts", /scopedFqn\(body\.fqn, \(await requestedRegisteredPlace\(body\.targetId, "[^"]+"\)\)\.targetId\)/],
    ["app/api/governance/classification/route.ts", /scopedFqn\(body\.fqn, \(await requestedRegisteredPlace\(body\.targetId, "[^"]+"\)\)\.targetId\)/],
    ["app/api/redshift/execute/route.ts", /normalizeQueryTargets\(requestedTargets\(body, "[^"]+"\)\)/],
    ["app/api/redshift/tasks/route.ts", /bodyTarget = \(await requestedRegisteredPlace\(body\?\.targetId, "[^"]+"\)\)\.targetId/],
    ["app/api/redshift/history/route.ts", /tid = \(await requestedRegisteredPlace\(body\?\.targetId, "[^"]+"\)\)\.targetId/],
    ["app/api/redshift/result/[id]/route.ts", /fromHandle \|\| requestedTargetId\(req\.nextUrl\.searchParams\.get\("targetId"\), "[^"]+"\)/],
    ["app/api/redshift/databases/route.ts", /targetId = \(await requestedRegisteredPlace\(sp\.get\("targetId"\), "[^"]+"\)\)\.targetId/],
    ["app/api/redshift/schemas/route.ts", /targetId: requestedTargetId\(sp\.get\("targetId"\), "[^"]+"\)/],
    ["app/api/genbi/cards/route.ts", /targetId: requestedTargetId\(body\.targetId, "[^"]+"\)/],
  ];
  for (const [f, re] of CASES) {
    it(f, () => {
      const s = read(f);
      expect(s, `${f} 没经点名作者取落点`).toMatch(re);
      expect(s, `${f} 没把落点错误映成 400 / 409`).toMatch(/placeErrorResponse\(e\)/);
    });
  }

  it("负向:这些入口里不许再出现「没给 / 非法 ⇒ 主控区」的旧写法", () => {
    for (const [f] of CASES) {
      const s = read(f);
      expect(s, f).not.toMatch(/targetId \|\| HOME_TARGET_ID|\|\| undefined;\s*$|governanceTargetFrom\(req\.nextUrl\.searchParams\)\)\);\s*$/m);
    }
    // 取结果:两样都没有 / 目标不存在,原来回落主控区客户端
    expect(read("app/api/redshift/result/[id]/route.ts")).not.toMatch(/homeRegion\(/);
  });
});

describe("🔴 前端:页面把落点**显式**带上(唯一作者 landingOfScope;不再「不带 ⇒ 服务端回落主控区」)", () => {
  it("指标页:两种计算都恒带 targetId = landingOfScope(scope)", () => {
    const s = read("app/metrics/page.tsx");
    expect(s).toMatch(/const computeTargetId = landingOfScope\(scope\);/);
    expect(s.match(/body: JSON\.stringify\(\{ targetId: computeTargetId \}\)/g)?.length).toBe(2);
    expect(s, "仍按视角条件性地不带落点").not.toMatch(/computeTargetId \? \{ targetId/);
  });

  it("治理页:运行检查 / 敏感扫描 / 添加规则 / 保存分级 四处写入都带 targetId: govTargetId", () => {
    const s = read("app/governance/page.tsx");
    expect(s).toMatch(/const govTargetId = landingOfScope\(scope\);/);
    const calls: Array<[string, RegExp]> = [
      ["运行检查", /"\/api\/governance\/quality-run",[\s\S]{0,200}?targetId: govTargetId/],
      ["敏感扫描", /"\/api\/governance\/sensitive-scan",[\s\S]{0,260}?targetId: govTargetId/],
      ["添加规则", /"\/api\/governance\/quality-rules",[\s\S]{0,300}?targetId: govTargetId \}\)/],
      ["保存分级", /`\/api\/governance\/classification`,[\s\S]{0,300}?targetId: govTargetId \}\)/],
    ];
    for (const [what, re] of calls) expect(s, `${what} 的请求体没带落点`).toMatch(re);
  });

  it("同步向导:列库清单恒带该源的章(主控区也带)", () => {
    const s = read("app/sync/SyncTaskModal.tsx");
    expect(s).toMatch(/\/api\/redshift\/databases\?workgroup=\$\{encodeURIComponent\(v\)\}&targetId=\$\{encodeURIComponent\(watchDsOwnerTarget\)\}/);
    expect(s, "仍是「非主控区才带」").not.toMatch(/dsNonHome \? `&targetId=/);
  });
});
