// 参数推荐引擎 — 确定性启发式(纯函数,零 AWS 调用,可单测)。
// 推荐值【恒由本引擎给出】,模型只解释不编值(反幻觉支柱,同网络顾问"裁决恒由 L2")。
// 每条推荐带 reason(引用规则或历史事实)+ confidence;有运行历史实据时置信度更高。
//
// 规则出处:AWS 官方售价/容量口径 + 平台实测:
//   Glue: G.1X=4vCPU/16GB/DPU,G.2X=8vCPU/32GB;worker 数按数据量线性放大(每 worker ~10GB 舒适区)。
//   Flink: 并行度锚定 Kinesis shard 数(1 shard ≈ 1 子任务读满);KPU≈ceil(parallelism/perKPU)+1。
//   DMS: t3.small 舒适区 ~10 表/50GB 以下;LOB 列或大批量全量建议 c5 系。
//   Redshift: 有稳定 join 列→KEY 分布消 shuffle;时间过滤列→SORTKEY 提升区间扫描。
//   Iceberg: 高频写→快照膨胀,缩短保留/加密合并;低频写→放宽减少 maintenance 开销。

import { catalogFor } from "./catalog";
import { GLUE_MAX_WORKERS } from "@/lib/etl/worker-types";
// EMR Serverless 规格默认值/上限来自「单一事实源」(lib/engines/emr/spec.ts),引擎按数据量在其档位内推荐。
import { EMR_SPEC_DEFAULT, EMR_MAX_EXECUTORS } from "@/lib/engines/emr/spec";
// Glue 版本缺省来自单一作者(清单最高;用户可降版,所以推荐值不是红线)
import { GLUE_VERSION_DEFAULT } from "@/lib/sync/glue-version";
import type {
  HistoryFacts,
  ParamAdviceRequest,
  ParamChannel,
  ParamDef,
  ParamPrefill,
  ParamRecommendation,
  WorkloadProfile,
} from "./types";

// ── 工具:点路径取当前值 + 按目录 clamp ──
function getPath(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function clampToDef(def: ParamDef | undefined, value: unknown): unknown {
  if (!def) return value;
  if (def.type === "number") {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return def.platformDefault;
    return Math.min(def.max ?? n, Math.max(def.min ?? n, n));
  }
  if (def.type === "enum" && def.options?.length) {
    return def.options.includes(String(value)) ? value : def.platformDefault;
  }
  return value;
}

interface RecDraft {
  key: string;
  value: unknown;
  reason: string;
  confidence: number;
  basedOnHistory?: boolean;
}

// ── 主入口 ──
export interface HeuristicResult {
  recommendations: ParamRecommendation[];
  prefill?: ParamPrefill;
  questions: string[];
  confidence: number; // 整体置信度
}

export function recommend(req: ParamAdviceRequest, history?: HistoryFacts | null): HeuristicResult {
  const w = req.workload || {};
  const drafts: RecDraft[] = [];
  const questions: string[] = [];

  switch (req.channel) {
    case "glue-etl":
      recommendGlueEtl(w, history, drafts, questions);
      break;
    case "glue-sync":
      recommendGlueSync(w, history, drafts, questions);
      break;
    case "flink":
      recommendFlink(w, history, drafts, questions);
      break;
    case "dms":
      recommendDms(w, history, drafts, questions);
      break;
    case "emr":
      recommendEmr(w, history, drafts, questions);
      break;
  }

  const defs = catalogFor(req.channel);
  const defOf = new Map(defs.map((d) => [d.key, d]));
  const recommendations: ParamRecommendation[] = drafts.map((d) => {
    const def = defOf.get(d.key);
    const value = clampToDef(def, d.value);
    const currentValue = getPath(req.current, d.key);
    return {
      key: d.key,
      label: def?.label || d.key,
      value,
      unit: def?.unit,
      reason: d.reason,
      confidence: Math.max(0.1, Math.min(1, d.confidence)),
      currentValue,
      changed: currentValue !== undefined && !valueEq(currentValue, value),
      basedOnHistory: d.basedOnHistory,
    };
  });

  const confidence = overallConfidence(recommendations, history, questions);
  return { recommendations, prefill: buildPrefill(req.channel, recommendations), questions, confidence };
}

function valueEq(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a ?? "") === String(b ?? "");
}

function overallConfidence(recs: ParamRecommendation[], history: HistoryFacts | null | undefined, questions: string[]): number {
  if (!recs.length) return 0.3;
  let c = recs.reduce((s, r) => s + r.confidence, 0) / recs.length;
  if (history && !history.degraded && history.kind !== "none") c += 0.05; // 有实据整体更稳
  if (questions.length) c -= 0.1; // 缺关键特征
  return Math.max(0.1, Math.min(1, c));
}

