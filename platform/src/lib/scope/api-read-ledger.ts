// @kf-batch 50-WP4quater-reads
/**
 * 🔴🔴 **读取级执行范围台账**(页内每一次取数,不是每一页)。
 *
 * 为什么必须有这一层:页面级棘轮 `NOT_WIRED_LIMIT` 只数**页**,而门禁 `scope-wired-guard` 的判据是
 * 「页面沿 import 图**任一处**读了 `useScope(`」⇒ **只把主列表接上、面板 / 抽屉 / Tab 全不接**
 * 也照样绿。2026-09-10 实测:20 个宣称 `wired: true` 的页里 **18 页**有不带执行范围的取数,
 * 合计 **67 处**。用户当天的原话是「**前面你处理的好几个页面都没做完**」——
 * 页面级绿灯正是那句话的成因。
 *
 * 机制(与 `route-scope.ts` 的页面级棘轮同构,但粒度是「一次取数」):
 *   · 门禁 `page-read-coverage` 自己沿 import 图**重新推导**每页的 `/api` 读取,与本表**逐项相等**比较;
 *   · 新长出一处不带范围的读取 ⇒ 表里没有 ⇒ **红**(想绿只能修好它,或来这里写清为什么合法);
 *   · 修好一处 ⇒ 必须在同一笔提交里删掉它的条目(多留也红);
 *   · `not-wired-yet` 的条数必须**恰好等于** `UNSCOPED_READ_LIMIT`,而这个数字**只许改小**。
 *
 * 🔴 判据只看 **URL 实参**,不看整个调用文本:本仓 `targetId` 被复用成表单字段名
 * (`SlaPanel` 里它指 SLA 绑的任务 id),拿整段调用文本去匹配会把那种页面判成「已带范围」= 假绿。
 */
import type { ScopeTicket } from "./capability";

/** 一处「不带执行范围的读取」为什么可以不带。**封闭枚举** —— 编不出理由 = 它就是欠账。 */
export type UnscopedReadReason =
  /** 全平台只有一份对应物(一个 OpenMetadata / 一个 AgentCore 的技能清单 / 通知渠道出口),按区拆没有对应物。 */
  | "platform-singleton"
  /** 按主键取一行/一批 DDB 行,不打任何区域性 AWS 端点 ⇒ 不需要落点(区维在行上,读它不需要先知道区)。 */
  | "by-id-row-lookup"
  /** 按主键取,且服务端**已从行上的章派生落点**(已逐个核实过服务端代码,不是想当然)。 */
  | "by-id-server-derives"
  /** 这次读取的**用途本身就是跨范围**(「其他范围里还有 N 条」提示;项目发现页要看全平台可申请的项目)。 */
  | "cross-scope-by-design"
  /** 🔴 欠账。必须带工单号,并在 WORK-PACKAGES 的台账里查得到。 */
  | "not-wired-yet";

interface UnscopedReadBase {
  /** 菜单叶 key(与 `MENU_ROUTE_SCOPE` / `EXTRA_ROUTE_SCOPE` 的键一致) */
  page: string;
  /** 发起这次读取的文件(相对 `platform/src`) */
  file: string;
  /** 被读的接口前缀(动态段与查询串已剥掉) */
  api: string;
  /** 一句话说清「为什么它现在不带范围」。🔴 不许同义反复(「待接入」「暂未支持」都不算) */
  note: string;
}

export type UnscopedRead =
  | (UnscopedReadBase & { reason: Exclude<UnscopedReadReason, "not-wired-yet">; ticket?: never })
  | (UnscopedReadBase & { reason: "not-wired-yet"; ticket: ScopeTicket });

/**
 * 🔴 全表。**修好一处就删一条**,新长出一处就必须在这里交代。
 * 顺序按 `page` 排,便于和门禁的推导结果对照。
 */
