/**
 * 🔴🔴 **Node 的 keep-alive 必须活得比 ALB 的空闲超时长**,否则偶发 502(无法复现的那种)。
 *
 * 缘由(2026-09-16 全量硬门实测两发):ALB 复用一条 keep-alive 连接的同一瞬间,
 * 目标端把它关掉 ⇒ **ALB 自己**产出 502(`HTTPCode_ELB_502_Count`=1,而 `HTTPCode_Target_5XX`=0、
 * 容器日志零错、ECS 无重启),同一请求手动重放 200/2.3s。两发各打红一整段(gbc / wp18)。
 *
 * 本门禁比的是**两个数的关系**(不是「有没有写那个变量」):
 * 从 CDK 源里取 ALB 空闲超时(秒)与容器 `KEEP_ALIVE_TIMEOUT`(毫秒),后者必须**严格大于**前者。
 * 真环境侧另有判据 N0-17(直接问 ALB 属性与 task definition)—— 这道是 3 秒能红的那一层。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../../../../../infra/lib/platform-stack.ts"), "utf8");

describe("🔴 ALB 空闲超时 vs 容器 keep-alive(偶发 502 的根)", () => {
  it("两个数都从 CDK 源里取得到,且 keep-alive 严格更长", () => {
    const idle = SRC.match(/const ALB_IDLE_TIMEOUT_SECONDS = (\d+);/);
    expect(idle, "ALB 空闲超时必须**显式**写在源里(吃 CDK 默认值 ⇒ 默认一变就静默失配)").toBeTruthy();
    const idleSec = Number(idle![1]);

    // 空闲超时必须真的被设到 ALB 上(只声明常量不 setAttribute = 白写)
    expect(SRC).toMatch(/setAttribute\(\s*"idle_timeout\.timeout_seconds",\s*String\(ALB_IDLE_TIMEOUT_SECONDS\)\s*\)/);

    const ka = SRC.match(/const NODE_KEEP_ALIVE_TIMEOUT_MS = \(ALB_IDLE_TIMEOUT_SECONDS \+ (\d+)\) \* 1000;/);
    expect(ka, "keep-alive 必须**从空闲超时派生**(两个独立字面量迟早各改一个)").toBeTruthy();
    const kaMs = (idleSec + Number(ka![1])) * 1000;

    expect(kaMs, `keep-alive(${kaMs}ms)必须 > ALB 空闲超时(${idleSec * 1000}ms)`).toBeGreaterThan(idleSec * 1000);

    // 必须真的注进容器环境(Next.js standalone 只认这个变量名)
    expect(SRC).toMatch(/KEEP_ALIVE_TIMEOUT: String\(NODE_KEEP_ALIVE_TIMEOUT_MS\)/);
  });
});