// ── Glue ETL:workerType / numberOfWorkers / glueVersion / timeout ──
function recommendGlueEtl(w: WorkloadProfile, history: HistoryFacts | null | undefined, out: RecDraft[], questions: string[]) {
  const gb = w.estimatedDataGB;
  const g = history?.glue;

  // Worker 类型 + 数量:按数据量档位(每 G.1X worker ~10GB 舒适区)。
  if (gb == null) {
    questions.push("预计单次处理的数据量大约多少 GB?(影响 Worker 类型与数量的推荐)");
    out.push({ key: "glueConfig.workerType", value: "G.1X", reason: "未知数据量,先用最小规格 G.1X(4vCPU/16GB);告知数据量后可精确推荐。", confidence: 0.5 });
    out.push({ key: "glueConfig.numberOfWorkers", value: 2, reason: "未知数据量,先用最小 2 个 worker 控成本;数据量确认后再放大。", confidence: 0.5 });
  } else if (gb <= 20) {
    out.push({ key: "glueConfig.workerType", value: "G.1X", reason: `约 ${gb}GB 属小数据量,G.1X(4vCPU/16GB)足够,成本最低。`, confidence: 0.85 });
    out.push({ key: "glueConfig.numberOfWorkers", value: Math.max(2, Math.ceil(gb / 10)), reason: `按每 G.1X worker ~10GB 舒适区,${gb}GB 配 ${Math.max(2, Math.ceil(gb / 10))} 个 worker(最少 2)。`, confidence: 0.8 });
  } else if (gb <= 100) {
    const n = Math.min(GLUE_MAX_WORKERS, Math.max(3, Math.ceil(gb / 15)));
    out.push({ key: "glueConfig.workerType", value: "G.1X", reason: `约 ${gb}GB 中等数据量,G.1X 多 worker 并行比升 G.2X 性价比更高(shuffle 不重时)。`, confidence: 0.75 });
    out.push({ key: "glueConfig.numberOfWorkers", value: n, reason: `${gb}GB 按每 worker ~15GB 配 ${n} 个 worker,并行加速全量处理。`, confidence: 0.75 });
  } else {
    const n = Math.min(GLUE_MAX_WORKERS, Math.max(5, Math.ceil(gb / 40)));
    out.push({ key: "glueConfig.workerType", value: "G.2X", reason: `约 ${gb}GB 大数据量,G.2X(8vCPU/32GB)减少 executor 内存溢出与 spill,大表 join/聚合更稳。`, confidence: 0.8 });
    out.push({ key: "glueConfig.numberOfWorkers", value: n, reason: `${gb}GB 按每 G.2X worker ~40GB 配 ${n} 个 worker(上限 ${GLUE_MAX_WORKERS})。`, confidence: 0.75 });
  }

  // Glue 版本:缺省取平台清单里的最高版本(用户可在表单里降版,这里给的是推荐值)。
  out.push({ key: "glueConfig.glueVersion", value: GLUE_VERSION_DEFAULT, reason: "平台缺省取清单里最高的 Glue 版本(Spark 与 S3 Tables / Iceberg 兼容性最好);需特定旧依赖再降版。", confidence: 0.95 });

  // 超时:有历史 → P90×1.5;无历史按数据量估。
  if (g?.p90DurationMin != null && g.runs >= 3) {
    const t = Math.min(2880, Math.max(15, Math.ceil((g.p90DurationMin * 1.5) / 5) * 5));
    out.push({
      key: "glueConfig.timeoutMinutes", value: t,
      reason: `近 ${g.runs} 次运行 P90 时长 ${g.p90DurationMin} 分钟,超时按 P90×1.5≈${t} 分钟——足够容纳波动又能及时止损。`,
      confidence: 0.9, basedOnHistory: true,
    });
  } else {
    const t = gb == null ? 60 : gb <= 20 ? 60 : gb <= 100 ? 120 : 240;
    out.push({ key: "glueConfig.timeoutMinutes", value: t, reason: gb == null ? "无运行历史,保持默认 60 分钟;跑 3 次后可按 P90 时长精调。" : `按 ${gb}GB 估算处理时长,超时给 ${t} 分钟余量。`, confidence: 0.6 });
  }

  // 成功率低 → 提示(不出值,交给模型解释/用户排查)。
  if (g && g.runs >= 3 && g.successRate < 0.7) {
    questions.push(`该作业近 ${g.runs} 次运行成功率仅 ${(g.successRate * 100).toFixed(0)}%,建议先看失败日志(常见:内存溢出→升 G.2X,超时→加 worker 或放宽超时)。`);
  }

  // 重试:生产级 2 次;有历史且成功率高 → 1 次即可(失败大概率是代码问题,重试无益)。
  if (w.productionGrade === true) {
    out.push({ key: "glueConfig.maxRetries", value: 2, reason: "生产级作业重试 2 次,扛住瞬时故障(Spot 回收/网络抖动);代码 bug 类失败重试无益,配合告警排查。", confidence: 0.7 });
  } else if (g && g.runs >= 3 && g.successRate >= 0.95) {
    out.push({ key: "glueConfig.maxRetries", value: 1, reason: `近 ${g.runs} 次运行成功率 ${(g.successRate * 100).toFixed(0)}%,作业稳定,重试 1 次兜住偶发即可(多了浪费失败成本)。`, confidence: 0.7, basedOnHistory: true });
  } else {
    out.push({ key: "glueConfig.maxRetries", value: 0, reason: "开发调试期不重试:失败快速暴露,避免重试拖长反馈;上生产再调 2 次。", confidence: 0.6 });
  }

  // 执行类:非时敏 + 非 G.4X → FLEX 更省(约 6-7 折);时敏/生产 SLA 用 STANDARD 保启动。
  if (w.productionGrade === true) {
    out.push({ key: "glueConfig.executionClass", value: "STANDARD", reason: "生产级作业用 STANDARD 保证即时启动与 SLA;FLEX 弹性容量启动时间不保证。", confidence: 0.75 });
  } else {
    out.push({ key: "glueConfig.executionClass", value: "FLEX", reason: "开发/非时敏作业用 FLEX(弹性容量,费用约打 6-7 折);启动可能等几分钟,不影响正确性。", confidence: 0.6 });
  }
}

