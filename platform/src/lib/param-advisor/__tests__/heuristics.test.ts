// 推荐引擎单测 — 纯函数,无 mock AWS。覆盖四通道的档位规则、历史实据加成、
// clamp 越界、prefill 组装、questions 生成。
import { describe, it, expect } from "vitest";
import { recommend } from "../heuristics";
import { catalogFor, renderCatalogForPrompt } from "../catalog";
import type { HistoryFacts, ParamAdviceRequest } from "../types";
import { GLUE_VERSION_DEFAULT } from "@/lib/sync/glue-version";

const noHistory: HistoryFacts = { kind: "none", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z" };

function rec(req: ParamAdviceRequest, history: HistoryFacts | null = noHistory) {
  return recommend(req, history);
}
function valOf(res: ReturnType<typeof recommend>, key: string) {
  return res.recommendations.find((r) => r.key === key)?.value;
}

describe("catalog", () => {
  it("四通道目录都非空,key 唯一", () => {
    for (const ch of ["glue-etl", "glue-sync", "flink", "dms"] as const) {
      const defs = catalogFor(ch);
      expect(defs.length).toBeGreaterThan(0);
      expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
    }
  });
  it("renderCatalogForPrompt 含平台默认与 console 出处", () => {
    const text = renderCatalogForPrompt("glue-etl");
    expect(text).toContain("glueConfig.workerType");
    expect(text).toContain("Glue Job > Worker type");
    expect(text).toContain(GLUE_VERSION_DEFAULT);
  });
});

describe("glue-etl 档位规则", () => {
  it("未知数据量 → 最小规格 + 追问数据量", () => {
    const r = rec({ channel: "glue-etl" });
    expect(valOf(r, "glueConfig.workerType")).toBe("G.1X");
    expect(valOf(r, "glueConfig.numberOfWorkers")).toBe(2);
    expect(r.questions.some((q) => q.includes("GB"))).toBe(true);
  });
  it("小数据量(10GB) → G.1X 少 worker", () => {
    const r = rec({ channel: "glue-etl", workload: { estimatedDataGB: 10 } });
    expect(valOf(r, "glueConfig.workerType")).toBe("G.1X");
    expect(valOf(r, "glueConfig.numberOfWorkers")).toBe(2);
    expect(r.questions).toHaveLength(0);
  });
  it("大数据量(400GB) → G.2X,超大数据量 worker 数不再被压到 20", () => {
    const r = rec({ channel: "glue-etl", workload: { estimatedDataGB: 400 } });
    expect(valOf(r, "glueConfig.workerType")).toBe("G.2X");
    expect(valOf(r, "glueConfig.numberOfWorkers")).toBe(10); // ceil(400/40)=10
    const r2 = rec({ channel: "glue-etl", workload: { estimatedDataGB: 2000 } });
    expect(valOf(r2, "glueConfig.numberOfWorkers")).toBe(50); // ceil(2000/40)=50(上限已放开到 1000)
  });
  it("Glue 版本推平台缺省(清单最高,;用户可降版)", () => {
    const r = rec({ channel: "glue-etl", workload: { estimatedDataGB: 50 } });
    expect(valOf(r, "glueConfig.glueVersion")).toBe(GLUE_VERSION_DEFAULT);
  });
  it("有运行历史(P90) → 超时按 P90×1.5,basedOnHistory=true", () => {
    const history: HistoryFacts = {
      kind: "glue-job", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z",
      glue: { runs: 10, successRate: 1, avgDurationMin: 30, p90DurationMin: 40, maxDurationMin: 55, lastErrors: [] },
    };
    const r = rec({ channel: "glue-etl", workload: { estimatedDataGB: 50 } }, history);
    const t = r.recommendations.find((x) => x.key === "glueConfig.timeoutMinutes");
    expect(t?.value).toBe(60); // 40*1.5=60
    expect(t?.basedOnHistory).toBe(true);
    expect(t?.confidence).toBeGreaterThan(0.8);
  });
  it("成功率低 → 生成排查提示", () => {
    const history: HistoryFacts = {
      kind: "glue-job", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z",
      glue: { runs: 10, successRate: 0.5, avgDurationMin: 5, p90DurationMin: 8, maxDurationMin: 9, lastErrors: ["OOM"] },
    };
    const r = rec({ channel: "glue-etl", workload: { estimatedDataGB: 10 } }, history);
    expect(r.questions.some((q) => q.includes("成功率"))).toBe(true);
  });
});

describe("glue-sync Iceberg + Redshift", () => {
  it("高频写 → 短快照保留 + 密集合并", () => {
    const r = rec({ channel: "glue-sync", workload: { estimatedDataGB: 20, writeFrequency: "high" } });
    expect(valOf(r, "s3Config.icebergConfig.snapshotRetentionDays")).toBe(3);
    expect(valOf(r, "s3Config.icebergConfig.compactionMinutes")).toBe(30);
  });
  it("低频写 → 放宽保留 + 稀疏合并", () => {
    const r = rec({ channel: "glue-sync", workload: { estimatedDataGB: 20, writeFrequency: "low" } });
    expect(valOf(r, "s3Config.icebergConfig.snapshotRetentionDays")).toBe(14);
    expect(valOf(r, "s3Config.icebergConfig.compactionMinutes")).toBe(240);
  });
  it("有 joinKey/timeColumn → KEY 分布 + SORTKEY", () => {
    const r = rec({ channel: "glue-sync", workload: { estimatedDataGB: 20, joinKey: "user_id", timeColumn: "created_at" } });
    expect(valOf(r, "redshiftConfig.distStyle")).toBe("key");
    expect(valOf(r, "redshiftConfig.distKey")).toBe("user_id");
    expect(valOf(r, "redshiftConfig.sortKeys")).toBe("created_at");
  });
  it("无 joinKey → AUTO 分布,不出 distKey", () => {
    const r = rec({ channel: "glue-sync", workload: { estimatedDataGB: 20 } });
    expect(valOf(r, "redshiftConfig.distStyle")).toBe("auto");
    expect(r.recommendations.find((x) => x.key === "redshiftConfig.distKey")).toBeUndefined();
  });
  it("生产级 → 重试 3 次", () => {
    const r = rec({ channel: "glue-sync", workload: { productionGrade: true } });
    expect(valOf(r, "retryCount")).toBe(3);
  });
});

describe("flink 并行度锚定", () => {
  it("shard 已知 → 并行度 1:1", () => {
    const r = rec({ channel: "flink", workload: { kinesisShards: 8 } });
    expect(valOf(r, "parallelism")).toBe(8);
    expect(valOf(r, "parallelismPerKPU")).toBe(1); // >4 shard 保裕量
  });
  it("少 shard → 每 KPU 2 子任务省成本", () => {
    const r = rec({ channel: "flink", workload: { kinesisShards: 2 } });
    expect(valOf(r, "parallelismPerKPU")).toBe(2);
  });
  it("shard 未知 → 保守 1 + 追问", () => {
    const r = rec({ channel: "flink" });
    expect(valOf(r, "parallelism")).toBe(1);
    expect(r.questions.some((q) => q.includes("shard"))).toBe(true);
  });
  it("CDC 源 → 并行度 2(binlog 单线程)", () => {
    const r = rec({ channel: "flink", workload: { sourceType: "mysql-cdc" } });
    expect(valOf(r, "parallelism")).toBe(2);
    expect(r.questions).toHaveLength(0); // CDC 不需要 shard 数
  });
  it("生产级 → 开自动扩缩;否则关", () => {
    expect(valOf(rec({ channel: "flink", workload: { kinesisShards: 2, productionGrade: true } }), "autoScalingEnabled")).toBe(true);
    expect(valOf(rec({ channel: "flink", workload: { kinesisShards: 2 } }), "autoScalingEnabled")).toBe(false);
  });
});

describe("dms 实例规格档位", () => {
  it("LOB 列 → c5.large(内存)", () => {
    const r = rec({ channel: "dms", workload: { tableCount: 3, estimatedDataGB: 10, hasLobColumns: true } });
    expect(valOf(r, "_infra.replicationInstanceClass")).toBe("dms.c5.large");
  });
  it("小规模 → t3.small;中等 → t3.medium;大规模 → c5.large", () => {
    expect(valOf(rec({ channel: "dms", workload: { tableCount: 3, estimatedDataGB: 10, hasLobColumns: false } }), "_infra.replicationInstanceClass")).toBe("dms.t3.small");
    expect(valOf(rec({ channel: "dms", workload: { tableCount: 3, estimatedDataGB: 50, hasLobColumns: false } }), "_infra.replicationInstanceClass")).toBe("dms.t3.medium");
    expect(valOf(rec({ channel: "dms", workload: { tableCount: 30, estimatedDataGB: 200, hasLobColumns: false } }), "_infra.replicationInstanceClass")).toBe("dms.c5.large");
  });
  it("LOB 未知 → 追问;任务有装载失败 → 提示排查", () => {
    const r = rec({ channel: "dms", workload: { tableCount: 3 } });
    expect(r.questions.some((q) => q.includes("LOB"))).toBe(true);
    const history: HistoryFacts = {
      kind: "dms-task", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z",
      dms: { status: "running", tablesErrored: 2, tablesLoaded: 8 },
    };
    const r2 = rec({ channel: "dms", workload: { tableCount: 10, hasLobColumns: false } }, history);
    expect(r2.questions.some((q) => q.includes("装载失败"))).toBe(true);
  });
});

describe("参数齐全暴露:新参数规则(B 任务补齐)", () => {
  it("glue-etl:生产级 → 重试 2 + STANDARD;开发期 → 重试 0 + FLEX", () => {
    const prod = rec({ channel: "glue-etl", workload: { estimatedDataGB: 10, productionGrade: true } });
    expect(valOf(prod, "glueConfig.maxRetries")).toBe(2);
    expect(valOf(prod, "glueConfig.executionClass")).toBe("STANDARD");
    const dev = rec({ channel: "glue-etl", workload: { estimatedDataGB: 10 } });
    expect(valOf(dev, "glueConfig.maxRetries")).toBe(0);
    expect(valOf(dev, "glueConfig.executionClass")).toBe("FLEX");
  });
  it("glue-sync:出 Glue 作业资源推荐(worker/超时/作业级重试)", () => {
    const r = rec({ channel: "glue-sync", workload: { estimatedDataGB: 100, tableCount: 5, productionGrade: true } });
    expect(valOf(r, "glueConfig.workerType")).toBe("G.2X");
    expect(Number(valOf(r, "glueConfig.numberOfWorkers"))).toBeGreaterThanOrEqual(4);
    expect(valOf(r, "glueConfig.maxRetries")).toBe(2);
    expect(Number(valOf(r, "glueConfig.timeoutMinutes"))).toBeGreaterThan(0);
  });
  it("flink:CDC 源 → checkpoint 60s;生产级 → TASK 指标 + 快照开", () => {
    const cdc = rec({ channel: "flink", workload: { sourceType: "mysql-cdc", productionGrade: true } });
    expect(valOf(cdc, "checkpointIntervalMs")).toBe(60000);
    expect(valOf(cdc, "metricsLevel")).toBe("TASK");
    expect(valOf(cdc, "snapshotsEnabled")).toBe(true);
    const dev = rec({ channel: "flink", workload: { kinesisShards: 2 } });
    expect(valOf(dev, "checkpointIntervalMs")).toBe(30000);
    expect(valOf(dev, "metricsLevel")).toBe("APPLICATION");
    expect(valOf(dev, "snapshotsEnabled")).toBe(false);
  });
  it("dms:LOB 有 → limited+63KB;无 → none;高吞吐 → 批量应用开", () => {
    const lob = rec({ channel: "dms", workload: { hasLobColumns: true, estimatedDataGB: 100 } });
    expect(valOf(lob, "dmsSettings.lobMode")).toBe("limited");
    expect(valOf(lob, "dmsSettings.lobMaxSizeKB")).toBe(63);
    expect(valOf(lob, "dmsSettings.batchApplyEnabled")).toBe(true);
    const nolob = rec({ channel: "dms", workload: { hasLobColumns: false, estimatedDataGB: 5 } });
    expect(valOf(nolob, "dmsSettings.lobMode")).toBe("none");
    expect(valOf(nolob, "dmsSettings.batchApplyEnabled")).toBe(false);
  });
  it("dms:全量并行子任务 = min(表数, 8);生产级校验开", () => {
    const r = rec({ channel: "dms", workload: { tableCount: 3, productionGrade: true } });
    expect(valOf(r, "dmsSettings.fullLoadMaxSubTasks")).toBe(3);
    expect(valOf(r, "dmsSettings.validationEnabled")).toBe(true);
    const many = rec({ channel: "dms", workload: { tableCount: 30 } });
    expect(valOf(many, "dmsSettings.fullLoadMaxSubTasks")).toBe(8);
  });
  it("dms prefill 含 dmsSettings;glue-sync prefill 含 glueConfig", () => {
    const dms = rec({ channel: "dms", workload: { hasLobColumns: true, tableCount: 3 } });
    expect((dms.prefill as any)?.dmsSettings?.lobMode).toBe("limited");
    const gs = rec({ channel: "glue-sync", workload: { estimatedDataGB: 30 } });
    expect((gs.prefill as any)?.glueConfig?.workerType).toBeDefined();
  });
});

describe("current diff + prefill 组装", () => {
  it("current 与推荐不同 → changed=true;相同 → false", () => {
    const r = rec({
      channel: "glue-etl",
      workload: { estimatedDataGB: 400 },
      current: { glueConfig: { workerType: "G.1X", numberOfWorkers: 10, glueVersion: GLUE_VERSION_DEFAULT } },
    });
    expect(r.recommendations.find((x) => x.key === "glueConfig.workerType")?.changed).toBe(true); // G.1X→G.2X
    expect(r.recommendations.find((x) => x.key === "glueConfig.numberOfWorkers")?.changed).toBe(false); // 10=10
    expect(r.recommendations.find((x) => x.key === "glueConfig.glueVersion")?.changed).toBe(false);
  });
  it("glue-etl prefill 形态完整", () => {
    const r = rec({ channel: "glue-etl", workload: { estimatedDataGB: 50 } });
    expect(r.prefill).toMatchObject({ channel: "glue-etl", glueConfig: { workerType: "G.1X", glueVersion: GLUE_VERSION_DEFAULT } });
  });
  it("flink prefill 形态完整(含 checkpoint/监控/快照,参数齐全暴露)", () => {
    const r = rec({ channel: "flink", workload: { kinesisShards: 4, productionGrade: true } });
    expect(r.prefill).toMatchObject({ channel: "flink", parallelism: 4, parallelismPerKPU: 2, autoScalingEnabled: true });
    // 生产级:TASK 级指标 + 快照开启;checkpoint 默认 30s/5s。
    expect(r.prefill).toMatchObject({ checkpointIntervalMs: 30000, minPauseBetweenCheckpointsMs: 5000, logLevel: "INFO", metricsLevel: "TASK", snapshotsEnabled: true });
  });
  it("dms prefill 不含 _infra.* 基建参数", () => {
    const r = rec({ channel: "dms", workload: { tableCount: 3, hasLobColumns: true } });
    expect(JSON.stringify(r.prefill)).not.toContain("_infra");
    expect(JSON.stringify(r.prefill)).not.toContain("replicationInstanceClass");
  });
  it("glue-sync prefill 含 iceberg + redshift 配置", () => {
    const r = rec({ channel: "glue-sync", workload: { estimatedDataGB: 20, writeFrequency: "high", joinKey: "id" } });
    expect(r.prefill).toMatchObject({
      channel: "glue-sync",
      icebergConfig: { snapshotRetentionDays: 3, compactionMinutes: 30 },
      redshiftConfig: { distStyle: "key", distKey: "id" },
    });
  });
});

describe("整体置信度", () => {
  it("有历史实据 > 无历史;有 questions 拉低", () => {
    const history: HistoryFacts = {
      kind: "glue-job", degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z",
      glue: { runs: 10, successRate: 1, avgDurationMin: 30, p90DurationMin: 40, maxDurationMin: 55, lastErrors: [] },
    };
    const withH = rec({ channel: "glue-etl", workload: { estimatedDataGB: 50 } }, history);
    const noH = rec({ channel: "glue-etl", workload: { estimatedDataGB: 50 } });
    const noInfo = rec({ channel: "glue-etl" }); // 有追问
    expect(withH.confidence).toBeGreaterThan(noH.confidence);
    expect(noH.confidence).toBeGreaterThan(noInfo.confidence);
  });
});