export const UNSCOPED_READS: readonly UnscopedRead[] = [
  // ── 首页 ────────────────────────────────────────────────────────────
  // ── 告警中心 ────────────────────────────────────────────────────────
  {
    page: "/alerting", file: "app/alerting/page.tsx", api: "/api/alerting/channels",
    reason: "platform-singleton",
    note: "通知渠道是**告警的出口**(Slack / Webhook / 邮件),不属于任何执行区;按区拆出来没有对应物",
  },
  {
    page: "/alerting", file: "components/alerting/SlaPanel.tsx", api: "/api/alerting/channels",
    reason: "platform-singleton",
    note: "同上:SLA 通知走同一批平台级渠道",
  },
  // ── 补数 ────────────────────────────────────────────────────────────
  {
    page: "/backfill", file: "app/backfill/page.tsx", api: "/api/backfill",
    reason: "by-id-row-lookup",
    note: "按 planId 取补数计划详情:纯 DDB 取行,不打区域性端点(计划行上已有绑定章,列表侧已按范围过滤)",
  },
  {
    // @kf-batch 50-SEQ47b-backfill-observability —— 补数实例抽屉「查看运行日志」复用监控页同一个弹窗
    page: "/backfill", file: "components/monitor/RunLogModal.tsx", api: "/api/monitor/tasks",
    reason: "by-id-server-derives",
    note: "按 (taskId, runId) 取补数实例底层那条 run 的日志:服务端按 run 行上的章解落点,解析不到回 409 说清原因(与监控页同一条路、同一个作者)",
  },
  // ── 报表搭建器 ──────────────────────────────────────────────────────
  {
    page: "/bi", file: "components/bi/AnalysisWorkbench.tsx", api: "/api/bi/reports",
    reason: "cross-scope-by-design",
    note: "画布里「导入已有报表」的候选清单:把**别区**的报表放进当前看板是合法用法(一张仪表盘可以并排放不同区的图,SPEC §8.3)⇒ 刻意不按范围筛,而是在每个候选后面标出它取哪个区的数;看板**列表**侧另有一个默认关的按区过滤开关(SC-28 定案:增加过滤能力、默认不过滤)",
  },
  // ── Copilot 计划中心 ────────────────────────────────────────────────
  {
    page: "/copilot/plans", file: "app/copilot/plans/page.tsx", api: "/api/copilot/plan",
    reason: "by-id-row-lookup",
    note: "按 planId 取计划详情与步骤:pk=copilot#<projectId> 的纯 DDB Query,不打区域性端点(列表侧已按 ?scope= 过滤,计划行上有 targets[] 章)",
  },
  {
    page: "/copilot/plans", file: "app/copilot/plans/page.tsx", api: "/api/copilot/plan/task",
    reason: "by-id-row-lookup",
    note: "按 taskId 轮询异步规划任务的状态:纯 DDB 取行(落点在提交规划时随 body.targetId 定下并落在任务行上)",
  },
  {
    page: "/copilot/plans", file: "components/copilot/RecipeLibrary.tsx", api: "/api/copilot/recipes",
    reason: "platform-singleton",
    note: "配方库(cookbook)是**全平台一份**的知识:同一条「Glue 写 Redshift 别踩这三个坑」在每个区都成立,按区拆出来只会让同一条配方维护 N 份并各自漂移",
  },
  // ── 数据源 ──────────────────────────────────────────────────────────
  {
    page: "/datasources", file: "app/datasources/page.tsx", api: "/api/datasources",
    reason: "by-id-server-derives",
    note: "按 datasourceId 浏览库表:凭证客户端按 **secret ARN 里的 region** 建(ARN 自带 region,是单一真值源);AWS 原生源(DDB / S3 / MSK / Kinesis)的 region 从行上的连接袋取;JDBC 是直连 host:port。SC-31 修的就是这里原来那个模块级主控区 Secrets Manager 客户端",
  },
  // ── 离线作业 ────────────────────────────────────────────────────────
  {
    page: "/etl-jobs", file: "app/etl-jobs/page.tsx", api: "/api/etl-jobs",
    reason: "by-id-server-derives",
    note: "按 jobId 取详情 / 运行 / 日志 / 调度:服务端已用 run 行上的 targetId 解出 region 再建 Glue 与 CloudWatch 客户端(见 api/etl-jobs/[id]/logs)",
  },
  {
    page: "/etl-jobs", file: "components/common/DiagnosisButton.tsx", api: "/api/diagnostics",
    reason: "by-id-row-lookup",
    note: "按 diagnosisId 取一行诊断结果:纯 DDB 取行",
  },
  {
    page: "/etl-jobs", file: "components/common/VersionHistoryDrawer.tsx", api: "/api/versions",
    reason: "by-id-row-lookup",
    note: "按 (type, id) 取某个对象的配置版本历史:版本随对象走,纯 DDB 取行",
  },
  {
    // @kf-batch 50-SEQ47a-promote-ux
    page: "/etl-jobs", file: "components/common/EnvPromotionStatus.tsx", api: "/api/promote/lineage",
    reason: "by-id-row-lookup",
    note: "按 (type, id) 取同一个对象在 dev / staging / prod 的三份与待批准审批:环境维在行上、按 lineageId 取行,纯 DDB,不打任何区域端点;同一组件也挂在编排 / EMR / 同步详情",
  },
  {
    // @kf-batch 50-WP5-rungroup
    page: "/etl-jobs", file: "components/monitor/RunGroupPanel.tsx", api: "/api/run-groups",
    reason: "cross-scope-by-design",
    note: "「联动运行」这个对象**本身就是跨执行范围的**(一次点击在 N 个区各跑一次 = 一个组);按当前范围过滤会把它**截掉一半** —— 那正是 WP-19 GC-9 修掉的「列表按范围截肢」同一个坑(计数器说 97 张而列表只有 3 张)。读法是按 runGroupId 取一行 + 按 taskId Query 子 run(纯 DDB);要打区域性端点的只有「取消」,而那条路径按**每条 run 自己的 targetId** 建客户端(lib/monitor/run-cancel.ts,判据 E-163 钉死)",
  },
  {
    page: "/etl-jobs", file: "components/engines/EmrJobPanel.tsx", api: "/api/engines",
    reason: "by-id-server-derives",
    note: "按 jobId 取 EMR 引擎作业的运行与日志:运行列表是纯 DDB Query,日志侧服务端已用 run 行上的 targetId 解出 region(api/engines/[engine]/[id]/logs 第 35 行)",
  },
  // ── 成本治理 FinOps ────────────────────────────────────────────────
  {
    page: "/finops", file: "components/finops/BudgetTab.tsx", api: "/api/alerting/channels",
    reason: "platform-singleton",
    note: "预算告警走同一批平台级通知渠道",
  },
  {
    page: "/finops", file: "components/finops/TaskCostTab.tsx", api: "/api/finops/tasks",
    reason: "by-id-row-lookup",
    note: "按 taskId 取该任务的成本明细:run 级成本行上已有 targetId,列表侧已按范围过滤;明细每行回带 effectiveTargetId,前端按排行那一行的执行环境等值筛(WP-6)",
  },
  // ── 智能问数 ────────────────────────────────────────────────────────
  {
    page: "/genbi", file: "app/genbi/page.tsx", api: "/api/genbi/tasks",
    reason: "by-id-row-lookup",
    note: "按 taskId 轮询异步问数结果:纯 DDB 取行(落点已在提问时随 body.targetId 定下并盖在行上)",
  },
  // @kf-batch 54-genbi-session-cards
  {
    page: "/genbi", file: "app/genbi/page.tsx", api: "/api/genbi/cards",
    reason: "by-id-server-derives",
    note:
      "按 cardId 打开一张会话卡片(GET /api/genbi/cards/<id>)—— **单张按主键取,不是集合**,所以不需要 " +
      "`?scope=`;而它确实要落点(正文在该卡片自己的区域),那个落点由**服务端从行上的章派生**:" +
      "`cards-service.openCard()` 读指针 → `getTargetRaw(pointer.targetId)` → 从该 target 的 " +
      "`datalakeBucket` 读正文,页面一个字都不参与。🔴 已逐行核实服务端代码(不是想当然):" +
      "openCard 刻意用 `getTargetRaw` 而不是 `requireReadyTarget` —— 「能不能看」≠「能不能承接」。" +
      "**卡片列表**(集合)那一处是带 `?scope=` 的,在 components/genbi/SessionCards.tsx 里,不在本表。",
  },
  // @kf-batch 50-WP28-platform-action-node(WP-29 问数)
  {
    page: "/genbi", file: "components/genbi/SessionCards.tsx", api: "/api/genbi/cards",
    reason: "by-id-row-lookup",
    note:
      "按 cardId 取一张卡的**刷新历史**(GET /api/genbi/cards/<id>/runs):单张按主键取,读的是 run 台账里 " +
      "taskId = gcard_<cardId> 的行(纯 DDB Query,只回时间 / 状态 / 行数等非数据字段),不打任何区域性端点。" +
      "卡片列表与「我的卡片定时」两处集合读取都带 `?scope=`(同一个阅读镜头)。",
  },
  // ── 治理工作台(数据目录) ──────────────────────────────────────────
  {
    page: "/governance", file: "app/governance/page.tsx", api: "/api/governance/columns",
    reason: "by-id-server-derives",
    note: "列清单是**纯 OM 读**:区维在 fqn 自带的 OM **service 名**里(用户 2026-09-10 拍板「一个 OpenMetadata,哪个区 = service 维度」)⇒ 目录行给的 fqn 本身就是区限定的,再传一个 `?scope=` 服务端也无处可用(传了就是白传)",
  },
  {
    page: "/governance", file: "app/governance/page.tsx", api: "/api/governance/quality",
    reason: "by-id-server-derives",
    note: "质量总览同上:数据来自 OM 的 testCases / profiles,按 OM service 天然分区;平台自己那三张 DDB 表(规则 / 结果 / 分类)已改成按区分区键",
  },
  {
    page: "/governance", file: "app/governance/page.tsx", api: "/api/governance/sensitive-scan",
    reason: "by-id-row-lookup",
    note: "按 scanId 取一次扫描的结果:纯 DDB 取行(发起扫描的落点在启动时已定)",
  },
  {
    page: "/governance", file: "components/governance/CrossTargetMirrorOverview.tsx", api: "/api/metadata-mirror",
    reason: "cross-scope-by-design",
    note: "这块卡本身就是**跨地域只读元数据总览**:它的用途是把各区的镜像并排看,按当前范围过滤等于把它的功能删掉",
  },
  // ── 运维知识库 ──────────────────────────────────────────────────────
  {
    page: "/incidents", file: "app/incidents/page.tsx", api: "/api/incidents",
    reason: "by-id-row-lookup",
    note: "按 signature 取一个故障类别的详情与发生时间线:pk=incident#<projectId> 的纯 DDB Query,不打区域性端点(列表与健康度两处都已按 ?scope= 过滤,主档上有 targets[] 章)",
  },
  // ── 建模治理 ────────────────────────────────────────────────────────
  {
    page: "/modeling", file: "app/modeling/page.tsx", api: "/api/modeling/dimensions",
    reason: "by-id-row-lookup",
    note: "按 modelTableId 取该维度表的 DDL 预览:纯 DDB 取行 + 纯文本渲染,不打区域性端点",
  },
  // ── 任务监控 ────────────────────────────────────────────────────────
  {
    // @kf-batch 50-SEQ47b-backfill-observability —— 「运行日志」弹窗抽成唯一作者 components/monitor/RunLogModal.tsx(监控页与补数页同用),读取随之搬家
    page: "/monitor", file: "components/monitor/RunLogModal.tsx", api: "/api/monitor/tasks",
    reason: "by-id-server-derives",
    note: "按 taskId 取运行日志:服务端已按 run 行上的 targetId 解出落点(S3 日志桶 + CloudWatch 都按那个区建),解析不到**回 409 并说清原因**而不是回落主控区取一份空日志 —— SC-34 修的就是这一点",
  },
  {
    page: "/monitor", file: "components/common/DiagnosisButton.tsx", api: "/api/diagnostics",
    reason: "by-id-row-lookup",
    note: "按 diagnosisId 取一行诊断结果:纯 DDB 取行",
  },
  {
    page: "/monitor", file: "components/monitor/SchedulePanel.tsx", api: "/api/sync",
    reason: "by-id-row-lookup",
    note: "按 taskId 取运行记录:纯 DDB Query(同面板的两条**列表**请求已按范围过滤)",
  },
  // ── 实时计算 ────────────────────────────────────────────────────────
  {
    page: "/realtime-compute", file: "app/realtime-compute/page.tsx", api: "/api/flink/connectors",
    reason: "platform-singleton",
    note: "用户上传的自定义 sink 连接器 JAR **全平台一份**(规范副本在主控区代码桶):启动时由 assembleUberJar 从主控区读源、把合并结果写进作业所在区的桶 ⇒ 用户不必按区各上传一遍",
  },
  {
    page: "/realtime-compute", file: "app/realtime-compute/page.tsx", api: "/api/flink/jobs",
    reason: "by-id-server-derives",
    note: "按 jobId 取详情 / 状态 / 日志 / 结果:服务端一律用 `flinkJobTarget(job)` 从行上的 targets[] 解出落点再建 MSAF / S3 / CloudWatch 客户端(列表侧已按 ?scope= 过滤)",
  },
  // ── 元数据 / 大屏 / 项目 / 数仓 / 技能 ─────────────────────────────
  {
    page: "/openmetadata", file: "app/openmetadata/page.tsx", api: "/api/openmetadata/url",
    reason: "platform-singleton",
    note: "全平台只有一个 OpenMetadata 实例(用户 2026-09-10 拍板),它的入口地址不随区变;「哪个区」体现在 service 名上,那部分本页已按区列出",
  },
  {
    page: "/projects", file: "app/projects/page.tsx", api: "/api/approvals",
    reason: "cross-scope-by-design",
    note: "本页有两处调用,语义不同:**审批收件箱**已按执行范围筛(带区的 deploy 类才筛,入组 / 数据访问不藏,且回 `hiddenByScope` 让被藏的条数看得见);**项目抽屉里那个项目自己的待审清单**刻意不筛 —— 按区筛会让项目 owner 看不全自己项目的待审,而那正是他打开抽屉要做的事",
  },
  {
    page: "/projects", file: "app/projects/page.tsx", api: "/api/projects",
    reason: "cross-scope-by-design",
    note: "发现页(申请加入)刻意跨范围:它要回答的是「全平台有哪些项目可申请」;项目主列表已按范围过滤",
  },
  // ── 平台设置 ────────────────────────────────────────────────────────
  {
    page: "/settings", file: "app/settings/page.tsx", api: "/api/datasources",
    reason: "platform-singleton",
    note: "这里不展示数据源,只把它当**控制面 DynamoDB 可达性探针**(只看 HTTP 是否 200);控制面表全平台一套,不随区变",
  },
  {
    page: "/settings", file: "app/settings/page.tsx", api: "/api/admin/pending-cleanups",
    reason: "cross-scope-by-design",
    note: "序 58 B-130 后台清理任务清单:人要看的是**全平台所有执行环境**里还没清掉 / 需人工的平台安全组,按区拆开反而漏看;服务端按注册表逐区取作业表,每条带 region",
  },
  {
    page: "/settings", file: "app/settings/page.tsx", api: "/api/admin/datasource-network-objects",
    reason: "cross-scope-by-design",
    note: "序 61 B-133 数据源网络对象清单:人要看的是**全平台所有执行环境**里平台自建的安全组各归谁 / 在不在用 / 是不是真孤儿,按区拆开正是误删事故的温床;服务端按注册表逐区 Describe,每条带 region / targetId",
  },
  {
    page: "/settings", file: "app/settings/page.tsx", api: "/api/system/wiring",
    reason: "platform-singleton",
    note: "AI 接线自检:探的是那一个 OpenMetadata 与那一个 AgentCore 是否接通(两者全平台各一份),没有按区拆的对应物",
  },
  {
    page: "/settings", file: "components/settings/AiModelCard.tsx", api: "/api/admin/model-config",
    reason: "not-wired-yet", ticket: "SC-25",
    note: "🔴 **只剩「按区分别设默认模型」这一半**:模型设置的作用域模型(`settingScope`)一期只有 `global`,per-region 覆盖(`settingScope=<targetId>#global`)是 **51 WP-8 / P51.3** 的设计决定 —— 50 这一刀不越权替它拍板。读侧已做实:模型**目录**按区取(`us.` 跨区推理配置在非美国区调不通),界面上标出清单属于哪个区、并说清保存的是全平台默认",
  },
  {
    page: "/skills", file: "app/skills/page.tsx", api: "/api/genbi/skills",
    reason: "platform-singleton",
    note: "全平台只有一个 AgentCore,技能**清单与定义**是同一份(用户 2026-09-10 拍板);按区变化的是**用量与报错**,那部分本页已按区取",
  },
];

/**
 * 🔴🔴 **读取级棘轮**:上表里 `not-wired-yet` 的条数。**只许改小。**
 *
 * 开工基线 **31**(2026-09-10 推导:去重成 **51** 条,其中 **31** 条是真欠账、20 条有封闭理由)。
 * 🔴 这个基线比我人工侦察出的数大 —— 门禁自己重新推导时多抓到 `/settings` 4 处与 EmrJobPanel 1 处,
 * 而我的侦察脚本因为正则解析漏了 `/settings` 那条登记。**以门禁的推导为准,不以我的清单为准。**
 * · 新长出一处欠账 ⇒ 实数 > 本数 ⇒ 门禁红;
 * · 修好一处 ⇒ 同一笔提交里把本数减 1(门禁断言**恰好相等**,多减也红)。
 */
export const UNSCOPED_READ_LIMIT = 1;
