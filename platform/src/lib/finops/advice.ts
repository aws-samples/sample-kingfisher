// 确定性优化建议引擎(照检测器 SPI 注册表:新增规则只在 RULES 追加一行)。
// 铁律:建议值恒由确定性规则产出,AI 不参与取值(AI 解读留二期)。全部只读探测。

import { homeRegion } from "@/lib/place/home-region";
import {
  DescribeReplicationInstancesCommand,
  DescribeReplicationTasksCommand,
} from "@aws-sdk/client-database-migration-service";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { listCostDaily, scanAllCostRuns } from "./store";
import { UNIT_PRICES } from "./pricing";
import type { Advice } from "./types";

// 🔴 这里原来是一个模块级主控区 DMS 客户端 ⇒ **别的区的空转实例永远不会被建议出来**,
// 而它一直在按小时计费。成本建议漏一个区,等于那个区的浪费永远看不见 —— 比没有建议更坏,
// 因为界面上写着「无优化建议」。

type AdviceRule = { ruleId: string; run: (regions: readonly string[]) => Promise<Advice[]> };

// ── 规则实现 ──────────────────────────────────────────────────

// R1 空转 DMS 复制实例:实例常驻计费,但无 running 任务 → 建议删除(任务配置保留可重建)。
async function idleDmsInstance(regions: readonly string[]): Promise<Advice[]> {
  const { dmsClientFor } = await import("@/lib/exec-env/target-clients");
  const out: Advice[] = [];
  // 🔴 逐区探:空转判定必须**在同一个区内**做(A 区有 running 任务不代表 B 区的实例不空转)。
  for (const region of regions) {
    try {
      const dms = await dmsClientFor(region);
      const { ReplicationInstances = [] } = await dms.send(new DescribeReplicationInstancesCommand({}));
      if (!ReplicationInstances.length) continue;
      const { ReplicationTasks = [] } = await dms.send(new DescribeReplicationTasksCommand({}));
      const hasRunning = ReplicationTasks.some((t: { Status?: string }) => t.Status === "running");
      if (hasRunning) continue;
      for (const ri of ReplicationInstances as Array<{ ReplicationInstanceIdentifier?: string; ReplicationInstanceClass?: string }>) {
        out.push({
          ruleId: "idle-dms-instance",
          severity: "high" as const,
          title: `DMS 复制实例空转(${region};无 running 任务仍常驻计费)`,
          detail: `复制实例 ${ri.ReplicationInstanceIdentifier}(${ri.ReplicationInstanceClass},${region})当前无运行中的复制任务,但按小时计费。若近期不用,建议删除实例(任务/端点配置保留,重建即恢复)。`,
          estMonthlySavingUsd: 120, // dms.t3.medium 按需约 $0.164/h ≈ $120/月(量级提示)
          resource: ri.ReplicationInstanceIdentifier,
          region,
        });
      }
    } catch {
      // 无 DMS 或权限缺失:静默跳过该区(建议是增益,不因探测失败报错)
    }
  }
  return out;
}

// R2 Glue 超配:近 30 天有 run 的作业,实测 DPU 用量远低于申请容量(<30%)。
async function overProvisionedGlue(): Promise<Advice[]> {  // 读 DDB,不探 AWS ⇒ 不需要区
  const runs = await scanAllCostRuns();
  const byTask = new Map<string, { dpuSeconds: number; count: number }>();
  for (const r of runs) {
    if (r.engine !== "glue" || !r.usage.dpuSeconds) continue;
    const cur = byTask.get(r.taskId) ?? { dpuSeconds: 0, count: 0 };
    cur.dpuSeconds += r.usage.dpuSeconds;
    cur.count++;
    byTask.set(r.taskId, cur);
  }
  // 一期用启发式:单次平均 DPU-s 很小(<120s ≈ 2 DPU×1min)却反复跑 → 提示可降配/合并调度。
  const out: Advice[] = [];
  for (const [taskId, agg] of Array.from(byTask.entries())) {
    const avg = agg.dpuSeconds / agg.count;
    if (agg.count >= 5 && avg < 120) {
      out.push({
        ruleId: "glue-tiny-runs",
        severity: "info",
        title: "Glue 作业单次用量极小且高频",
        detail: `任务 ${taskId} 近期 ${agg.count} 次运行平均仅 ${Math.round(avg)} DPU-秒/次。Glue 每次运行有最低计费(1 分钟),高频微作业可考虑合并调度或降低 worker 数。`,
        resource: taskId,
      });
    }
  }
  return out;
}

