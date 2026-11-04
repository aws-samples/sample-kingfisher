// 🔴 删除态负向门禁(ACCEPTANCE):`residency-blocked` / `crossJurisdiction` / `cross-jurisdiction` 在**产品代码**里零命中。
// 为什么必须是门禁而不是一次性删除:这三个标识符是「不设法务门」之前的设计残骸,任何一处回流都会让跨法域 target 重新被当成「本就不该有」。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
    const fp = resolve(dir, e);
    if (statSync(fp).isDirectory()) walk(fp, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
  }
  return acc;
};
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("🔴 不设法务门(DESIGN §18 决策 6quinquies)—— 已删除的判据字面在产品代码里零命中", () => {
  const files = walk(SRC);
  it.each([
    ["residency-blocked", "⊘ 被驻留门控 观测态(五态 → 四态)"],
    // 2026-09-05 真环境 W5a-23 抓到:看板说明文案里仍列着「⊘被驻留门控」(代码删了、文案没删)⇒ 渲染文案也进负向清单
    ["被驻留门控", "看板 / 落地面板的说明文案(已作废态不许再出现在页面上)"],
    ["crossJurisdiction(", "直查「跨法域禁止合并」判据"],
    ["cross-jurisdiction", "直查错误类(跨法域 ⇒ 拒)"],
    ["跨法域执行目标(jurisdiction=", "deploy / preview / add-components 的 403 硬拦文案"],
    ["本期不接受绑定", "assertBindableTarget 的跨法域拒绑"],
  ])("`%s` 零命中(%s)", (marker) => {
    expect(files.length).toBeGreaterThan(200);
    const hits = files.filter((fp) => strip(readFileSync(fp, "utf8")).includes(marker)).map((fp) => fp.slice(SRC.length + 1));
    expect(hits, `仍有产品代码把 \`${marker}\` 当实现目标`).toEqual([]);
  });
  it("准入内核里挂着技术前置(residencyPrerequisite),且部署入口不再判 jurisdiction", () => {
    const registry = strip(readFileSync(resolve(SRC, "lib/exec-env/registry.ts"), "utf8"));
    expect(registry).toContain("const residency = residencyPrerequisite(t);");
    for (const rel of ["deploy", "preview", "add-components"]) {
      const src = strip(readFileSync(resolve(SRC, `app/api/admin/exec-envs/[targetId]/${rel}/route.ts`), "utf8"));
      expect(src, `${rel} 路由仍在按 jurisdiction 判`).not.toMatch(/jurisdiction\s*!==\s*"home"/);
    }
  });
});
