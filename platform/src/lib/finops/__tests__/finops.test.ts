import { describe, it, expect } from "vitest";
import { costOfUsage, roundUsd, UNIT_PRICES, PRICE_VERSION } from "../pricing";
import { detectSpike } from "../anomaly-core";
import { costSignature } from "../cost-signature";
import { targetSignatureCode } from "@/lib/exec-env/target-id";
import { categorizeService } from "../constants";
import type { CostAnomaly } from "../types";

describe("pricing.costOfUsage", () => {
  it("Glue:DPUSeconds → 美元(实测样本 370s G.1X×2)", () => {
    // 370 DPU-s = 0.102777…h × $0.44 = $0.0452222…
    expect(roundUsd(costOfUsage("glue", { dpuSeconds: 370 }))).toBeCloseTo(0.045222, 5);
  });

  it("EMR Serverless:billedResourceUtilization 三项合计(实测样本 0.267 vCPUh + 1.2 GBh)", () => {
    const usd = costOfUsage("emr-serverless", { vcpuHours: 0.267, memoryGbHours: 1.2, storageGbHours: 0 });
    expect(usd).toBeCloseTo(0.267 * UNIT_PRICES.emrVcpuHourUsd + 1.2 * UNIT_PRICES.emrMemoryGbHourUsd, 8);
  });

  it("Athena:按 TB 计价,10MB 最低计费,0 字节不计费", () => {
    expect(costOfUsage("athena", { dataScannedBytes: 0 })).toBe(0);
    const tenMb = costOfUsage("athena", { dataScannedBytes: 1 }); // 1B 抬到 10MB 最低档
    expect(tenMb).toBeCloseTo((10 * 1024 * 1024 / 1024 ** 4) * 5, 10);
    const oneTb = costOfUsage("athena", { dataScannedBytes: 1024 ** 4 });
    expect(oneTb).toBeCloseTo(5, 6);
  });

  it("缺失计量视为 0(不 NaN)", () => {
    expect(costOfUsage("glue", {})).toBe(0);
    expect(costOfUsage("emr-serverless", {})).toBe(0);
  });

  it("priceVersion 存在(归因记录可审计)", () => {
    expect(PRICE_VERSION).toMatch(/^use1-/);
  });
});

describe("anomaly-core.detectSpike", () => {
  const flat = [1, 1.1, 0.9, 1, 1.05, 0.95, 1]; // 7 样本,基线≈1

  it("正常波动不报", () => {
    const v = detectSpike(flat, 1.2);
    expect(v.isSpike).toBe(false);
  });

  it("显著突增报出且倍数正确", () => {
    const v = detectSpike(flat, 5);
    expect(v.isSpike).toBe(true);
    expect(v.deviationX).toBeCloseTo(5, 1);
    expect(v.samples).toBe(7);
  });

  it("冷启动(样本<7)不报——即使当前值巨大", () => {
    const v = detectSpike([1, 1, 1], 100);
    expect(v.isSpike).toBe(false);
    expect(v.samples).toBe(3);
  });

  it("历史含 backfill 大跑离群点:MAD 剔除,不污染基线", () => {
    // 一次 50 的大跑混入;基线仍应≈1,当前 5 仍判异常
    const v = detectSpike([...flat, 50], 5);
    expect(v.baseline).toBeLessThan(1.5);
    expect(v.isSpike).toBe(true);
  });

  it("全等历史(mad=0)微小波动不报,大偏离报", () => {
    const same = [2, 2, 2, 2, 2, 2, 2];
    expect(detectSpike(same, 2.2).isSpike).toBe(false);
    expect(detectSpike(same, 6).isSpike).toBe(true);
  });
});

describe("cost-signature", () => {
  const taskAnomaly: CostAnomaly = {
    scope: "task", key: "01KX8D1BH0ABC", targetId: "tgt_home", displayName: "fact_ad_daily", date: "2026-07-13",
    actualUsd: 0.5, baselineUsd: 0.05, deviationX: 10, samples: 9, incidentRecorded: false, notified: false,
  };
  const svc = (key: string, region: string): CostAnomaly => ({
    scope: "service", key, region, displayName: key, date: "2026-07-13",
    actualUsd: 5, baselineUsd: 1, deviationX: 5, samples: 9, incidentRecorded: false, notified: false,
  });

  it("任务级:同任务同区稳定归并,含引擎前缀与 target 短码,不含金额/任务名", () => {
    const s1 = costSignature(taskAnomaly, "emr");
    const s2 = costSignature({ ...taskAnomaly, actualUsd: 0.9, deviationX: 18 }, "emr");
    expect(s1.signature).toBe(s2.signature);
    expect(s1.signature).toBe(`emr::COST_SPIKE_TASK_01KX8D1BH0ABC_AT_${targetSignatureCode("tgt_home")}`);
    expect(s1.signature).toMatch(/^[a-z]+::[A-Z0-9_]+$/);
    expect(s1.title).not.toContain("fact_ad_daily");
    expect(s1.title).not.toContain("0.5");
  });

  // 变异:去掉 target 维 ⇒ 本条红
  it("🔴 任务级:同任务**不同区**必须是不同签名(否则两区事件落进同一知识库主档)", () => {
    const a = costSignature({ ...taskAnomaly, targetId: "tgt_home" }, "glue");
    const b = costSignature({ ...taskAnomaly, targetId: "tgt_usw2_a" }, "glue");
    expect(a.signature).not.toBe(b.signature);
    // 不喂 targetId 原文(出口清单:大写化会折叠 `_`)
    expect(b.signature).not.toContain("USW2");
  });

  it("服务级:服务名 + region slug 化;不同服务、同服务不同区都不归并", () => {
    const a = costSignature(svc("AWS Glue", "us-east-1"), "finops");
    const b = costSignature(svc("Amazon Athena", "us-east-1"), "finops");
    const c = costSignature(svc("AWS Glue", "us-west-2"), "finops");
    expect(a.signature).toBe("finops::COST_SPIKE_SERVICE_AWS_GLUE_IN_US_EAST_1");
    expect(a.signature).not.toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it("targetSignatureCode:确定性、8 位大写十六进制、相近 id 不撞", () => {
    expect(targetSignatureCode("tgt_usw2_a")).toBe(targetSignatureCode("tgt_usw2_a"));
    expect(targetSignatureCode("tgt_usw2_a")).toMatch(/^[0-9A-F]{8}$/);
    const ids = ["tgt_home", "tgt_a_b", "tgt_ab", "tgt_usw2_a", "tgt_usw2_b", "tgt_euw1_prod"];
    expect(new Set(ids.map(targetSignatureCode)).size).toBe(ids.length);
  });
});

describe("constants.categorizeService", () => {
  it("MWAA=底座,Glue=引擎,未知=other", () => {
    expect(categorizeService("Amazon Managed Workflows for Apache Airflow")).toBe("base");
    expect(categorizeService("AWS Glue")).toBe("engine");
    expect(categorizeService("Some Future Service")).toBe("other");
  });
});