// ── 数据同步 Glue 通道:retry/timeout + Glue 作业资源 + Iceberg + Redshift ──
function recommendGlueSync(w: WorkloadProfile, history: HistoryFacts | null | undefined, out: RecDraft[], questions: string[]) {
  const prod = w.productionGrade === true;
  out.push({ key: "retryCount", value: prod ? 3 : 2, reason: prod ? "生产级任务重试 3 次,扛住瞬时故障(网络抖动/限流)。" : "默认重试 2 次,兼顾止损与自愈。", confidence: 0.7 });

  // Glue 作业资源(与 glue-etl 同一口径:每 G.1X worker ~10GB 舒适区)。
  {
    const gb = w.estimatedDataGB;
    if (gb == null) {
      out.push({ key: "glueConfig.workerType", value: "G.1X", reason: "未知数据量,先用最小规格 G.1X 控成本;告知数据量后可精确推荐。", confidence: 0.5 });
      out.push({ key: "glueConfig.numberOfWorkers", value: 2, reason: "未知数据量,先用最小 2 个 worker。", confidence: 0.5 });
      out.push({ key: "glueConfig.timeoutMinutes", value: 60, reason: "默认 60 分钟;同步跑通后按实际时长精调。", confidence: 0.55 });
    } else if (gb <= 50) {
      out.push({ key: "glueConfig.workerType", value: "G.1X", reason: `约 ${gb}GB 同步量,G.1X 足够。`, confidence: 0.8 });
      out.push({ key: "glueConfig.numberOfWorkers", value: Math.max(2, Math.ceil(gb / 10)), reason: `按每 worker ~10GB,${gb}GB 配 ${Math.max(2, Math.ceil(gb / 10))} 个 worker。`, confidence: 0.75 });
      out.push({ key: "glueConfig.timeoutMinutes", value: Math.max(30, Math.ceil(gb * 1.5 / 5) * 5), reason: `按 ${gb}GB 估算装载时长给足余量。`, confidence: 0.65 });
    } else {
      const n = Math.min(GLUE_MAX_WORKERS, Math.max(4, Math.ceil(gb / 25)));
      out.push({ key: "glueConfig.workerType", value: "G.2X", reason: `约 ${gb}GB 大批量同步,G.2X 内存更足,大表读写更稳。`, confidence: 0.75 });
      out.push({ key: "glueConfig.numberOfWorkers", value: n, reason: `${gb}GB 按每 G.2X worker ~25GB 配 ${n} 个 worker。`, confidence: 0.7 });
      out.push({ key: "glueConfig.timeoutMinutes", value: Math.min(2880, Math.max(60, Math.ceil(gb * 2 / 10) * 10)), reason: `大数据量放宽超时,避免全量装载被误杀。`, confidence: 0.65 });
    }
    out.push({ key: "glueConfig.maxRetries", value: prod ? 2 : 0, reason: prod ? "生产级 Glue 作业级重试 2 次(区别于调度级重试:原地重跑更快)。" : "开发期 Glue 作业级不重试,失败快速暴露。", confidence: 0.6 });
  }

  const gb = w.estimatedDataGB;
  const tables = w.tableCount || 1;
  const tSec = gb == null ? 3600 : Math.min(86400, Math.max(1800, Math.ceil((gb * 60 + tables * 120) / 600) * 600));
  out.push({
    key: "timeout", value: tSec,
    reason: gb == null ? `未知数据量,保持默认 3600 秒;${tables} 张表的全量同步若超 1 小时请上调。` : `按 ${gb}GB/${tables} 表估算,超时 ${tSec} 秒(每 GB ~1 分钟 + 每表 2 分钟建表开销)。`,
    confidence: gb == null ? 0.55 : 0.7,
  });
  if (gb == null) questions.push("源表数据量大约多少 GB?(影响超时与 Iceberg 维护参数推荐)");

  // Iceberg 维护三参数:按写入频率。
  const freq = w.writeFrequency;
  if (freq === "high" || w.syncMode === "realtime") {
    out.push({ key: "s3Config.icebergConfig.snapshotRetentionDays", value: 3, reason: "高频写入快照膨胀快,保留 3 天防元数据堆积(需要更长审计期可上调)。", confidence: 0.75 });
    out.push({ key: "s3Config.icebergConfig.maxSnapshots", value: 50, reason: "高频写入限制 50 个快照,配合短保留期控制 S3 元数据规模。", confidence: 0.7 });
    out.push({ key: "s3Config.icebergConfig.compactionMinutes", value: 30, reason: "高频写入产生大量小文件,30 分钟一次合并保查询性能。", confidence: 0.75 });
  } else if (freq === "low") {
    out.push({ key: "s3Config.icebergConfig.snapshotRetentionDays", value: 14, reason: "低频写入快照少,放宽到 14 天保留,时间旅行窗口更长。", confidence: 0.7 });
    out.push({ key: "s3Config.icebergConfig.maxSnapshots", value: 100, reason: "低频写入默认 100 个快照上限已足够。", confidence: 0.7 });
    out.push({ key: "s3Config.icebergConfig.compactionMinutes", value: 240, reason: "低频写入小文件少,4 小时一次合并即可,省 maintenance 成本。", confidence: 0.7 });
  } else {
    out.push({ key: "s3Config.icebergConfig.snapshotRetentionDays", value: 7, reason: "中等写入频率用默认 7 天快照保留。", confidence: 0.65 });
    out.push({ key: "s3Config.icebergConfig.maxSnapshots", value: 100, reason: "默认 100 个快照上限。", confidence: 0.65 });
    out.push({ key: "s3Config.icebergConfig.compactionMinutes", value: 60, reason: "默认 60 分钟合并间隔,平衡查询性能与维护成本。", confidence: 0.65 });
  }

  recommendRedshiftTable(w, out);
}

