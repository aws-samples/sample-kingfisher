// 模块 25 — 故障证据构造：把一次失败运行的上下文（运行记录 + 作业/工作流定义 + 真实日志/错误）
// 组织成"证据充分"的中文 prompt，交给 AWS DevOps Agent 产出结构化诊断报告。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
// @kf-batch 50-P50.3-mrquery
import { redshiftClientForTarget, stampedTargetOf } from "@/lib/exec-env/data-plane-target";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { GlueClient, GetJobRunCommand } from "@aws-sdk/client-glue";
import { CloudWatchLogsClient, GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeStatementCommand } from "@aws-sdk/client-redshift-data";
import { describeFlinkJob, readFlinkLogs, flinkHealthMetrics, flinkJobTarget } from "@/lib/realtime/flink-service";
import { buildDiagnosisGrounding } from "@/lib/incidents/grounding";
// 序 53:证据里的 Glue 运行环境来自单一作者(缺省版本 + 可选清单),具体这次运行用的版本从 Glue JobRun 真值读
import { GLUE_VERSIONS, glueRuntimeSummary } from "@/lib/sync/glue-version";

const region = homeRegion();
const account = process.env.AWS_ACCOUNT_ID || "";
const glue = sdkClient("data-plane", GlueClient, { region });
const cwl = sdkClient("data-plane", CloudWatchLogsClient, { region });
const USER_ID = "default-user";

export interface IncidentContext {
  taskId: string;
  runId: string;
  taskType: string;
  resourceName: string;
  status: string;
  error?: string;
  prompt: string;
  // 模块 43-A.2 — 本次证据是否注入了知识库中【人工已验证】的历史修复(落库 bgp-diagnostics)。
  usedIncidentHistory?: boolean;
  // 命中的故障签名(关联知识库,供 UI/审计;未命中为空)。
  incidentSignature?: string;
}

async function tailLogStream(logGroupName: string, logStreamName: string, limit = 120): Promise<string[]> {
  try {
    const out = await cwl.send(new GetLogEventsCommand({ logGroupName, logStreamName, limit, startFromHead: false }));
    return (out.events || []).map((e) => e.message || "").filter(Boolean);
  } catch {
    return [];
  }
}

// 取 run 记录所属的作业/工作流/同步定义。
async function getDefinition(taskId: string, taskType: string): Promise<any | null> {
  const t = (taskType || "").toLowerCase();
  if (t.startsWith("etl")) {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: taskId } }));
    return Item || null;
  }
  if (t === "workflow") {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: taskId } }));
    return Item || null;
  }
  if (t === "sync") {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId } }));
    return Item || null;
  }
  return null;
}

