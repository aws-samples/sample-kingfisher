// 🔴 (2026-11-01 …4916 第五十轮硬门 wp24 真撞):后台编排等 DMS 复制实例的预算 8 分钟 < AWS 真建实例 13.3 分钟
//    ⇒ 编排放弃、复制任务从未创建、用户得再点一次。本判据钉三件事实:
//    ① 预算 ≥ 25 分钟(覆盖实测 13.3 分钟并留余量)且 ≤ 60 分钟(不许无限等);
//    ② 轮询循环真的用这份常量(不许再长出 `i < 48` 这种字面量);
//    ③ 用户可见文案不再说「3–5 分钟」(文案与预算同源,别让页面骗人)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPLICATION_INSTANCE_WAIT } from "../dms-service";

const read = (rel: string) => readFileSync(resolve(__dirname, "../../../", rel), "utf8");

describe("DMS 复制实例等待预算", () => {
  it("① 预算覆盖实测的实例创建时长(13.3 分钟)并留余量,且有上限", () => {
    const totalMin = (REPLICATION_INSTANCE_WAIT.intervalMs * REPLICATION_INSTANCE_WAIT.maxAttempts) / 60_000;
    expect(totalMin, "预算必须 ≥ 25 分钟:…4916 实测 CreateReplicationInstance → available 用了 13.3 分钟,8 分钟预算让编排在实例就位前放弃").toBeGreaterThanOrEqual(25);
    expect(totalMin, "预算必须 ≤ 60 分钟:后台编排不许无限等").toBeLessThanOrEqual(60);
    expect(REPLICATION_INSTANCE_WAIT.intervalMs).toBeGreaterThanOrEqual(10_000);
  });

  it("② getReplicationInstanceArn 的轮询循环用的是这份常量,不是字面量", () => {
    const src = read("lib/realtime/dms-service.ts");
    expect(src).toMatch(/for \(let i = 0; i < REPLICATION_INSTANCE_WAIT\.maxAttempts && cur && cur\.status !== "available"; i\+\+\)/);
    expect(src).toMatch(/await sleep\(REPLICATION_INSTANCE_WAIT\.intervalMs\)/);
    expect(src, "不许再长出 8 分钟那种写死的循环上限").not.toMatch(/i < 48 &&/);
  });

  it("③ 启动路由给用户看的文案与预算同源:说「约 10–15 分钟」,不再说「3–5 分钟」", () => {
    const route = read("app/api/sync/[id]/start-realtime/route.ts");
    expect(route).toMatch(/首次使用需先创建复制实例\(约 10–15 分钟\)/);
    expect(route).not.toMatch(/约 3[–-]5 分钟/);
    const svc = read("lib/realtime/dms-service.ts");
    expect(svc).not.toMatch(/3[–-]5 ?min|首次使用需 3[–-]5 分钟/);
  });
});