// ── Redshift 目标表物理设计(glue-sync 与 dms 共用)──
function recommendRedshiftTable(w: WorkloadProfile, out: RecDraft[]) {
  if (w.joinKey) {
    out.push({ key: "redshiftConfig.distStyle", value: "key", reason: `有稳定 join 列「${w.joinKey}」,KEY 分布让 join 双方同节点,消除跨节点 shuffle。`, confidence: 0.8 });
    out.push({ key: "redshiftConfig.distKey", value: w.joinKey, reason: `DISTKEY 用常用 join 列「${w.joinKey}」。`, confidence: 0.8 });
  } else {
    out.push({ key: "redshiftConfig.distStyle", value: "auto", reason: "无明确 join 列,AUTO 让 Redshift 按表大小自动选择分布策略(小表 ALL,大表 EVEN/KEY)。", confidence: 0.75 });
  }
  if (w.timeColumn) {
    out.push({ key: "redshiftConfig.sortKeys", value: w.timeColumn, reason: `常用时间过滤列「${w.timeColumn}」作 SORTKEY,区间扫描跳过无关块(zone map)。`, confidence: 0.8 });
  }
}

// ── Flink/MSAF:parallelism / parallelismPerKPU / autoScaling ──
function recommendFlink(w: WorkloadProfile, history: HistoryFacts | null | undefined, out: RecDraft[], questions: string[]) {
  const shards = w.kinesisShards;
  const isCdc = w.sourceType === "mysql-cdc";

  if (isCdc) {
    // CDC 源:MySQL binlog 单线程读,并行度锚定下游写吞吐,不必大。
    out.push({ key: "parallelism", value: 2, reason: "MySQL CDC 源 binlog 读取本质单线程,并行度 2 兼顾下游 sink 写并行,再大浪费 KPU。", confidence: 0.75 });
    out.push({ key: "parallelismPerKPU", value: 2, reason: "CDC 轻负载,每 KPU 跑 2 个子任务提高密度省成本(KPU≈2/2+1=2 个)。", confidence: 0.7 });
  } else if (shards == null) {
    questions.push("源 Kinesis 流有几个 shard?(并行度建议锚定 shard 数,1 shard ≈ 1 个读子任务)");
    out.push({ key: "parallelism", value: 1, reason: "未知 shard 数,先用并行度 1;确认 shard 数后按 1:1 配置。", confidence: 0.5 });
    out.push({ key: "parallelismPerKPU", value: 1, reason: "默认每 KPU 1 个子任务,资源最充裕(确认负载后可提高密度省成本)。", confidence: 0.55 });
  } else {
    const p = Math.min(64, Math.max(1, shards));
    out.push({ key: "parallelism", value: p, reason: `源流 ${shards} 个 shard,并行度 1:1 配 ${p}——每个 shard 一个读子任务恰好读满,不空转不积压。`, confidence: 0.85 });
    const perKpu = shards <= 4 ? 2 : 1;
    out.push({
      key: "parallelismPerKPU", value: perKpu,
      reason: perKpu === 2 ? `${shards} shard 轻负载,每 KPU 2 个子任务提高密度(KPU≈${Math.ceil(p / 2) + 1} 个)省成本。` : `${shards} shard 吞吐较大,每 KPU 1 个子任务保处理裕量。`,
      confidence: 0.7,
    });
  }

  out.push({
    key: "autoScalingEnabled", value: w.productionGrade === true,
    reason: w.productionGrade ? "生产级作业开启自动扩缩,MSAF 按 CPU 利用率自动调 KPU 应对流量波动。" : "开发/验证阶段关闭自动扩缩,固定资源便于观察基线性能(上生产再开)。",
    confidence: 0.7,
  });

  // Checkpoint:CDC 写 Iceberg 场景 checkpoint 即 flush 批次——间隔短=低延迟多小文件,长=高延迟大批次。
  if (isCdc) {
    out.push({ key: "checkpointIntervalMs", value: 60000, reason: "CDC 写 Iceberg 时 checkpoint 即提交批次:60 秒间隔减少小文件数量(延迟要求分钟级即可);要秒级新鲜度再缩短。", confidence: 0.7 });
  } else {
    out.push({ key: "checkpointIntervalMs", value: 30000, reason: "默认 30 秒 checkpoint 平衡故障恢复距离与开销;状态大或反压时可放宽到 60 秒。", confidence: 0.65 });
  }
  out.push({ key: "minPauseBetweenCheckpointsMs", value: 5000, reason: "两次 checkpoint 之间至少歇 5 秒,保证反压时算子有时间处理数据,避免 checkpoint 风暴。", confidence: 0.65 });

  // 监控:生产 INFO+APPLICATION 够用;排障临时升 DEBUG/TASK(有额外 CloudWatch 费用)。
  out.push({ key: "logLevel", value: "INFO", reason: "INFO 级别覆盖启动/checkpoint/异常关键事件;排障时临时切 DEBUG(日志量大,查完切回)。", confidence: 0.7 });
  out.push({ key: "metricsLevel", value: w.productionGrade === true ? "TASK" : "APPLICATION", reason: w.productionGrade ? "生产级建议 TASK 级指标,能看到单 task 反压/延迟定位瓶颈(CloudWatch 指标量增加)。" : "APPLICATION 级指标已覆盖整体吞吐/KPU 利用率,开发阶段够用且省 CloudWatch 费用。", confidence: 0.65 });

  // 快照:有状态聚合作业强烈建议开(停止→重启不丢中间态);纯透传可关。
  out.push({
    key: "snapshotsEnabled", value: w.productionGrade === true,
    reason: w.productionGrade ? "生产级开启快照:停止时自动打 savepoint,重启从快照恢复,窗口聚合等中间状态不丢。" : "开发阶段可关(每次启动从头读);上生产或 SQL 含窗口聚合时务必开启。",
    confidence: 0.7,
  });

  // 已有应用实据:current 与推荐差异会由 changed 标出;这里补状态提示。
  const f = history?.flink;
  if (f?.status && f.status !== "RUNNING" && f.status !== "READY") {
    questions.push(`应用当前状态 ${f.status},调参前请先确认应用已停止(运行中不可更新配置)。`);
  }
}