export async function buildIncidentContext(taskId: string, runId: string, projectId?: string): Promise<IncidentContext> {
  const { Item: run } = await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId, runId } }));
  if (!run) throw new Error("找不到该运行记录");
  const taskType = run.taskType || "unknown";
  const def = await getDefinition(taskId, taskType);
  const resourceName = def?.name || taskId;

  const lines: string[] = [];
  const isFailed = String(run.status || "").toLowerCase() === "failed";
  if (isFailed) {
    lines.push("你是资深数据平台 SRE / DevOps 工程师。请基于以下**真实证据**对这次任务失败做诊断，");
    lines.push("**直接输出**一份结构化的中文诊断报告（不要反问、不要只说「我去查一下」）：");
    lines.push("① 故障摘要 ② 根因分析（结合证据） ③ 修复建议（具体、可操作，必要时给修正代码片段） ④ 预防建议。");
  } else {
    lines.push("你是资深数据平台 SRE / DevOps 工程师。请基于以下**真实证据**对这次任务运行做分析复盘，");
    lines.push("**直接输出**一份结构化的中文报告（不要反问、不要只说「我去查一下」）：");
    lines.push("① 运行摘要 ② 运行表现与数据处理评估（结合证据） ③ 优化建议（性能/成本/健壮性，必要时给改进代码片段） ④ 风险与注意事项。");
  }
  lines.push("");
  lines.push(`## 运行环境`);
  lines.push(`- AWS 账号: ${account || "(本账号)"}，区域: ${region}`);
  lines.push(`- 平台: Kingfisher 大数据治理平台（Glue PySpark 缺省 ${glueRuntimeSummary()},作业可自选 ${GLUE_VERSIONS.join(" / ")} / Redshift Serverless / S3 Tables Iceberg / MWAA）`);
  lines.push(`- S3 Tables(Iceberg) 联邦目录名 s3tablescatalog，命名空间 ecommerce；Glue 作业需 --conf spark.sql.catalog.s3tablescatalog=... 注册后方可 spark.table 三段式访问。`);
  lines.push("");
  lines.push(`## 失败任务`);
  lines.push(`- 名称: ${resourceName}`);
  lines.push(`- 类型: ${taskType}`);
  lines.push(`- 运行状态: ${run.status}`);
  if (run.runDate) lines.push(`- 业务日期: ${run.runDate}`);
  if (run.error) lines.push(`- 平台记录的错误: ${String(run.error).slice(0, 800)}`);

  // 定义（脚本/SQL）
  if (def?.script) {
    lines.push("");
    lines.push(`## 作业脚本（${def.type === "glue" ? "Glue PySpark" : def.type === "redshift" ? "Redshift SQL" : ""}）`);
    lines.push("```");
    lines.push(String(def.script).slice(0, 3000));
    lines.push("```");
  }

  // 日志/错误（按引擎拉真实日志）
  if (run.glueJobRunId && run.glueJobName) {
    lines.push("");
    lines.push(`## Glue 运行信息`);
    lines.push(`- Glue 作业名: ${run.glueJobName}，JobRunId: ${run.glueJobRunId}`);
    lines.push(`- CloudWatch 日志组: /aws-glue/jobs/error 与 /aws-glue/jobs/output（logStream=${run.glueJobRunId}）`);
    try {
      const { JobRun } = await glue.send(new GetJobRunCommand({ JobName: run.glueJobName, RunId: run.glueJobRunId }));
      if (JobRun?.GlueVersion) lines.push(`- 本次运行的 Glue 版本: ${JobRun.GlueVersion}`);
      if (JobRun?.ErrorMessage) lines.push(`- Glue ErrorMessage: ${JobRun.ErrorMessage}`);
    } catch { /* best-effort */ }
    const errTail = await tailLogStream("/aws-glue/jobs/error", run.glueJobRunId, 120);
    const relevant = errTail.filter((l) => /error|exception|traceback|fail|caused by|at \w/i.test(l)).slice(-40);
    if (relevant.length) {
      lines.push("- CloudWatch 错误日志（尾部相关行）：");
      lines.push("```");
      lines.push(relevant.join("\n").slice(0, 2500));
      lines.push("```");
    }
  } else if (run.statementId) {
    lines.push("");
    lines.push(`## Redshift 执行信息`);
    try {
      // @kf-batch 50-P50.3-mrquery —— 同上:statementId 是 region 内的,取 run 的章去解 region。
      const rsForRun = await redshiftClientForTarget(stampedTargetOf(run));
      const desc = await rsForRun.send(new DescribeStatementCommand({ Id: run.statementId }));
      lines.push(`- 状态: ${desc.Status}`);
      if (desc.Error) lines.push(`- 错误: ${desc.Error}`);
      for (const s of desc.SubStatements || []) {
        if (s.Error) lines.push(`- 子语句错误: ${(s.QueryString || "").slice(0, 120)} → ${s.Error}`);
      }
    } catch { /* best-effort */ }
  }

  // 模块 43-A.2 — 注入运维知识库历史已验证修复 + 业务口径 grounding(仅失败诊断;best-effort)。
  // errorText 用 run.error(与 recordIncident 沉淀时的签名来源一致 → 命中同一主档,历史可闭环)。
  let usedIncidentHistory = false;
  let incidentSignature = "";
  if (isFailed && projectId) {
    try {
      const g = await buildDiagnosisGrounding({ projectId, taskType, errorText: run.error, keywords: resourceName });
      if (g.promptBlock) lines.push(g.promptBlock);
      usedIncidentHistory = g.usedIncidentHistory;
      incidentSignature = g.signature;
    } catch { /* grounding 失败不阻断诊断 */ }
  }

  return {
    taskId,
    runId,
    taskType,
    resourceName,
    status: run.status,
    error: run.error,
    prompt: lines.join("\n"),
    usedIncidentHistory,
    incidentSignature,
  };
}

