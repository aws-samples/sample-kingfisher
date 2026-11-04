// 护栏 2(写操作在按钮上复述目标)的判据 + **单一作者闭合**。
//
// 🔴 起因:2026-09-19 无头验收抓到 —— 同一个 `/etl-jobs` 页面里,Glue/Redshift 作业的按钮写着
//   「立即运行 · us-west-2」,而 EMR Serverless 面板的按钮只写「立即运行」。两个都是「在某个区真跑
//   一次」的写操作,一个复述了目标、一个没有 ⇒ 用户点下去之前看不出这一下打到哪个区。
//   护栏 2 早就立了,只是**那条路径没接**(本仓的元 bug)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNowLabel } from "@/lib/scope/run-now-label";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const t = (s: string, v?: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(v?.[k] ?? `{${k}}`));

describe("立即运行按钮文案", () => {
  it("单区 ⇒ 复述该区 region", () => {
    expect(runNowLabel({ targets: ["tgt_usw2_a"], regionOfSingle: "us-west-2", t })).toBe("立即运行 · us-west-2");
  });
  it("多区 ⇒ 复述「几个区各跑一次」(用户看不出扇出就等于没发生)", () => {
    expect(runNowLabel({ targets: ["tgt_home", "tgt_usw2_a"], regionOfSingle: "", t })).toBe("立即运行(2 个区各跑一次)");
  });
  it("🔴 拿不到 region ⇒ 退回原文案,**绝不**拿 targetId 充数(targetId 不是用户语言)", () => {
    const s = runNowLabel({ targets: ["tgt_usw2_a"], regionOfSingle: "", t });
    expect(s).toBe("立即运行");
    expect(s).not.toContain("tgt_");
  });
  it("空绑定 ⇒ 也不炸", () => {
    expect(runNowLabel({ targets: [], regionOfSingle: "", t })).toBe("立即运行");
  });
});

describe("🔴 单一作者闭合:所有「立即运行」按钮都走 runNowLabel", () => {
  const CALLERS = ["app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx"];

  it("两个面板都调 runNowLabel,且都不再自己拼文案", () => {
    for (const rel of CALLERS) {
      const body = read(rel);
      expect(body, `${rel} 没调 runNowLabel`).toContain("runNowLabel({");
      // 自己拼的形状:`${t("立即运行")} · ` —— 出现即有人又抄了一份
      expect(body, `${rel} 里还有手写的文案拼接`).not.toContain('{t("立即运行")} · ');
      expect(body, `${rel} 里还有手写的多区文案`).not.toContain('t("立即运行({n} 个区各跑一次)"');
    }
  });

  it("🔴 两个按钮都有 data-testid(没有 testid 的写操作 = 页面级验收看不见它)", () => {
    expect(read("app/etl-jobs/page.tsx")).toContain('data-testid="etl-run-btn"');
    expect(read("components/engines/EmrJobPanel.tsx")).toContain('data-testid="emr-run-btn"');
  });

  it("EMR 面板的 region 取自**作业自己的绑定**,不是顶栏视角", () => {
    const body = read("components/engines/EmrJobPanel.tsx");
    expect(body).toContain("targets.length === 1 ? (execTargets.find((x) => x.targetId === targets[0])?.region");
  });
});
