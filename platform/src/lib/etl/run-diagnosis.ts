/**
 * 从**引擎日志**里认出「这不是作业出错,是云侧还没给算力」——并给用户一句人话 + 出路。
 *
 * 🔴🔴 为什么要有这个文件(2026-09-16 真环境实测):us-east-1 的 Glue 连着两次
 *   只分到 driver、**十几分钟拿不到 executor**(Spark 反复报
 *   `Initial job has not accepted any resources`),`ExecutionTime` 一路涨到 963s;
 *   而**同一份脚本**在 us-west-2 正常成功,账号配额(并发 2000 / task DPU 1000,当时全账号只有这一个 run)、
 *   VPC(无连接)、FLEX(是 STANDARD)全部排除 ⇒ **云侧容量**。
 *   而用户在页面上看到的只有一个「运行中」，日志弹窗里**一个字都没解释**:
 *   分不清「排队等资源」「脚本挂住了」「平台坏了」——这三件事的下一步完全不同
 *   (等 / 改代码 / 报障),所以必须说清楚是哪一种。
 *
 * 判定只看**日志文本 + 是否仍在运行**,不猜、不依赖任何私有 API:
 * Spark 的 `TaskSchedulerImpl` 在拿不到 executor 时按固定间隔重复打那句 starvation 告警,
 * 这是官方行为(不是我们自己拼的字符串),因此它是可靠的事实来源。
 */

/** Spark 在「driver 起了、executor 一个都没注册」时反复打的那句(官方文本,勿改)。 */
const SPARK_STARVATION = "Initial job has not accepted any resources";

export type RunDiagnosisKind = "capacity-queued" | "none";

export interface RunDiagnosis {
  kind: RunDiagnosisKind;
  /** 给用户看的人话(一行,已含出路);`kind === "none"` 时为空。 */
  advice: string;
}

export const CAPACITY_QUEUED_ADVICE =
  "⏳ 云侧还没给这个作业分配计算资源(Spark 报 task starvation:driver 已启动、executor 数为 0)。" +
  "这不是作业本身出错,也不是平台故障 —— 该区域此刻算力紧张,作业在排队。" +
  "出路:继续等(作业自己的超时到点会失败),或者停掉这次运行、稍后重跑;" +
  "同一份代码在别的执行范围通常照样能跑。";

/**
 * @param logLines 已取到的日志行(错误流优先;顺序无关)
 * @param stillRunning 引擎侧是否**仍在运行**(已终态就不该再说「在排队」)
 */
export function diagnoseRunLogs(logLines: readonly string[], stillRunning: boolean): RunDiagnosis {
  if (!stillRunning) return { kind: "none", advice: "" };
  const hit = logLines.some((l) => typeof l === "string" && l.includes(SPARK_STARVATION));
  return hit ? { kind: "capacity-queued", advice: CAPACITY_QUEUED_ADVICE } : { kind: "none", advice: "" };
}

/** 引擎侧状态是否还算「在运行」(Glue / EMR / Redshift 三套词表的并集,统一小写比较)。 */
export function isStillRunning(state: string | undefined | null): boolean {
  const s = String(state ?? "").toLowerCase();
  return ["running", "starting", "waiting", "queued", "scheduled", "submitted", "pending", "started"].includes(s);
}