// 模块 32 — Flink(MSAF)流作业取证:Flink 作业无 TASK_RUNS 运行记录,按 jobId 直接取
// 作业定义 + MSAF 应用状态 + CloudWatch 运行日志,组装证据 prompt。覆盖所有 sinkType(尤其
// 自定义 sink:用户自管连接定义/网络,出问题时由 DevOps Agent 诊断根因)。
export async function buildFlinkIncidentContext(jobId: string, projectId?: string): Promise<IncidentContext> {
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId } }));
  if (!job) throw new Error("找不到该 Flink 流作业");
  const resourceName = job.name || jobId;
  const sinkType = job.sinkType || "s3";

  // @kf-batch 50-WP27-9cap-matrix —— 🔴 **取证的三条路都要打作业自己那个区**。
  //   这三个函数都**接受** targetId,而这里三处都没传 ⇒ 非 home 的流作业,诊断拿到的是
  //   **主控区**的应用状态 / 指标 / 日志(大概率是「不存在 + 全 null + 空日志」)⇒ AI 会据此
  //   给出一份完全错的根因报告。与 `reconcileFlinkStatus` 同一族:落点参数在签名里,调用点没接上。
  const flinkTarget = flinkJobTarget(job);

  // MSAF 应用实时状态(可能已停/不存在)。
  let appStatus = "(无 MSAF 应用,可能未启动或已止血删除)";
  try { const d = await describeFlinkJob(jobId, flinkTarget); if (d) appStatus = d.status; } catch { /* best-effort */ }

  // 客观健康指标(CloudWatch):用于区分「真失败」与「良性日志噪声」。
  let health: { fullRestarts: number | null; failedCheckpoints: number | null; completedCheckpoints: number | null } = { fullRestarts: null, failedCheckpoints: null, completedCheckpoints: null };
  try { health = await flinkHealthMetrics(jobId, flinkTarget); } catch { /* best-effort */ }
  const healthy = health.fullRestarts === 0 && (health.failedCheckpoints === 0 || health.failedCheckpoints === null);

  const lines: string[] = [];
  lines.push("你是资深实时计算(Apache Flink / Amazon Managed Service for Apache Flink)SRE / DevOps 工程师。");
  lines.push("请基于以下**真实证据**对这个 Flink SQL 流作业做诊断,**直接输出**一份结构化的中文诊断报告");
  lines.push("(不要反问、不要只说「我去查一下」):① 故障/运行摘要 ② 根因分析(结合证据) ③ 修复建议");
  lines.push("(具体、可操作,必要时给修正后的 Flink SQL 或连接器/网络配置) ④ 预防建议。");
  lines.push("");
  lines.push(`## 关键判读规则(务必遵守,避免误判)`);
  lines.push(`- **先看「健康指标」再下结论**:fullRestarts 持续为 0 且无失败 checkpoint = 作业【健康运行,未失败】;此时不要把日志里的零星 WARN 当作故障根因。fullRestarts 增长 / 失败 checkpoint 增长 = 作业【真在重启循环】,才需深挖根因。`);
  lines.push(`- **区分「Flink 内部连接」与「sink 外部连接」**:logger 为 \`org.apache.pekko.*\` / \`org.apache.flink.runtime.*\` / Netty \`NettyTransport\` 且目标为 VPC 内网 IP + 高端口(如 10.x.x.x:4xxxx/5xxxx)的 SSL/连接 WARN,是 **Flink JobManager↔TaskManager 内部 RPC(Pekko/Akka)** 的良性抖动,**与外部 sink(数据库/OpenSearch 等)的网络可达性无关**——不要据此判定「sink 网络不通/安全组未放行」。只有当异常明确来自 sink 算子(如 \`region_agg_sink\`、JDBC/connector 类、sink 目标 host:端口如 3306/5439/443)时,才指向 sink 网络/配置问题。`);
  lines.push("");
  lines.push(`## 运行环境`);
  lines.push(`- AWS 账号: ${account || "(本账号)"},区域: ${region}`);
  lines.push(`- 引擎: Amazon Managed Service for Apache Flink(MSAF),Flink 1.20,源为 Kinesis 数据流。`);
  lines.push(`- 自定义 sink(custom)的连接定义与网络可达性【由用户自管】:连接器 JAR 用户上传并在启动时与基础 runner 合并为 per-job uber-jar;VPC 接入由用户显式提供私有子网 + 安全组(平台透传给 MSAF VpcConfiguration)。`);
  lines.push(`- 自定义 sink 接入前置条件:① 连接器 JAR 须为 Flink 1.20 兼容、含 META-INF/services SPI 工厂、≤250MB;② sink 目标须在私有子网且其安全组对 MSAF 子网放行对应端口、MSAF 子网经 NAT 出网到 Kinesis/CloudWatch;③ Flink SQL 须含 INSERT INTO,窗口聚合须 GROUP BY window_start, window_end。`);
  lines.push("");
  lines.push(`## 流作业`);
  lines.push(`- 名称: ${resourceName}`);
  lines.push(`- sink 类型: ${sinkType}`);
  lines.push(`- 平台作业状态: ${job.status}`);
  lines.push(`- MSAF 应用状态: ${appStatus}`);
  lines.push(`- **健康指标(近30分钟 CloudWatch)**:fullRestarts=${health.fullRestarts ?? "无数据"}、失败checkpoint=${health.failedCheckpoints ?? "无数据"}、完成checkpoint=${health.completedCheckpoints ?? "无数据"} → 综合判断:${healthy ? "**作业健康运行(无重启、checkpoint 正常)**,日志中的内部连接 WARN 应视为良性噪声,不应作为故障根因" : "作业可能存在重启/checkpoint 失败,需结合日志深挖根因"}`);
  if (Array.isArray(job.connectorIds) && job.connectorIds.length) lines.push(`- 自定义连接器数量: ${job.connectorIds.length}`);
  if (Array.isArray(job.vpcSubnets) && job.vpcSubnets.length) lines.push(`- 用户声明的 VPC 子网: ${job.vpcSubnets.join(", ")}`);
  if (Array.isArray(job.vpcSecurityGroups) && job.vpcSecurityGroups.length) lines.push(`- 用户声明的安全组: ${job.vpcSecurityGroups.join(", ")}`);
  if (job.lastError) lines.push(`- 平台记录的最近错误: ${String(job.lastError).slice(0, 800)}`);

  if (job.sql) {
    lines.push("");
    lines.push(`## 作业 Flink SQL`);
    lines.push("```sql");
    lines.push(String(job.sql).slice(0, 3000));
    lines.push("```");
  }

  // MSAF CloudWatch 运行日志(尾部相关行)。对 Pekko/Netty 内部 RPC 噪声打标,避免被误读为 sink 故障。
  let hadLogs = false;
  try {
    const logs = await readFlinkLogs(jobId, 200, flinkTarget);
    const relevant = logs.filter((l) => /error|exception|fail|caused by|restart|timeout|refused|denied|unable|not found|partial recovery|could not execute|encountered \"/i.test(l.msg)).slice(-40);
    const tail = relevant.length ? relevant : logs.slice(-30);
    const isInternalRpcNoise = (msg: string) => /pekko|akka|NettyTransport|Cannot kickstart|quarantine|association|Remote connection to \/10\.|gated for/i.test(msg);
    if (tail.length) {
      hadLogs = true;
      lines.push("");
      lines.push(`## MSAF CloudWatch 运行日志(${relevant.length ? "错误/重启相关行" : "尾部"};[内部RPC噪声] = Flink 内部 Pekko/Netty 连接抖动,非 sink 故障)`);
      lines.push("```");
      lines.push(tail.map((l) => `${l.time} [${l.level}]${isInternalRpcNoise(l.msg) ? " [内部RPC噪声]" : ""} ${l.msg}`).join("\n").slice(0, 2800));
      lines.push("```");
    }
  } catch { /* best-effort */ }

  // 证据兜底:既无实时日志、又无平台记录的错误时,明确告知模型"证据缺失"及原因,避免它
  // 凭空编造根因(此前用户反馈"诊断不出来"正源于此——作业被删后日志/状态全空)。
  if (!hadLogs && !job.lastError) {
    lines.push("");
    lines.push(`## ⚠️ 证据缺失说明`);
    lines.push(`未取到 CloudWatch 运行日志,且平台无记录的错误(lastError 为空)。可能原因:作业从未真正启动、`);
    lines.push(`或 MSAF 应用已被删除(其 CloudWatch 日志组随之删除)。请【不要臆测具体根因】,而是:`);
    lines.push(`① 指出证据缺失这一事实;② 给出"如何拿到证据"的可操作步骤(重新启动作业以复现并产生实时日志、`);
    lines.push(`或在作业停止而非删除的状态下重试诊断);③ 基于 Flink SQL 本身做静态检查(语法/连接器选项/占位符)给出可能的问题点,并标注为"待日志确认"。`);
  }

  // 模块 43-A.2 — 注入知识库历史已验证修复 + 业务口径 grounding(best-effort)。
  // Flink 错误源为 job.lastError(与 recordIncident 的 Flink 取数一致 → 命中同一主档)。
  let usedIncidentHistory = false;
  let incidentSignature = "";
  if (projectId && job.lastError) {
    try {
      const g = await buildDiagnosisGrounding({ projectId, taskType: "flink", errorText: job.lastError, keywords: resourceName });
      if (g.promptBlock) lines.push(g.promptBlock);
      usedIncidentHistory = g.usedIncidentHistory;
      incidentSignature = g.signature;
    } catch { /* grounding 失败不阻断诊断 */ }
  }

  return {
    taskId: jobId,
    runId: "",
    taskType: "flink",
    resourceName,
    status: job.status,
    error: job.lastError,
    prompt: lines.join("\n"),
    usedIncidentHistory,
    incidentSignature,
  };
}
