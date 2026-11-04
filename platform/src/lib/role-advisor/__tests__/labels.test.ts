// 页面半边(2026-10-01 新账号无头复现):
//   ① 预检拒因叫用户点「一键补齐」,页面上的按钮却叫「一键创建角色」(两个作者各写一个名字);
//   ② 后端对账真补回了权限,页面只说「角色已存在,已复用」(`reconciledSids` 在最后一跳被丢掉)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  provisionOutcome, ROLE_APPLY_BUTTON_LABEL, ROLE_RECOMMEND_BUTTON_LABEL, ROLE_APPLY_HOW_TO,
} from "../labels";

const SRC = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
/** 剥掉注释(行注释 / 块注释 / JSX 注释)再判,别让注释里的旧名字打红或放行。 */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "__tests__" && n !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

describe("provisionOutcome:「一键」结果封闭三态", () => {
  it("新建 ⇒ created", () => {
    expect(provisionOutcome({ roleName: "r", created: true }).kind).toBe("created");
  });
  it("🔴 已存在且补了 Sid ⇒ reconciled,并原样带出补了哪几条(不许说成「复用」)", () => {
    const o = provisionOutcome({ roleName: "r", created: false, reconciled: true, reconciledSids: ["BaselineEmrLogDestination"] });
    expect(o).toEqual({ kind: "reconciled", roleName: "r", sids: ["BaselineEmrLogDestination"] });
  });
  it("🔴 布尔与清单不一致时以清单为准(有补就如实说补了)", () => {
    expect(provisionOutcome({ roleName: "r", created: false, reconciled: false, reconciledSids: ["X"] }).kind).toBe("reconciled");
  });
  it("已存在且本来就齐 ⇒ unchanged", () => {
    expect(provisionOutcome({ roleName: "r", created: false, reconciled: false, reconciledSids: [] }).kind).toBe("unchanged");
  });
});

describe("🔴🔴 按钮名与「点哪里」只有一个作者", () => {
  it("出路那一句引用的就是真实的两个按钮名", () => {
    expect(ROLE_APPLY_HOW_TO).toContain(ROLE_APPLY_BUTTON_LABEL);
    expect(ROLE_APPLY_HOW_TO).toContain(ROLE_RECOMMEND_BUTTON_LABEL);
  });

  it("面板的两个按钮都取自 labels(在调用位置,不是只 import)", () => {
    const s = code(read("components/role-advisor/RoleAdvisorPanel.tsx")).replace(/^import .*$/gm, "");
    expect(s).toMatch(/t\(ROLE_APPLY_BUTTON_LABEL\)/);
    expect(s).toMatch(/t\(ROLE_RECOMMEND_BUTTON_LABEL\)/);
  });

  it("🔴 预检拒因的出路取自 ROLE_APPLY_HOW_TO(三处:角色不存在 / 量不了 / 缺权限)", () => {
    const s = code(read("lib/role-advisor/preflight.ts")).replace(/^import .*$/gm, "");
    expect((s.match(/\$\{ROLE_APPLY_HOW_TO\}/g) || []).length).toBe(3);
  });

  it("🔴🔴 闭合式:任何「…一键创建 / 一键补齐…」的按钮指引都必须包含真实按钮名(含 cookbook 配方文本 —— 它编译不进 labels,只能由本条钉住)", () => {
    // 2026-10-01 第三跑真踩:预检「角色不存在」分支自写了「一键创建/补齐」(无空格),上一版只禁两个固定词所以漏了 ⇒
    //   反过来钉「唯一允许的形态」:引号里只要提到一键创建/补齐,就必须含 ROLE_APPLY_BUTTON_LABEL。
    const bad: string[] = [];
    for (const f of walk(SRC)) {
      if (f.endsWith(join("i18n", "messages", "en.ts")) || f.endsWith(join("role-advisor", "labels.ts"))) continue;
      const s = code(readFileSync(f, "utf-8"));
      for (const m of s.matchAll(/「([^」]*一键(?:创建|补齐)[^」]*)」/g)) {
        if (m[1].includes("${ROLE_APPLY_BUTTON_LABEL}") || m[1].includes(ROLE_APPLY_BUTTON_LABEL)) continue;
        bad.push(`${f.slice(SRC.length + 1)}: 「${m[1]}」`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("🔴 闭合式:产品代码里不许再出现自写的「一键补齐」/「一键创建角色」按钮名", () => {
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      if (f.endsWith(join("i18n", "messages", "en.ts"))) continue; // 翻译表的键不是作者
      const s = code(readFileSync(f, "utf-8"));
      if (/一键补齐|一键创建角色/.test(s)) hits.push(f.slice(SRC.length + 1));
    }
    expect(hits).toEqual([]);
  });
});

describe("🔴 面板把对账结果呈现出来(最后一跳不许丢)", () => {
  const s = code(read("components/role-advisor/RoleAdvisorPanel.tsx"));
  it("用 provisionOutcome 解析接口结果,且常驻结果框带 data-outcome / data-sids", () => {
    expect(s).toMatch(/provisionOutcome\(r\.data\)/);
    expect(s).toContain('data-testid="role-advisor-result"');
    expect(s).toMatch(/data-outcome=\{outcome\.kind\}/);
    expect(s).toMatch(/data-sids=/);
  });
  it("不许再有把「补过了」说成「复用」的旧文案", () => {
    expect(s).not.toMatch(/已复用/);
  });
});
