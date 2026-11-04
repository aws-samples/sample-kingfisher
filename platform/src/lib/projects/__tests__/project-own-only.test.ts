// 删项目的守卫必须只数「这个项目**拥有**的东西」——不许把**全局共享**的条目算成它的。
//
// 【真环境实证】2026-09-15 段 `gbc` 的 GC-15 正控制(空项目必须删得掉)红了,拒因逐字是:
//   「项目空间下仍有内容,已拒绝删除(平台不做级联删除):问数会话卡片 1 个、**问数业务口径 13 个**」
// 而那 13 条口径的 `projectId` 是 `global`(所有项目共享,谁删了都影响别人)⇒ 用户看到的是
// 「新建的空项目删不掉,而让我去删的东西不是我的」。根因不是某行写错,是**同一个集合被当成两件事用**:
//   · grounding 要「这个项目能看见什么」= 项目 ∪ global(`listContext` / `listSkills` 刻意合并);
//   · 删除守卫要「这个项目拥有什么」= 只有项目自己。
// ⇒ 两种语义两个作者;本门禁同时钉住 ①行为(合并版与 owned 版结果必须不同)②接线(守卫真的用了 owned 版)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** 一张按 pk 存的内存表:global 有 13 条,proj-空 有 0 条,proj-有货 有 2 条 */
const ROWS: Record<string, Array<Record<string, unknown>>> = {
  global: Array.from({ length: 13 }, (_, i) => ({ projectId: "global", entryId: `g${i}`, updatedAt: "2026-01-01" })),
  "proj-empty": [],
  "proj-has": [
    { projectId: "proj-has", entryId: "a", updatedAt: "2026-02-01" },
    { projectId: "proj-has", entryId: "b", updatedAt: "2026-02-02" },
  ],
};

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { GENBI_CONTEXT: "bgp-genbi-context", GENBI_SKILLS: "bgp-genbi-skills" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const input = (cmd.input ?? {}) as Record<string, any>;
      // 🔴 mock 只回**传进来的那个 pk** 的行(不许自己编:回传入参是 mock 的底线)
      const pid = String(input.ExpressionAttributeValues?.[":p"] ?? "");
      return { Items: ROWS[pid] ?? [] };
    }),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe("🔴🔴 「能看见什么」与「拥有什么」必须是两个作者", () => {
  it("空项目:合并版数出 13(全局的)而 **owned 版数出 0** —— 差别就是这个缺陷的全部", async () => {
    const { listContext, listContextOwnedByProject } = await import("@/lib/genbi/context");
    expect((await listContext("proj-empty")).length).toBe(13);
    expect((await listContextOwnedByProject("proj-empty")).length).toBe(0);
  });

  it("有货的项目:owned 版只数自己的 2 条,合并版是 2 + 13", async () => {
    const { listContext, listContextOwnedByProject } = await import("@/lib/genbi/context");
    expect((await listContextOwnedByProject("proj-has")).length).toBe(2);
    expect((await listContext("proj-has")).length).toBe(15);
  });

  it("owned 版拿到的每一行,projectId 都必须等于问的那个项目(不许漏过 global)", async () => {
    const { listContextOwnedByProject } = await import("@/lib/genbi/context");
    for (const r of await listContextOwnedByProject("proj-has")) {
      expect((r as { projectId: string }).projectId).toBe("proj-has");
    }
  });

  it("🔴 接线:删项目的资源清单**真的**用 owned 版(不是又留着合并版)", () => {
    const src = read("lib/projects/project-resources.ts");
    expect(src).toContain("listContextOwnedByProject");
    expect(src).toContain("listSkillsOwnedByProject");
    // 反例:合并版一旦回到这张清单里,空项目又会删不掉
    expect(src).not.toMatch(/list:\s*listContext\s*[,}]/);
    expect(src).not.toMatch(/list:\s*listSkills\s*[,}]/);
  });

  it("🔴 合并版**必须**继续合并(问数要靠它;别为了修这个 bug 把 grounding 改坏)", () => {
    const ctx = read("lib/genbi/context.ts");
    const skl = read("lib/genbi/skills.ts");
    for (const s of [ctx, skl]) expect(s).toContain("GLOBAL_SCOPE");
    expect(ctx).toMatch(/\[\.\.\.proj, \.\.\.glob\]/);
    expect(skl).toMatch(/\[\.\.\.proj, \.\.\.glob\]/);
  });
});
