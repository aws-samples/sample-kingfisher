import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

interface DatabaseStackProps extends cdk.StackProps {
  // 模块 27 (WS1) — 数据域 CMK,用于全部 DynamoDB 表静态加密。
  dataKey: kms.IKey;
}

export class DatabaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // 模块 27 — 生产化加固的统一表选项:
    //  WS1 CMK 加密(解密由 DynamoDB 服务经 grant 完成,应用角色无需 kms 权限);
    //  WS3 PITR(35 天连续备份,可秒级时间点恢复)+ RemovalPolicy.RETAIN(防 cdk destroy 误删)。
    const hardened = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dataKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    } as const;

    const tables = [
      { name: "bgp-datasources", pk: "userId", sk: "datasourceId" },
      { name: "bgp-sync-tasks", pk: "userId", sk: "taskId" },
      { name: "bgp-workflows", pk: "userId", sk: "workflowId" },
      { name: "bgp-redshift-tasks", pk: "userId", sk: "taskId" },
      { name: "bgp-task-runs", pk: "taskId", sk: "runId" },
      { name: "bgp-sql-history", pk: "userId", sk: "historyId" },
      { name: "bgp-lineage", pk: "targetFqn", sk: "sourceFqn" },
      // AUTH-04 operation audit log. Single logical partition (pk = "audit") with a
      // time-ordered sort key (ts = "<iso>#<ulid>") so the most recent operations can be
      // read cheaply in reverse-chronological order via Query(ScanIndexForward=false).
      { name: "bgp-audit", pk: "pk", sk: "ts" },
      // GenBI (智能问数) question history. One partition per user, ULID sort key for cheap
      // reverse-chronological reads (Query ScanIndexForward=false).
      { name: "bgp-genbi-history", pk: "userId", sk: "historyId" },
      // ETL 开发模块（作业开发）: user-authored Glue PySpark / Redshift SQL jobs.
      { name: "bgp-etl-jobs", pk: "userId", sk: "jobId" },
      // 模块 13 — 多租户/项目空间/RBAC/审批 (v1.4.0)
      // Projects: single logical partition (pk = "project") with projectId sort key, so all
      // projects are listed via Query(pk="project") and fetched via Get(pk,sk).
      { name: "bgp-projects", pk: "pk", sk: "projectId" },
      // Approvals (access/role-change requests, and a generic gate reused by later pillars):
      // single logical partition (pk = "approval"), ULID sort key. Low volume → Scan+filter
      // for "pending" lists; Get(pk,sk) for decisions.
      { name: "bgp-approvals", pk: "pk", sk: "approvalId" },
      // 模块 14 — 资源版本管理与回滚 (v1.5.0): per-resource config snapshots.
      // pk = `<type>#<resourceId>` (e.g. "workflow#01..."), sk = zero-padded version. Query
      // by pk lists a resource's history; ScanIndexForward=false gives newest-first.
      { name: "bgp-resource-versions", pk: "pk", sk: "version" },
      // 模块 18 — 数据分级分类 + 字段脱敏 + 权限申请 (v1.9.0)
      // Classification: pk = table FQN (bgp-redshift.<db>.<schema>.<table>), sk = column name
      // ("__table__" for table-level). Query(pk=fqn) lists a table's column classifications.
      { name: "bgp-data-classification", pk: "fqn", sk: "column" },
      // Data-access grants: pk = Cognito username, sk = granted table FQN. Get(pk,sk) checks
      // a user's access to a table; Query(pk=username) lists "my grants". Written on approval.
      { name: "bgp-data-grants", pk: "username", sk: "fqn" },
      // 模块 19 — 数据质量规则模板 + 评分 + SLA (v1.10.0)
      // Quality rules: pk = table FQN, sk = ruleId (ulid). Query(pk=fqn) lists a table's rules.
      { name: "bgp-quality-rules", pk: "fqn", sk: "ruleId" },
      // Quality results/history: pk = table FQN, sk = "<runId>#<ruleId>" (runId=ulid, time-
      // ordered; summary row sk = "<runId>#__summary__"). Query(pk=fqn, desc) → latest run +
      // trend (summary rows). Each run writes one row per rule + one summary row.
      { name: "bgp-quality-results", pk: "fqn", sk: "sk" },
      // 模块 20 — 指标中台 / Metrics Store (v1.11.0)
      // Metric definitions: single logical partition (pk = "metric") + metricId sort key, so
      // all metrics list via Query(pk="metric") and fetch via Get(pk,sk).
      { name: "bgp-metrics", pk: "pk", sk: "metricId" },
      // Metric value snapshots: pk = metricId, sk = ts (ISO). Query(pk=metricId, desc) gives
      // the recent value history (trend) of a metric.
      { name: "bgp-metric-values", pk: "metricId", sk: "ts" },
      // 模块 22 — 智能问数→需求→研发交付流水线 (v1.14.0)
      // Requirements: single logical partition (pk = "requirement"), ULID sort key. Query(pk)
      // lists all; in-memory filter for role-aware boxes (mine/assigned/inbox/all). Comments
      // and state transitions are embedded as an `activity[]` timeline (well under 400KB).
      { name: "bgp-requirements", pk: "pk", sk: "requirementId" },
      // 模块 25 — 故障诊断 / AWS DevOps Agent (v1.22.0)
      // 诊断报告：单逻辑分区 (pk = "diagnostic") + diagnosticId(ULID) 排序键。Query(pk) 列全部、
      // 内存按 taskId/runId 过滤；Get(pk,sk) 取单条。存 status/report/agentSpaceId/executionId 等。
      { name: "bgp-diagnostics", pk: "pk", sk: "diagnosticId" },
      // 模块 35 — 数仓建模（分层/数据域/数据标准/码表/归属）。均为低频低量配置数据。
      // 分层：单逻辑分区 (pk = "layer") + layerId(ULID)。Query(pk) 列全部、Get(pk,sk) 取单条。
      { name: "bgp-data-layers", pk: "pk", sk: "layerId" },
      // 数据域/主题域（两级树）：单逻辑分区 (pk = "domain") + domainId(ULID)。parentId 区分级别。
      { name: "bgp-data-domains", pk: "pk", sk: "domainId" },
      // 数据标准（标准字段字典）：单逻辑分区 (pk = "standard") + standardId(ULID)。
      { name: "bgp-data-standards", pk: "pk", sk: "standardId" },
      // 码表（枚举字典）：单逻辑分区 (pk = "codetable") + codeTableId(ULID)。枚举项内嵌 values[]。
      { name: "bgp-code-tables", pk: "pk", sk: "codeTableId" },
      // 建模资产归属：表/指标 FQN → 分层/域。pk = fqn, sk = "binding"。Get(fqn,"binding") O(1) 查归属。
      { name: "bgp-model-assets", pk: "fqn", sk: "sk" },
      // 模块 35 P1 — D3 维度/事实表登记：单逻辑分区 (pk = "modeltable") + modelTableId(ULID)。
      // 列定义/SCD/粒度内嵌；可一键生成并应用 Redshift DDL。
      { name: "bgp-model-tables", pk: "pk", sk: "modelTableId" },
      // 模块 35 P1 — D4 指标体系(原子/派生)：单逻辑分区 (pk = "modelmetric") + modelMetricId(ULID)。
      // 模块20 之上的治理建模层,不动 bgp-metrics。
      { name: "bgp-model-metrics", pk: "pk", sk: "modelMetricId" },
      // 模块 32 — 实时计算 Flink:Flink SQL 流作业登记(每作业一个 MSAF 应用)。pk=userId, sk=jobId。
      { name: "bgp-flink-jobs", pk: "userId", sk: "jobId" },
      // 模块 32 — 自定义连接器注册表(用户上传的 sink 连接器 JAR 元数据)。pk=userId, sk=connectorId。
      // JAR 本体存 S3(代码桶 flink/connectors/ 前缀),此表只存元数据(名称/连接器标识/S3键/大小)。
      { name: "bgp-flink-connectors", pk: "userId", sk: "connectorId" },
      // 模块 33-A — 离线多引擎:EMR Serverless 作业定义(独立表,不污染 bgp-etl-jobs)。pk=userId, sk=jobId。
      // per-作业专属 application id 内嵌;运行记录仍写共享表 bgp-task-runs(taskType=emr-serverless)。
      { name: "bgp-engine-jobs", pk: "userId", sk: "jobId" },
      // 模块 34 — 智能运维/统一告警中心。均低频低量配置数据,与 bgp-metrics/bgp-approvals 同构。
      // 告警规则：单逻辑分区 (pk = "alertrule") + ruleId(ULID)。Query(pk) 列全部；projectId 作属性过滤。
      { name: "bgp-alert-rules", pk: "pk", sk: "ruleId" },
      // 通知通道：单逻辑分区 (pk = "alertchannel") + channelId(ULID)。钉钉/企微/邮件/通用 webhook 配置。
      // webhook secret 是用户运行期输入(非代码硬编码),随表 CMK 静态加密存储。
      { name: "bgp-alert-channels", pk: "pk", sk: "channelId" },
      // 告警事件流(bgp-alert-events)在 tables 循环外单独建(需 TTL,见下)。
      // 模块 37 — BI 报表/仪表盘搭建器(F3)。项目级共享资产,键式隔离:pk=projectId,
      // Query(pk=projectId) 天然按项目列表。无 TTL(长期资产)。
      // 报表 widget:取数 spec(自由 SQL / DataService 引用 / GenBI 固化)+ 可视化 spec + 乐观锁 version。
      { name: "bgp-bi-reports", pk: "projectId", sk: "reportId" },
      // 仪表盘:栅格布局({i,x,y,w,h} 兼容 react-grid-layout 便于二期升级)+ widget 引用 + 筛选器,内嵌数组。
      { name: "bgp-bi-dashboards", pk: "projectId", sk: "dashboardId" },
      // v4 分析看板(QuickSight 式):一个画布内嵌 N 个视觉对象 + 绑字段·作用域筛选器 + 布局。纯新增,旧两表保留。
      { name: "bgp-bi-analyses", pk: "projectId", sk: "analysisId" },
      // 模块 43-B — 智能基线学习:每任务从 bgp-task-runs 历史学出的时长/准点/成功率基线快照。
      // pk = "baseline#<projectId>"(键式项目隔离),sk = taskId。学习器周期 upsert;Get(pk,taskId) O(1) 取单任务基线。
      { name: "bgp-baselines", pk: "pk", sk: "taskId" },
      // 模块 43-B — SLA 定义 + 最近预测态。pk = "sla#<projectId>",sk = slaId(ULID)。内嵌 version 乐观锁 +
      // lastPrediction(runId/etaAt/willBreach/riskLevel)。Query(pk) 列一个项目全部 SLA。
      { name: "bgp-slas", pk: "pk", sk: "slaId" },
      // 模块 43-C — 生产级补数据:补数计划(参数 + 聚合进度 + 状态机 + version)。
      // pk = "backfill#<projectId>",sk = planId(ULID)。Query(pk) 列一个项目全部计划。
      { name: "bgp-backfill-plans", pk: "pk", sk: "planId" },
      // 模块 44 — Copilot 规划-执行引擎:执行计划主档(用户诉求 + 聚合进度 + 状态机 + version 乐观锁 +
      // autoExecute 门控)。pk = "copilot#<projectId>"(键式项目隔离),sk = planId(ULID)。
      // Query(pk) 列一个项目全部计划。复用补数 plan/tick/reconcile 内核,泛化为异构步骤(见
      // docs/design/44-unified-copilot/PLAN-EXECUTE-DESIGN.md)。计划主档长期留存,不设 TTL。
      { name: "bgp-copilot-plans", pk: "pk", sk: "planId" },
      // @kf-batch 50-PROD-B-seq33 ③:`bgp-action-schedules`(平台动作的调度对象)**已移到** 平台栈的
      //   ActionDispatch 构件(infra/lib/action-dispatch.ts)—— 本栈与平台栈互不依赖,
      //   `redeploy-platform.sh` 只部署平台栈 ⇒ 表放这里会让「只重部署平台」的环境缺表(功能当场 500)。
    ];

    for (const t of tables) {
      new dynamodb.Table(this, t.name, {
        tableName: t.name,
        partitionKey: { name: t.pk, type: dynamodb.AttributeType.STRING },
        sortKey: { name: t.sk, type: dynamodb.AttributeType.STRING },
        ...hardened,
      });
    }

    // Project membership (module 13): pk = projectId, sk = username (Cognito Username, so it
    // is human-readable and matches the user-management page). A `byUser` GSI lets us list
    // "my projects" via Query(pk=username).
    const memberTable = new dynamodb.Table(this, "bgp-project-members", {
      tableName: "bgp-project-members",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "username", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    memberTable.addGlobalSecondaryIndex({
      indexName: "byUser",
      partitionKey: { name: "username", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 模块 26 — GenBI on AgentCore：对话短期记忆（当前对话上下文）。
    // pk = conversationId, sk = ts(ISO)。Query(pk, asc) 取一段对话最近 N 轮；TTL 属性 `ttl`
    // （epoch 秒）让短期记忆 ~24h 自动过期，避免堆积。长期记忆走 S3 摘要（见模块 26 设计）。
    new dynamodb.Table(this, "bgp-genbi-turns", {
      tableName: "bgp-genbi-turns",
      partitionKey: { name: "conversationId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 网络连通性智能顾问 — 多轮对话短期记忆（当前会话上下文）。结构与 bgp-genbi-turns 一致：
    // pk = conversationId, sk = ts(ISO)；TTL 属性 `ttl`（epoch 秒）让记忆 ~24h 自动过期。
    new dynamodb.Table(this, "bgp-network-advisor-turns", {
      tableName: "bgp-network-advisor-turns",
      partitionKey: { name: "conversationId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 参数辅助智能顾问 — 多轮对话短期记忆（selfmanaged 记忆后端/回退档）。结构同上。
    new dynamodb.Table(this, "bgp-param-advisor-turns", {
      tableName: "bgp-param-advisor-turns",
      partitionKey: { name: "conversationId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 44 — 统一 Copilot：多轮对话短期记忆（selfmanaged 后端）。结构同上（pk=conversationId,
    // sk=ts，TTL ~24h）。此前漏建此表 → lib/copilot/memory.ts 的 loadShortTerm/appendTurn 静默降级
    // 返回空 → Copilot 每轮都是空上下文、不支持多轮对话。补建后代码链路（前端传 conversationId →
    // route loadShortTerm/appendTurn → agent 消费 history）即刻打通，无需其他改动。TaskRole 的
    // bgp-* 通配授权已自动覆盖本表。
    new dynamodb.Table(this, "bgp-copilot-turns", {
      tableName: "bgp-copilot-turns",
      partitionKey: { name: "conversationId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 26 — GenBI on AgentCore：业务知识/口径/规则库（供 lookup_business_context 技能查阅）。
    // pk = projectId（"global" 为跨项目通用条目）, sk = entryId(ULID)。Query(pk) 列一个项目的条目。
    new dynamodb.Table(this, "bgp-genbi-context", {
      tableName: "bgp-genbi-context",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "entryId", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });

    // 模块 26 — 数据驱动「工具型 skill」注册表（SQL 模板技能；run_registered_skill 执行）。
    // pk = projectId（"global" 通用）, sk = skillId(ULID)。新技能=加一行(纯数据,零部署热加载)。
    new dynamodb.Table(this, "bgp-genbi-skills", {
      tableName: "bgp-genbi-skills",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "skillId", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });

    // 模块 30 — 数据服务 DataService:API 定义。pk=projectId, sk=apiId。
    // GSI byPath(pk=pathKey="path#version")供对外端点 O(1) 路由到已发布 API。
    const dataApis = new dynamodb.Table(this, "bgp-data-apis", {
      tableName: "bgp-data-apis",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "apiId", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    dataApis.addGlobalSecondaryIndex({
      indexName: "byPath",
      partitionKey: { name: "pathKey", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 模块 30 — API Key(哈希存储)。pk=projectId, sk=keyId。
    // GSI byHash(pk=keyHash)供对外端点按 sha256(明文) O(1) 验证 Key。
    const dataApiKeys = new dynamodb.Table(this, "bgp-data-api-keys", {
      tableName: "bgp-data-api-keys",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "keyId", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    dataApiKeys.addGlobalSecondaryIndex({
      indexName: "byHash",
      partitionKey: { name: "keyHash", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 模块 30 — 限流固定窗口计数。pk="<keyId>#<apiId>", sk="<window>#<bucket>"。
    // TTL 属性 ttl(epoch 秒)让过期窗口行自动清理。
    new dynamodb.Table(this, "bgp-data-api-usage", {
      tableName: "bgp-data-api-usage",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 34 — 智能运维/统一告警中心：告警事件流。pk = ruleId(按规则天然分散,无热点),
    // sk = dedupeKey(失败/超时类="run#<runId>";成功率/断流类="win#<bucket>")。**sk 即去重键**:
    // 命中时用条件写 attribute_not_exists(ruleId) 保证同一 run/窗口只产生一条事件(幂等,杜绝重复告警)。
    // 事件按属性 createdAt 排序展示(低量,跨规则列表走 Scan,同 bgp-task-runs 约定)。TTL 属性 ttl
    // (epoch 秒)让事件 ~90 天自动过期,不堆积。
    new dynamodb.Table(this, "bgp-alert-events", {
      tableName: "bgp-alert-events",
      partitionKey: { name: "ruleId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 36 — 治理深化(E5):敏感数据识别扫描的运行记录/建议。pk = scanId(ULID,时间有序),
    // sk = "finding#<fqn>#<column>"(每条建议一行)或 "__summary__"(汇总行)。Query(pk=scanId)
    // 取一次扫描全部建议;跨扫描列"最近扫描"走 Scan(低频低量)。**只存元数据(列名/类型/检测器/
    // 命中率/置信度),绝不存抽样到的敏感值本身**。TTL 属性 ttl(epoch 秒)让旧扫描 ~90 天自动过期。
    new dynamodb.Table(this, "bgp-sensitive-findings", {
      tableName: "bgp-sensitive-findings",
      partitionKey: { name: "scanId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 38 — GenBI 异步化执行:一次问数任务(提交→轮询→取结果,根治 60s 同步超时)。
    // pk = taskId(ULID,时间有序);单分区键即天然幂等键,无 sk。存 pending|running|succeeded|
    // failed|timeout + result(GenBiResult JSON,仅 succeeded)+ heartbeatAt(心跳,轮询驱动重认领用)。
    // **result 受 maxRows=200 约束,远小于 400KB 上限**。TTL 属性 ttl(epoch 秒)让任务 ~7 天自动过期。
    new dynamodb.Table(this, "bgp-genbi-tasks", {
      tableName: "bgp-genbi-tasks",
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 43-C — 生产级补数据:每个(日期,节点)补数实例。pk = planId(按计划天然分散),
    // sk = "<date>#<nodeId>"(计划内唯一,幂等去重键 = planId#sk)。存 status/runId/dependsOn/
    // attempts 等。Query(pk=planId) 取一个计划全部实例聚合进度矩阵。TTL 属性 ttl(epoch 秒)
    // 让补数实例 ~90 天自动过期(计划主档不设 TTL,长期留存)。
    new dynamodb.Table(this, "bgp-backfill-instances", {
      tableName: "bgp-backfill-instances",
      partitionKey: { name: "planId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 44 — Copilot 规划-执行引擎:执行计划的每个异构步骤一行(泛化补数实例)。
    // pk = planId(按计划天然分散),sk = stepId(计划内唯一,序号/ULID)。存 stepType/status/
    // dependsOn/params/execHint/runToken/attempts 等。Query(pk=planId) 取一个计划全部步骤矩阵。
    // TTL 属性 ttl(epoch 秒)~90 天自动过期(计划主档不设 TTL,长期留存)。TaskRole 的 bgp-*
    // 通配授权已自动覆盖本表(与 bgp-copilot-turns 同款,加表零 IAM 改动)。
    new dynamodb.Table(this, "bgp-copilot-steps", {
      tableName: "bgp-copilot-steps",
      partitionKey: { name: "planId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "stepId", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 44 — Copilot 规划大脑异步任务(照抄模块38 bgp-genbi-tasks 异步化模式)。
    // 规划大脑(Strands+Opus 发现+结构化输出)重推理耗时可能 >CloudFront 60s 同步硬墙 → 必须异步:
    // POST /api/copilot/plan 立即建 pending 任务返 taskId;后台跑 planner 不受 60s 约束;前端轮询取计划。
    // pk = taskId(ULID)。status/result(planId)/error/runToken/heartbeatAt/startedAt/ttl(7d)。
    // 并发三保证(claimForRun 条件写 + runToken 防僵尸 + 300s 天花板 forceTimeout)复用 GenBI。
    new dynamodb.Table(this, "bgp-copilot-plan-tasks", {
      tableName: "bgp-copilot-plan-tasks",
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 55 / 序 50 — 长操作统一框架的任务表(照 bgp-genbi-tasks 的状态机与并发三保证;替掉序 46 B-107 的 bgp-ai-tasks ——
    // B-107 未发版,客户现网没有那张表,改名零迁移;装过预发版本的测试账号升级后旧表因 RETAIN 留空壳,由运维点名删)。
    // 为什么:B-74 同步列 / B-95 删项目 / B-107 七条 AI / B-111 建模落地撞数仓冷启动 —— 同一病四次发作:请求处理器同步等外部终态
    // 撞 CloudFront / ALB 60s 墙 ⇒ 504 HTML。用户 2026-10-21 拍板「高度抽象、一劳永逸」⇒ 全平台只有一个「提交长操作」原语:
    // 进程内等 45s 未终态才转 202(协议 long-op/1)+ GET /api/long-ops/[taskId] 轮询(客户端由全局 fetch 拦截器接管,页面调用点零改动)。
    // pk = taskId(ULID)。kind/params/userId/status/result/resultStatus/meta/error/errorStatus/errorBody/runToken/heartbeatAt/startedAt/ttl(7d)。
    // 平台侧唯一作者 platform/src/lib/long-ops/store.ts。TaskRole bgp-* 通配已覆盖。
    new dynamodb.Table(this, "bgp-long-ops", {
      tableName: "bgp-long-ops",
      partitionKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 44 — Copilot 工程配方库【管理员动态扩展】。系统配方代码内嵌(只读基座);此表存管理员
    // 新增的企业特有范式(仅 isPlatformAdmin 可写,全局只读)。pk="recipe#<engine>", sk=recipeId(ULID)。
    // 不设 TTL(配方是长期知识资产)。TaskRole bgp-* 通配已覆盖。
    new dynamodb.Table(this, "bgp-copilot-recipes", {
      tableName: "bgp-copilot-recipes",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recipeId", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });

    // S0(模块 50 SPEC §0/§3.7)— 查询句柄:修「凭 statementId 即可读他人查询结果」的现网越权。
    // 提交语句时签发,取结果/取消必须带 `?handleId=` 并核对 statementId + ownerSub/项目归属。
    // 🔴 pk **必须是 handleId**(不可猜的 ULID)——若按 statementId 建键,句柄就和被保护的 id 一样
    // 可猜/可传播,IDOR 根本没修。TTL 属性 `ttl`(epoch 秒,36h)自动清理过期句柄。
    new dynamodb.Table(this, "bgp-query-handles", {
      tableName: "bgp-query-handles",
      partitionKey: { name: "handleId", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 平台运行时配置(页面可改、无需重部署)。pk="system", sk="<域>#<键>"。
    // S0 用 sk="security#query-handle"({enforce:boolean})做 handle 校验的紧急回滚开关;
    // 模块 51 的模型配置(sk="ai-model#*" / "ai-model#__version" / "ratelimit#probe#*")复用同表。
    // 🔴 表级开 TTL 属性 `ttl`,但**配置主档绝不写该属性**(误带一次全局配置就静默消失,
    // RETAIN/PITR 都不会报警)——只有限频计数类 item 才带 ttl。同表混合保留有先例(bgp-incidents)。
    new dynamodb.Table(this, "bgp-settings", {
      tableName: "bgp-settings",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // @kf-batch 50-W5-seg2-WP10a —— 模块 50 S13:免责告知**同意留存**(50 SPEC v3.23 §1.3a S13 / §3.2;DESIGN §18 决策 6quinquies ④)。
    // pk = 用户 sub,sk = "<targetId>#<disclaimerVersion>" ⇒ 「这个人对这个 target 同意过这一版文案」一行一次、只追加
    // (平台 TaskRole 对本表显式 Deny UpdateItem / DeleteItem / BatchWriteItem,见 platform-stack `ExecEnvResidency`:写了改不了)。
    // 属性 {targetId, version, textHash, at, ip, ua, username}。🔴 不设 TTL:同意记录是留证,不许过期消失。
    // GSI byTarget(pk=targetId, sk=at)回答「这个 target 谁同意过」(详情页「已同意告知」卡;GET .../[targetId]/acks),免 Scan。
    const residencyAcks = new dynamodb.Table(this, "bgp-residency-acks", {
      tableName: "bgp-residency-acks",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    residencyAcks.addGlobalSecondaryIndex({
      indexName: "byTarget",
      partitionKey: { name: "targetId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "at", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // @kf-batch 54-genbi-session-cards —— 模块 54:问数「会话卡片」的**中央指针 + 每人配额**
    // (54 DESIGN v1.1 §4.1;用户 2026-09-12「每个人最多只能保留100个会话卡片」)。
    //
    // pk = 用户 Cognito **sub**(不是用户名 —— 改名不该丢卡片),sk 两类 item 同表:
    //   · "card#<cardId>" 指针行:cardId / conversationId / targetId / region / projectId / engine /
    //     title / turnCount / bytes / bodyRef{bucket,key} / bodySha256 / createdAt / updatedAt / state
    //   · "quota#"        计数器行:{ n }
    // 🔴 **两类 item 必须同表同分区**:上限「每人 ≤100」只有在「指针 + 计数器同一次 TransactWriteItems」
    //    里才是真的(「先 Count 再 Put」在两个并发保存都读到 99 时会写出 101)。分表 = 跨表事务 = 做不到强一致。
    // 🔴 本表**只存非数据值**:结果行 / SQL / 结论 / 推理步骤一律落**该 target 本区**的 S3
    //    (`s3://<该 target 的 datalakeBucket>/genbi-cards/<userSub>/<cardId>/body.json`)。
    //    会话卡片是平台**第一个持久化查询结果行**的功能 —— 正文放中央就等于把别法域的数据搬进主控区。
    // GSI byConversation(pk=pk, sk=conversationId)= **幂等键**:同一段对话重复点保存要更新同一张卡,
    //    否则点三次吃掉 3 个额度。稀疏索引(计数器行没有 conversationId 属性,天然不进索引)。
    // 🔴 **不设 TTL**:卡片是用户主动保存的资产,不许到期悄悄消失(满额也只明确拒绝、绝不自动淘汰)。
    const genbiCards = new dynamodb.Table(this, "bgp-genbi-cards", {
      tableName: "bgp-genbi-cards",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    genbiCards.addGlobalSecondaryIndex({
      indexName: "byConversation",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "conversationId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // @kf-batch 50-WP5-rungroup —— 模块 50 O2:多区联动运行的**持久父对象**(50 SPEC v3.44 §1.3a S7 / §2.7 / §3.17)。
    //
    // 用户原话:「在主控区创建任务下发到多个区域,这些任务会产生关联性,后续主控区执行可以选择联动」。
    // 一次点「运行」扇出到 N 个区 ⇒ N 条 run 行(每条只发生在一个区)+ **一行组**。
    //
    // pk = runGroupId,两种形态同表:
    //   · `rg_<ULID>`              手动 / API 扇出(W3-f 门票 T2 起 run 行上就带着它了)
    //   · `rgs_<sha256 前 24 hex>` 定时触发的**确定性**键(各区各自算得出、互不通信;§3.17)
    // GSI byDefinition(pk=definitionId, sk=createdAt)= 「这个作业最近的几次联动运行」,**不 Scan**
    //   (Scan 在多组之后只回首页且不报错 = 静默漏数,与 §1.2 里 Scan→Query 的整改同一个理由)。
    //
    // 🔴 **不设 TTL**:运行历史属审计面,不许到期悄悄消失(与 bgp-residency-acks 同一条纪律)。
    // 🔴 表里的 `status` 是**物化投影**,不是真值源 —— 真值永远是子 run 行,读时 `deriveGroupStatus()`
    //    派生并对账写回。造第二个真值源的下场见 §3.17.1 第 2 条。
    const runGroups = new dynamodb.Table(this, "bgp-run-groups", {
      tableName: "bgp-run-groups",
      partitionKey: { name: "runGroupId", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    runGroups.addGlobalSecondaryIndex({
      indexName: "byDefinition",
      partitionKey: { name: "definitionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 模块 50 G1 — 执行目标(ExecutionTarget)注册表。pk 常量 "env",sk = targetId。
    //
    // 🔴 sk 是**不可变身份 targetId**(如 tgt_home / tgt_usw2_a),**不是 region**。
    // 早期方案拿 region 当主键,导致三个同根缺陷:① bgp-task-runs 的 (taskId, runId) 在多 region
    // 下碰撞(同 cron 的 Airflow runId 确定性相同)② 运行锁缺作用域 ③ 身份被绑死在"位置"上。
    // 位置类属性(partition/accountId/region/cellId/stage)一律降为**属性**。
    //
    // GSI `byRegion` 回答"某 region 有哪些 target",避免全表 Scan(多 target 后 Scan 只回首页
    // 且不报错 = 静默漏数,与 50 SPEC §1.2 里 Scan→Query 的整改同一个理由)。
    // sk 复用基表的 sk 属性(值即 targetId),不另存一份、免两处漂移。
    // 🔴 合同已按此订正:50 SPEC §1.1 v3.4 明写 `byRegion(pk=region, sk=sk)`(原写 `sk=targetId` 与本处漂移);
    //    并写明 **GSI 最终一致 ⇒ 禁用于准入判定**(§3.1)。`contract-drift.test.ts` 会 parse SPEC 与本处比对。
    //
    // RETAIN(随 hardened)+ 描述符 `ready` 整包写完才置位。
    // 🔴 v3.7 订正:原写「回滚 = 删 item 回到现状」已废 —— 删 item 后依赖描述符的路径是 fail-closed;
    //    真回滚靠「不接线」(50 SPEC §1.1)。
    const execEnvs = new dynamodb.Table(this, "bgp-execution-envs", {
      tableName: "bgp-execution-envs",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
    execEnvs.addGlobalSecondaryIndex({
      indexName: "byRegion",
      partitionKey: { name: "region", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // @kf-batch 50-WP9a-durable-jobs —— 数据面长作业(WORK-PACKAGES WP-9 ④-1;52 SPEC §1 `bgp-dataplane-jobs`)。
    //
    // 为什么要一张新表、而不是塞进 bgp-execution-envs:那张表有写点拓扑门禁(并行包 WP-30 正在改),
    //   作业又是高频写(每一步一次条件写)—— 与描述符混住只会让两边的门禁都变难判。
    // pk = jobId(**确定性** sha256:同一件事算出同一个 id ⇒ `attribute_not_exists(jobId)` 让重复入队只有一条)。
    // GSI byDue(dueShard, nextRunAt)🔴 **稀疏**:只有未终态作业带 dueShard ⇒ 推进泵每 15s 一次 Query 就拿到到期的那几条,不 Scan。
    // GSI byTarget(targetId, createdAt):某个执行环境的作业清单(页面 / isolated 前置判据 / WP-30 删除预检的在途数)。
    // TTL 属性 `ttl`:只有可再生的证据类作业(canary,30 天)带;供给作业不带(它是「这个项目的凭证是怎么来的」的记录)。
    // TaskRole 的 bgp-* 通配(home 轴)已覆盖读写与 GSI;清单见 infra/iam/platform-taskrole-calls.json。
    const dataplaneJobs = new dynamodb.Table(this, "bgp-dataplane-jobs", {
      tableName: "bgp-dataplane-jobs",
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });
    dataplaneJobs.addGlobalSecondaryIndex({
      indexName: "byDue",
      partitionKey: { name: "dueShard", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "nextRunAt", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    dataplaneJobs.addGlobalSecondaryIndex({
      indexName: "byTarget",
      partitionKey: { name: "targetId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 模块 50 §3.13(差异化B)— 跨地域**只读元数据镜像**。
    //
    // 🔴 为什么必须自建这张表:AWS **没有跨 region 的全局数据目录** —— Glue Data Catalog 是
    // region 内的、RAM 不跨区、Lake Formation 也不跨区共享目录。所以"一屏看全部 target 的资产"
    // 这件对标产品(含 DataWorks)做不到的事,只能由中央按 target 去它自己的 region 拉元数据、
    // 落这张表,页面读镜像。
    //
    // pk="mirror#<targetId>", sk="<kind>#<fqn>"(kind ∈ db|table|column|lineage-edge,50 SPEC §1.1);
    // 分面汇总另放 pk="mirror#__facets", sk=targetId —— 一次 Query 取回全部 target 的分面,
    // 免得为了"哪些 target 有过镜像"去 Scan 整张表(Scan 的 Filter 在**读之后**才生效 = 每次开页面
    // 把几千条表条目全读一遍还计费)。`__facets` 不是合法 targetId(必须 ^tgt_…$)⇒ 与真分区不可能撞。
    //
    // 🔴 表里**只有元数据**(库名/表名/列名与类型/计数),没有任何行数据或抽样值 ——
    //    §3.13 的边界是「只搬元数据、零数据 egress」,写入侧用白名单**重建** payload 来保证。
    // TTL 属性 `ttl`(epoch 秒,7 天):§3.13 明写"过期即视为 stale,不长期残留"。
    //    读侧**另外自己判 ttl**,因为 DynamoDB 的 TTL 删除最长滞后 48h,过期 item 仍会被 Query 返回。
    new dynamodb.Table(this, "bgp-metadata-mirror", {
      tableName: "bgp-metadata-mirror",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });

    // 模块 43-A — 运维知识库(Incident Memory):诊断沉淀的结构化故障事件,按 signature 归并。
    // 单表两类 item(照 bgp-alert-events 的 pk/sk 分散思路):
    //   · 故障类别主档  pk="incident#<projectId>", sk="sig#<signature>"  — 复发计数/状态/已验证修复手册/首次·最近。**永久沉淀(不写 ttl 属性)**。
    //   · 单次发生记录  pk="incident#<projectId>", sk="occ#<signature>#<ts-iso>#<ulid>" — 每次发生快照(runId/diagnosisId/症状摘要)。写 ttl(epoch 秒)~180 天自动过期。
    // DynamoDB TTL 只删带 ttl 属性的 item,故主档天然永久保留、发生记录到期清理。这是护城河的复利数据资产入口。
    new dynamodb.Table(this, "bgp-incidents", {
      tableName: "bgp-incidents",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
      timeToLiveAttribute: "ttl",
    });
  }
}
