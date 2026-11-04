// 模块47 L3 — @netadvisor/core 规则目录的【快照守卫】。
//
// rules 抽 core 后天然单源(network-advisor/rules.ts 反向 re-export core/rules,只有一份 RULES),
// 无需 L2 catalog 那种"core 常量 === 平台真源"双源比对(netadvisor 本就单源,无外部常量)。
// 本单测锁住规则集契约:18 条规则全在、id 完整、hard/soft 标记正确、渲染文本含全部 id 与硬/软标签、
// 排障树结构完整——防未来误删规则或改坏渲染(反幻觉支柱②:模型看到的规则文本即引擎执行的规则)。
//
// 注:consumer 侧(connectivity-judge/skills-handler)行为由既有单测覆盖(re-export 保持其绿)。

import { describe, it, expect } from "vitest";
import { RULES, RULE_BY_ID, renderRulesForPrompt, ruleApplies, TROUBLESHOOTING_ORDER } from "../rules";

// 规则集契约锚(id → severity)。新增/删除规则须同步这里 —— 单测即"规则集变更评审点"。
const EXPECTED: Record<string, "hard" | "soft"> = {
  AZ_MATCH: "hard",
  PRIVATE_EGRESS: "hard",
  SELF_REF: "hard",
  EGRESS_TO_TARGET: "hard",
  SOURCE_INGRESS_FROM_SG: "hard",
  ROUTE: "hard",
  INTERFACE_ENDPOINT: "hard",
  GATEWAY_ENDPOINT: "hard",
  DNS_ATTRS: "hard",
  NACL: "hard",
  IP_CAPACITY: "hard",
  AZ_COVERAGE: "hard",
  DISCOVERABILITY: "hard",
  ENDPOINT_POLICY: "hard",
  CROSS_REGION: "hard",
  ZEROETL_POLICY: "hard",
  ZEROETL_BINLOG: "hard",
  LEAST_PRIV: "soft",
};

describe("@netadvisor/core 规则目录(快照守卫)", () => {
  it("规则总数与 id 集合精确一致(18 条)", () => {
    expect(RULES.length).toBe(18);
    expect(RULES.map((r) => r.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("每条规则 severity 标记与契约一致(仅 LEAST_PRIV 为 soft)", () => {
    for (const r of RULES) {
      expect(r.severity, `规则 ${r.id} 的 severity`).toBe(EXPECTED[r.id]);
    }
    expect(RULES.filter((r) => r.severity === "soft").map((r) => r.id)).toEqual(["LEAST_PRIV"]);
  });

  it("每条规则字段完整(title/statement/awsCitation/remediationType 非空)", () => {
    for (const r of RULES) {
      expect(r.title, `${r.id}.title`).toBeTruthy();
      expect(r.statement, `${r.id}.statement`).toBeTruthy();
      expect(r.awsCitation, `${r.id}.awsCitation`).toBeTruthy();
      expect(r.remediationType, `${r.id}.remediationType`).toBeTruthy();
    }
  });

  it("RULE_BY_ID 覆盖全部规则", () => {
    expect(Object.keys(RULE_BY_ID).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(RULE_BY_ID.AZ_MATCH.severity).toBe("hard");
  });

  it("renderRulesForPrompt 含全部规则 id + 硬/软标签(模型可见的权威规则文本)", () => {
    const text = renderRulesForPrompt();
    for (const id of Object.keys(EXPECTED)) {
      expect(text, `渲染文本应含规则 [${id}]`).toContain(`[${id}]`);
    }
    expect(text).toContain("硬性");
    expect(text).toContain("软性/最佳实践");
    expect(text.startsWith("以下是网络连通性的权威规则")).toBe(true);
  });

  it("ruleApplies 按 appliesToCompute 过滤(AZ_MATCH 仅 glue;LEAST_PRIV 全适用)", () => {
    expect(ruleApplies(RULE_BY_ID.AZ_MATCH, "glue")).toBe(true);
    expect(ruleApplies(RULE_BY_ID.AZ_MATCH, "dms")).toBe(false);
    expect(ruleApplies(RULE_BY_ID.LEAST_PRIV, "flink")).toBe(true); // 无 appliesToCompute=全适用
    expect(ruleApplies(RULE_BY_ID.ZEROETL_POLICY, "zeroetl")).toBe(true);
    expect(ruleApplies(RULE_BY_ID.ZEROETL_POLICY, "glue")).toBe(false);
  });

  it("TROUBLESHOOTING_ORDER 四层排障树结构完整(网络→凭证→驱动→SSL)", () => {
    expect(TROUBLESHOOTING_ORDER).toContain("1) 网络");
    expect(TROUBLESHOOTING_ORDER).toContain("2) 凭证");
    expect(TROUBLESHOOTING_ORDER).toContain("3) 驱动");
    expect(TROUBLESHOOTING_ORDER).toContain("4) SSL");
    expect(TROUBLESHOOTING_ORDER).toContain("UnableToFindVpcEndpoint");
  });
});