// ── DMS:retry/timeout + Redshift 目标 + 实例规格(展示级)──
function recommendDms(w: WorkloadProfile, history: HistoryFacts | null | undefined, out: RecDraft[], questions: string[]) {
  const prod = w.productionGrade === true;
  out.push({ key: "retryCount", value: prod ? 3 : 2, reason: prod ? "生产级 CDC 任务重试 3 次,扛住网络抖动与源库瞬时不可用。" : "默认重试 2 次。", confidence: 0.7 });

  const gb = w.estimatedDataGB;
  const tSec = gb == null ? 3600 : Math.min(86400, Math.max(3600, Math.ceil((gb * 90) / 600) * 600));
  out.push({
    key: "timeout", value: tSec,
    reason: gb == null ? "未知数据量,保持默认 3600 秒(仅约束全量阶段;CDC 持续复制不受此限)。" : `按 ${gb}GB 全量装载估算(DMS 全量 ~1.5 分钟/GB 保守值),给 ${tSec} 秒。`,
    confidence: gb == null ? 0.55 : 0.65,
  });

  recommendRedshiftTable(w, out);

  // DMS 任务设置(对齐 console Task settings,平台表单已暴露)。
  out.push({ key: "dmsSettings.targetTablePrepMode", value: "DO_NOTHING", reason: "平台已预建目标 schema 且落库幂等,DO_NOTHING 保留已有数据最安全;需每次重建选 DROP_AND_CREATE。", confidence: 0.7 });
  if (w.hasLobColumns === true) {
    out.push({ key: "dmsSettings.lobMode", value: "limited", reason: "源表含 LOB 列:limited 模式按上限截断迁移,速度快且内存可控;需完整 LOB 再切 full(明显变慢)。", confidence: 0.75 });
    out.push({ key: "dmsSettings.lobMaxSizeKB", value: 63, reason: "LOB 截断上限给 63KB(Redshift 目标引擎最大允许值,AWS 校验 1~63KB),覆盖多数 TEXT 字段;超限部分截断。", confidence: 0.6 });
  } else if (w.hasLobColumns === false) {
    out.push({ key: "dmsSettings.lobMode", value: "none", reason: "源表无 LOB 列,直接关闭 LOB 处理,全量装载更快。", confidence: 0.7 });
  }
  const highThroughput = (gb != null && gb > 50) || (w.writeFrequency === "high");
  out.push({
    key: "dmsSettings.batchApplyEnabled", value: highThroughput,
    reason: highThroughput ? "高吞吐 CDC 开批量应用:合并小事务批量写 Redshift,应用速度提升数倍;注意事务按批重排。" : "默认关闭批量应用,保持事务顺序逐条应用(低吞吐下延迟差异不大)。",
    confidence: 0.65,
  });
  out.push({
    key: "dmsSettings.validationEnabled", value: prod,
    reason: prod ? "生产级开启数据校验,DMS 逐行比对源/目标,保迁移正确性(增加源库与实例负载)。" : "开发期关闭校验省资源;上线前核对时再开。",
    confidence: 0.65,
  });
  const tablesForSubTasks = w.tableCount || 1;
  out.push({ key: "dmsSettings.fullLoadMaxSubTasks", value: Math.min(49, Math.max(1, Math.min(tablesForSubTasks, 8))), reason: `全量并行子任务=min(表数 ${tablesForSubTasks}, 8):每表一个子任务并行装载,超过 8 对 t3 系实例内存压力大。`, confidence: 0.65 });

  // 复制实例规格:展示级推荐(实例由基建层管理,表单无此字段)。
  const tables = w.tableCount || 1;
  const d = history?.dms;
  let cls = "dms.t3.small";
  let why = `${tables} 张表/小数据量,dms.t3.small(2vCPU/2GB)够用,成本最低。`;
  if (w.hasLobColumns) {
    cls = "dms.c5.large";
    why = "源表含 LOB(TEXT/BLOB)列,LOB 装载吃内存,建议 c5.large(4GB)避免全量阶段内存溢出。";
  } else if ((gb != null && gb > 100) || tables > 20) {
    cls = "dms.c5.large";
    why = `${gb != null ? `${gb}GB` : `${tables} 张表`}规模较大,建议 c5.large 提升全量并行装载吞吐。`;
  } else if ((gb != null && gb > 30) || tables > 8) {
    cls = "dms.t3.medium";
    why = `${gb != null ? `${gb}GB` : `${tables} 张表`}中等规模,t3.medium(4GB)全量阶段更稳。`;
  }
  if (d?.instanceClass && d.instanceClass !== cls) {
    why += `(当前实例 ${d.instanceClass};规格属基建层,如需调整请联系平台管理员改 realtime-stack)`;
  } else if (!d?.instanceClass) {
    why += "(规格属基建层,平台表单不直接暴露;此建议供容量评估)";
  }
  out.push({ key: "_infra.replicationInstanceClass", value: cls, reason: why, confidence: 0.65, basedOnHistory: !!d?.instanceClass });

  if (w.hasLobColumns === undefined) {
    questions.push("源表是否含 TEXT/BLOB 等大字段(LOB)列?(影响复制实例内存与 LOB 模式建议)");
  }
  if (d && d.tablesErrored != null && d.tablesErrored > 0) {
    questions.push(`现有任务有 ${d.tablesErrored} 张表装载失败,建议先看任务日志排错再调参。`);
  }
}

