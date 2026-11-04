// 用户 2026-10-21 拍板:「造数据不需要在前台预留面板,这是测试使用的」(原 UX 候选 ⑤:演示造数面板的禁用按钮 tooltip 盖住「新建」)。
//   钉两件事:① 数据源页不再渲染造数面板(组件文件删除,页面无引用);② 造数能力本身**保留给测试**:
//   /api/seed/run · /api/seed/schedules(·/[taskId]) 三条路由与唯一作者 lib/seed/run-once.ts 仍在、仍被路由与调度动作处理器调用
//   (硬门 4b 能力矩阵 seed 行、fixture_projects 都走它们)。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("🔴 造数面板已移出前台(用户 2026-10-21 拍板)", () => {
  it("组件文件不存在,数据源页无任何造数面板引用 / testid", () => {
    expect(fs.existsSync(path.join(SRC, "components/datasources/SeedDataPanel.tsx"))).toBe(false);
    const page = strip(read("app/datasources/page.tsx"));
    for (const token of ["SeedDataPanel", "seed-panel", "seed-run-btn", "seed-schedule-create-btn"]) {
      expect(page, `数据源页仍含 ${token}`).not.toContain(token);
    }
    // 全仓组件 / 页面里都不许再出现(防止换个地方又长出来)
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? (d.name === "__tests__" ? [] : walk(path.join(dir, d.name))) : d.name.endsWith(".tsx") ? [path.join(dir, d.name)] : []
      );
    const offenders = [...walk(path.join(SRC, "app")), ...walk(path.join(SRC, "components"))].filter((f) =>
      /SeedDataPanel|data-testid="seed-(panel|run-btn|schedule-create-btn)"/.test(fs.readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("造数能力保留给测试夹具:三条 /api/seed 路由与唯一作者 runSeedOnce 仍在且仍被调用", () => {
    for (const rel of ["app/api/seed/run/route.ts", "app/api/seed/schedules/route.ts", "app/api/seed/schedules/[taskId]/route.ts", "lib/seed/run-once.ts"]) {
      expect(fs.existsSync(path.join(SRC, rel)), `${rel} 不在了`).toBe(true);
    }
    expect(strip(read("app/api/seed/run/route.ts"))).toMatch(/runSeedOnce\(/);
    expect(strip(read("lib/scheduler/action-handlers.ts"))).toMatch(/runSeedOnce\(/);
  });
});
