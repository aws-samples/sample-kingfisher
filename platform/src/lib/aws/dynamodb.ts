// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = sdkClient("control-plane", DynamoDBClient, { region: homeRegion() });
// removeUndefinedValues: optional fields (e.g. approval note, member email/sub) may be
// undefined; drop them rather than throwing a marshalling error. Purely additive — DynamoDB
// cannot store undefined anyway, so this never changes the value of a defined attribute.
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLES = {
  // 模块 50 G1 — 执行目标(ExecutionTarget)注册表。pk="env", sk=targetId(不可变身份)。
  // 🔴 G1 阶段只有 lib/exec-env/registry.ts 读写它,没有既有调用方改道 ⇒ 上线对现网行为影响为 0。
  EXECUTION_ENVS: process.env.EXECUTION_ENVS_TABLE || "bgp-execution-envs",
  DATASOURCES: "bgp-datasources",
  SYNC_TASKS: "bgp-sync-tasks",
  WORKFLOWS: "bgp-workflows",
  REDSHIFT_TASKS: "bgp-redshift-tasks",
  TASK_RUNS: "bgp-task-runs",
  AUDIT: "bgp-audit",
  // @kf-batch 50-W5-seg1-WP10a:免责告知同意留存(SPEC v3.22 §1.3a S13;只追加,TaskRole Deny Update/Delete;建表随第二段 database-stack)
  RESIDENCY_ACKS: "bgp-residency-acks",
  GENBI_HISTORY: "bgp-genbi-history",
  // @kf-batch 54-genbi-session-cards —— 问数「会话卡片」的**中央指针 + 每人配额**(54 DESIGN v1.1 §4.1)。
  // pk=userSub, sk="card#<cardId>" | "quota#";GSI byConversation(userSub, conversationId)= 幂等键。
  // 🔴 本表**只存非数据值**:结果行 / SQL / answer / 推理步骤一律在**该 target 本区**的 S3(§3.1)——
  //    卡片是平台第一个持久化查询结果行的功能,把正文放中央就等于把别法域的数据搬进主控区。
  //    判据 GC-7 会扫本表断言那些字段一个都不存在。
  GENBI_CARDS: "bgp-genbi-cards",
  // @kf-batch 50-WP5-rungroup —— 模块 50 O2:多区联动运行的持久父对象(50 SPEC v3.44 §1.3a S7)。
  // pk=runGroupId(`rg_<ULID>` 手动扇出 / `rgs_<24hex>` 定时确定性键);GSI byDefinition(definitionId, createdAt)。
  // 🔴 行里的 `status` 是**物化投影**,真值源永远是子 run 行(读时 `deriveGroupStatus()` 派生 + 对账写回)。
  RUN_GROUPS: "bgp-run-groups",
  ETL_JOBS: "bgp-etl-jobs",
  // 模块 13 — 多租户/项目空间/RBAC/审批 (v1.4.0)
  PROJECTS: "bgp-projects",
  PROJECT_MEMBERS: "bgp-project-members",
  APPROVALS: "bgp-approvals",
  // 模块 14 — 资源版本管理与回滚 (v1.5.0)
  RESOURCE_VERSIONS: "bgp-resource-versions",
  // 模块 18 — 数据分级分类 + 字段脱敏 + 权限申请 (v1.9.0)
  DATA_CLASSIFICATION: "bgp-data-classification",
  DATA_GRANTS: "bgp-data-grants",
  // 模块 19 — 数据质量规则模板 + 评分 + SLA (v1.10.0)
  QUALITY_RULES: "bgp-quality-rules",
  QUALITY_RESULTS: "bgp-quality-results",
  // 模块 20 — 指标中台 / Metrics Store (v1.11.0)
  METRICS: "bgp-metrics",
  METRIC_VALUES: "bgp-metric-values",
  // 模块 22 — 智能问数→需求→研发交付流水线 (v1.14.0)
  REQUIREMENTS: "bgp-requirements",
  // 模块 25 — 故障诊断 / AWS DevOps Agent (v1.22.0)
  DIAGNOSTICS: "bgp-diagnostics",
  // 模块 26 — GenBI on AgentCore：对话短期记忆（当前对话上下文，TTL ~24h）
  GENBI_TURNS: "bgp-genbi-turns",
  // 模块 26 — 业务知识/口径/规则库（lookup_business_context 技能 + 管理 UI）
  GENBI_CONTEXT: "bgp-genbi-context",
  // 模块 26 — 数据驱动工具型 skill 注册表（run_registered_skill / list_registered_skills）
  GENBI_SKILLS: "bgp-genbi-skills",
  // @kf-batch 50-W5-seg2-WP1 — 模块 30 数据服务已于 2026-09-05 下线(50 SPEC §3.9c):它的三张表 infra 保留(RETAIN,删表另过破坏性变更门),
  //   平台代码不再认识它们(常量已删;登记见 platform/naming.json notCovered.retired;门禁 lib/__tests__/data-service-retired.test.ts)。
  // 模块 35 — 数仓建模:数据分层 / 数据域(主题域)/ 数据标准 / 码表 / 建模资产归属。
  DATA_LAYERS: "bgp-data-layers",
  DATA_DOMAINS: "bgp-data-domains",
  DATA_STANDARDS: "bgp-data-standards",
  CODE_TABLES: "bgp-code-tables",
  MODEL_ASSETS: "bgp-model-assets",
  // 模块 35 P1 — 数仓建模深化:D3 维度/事实表登记 / D4 指标体系(原子/派生)。
  MODEL_TABLES: "bgp-model-tables",
  MODEL_METRICS: "bgp-model-metrics",
  // 模块 32 — 实时计算 Flink:Flink SQL 流作业(每作业一个 MSAF 应用)。
  FLINK_JOBS: "bgp-flink-jobs",
  // 模块 32 — 自定义连接器注册表(用户上传的 sink 连接器 JAR 元数据)。
  FLINK_CONNECTORS: "bgp-flink-connectors",
  // 网络连通性智能顾问 — 多轮对话短期记忆(当前会话上下文,TTL ~24h)。
  NETWORK_ADVISOR_TURNS: "bgp-network-advisor-turns",
  // 参数辅助智能顾问 — 多轮对话短期记忆(结构同上,TTL ~24h)。
  PARAM_ADVISOR_TURNS: "bgp-param-advisor-turns",
  // 模块 33-A — 离线多引擎:EMR Serverless 作业定义(独立表,不污染 bgp-etl-jobs)。pk=userId, sk=jobId。
  ENGINE_JOBS: "bgp-engine-jobs",
  // 模块 34 — 智能运维/统一告警中心。告警规则/通知通道/告警事件流(三表,均低频低量配置数据)。
  ALERT_RULES: "bgp-alert-rules",
  ALERT_CHANNELS: "bgp-alert-channels",
  ALERT_EVENTS: "bgp-alert-events",
  // 模块 36 — 治理深化(E5)。敏感数据识别扫描的运行记录/建议(findings)。pk=scanId(ULID),
  // sk="finding#<fqn>#<column>" 或 "__summary__"。**只存元数据(列名/类型/检测器/命中率/置信度),
  // 绝不存抽样到的敏感值本身**。TTL 90 天自动清理。
  SENSITIVE_FINDINGS: "bgp-sensitive-findings",
  // @kf-batch 50-WP28-platform-action-node —— 「按时跑一次平台动作」的两张表:
  //   · ACTION_COMMANDS = 传声筒(DAG 投 pending → 主控区 Lambda 经 Streams 消费 → 平台内部端点执行 → 写终态;TTL 7 天)。
  //     建在 infra `lib/action-dispatch.ts`(与消费端同一个构件:Streams ARN 不必跨栈导出)。
  //   · ACTION_SCHEDULES = 平台动作的**调度对象**(治理定时任务 / 问数卡片定时刷新)。pk=userId("default-user"),sk=taskId。
  //     发布台账 `deployments[targetId]` 落在这一行(CarrierLedger),run 台账 taskId 就是它的 taskId。
  ACTION_COMMANDS: process.env.ACTION_COMMANDS_TABLE || "bgp-action-commands",
  ACTION_SCHEDULES: "bgp-action-schedules",
  // @kf-batch 50-WP9a-durable-jobs —— 数据面长作业(凭证供给 / permission canary / 9b 起的盘点与搬迁)。
  //   pk=jobId(确定性 sha256);稀疏 GSI byDue(dueShard, nextRunAt)= 泵取「到期且未终态」的作业;
  //   GSI byTarget(targetId, createdAt)= 某个执行环境的作业清单。说明见 lib/dataplane-jobs/schema.ts。
  DATAPLANE_JOBS: process.env.DATAPLANE_JOBS_TABLE || "bgp-dataplane-jobs",
  // 模块 38 — GenBI 异步化执行:一次问数任务(提交→轮询→取结果)。pk=taskId(ULID)。
  // status/result/error/heartbeatAt/startedAt/finishedAt/ttl(7d)。IAM 走 bgp-* 通配已覆盖。
  GENBI_TASKS: "bgp-genbi-tasks",
  // 模块 37 — BI 报表/仪表盘搭建器(F3)。项目级共享资产,pk=projectId 键式隔离,内嵌 version 乐观锁。
  BI_REPORTS: "bgp-bi-reports",
  BI_DASHBOARDS: "bgp-bi-dashboards",
  // v4 分析看板(QuickSight 式:一个画布 N 个视觉对象 + 绑字段·作用域筛选器)。纯新增,旧两表保留。
  BI_ANALYSES: "bgp-bi-analyses",
  // 模块 43-B — 智能基线学习:每任务时长/准点/成功率基线快照。pk="baseline#<projectId>", sk=taskId。
  BASELINES: "bgp-baselines",
  // 模块 43-B — SLA 定义 + 最近预测态。pk="sla#<projectId>", sk=slaId(ULID),内嵌 version 乐观锁。
  SLAS: "bgp-slas",
  // 模块 43-C — 生产级补数据:补数计划(参数+聚合进度+状态机+version)。pk="backfill#<projectId>", sk=planId(ULID)。
  BACKFILL_PLANS: "bgp-backfill-plans",
  // 模块 43-C — 补数实例:每个(日期,节点)一行。pk=planId, sk="<date>#<nodeId>"。TTL 90d。幂等去重键=planId#sk。
  BACKFILL_INSTANCES: "bgp-backfill-instances",
  // 模块 43-A — 运维知识库(Incident Memory)。诊断沉淀的结构化故障,按 signature 归并。单表两类 item:
  // 主档 pk="incident#<projectId>", sk="sig#<signature>"(永久,不写 ttl);发生记录 sk="occ#<sig>#<ts>#<ulid>"(ttl 180d)。
  INCIDENTS: "bgp-incidents",
  // 模块 44 — Copilot 规划-执行引擎:执行计划主档(诉求+聚合进度+状态机+version+autoExecute)。
  // pk="copilot#<projectId>", sk=planId(ULID)。复用补数 plan/tick/reconcile 内核,泛化为异构步骤。
  COPILOT_PLANS: "bgp-copilot-plans",
  // 模块 44 — Copilot 执行计划的每个异构步骤一行(泛化补数实例)。pk=planId, sk=stepId(序号/ULID)。
  // 存 stepType/status/dependsOn/params/execHint/runToken 等。TTL 90d。IAM 走 bgp-* 通配已覆盖。
  COPILOT_STEPS: "bgp-copilot-steps",
  // 模块 44 — Copilot 规划大脑异步任务(照 bgp-genbi-tasks)。pk=taskId(ULID)。规划重推理>60s墙→异步:
  // 提交建pending返taskId,后台跑planner,前端轮询。status/result(planId)/runToken/heartbeatAt/ttl(7d)。
  COPILOT_PLAN_TASKS: "bgp-copilot-plan-tasks",
  // 模块 55 / 序 50 — 长操作统一框架的任务表(替 序 46 B-107 的 bgp-ai-tasks;B-107 未发版零迁移)。pk=taskId(ULID)。
  // 任何会等外部系统到终态的路由(AI 七种 / 建模落地 · 应用 · 解绑 · 预览 / 目录建表 · 改表 · 读列 / 审批执行 DDL …)共用:
  // 进程内等 45s 未终态 ⇒ 202(协议 long-op/1)+ GET /api/long-ops/[taskId] 轮询。kind/params/userId/status/result/resultStatus/
  // meta/error/errorStatus/errorBody/runToken/heartbeatAt/ttl(7d)。唯一作者 lib/long-ops/store.ts。IAM 走 bgp-* 通配。
  LONG_OPS: "bgp-long-ops",
  // 模块 44 — Copilot 工程配方库【管理员动态扩展】(系统配方代码内嵌只读;这里存管理员新增的企业特有范式)。
  // pk="recipe#<engine>", sk=recipeId(ULID)。仅 isPlatformAdmin 可写,全局只读(所有项目共享标准范式)。
  COPILOT_RECIPES: "bgp-copilot-recipes",
  // S0(模块 50 SPEC §0/§3.7)— 查询句柄:修「凭 statementId 即可读他人查询结果」的越权。
  // pk=handleId(ULID,**必须是 PK**——按 statementId 建键就等于没修)。属性 statementId/ownerSub/
  // projectId/engine/expiresAt;TTL 属性 `ttl`(epoch 秒,36h)让过期句柄自动清理。
  QUERY_HANDLES: "bgp-query-handles",
  // 平台运行时配置(pk="system", sk="<域>#<键>")。S0 先用它存 handle 校验的回滚开关
  // (sk="security#query-handle");模块 51 的模型配置(sk="ai-model#*")复用同表同键式。
  // 🔴 表开了 TTL 属性 `ttl`,但**配置主档绝不写 ttl**(误带即静默消失);仅限频计数类才带。
  // env 覆盖(SETTINGS_TABLE)照房内 COPILOT_TURNS_TABLE 先例,供非生产注坏表做韧性验收。
  SETTINGS: process.env.SETTINGS_TABLE || "bgp-settings",
  // 模块 50 §3.13(差异化B)— 跨地域**只读元数据镜像**。AWS 没有跨 region 的全局数据目录
  // (Glue Catalog 是 region 内的、RAM 不跨区)⇒ 一屏看全部 target 只能自建镜像。
  // pk="mirror#<targetId>", sk="<kind>#<fqn>"(kind ∈ db|table|column|lineage-edge);
  // 分面索引另放 pk="mirror#__facets", sk=targetId(一次 Query 取全,免 Scan 整表)。
  // 🔴 **只存元数据**(库名/表名/列名/类型/计数),绝不存行数据或抽样值 ——
  //    写入侧由 `metadata-mirror.ts` 的 `sanitize*` **重建**对象保证(白名单,不是过滤)。
  // TTL 属性 `ttl`(epoch 秒,7d);读侧**自己判 ttl**,不信 DDB 懒删(最长 48h 才真删)。
  METADATA_MIRROR: "bgp-metadata-mirror",
} as const;

// GSI on bgp-project-members for "my projects" lookups (pk=username).
export const PROJECT_MEMBERS_BY_USER_INDEX = "byUser";