// ── 离线多引擎 EMR Serverless:release/架构 + driver/executor 规格 + executor 数──
// 规格默认锚定 EMR_SPEC_DEFAULT(单一事实源);按数据量分档:小=默认规格靠多 executor 并行,
// 大=升 8vCPU/32GB 减 spill。release/架构恒取默认(最新版 + ARM64 省成本)。EMR Serverless 无平台侧
// 运行历史探测(非 Glue/Flink/DMS 三类 jobRef),故不引用 history。
function recommendEmr(w: WorkloadProfile, _history: HistoryFacts | null | undefined, out: RecDraft[], questions: string[]) {
  const gb = w.estimatedDataGB;
  const prod = w.productionGrade === true;

  // release:平台缺省取最新(同 Glue「缺省最高、可降版」精神:Spark 性能与 S3 Tables/Iceberg 兼容性最好)。
  out.push({ key: "spec.releaseLabel", value: EMR_SPEC_DEFAULT.releaseLabel, reason: `平台默认最新 EMR 版本 ${EMR_SPEC_DEFAULT.releaseLabel}(Spark 性能与 S3 Tables/Iceberg 兼容性最好);需特定旧依赖再降版。`, confidence: 0.9 });
  // 架构:ARM64(Graviton)默认——同规格约省 20% 成本;含 x86-only native 依赖时再切 X86_64。
  out.push({ key: "spec.architecture", value: EMR_SPEC_DEFAULT.architecture, reason: "默认 ARM64(Graviton,同规格约省 20% 成本,PySpark/Scala 原生兼容);仅当有 x86-only native 依赖时切 X86_64。", confidence: 0.8 });

  // driver/executor 规格 + executor 数 + 磁盘:按数据量分档。
  let driverCpu = EMR_SPEC_DEFAULT.driver.cpu, driverMem = EMR_SPEC_DEFAULT.driver.memory;
  let execCpu = EMR_SPEC_DEFAULT.executor.cpu, execMem = EMR_SPEC_DEFAULT.executor.memory;
  let execDisk = EMR_SPEC_DEFAULT.executor.disk ?? "20 GB";
  let count: number;
  let specWhy: string, countWhy: string, diskWhy: string;

  if (gb == null) {
    questions.push("预计单次处理的数据量大约多少 GB?(影响 executor 规格与数量的推荐)");
    count = EMR_SPEC_DEFAULT.executorCount;
    specWhy = `未知数据量,driver/executor 先用默认 ${EMR_SPEC_DEFAULT.executor.cpu}/${EMR_SPEC_DEFAULT.executor.memory} 规格;告知数据量后可精确推荐。`;
    countWhy = `未知数据量,先用默认 ${count} 个 executor 控成本;数据量确认后再放大。`;
    diskWhy = "未知数据量,executor 磁盘保持默认 20 GB;shuffle 报 No space left 时再上调。";
  } else if (gb <= 50) {
    count = Math.max(2, Math.ceil(gb / 25));
    specWhy = `约 ${gb}GB 小数据量,driver/executor 用默认 4 vCPU/16 GB 足够,成本最低。`;
    countWhy = `按每 executor ~25GB 舒适区,${gb}GB 配 ${count} 个 executor(最少 2)。`;
    diskWhy = "小数据量 shuffle 少,executor 磁盘默认 20 GB 够用。";
  } else if (gb <= 200) {
    count = Math.min(EMR_MAX_EXECUTORS, Math.max(4, Math.ceil(gb / 25)));
    specWhy = `约 ${gb}GB 中等数据量,driver/executor 保持 4 vCPU/16 GB、靠多 executor 并行(比升大规格性价比更高)。`;
    countWhy = `${gb}GB 按每 executor ~25GB 配 ${count} 个 executor 并行加速。`;
    diskWhy = "中等数据量 executor 磁盘给 50 GB,留足 shuffle 溢出空间。";
    execDisk = "50 GB";
  } else {
    driverCpu = "8 vCPU"; driverMem = "32 GB";
    execCpu = "8 vCPU"; execMem = "32 GB";
    execDisk = "100 GB";
    count = Math.min(EMR_MAX_EXECUTORS, Math.max(6, Math.ceil(gb / 60)));
    specWhy = `约 ${gb}GB 大数据量,driver/executor 升 8 vCPU/32 GB 减少内存溢出与 spill,大表 join/聚合更稳。`;
    countWhy = `${gb}GB 按每 8 vCPU executor ~60GB 配 ${count} 个 executor(上限 ${EMR_MAX_EXECUTORS})。`;
    diskWhy = "大数据量 shuffle 重,executor 磁盘给 100 GB 防溢出报错(EMR Serverless 磁盘 20-200GB)。";
  }

  // 生产级:executor 数上浮 ~20% 留 SLA 与数据倾斜裕量(同 flink/glue 生产从严思路,此处体现在并行度)。
  if (prod) {
    const bumped = Math.min(EMR_MAX_EXECUTORS, Math.ceil(count * 1.2));
    if (bumped > count) {
      countWhy += ` 生产级再上浮 ~20% 到 ${bumped},留 SLA 与数据倾斜裕量。`;
      count = bumped;
    }
  }

  const specConf = gb == null ? 0.5 : 0.8;
  out.push({ key: "spec.driver.cpu", value: driverCpu, reason: specWhy, confidence: specConf });
  out.push({ key: "spec.driver.memory", value: driverMem, reason: specWhy, confidence: specConf });
  out.push({ key: "spec.executor.cpu", value: execCpu, reason: specWhy, confidence: specConf });
  out.push({ key: "spec.executor.memory", value: execMem, reason: specWhy, confidence: specConf });
  out.push({ key: "spec.executor.disk", value: execDisk, reason: diskWhy, confidence: gb == null ? 0.5 : 0.65 });
  out.push({ key: "spec.executorCount", value: count, reason: countWhy, confidence: gb == null ? 0.5 : 0.75 });
}

