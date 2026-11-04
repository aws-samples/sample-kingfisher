// @kf-batch 54-genbi-session-cards
// 🔴 「执行目标不能承接」→ HTTP 的映射**只许有一处定义**(2026-09-13 立)。
// 病史:建模落地路由对同一件事回 **500**,而卡片 / 运行 / add-components 回 **409 + target-not-ready**
// ⇒ 500 把人引去查平台故障,而这件事是**用户可修**的;两份映射还会各自漂移。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targetNotReadyResponse } from "@/lib/exec-env/target-http";
import { TargetNotReadyError } from "@/lib/exec-env/registry";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== "__tests__") walk(p, out);
    } else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("🔴 target-not-ready 的 HTTP 映射是单一作者", () => {
  it("映射本身:409 + code CONFLICT + detail.reason=target-not-ready(带 targetId 与原因)", async () => {
    const r = targetNotReadyResponse(new TargetNotReadyError("tgt_use1_z", "描述符已 stale"));
    expect(r, "不是 null").toBeTruthy();
    expect(r!.status, "必须 409(用户可修),不是 500").toBe(409);
    const body = await r!.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.detail.reason).toBe("target-not-ready");
    expect(body.error.detail.targetId).toBe("tgt_use1_z");
    expect(body.error.message).toContain("描述符已 stale");
  });

  it("不是这个类型 ⇒ 回 null(调用方继续走自己的分支,绝不吞掉别的错误)", () => {
    expect(targetNotReadyResponse(new Error("别的错"))).toBeNull();
    expect(targetNotReadyResponse(null)).toBeNull();
  });

  it("🔴 全仓只有 `target-http.ts` 一处构造这个 409(其余入口必须委托它)", () => {
    const hits = walk(SRC)
      .filter((f) => !f.endsWith("target-http.ts"))
      .filter((f) => readFileSync(f, "utf8").includes('reason: "target-not-ready"'))
      .map((f) => f.slice(SRC.length + 1));
    expect(hits, `这些文件自己拼了那个 409,请改成调 targetNotReadyResponse():\n${hits.join("\n")}`).toEqual([]);
  });
});