// R3 价目表校准提醒:CE 实付的 Glue 金额/用量 与内置单价偏差 >10% → 提醒更新 pricing.ts。
async function priceDriftCheck(): Promise<Advice[]> {  // 读 DDB,不探 AWS ⇒ 不需要区
  const month = new Date().toISOString().slice(0, 7);
  const rows = await listCostDaily(month);
  // CE 的 Glue 行含 DPU-Hour 用量语义(采集时未细分 usage type,故这里只做金额级粗校准:
  // 平台归因的 Glue 月成本 vs CE 的 Glue 月成本,偏差大提示价目或归因覆盖不全)。
  const ceGlue = rows.filter((r) => r.service === "AWS Glue").reduce((a, b) => a + b.amountUsd, 0);
  const runs = await scanAllCostRuns();
  const attributed = runs
    .filter((r) => r.engine === "glue" && r.finishedAt.slice(0, 7) === month)
    .reduce((a, b) => a + b.costUsd, 0);
  if (ceGlue > 1 && attributed > 0) {
    const ratio = attributed / ceGlue;
    if (ratio < 0.5 || ratio > 1.5) {
      return [
        {
          ruleId: "price-drift",
          severity: "warn",
          title: "任务归因与账单偏差较大(价目表或覆盖度需校准)",
          detail: `本月平台归因 Glue 成本 $${attributed.toFixed(2)},CE 账单 $${ceGlue.toFixed(2)}(覆盖率 ${(ratio * 100).toFixed(0)}%)。可能原因:价目表过期(当前 $${UNIT_PRICES.glueDpuHourUsd}/DPU-h)、Crawler/交互式会话等非任务用量、或部分 run 未归因。`,
        },
      ];
    }
  }
  return [];
}

// R4 已知同步退化:run 记录带 degraded 标记(COPY→INSERT 慢兜底,防线①落的字段)的任务(慢即贵)。
async function knownDegradations(): Promise<Advice[]> {  // 读 DDB,不探 AWS ⇒ 不需要区
  const { Items = [] } = await docClient.send(
    new ScanCommand({
      TableName: TABLES.TASK_RUNS,
      FilterExpression: "attribute_exists(degraded) AND NOT attribute_type(degraded, :null)",
      ExpressionAttributeValues: { ":null": "NULL" },
      ProjectionExpression: "taskId, degraded",
      Limit: 100,
    })
  );
  const seen = new Set<string>();
  const out: Advice[] = [];
  for (const it of Items as { taskId?: string; degraded?: { reason?: string } }[]) {
    if (!it.taskId || seen.has(it.taskId)) continue;
    seen.add(it.taskId);
    out.push({
      ruleId: "sync-degraded",
      severity: "warn",
      title: "同步任务曾发生 COPY→INSERT 退化(慢路径更烧钱)",
      detail: `任务 ${it.taskId} 历史运行中发生退化(${it.degraded?.reason || "copy_fallback"}):COPY 回退慢 INSERT 显著拉长 Glue 运行时长(=DPU 费用)。建议核查类型映射后重跑。`,
      resource: it.taskId,
    });
  }
  return out;
}

// ── 注册表(新增规则只加一行)─────────────────────────────────

const RULES: AdviceRule[] = [
  { ruleId: "idle-dms-instance", run: idleDmsInstance },
  { ruleId: "glue-tiny-runs", run: () => overProvisionedGlue() },
  { ruleId: "price-drift", run: () => priceDriftCheck() },
  { ruleId: "sync-degraded", run: () => knownDegradations() },
];

/**
 * @param regions 要探的区(缺省 = 只探主控区 ⇒ 与改动前逐字节等价,是回滚点)。
 * 🔴 只有真探 AWS 的规则用得到它;读 DDB 的规则(成本行 / 同步任务)本来就是全平台一份数据。
 */
export async function listAdvice(regions?: readonly string[]): Promise<Advice[]> {
  const probeRegions = regions && regions.length > 0 ? regions : [homeRegion()];
  const settled = await Promise.allSettled(RULES.map((r) => r.run(probeRegions)));
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}