// ── prefill 组装:把可回填的推荐映射为通道原生形态(表单无字段的 _infra.* 不入 prefill)──
function buildPrefill(channel: ParamChannel, recs: ParamRecommendation[]): ParamPrefill | undefined {
  const val = (key: string) => recs.find((r) => r.key === key)?.value;
  if (channel === "glue-etl") {
    const retries = val("glueConfig.maxRetries");
    const execClass = val("glueConfig.executionClass");
    return {
      channel,
      glueConfig: {
        workerType: String(val("glueConfig.workerType") ?? "G.1X"),
        numberOfWorkers: Number(val("glueConfig.numberOfWorkers") ?? 2),
        glueVersion: String(val("glueConfig.glueVersion") ?? GLUE_VERSION_DEFAULT),
        timeoutMinutes: Number(val("glueConfig.timeoutMinutes") ?? 60),
        ...(retries !== undefined ? { maxRetries: Number(retries) } : {}),
        ...(execClass !== undefined ? { executionClass: String(execClass) } : {}),
      },
    };
  }
  if (channel === "glue-sync") {
    const distKey = val("redshiftConfig.distKey");
    const sortKeys = val("redshiftConfig.sortKeys");
    const gWorker = val("glueConfig.workerType");
    const gNum = val("glueConfig.numberOfWorkers");
    const gTimeout = val("glueConfig.timeoutMinutes");
    const gRetries = val("glueConfig.maxRetries");
    return {
      channel,
      retryCount: Number(val("retryCount") ?? 2),
      timeout: Number(val("timeout") ?? 3600),
      ...(gWorker !== undefined || gNum !== undefined ? {
        glueConfig: {
          ...(gWorker !== undefined ? { workerType: String(gWorker) } : {}),
          ...(gNum !== undefined ? { numberOfWorkers: Number(gNum) } : {}),
          ...(gTimeout !== undefined ? { timeoutMinutes: Number(gTimeout) } : {}),
          ...(gRetries !== undefined ? { maxRetries: Number(gRetries) } : {}),
        },
      } : {}),
      icebergConfig: {
        snapshotRetentionDays: Number(val("s3Config.icebergConfig.snapshotRetentionDays") ?? 7),
        maxSnapshots: Number(val("s3Config.icebergConfig.maxSnapshots") ?? 100),
        compactionMinutes: Number(val("s3Config.icebergConfig.compactionMinutes") ?? 60),
      },
      redshiftConfig: {
        distStyle: String(val("redshiftConfig.distStyle") ?? "auto"),
        ...(distKey ? { distKey: String(distKey) } : {}),
        ...(sortKeys ? { sortKeys: String(sortKeys) } : {}),
      },
    };
  }
  if (channel === "flink") {
    const ckInterval = val("checkpointIntervalMs");
    const ckPause = val("minPauseBetweenCheckpointsMs");
    const logLv = val("logLevel");
    const mtLv = val("metricsLevel");
    const snaps = val("snapshotsEnabled");
    return {
      channel,
      parallelism: Number(val("parallelism") ?? 1),
      parallelismPerKPU: Number(val("parallelismPerKPU") ?? 1),
      autoScalingEnabled: val("autoScalingEnabled") === true,
      ...(ckInterval !== undefined ? { checkpointIntervalMs: Number(ckInterval) } : {}),
      ...(ckPause !== undefined ? { minPauseBetweenCheckpointsMs: Number(ckPause) } : {}),
      ...(logLv !== undefined ? { logLevel: String(logLv) } : {}),
      ...(mtLv !== undefined ? { metricsLevel: String(mtLv) } : {}),
      ...(snaps !== undefined ? { snapshotsEnabled: snaps === true } : {}),
    };
  }
  if (channel === "dms") {
    const distKey = val("redshiftConfig.distKey");
    const sortKeys = val("redshiftConfig.sortKeys");
    const dmsKeys = ["targetTablePrepMode", "lobMode", "lobMaxSizeKB", "batchApplyEnabled", "validationEnabled", "fullLoadMaxSubTasks", "commitRate"] as const;
    const dmsSettings: Record<string, unknown> = {};
    for (const k of dmsKeys) {
      const v = val(`dmsSettings.${k}`);
      if (v !== undefined) dmsSettings[k] = v;
    }
    return {
      channel,
      retryCount: Number(val("retryCount") ?? 2),
      timeout: Number(val("timeout") ?? 3600),
      ...(Object.keys(dmsSettings).length ? { dmsSettings } : {}),
      redshiftConfig: {
        distStyle: String(val("redshiftConfig.distStyle") ?? "auto"),
        ...(distKey ? { distKey: String(distKey) } : {}),
        ...(sortKeys ? { sortKeys: String(sortKeys) } : {}),
      },
    };
  }
  if (channel === "emr") {
    // spec 形态对齐 EmrSpec;缺项回落 EMR_SPEC_DEFAULT(单一事实源)。driver.disk 非 catalog 项(表单无),
    // 直接带默认值补全 spec 供消费方一键回填。executor.disk 为 string 型推荐。
    const execDisk = val("spec.executor.disk");
    return {
      channel,
      spec: {
        releaseLabel: String(val("spec.releaseLabel") ?? EMR_SPEC_DEFAULT.releaseLabel),
        architecture: String(val("spec.architecture") ?? EMR_SPEC_DEFAULT.architecture),
        driver: {
          cpu: String(val("spec.driver.cpu") ?? EMR_SPEC_DEFAULT.driver.cpu),
          memory: String(val("spec.driver.memory") ?? EMR_SPEC_DEFAULT.driver.memory),
          ...(EMR_SPEC_DEFAULT.driver.disk ? { disk: EMR_SPEC_DEFAULT.driver.disk } : {}),
        },
        executor: {
          cpu: String(val("spec.executor.cpu") ?? EMR_SPEC_DEFAULT.executor.cpu),
          memory: String(val("spec.executor.memory") ?? EMR_SPEC_DEFAULT.executor.memory),
          ...(execDisk !== undefined ? { disk: String(execDisk) } : EMR_SPEC_DEFAULT.executor.disk ? { disk: EMR_SPEC_DEFAULT.executor.disk } : {}),
        },
        executorCount: Number(val("spec.executorCount") ?? EMR_SPEC_DEFAULT.executorCount),
      },
    };
  }
  return undefined;
}
