// @kf-batch 50-WP4quater-reads(工单 SC-17)
/**
 * 钉住「Copilot 建出来的草稿必须有落点章」。
 *
 * 🔴 这是本仓记录过的教训**第二次现形**:「planner 是唯一绕过环境注入的路径」。
 * `create-service.ts` 的三个 `createXxxDraft` 直接写 DDB,绕过了平台的落点作者
 * (`bindingForNewSyncTask` / 新建路由里的落点校验)⇒ 建出来的行**一个章都没有**,
 * 读侧三级回落把它们全归主控区。用户在 us-west-2 视角下让 Copilot 建一个同步任务,
 * **在他自己的列表里根本看不见** —— 而没有任何报错。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = (p: string) => strip(readFileSync(resolve(SRC, p), "utf8"));

describe("Copilot 草稿的落点章(SC-17)", () => {
  const svc = read("lib/copilot/tools/create-service.ts");

  it("🔴 同步草稿的章必须走**平台唯一的落点作者**,不许在这里另写一份判定", () => {
    expect(svc, "没过 bindingForNewSyncTask ⇒ 草稿无章 ⇒ 读侧全归主控区").toContain("bindingForNewSyncTask(");
    // 🔴 光调用不算 —— 结果必须**真写进落库的那一行**。
    // 变异验证第一轮:我把 `...binding,` 从 item 里删掉(只留调用),上面那条判据照样绿。
    // 「调用存在」与「结果被使用」是两件事,判据必须落在后者上。
    expect(svc, "binding 算出来了却没写进 item ⇒ 等于没盖章").toMatch(/\.\.\.binding,/);
    // 章来自数据源行;读不到数据源就退回计划面向的区(而不是凭空猜一个区)
    expect(svc).toContain("caller.targetId || HOME_TARGET_ID");
  });

  it("🔴 离线作业草稿必须盖 targets[](否则它在别的区看不见)", () => {
    expect(svc).toMatch(/targets: \[caller\.targetId \|\| HOME_TARGET_ID\]/);
  });

  it("落点必须能一路传到执行体(规划是异步任务,只放内存里执行体拿不到)", () => {
    // 🔴 @kf-batch 50-B39-plan-target:原来这条查的是**类型声明**里有 `targetId?: string;` ——
    //   类型一直有、Put 里一直没写 ⇒ 本条恒绿而落点从没落库(段 cov 真环境坐实)。
    //   接缝的真判据在 `lib/copilot/plan/__tests__/plan-target-assembly.test.ts`(只 mock 真外部);
    //   这里只钉三处写法不许回退:Put 写它 · 执行体经唯一作者读 · 计划行不再有静默缺省。
    expect(read("lib/copilot/plan/plan-task-service.ts"), "任务行必须落 targetId").toContain("targetId: params.targetId,");
    expect(read("lib/copilot/plan/plan-task-runner.ts")).toContain("targetOfStamp(task.targetId)");
    const svc = read("lib/copilot/plan/plan-service.ts");
    expect(svc, "计划行要盖章").toContain("targets: [input.targetId],");
    expect(svc, "不许回到静默缺省").not.toContain("input.targetId || HOME_TARGET_ID");
  });

  it("🔴 提交规划的落点走 **body** 而不是 `?scope=`(写/执行路由不读 scope,SPEC §2.6.3)", () => {
    const route = read("app/api/copilot/plan/route.ts");
    // B-39:带了就必须合法(否则 400),没带才显式定为主控区 —— 非法值不许静默改成主控区
    expect(route).toContain("isValidTargetId(rawTarget)");
    expect(route).toContain("targetId 不合法 —— 不会改用主控区");
    // 列表侧才读 scope
    expect(route).toContain("readScope(req)");
  });
});
