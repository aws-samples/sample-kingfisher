// O1 —— 菜单叶子的「执行范围能力」**数据**(合同 SPEC v3.35 §2.6.7;矩阵 INTERACTION §9.6 表 A)。
//
// ── 为什么单独一个纯 .ts 文件,而不是写在 routes.tsx 的每个叶子上 ────────────────────
// ① 本仓的 vitest 是 `environment: node` 且**刻意不处理 JSX**(只跑纯逻辑层)⇒ 门禁测试
//    没法 import `routes.tsx`。能力登记表是**必须被门禁逐条核对**的东西,所以它得住在纯 .ts 里。
// ② A4(编译期堵死)一点没丢:`routes.tsx` 的 `Leaf.key` 类型就是本表的 `keyof` ——
//    菜单里加一页而这里没登记,**`tsc` 直接红**;这里登记了菜单里没有,门禁红。
//
// 🔴 取值理由逐条写在 INTERACTION §9.6 表 A,别在这里重复一遍(一处定义)。
//
// ── —— 🔴🔴 2026-09-10 用户拍板后的重做 ──────────────────
// 用户原话:「这些都有问题,你都必须要覆盖到,我不想再说第二次」,**两句横幅都被否**。
// ⇒ 本表改用判别联合(见 `capability.ts` 文件头):没接入的必须写**工单号 + 差什么**,
//   声明全局的必须写**登记过的理由码 + 按区的东西去哪看**。
// 🔴 连带结果:原先 7 页靠「此页属于全局控制平面」一句话豁免掉的(计划中心 / 业务口径 / 运维大屏 /
//   运维知识库 / 项目空间 / 系统设置 / 技能),**逐条对不上任何一条理由码** ⇒ 现在如实落进
//   `wired: false` 名单。所以未接入条数从 15 涨到 22 —— 这不是退步,是**把 7 处伪全局翻出来记账**。

import type { ScopeDecl } from "./capability";

export const MENU_ROUTE_SCOPE = {
  // 首页六块统计各查一张表(数据源 / 离线 / 同步 / 编排 / run / 建模指标)⇒ 透传即可,不欠数据维
  // (批次 A)—— 六块统计逐个带 `?scope=`(数据源 / 同步 / 编排 /
  // 离线 / 引擎作业 / run),并常驻护栏 1 提示条。「核心业务指标」刻意不带:它是平台级定义。
  "/": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "资源计数、运行态势与近期运行已按执行范围;「核心业务指标」是平台级指标定义(与建模页「指标」同一物),本身不分区",
    },
  },
  // 🔴 原为 global-only。计划中心生成的是**离线作业 / 同步任务 / 编排**,它们各自落在具体的区
  // ⇒ 计划本身必须带「打算配置到哪些区」,不然「一次配置多区」在计划这一层就断了。
  // 已接入:计划行加 `targets[]`(面向哪个区),
  // 列表按范围过滤;🔴 顺带修了一个更要紧的洞 —— `create-service.ts` 的三个 createXxxDraft
  // **绕过了平台的落点作者**(`bindingForNewSyncTask` / 新建路由的落点校验)⇒ Copilot 建出来的
  // 草稿一个章都没有、读侧全归主控区,用户在 usw2 视角下让 Copilot 建的任务**在他列表里看不见**。
  // 这与记忆里「planner 是唯一绕过环境注入的路径」是同一个模式的第二次现形。
  "/copilot/plans": { scope: "global-and-target", wired: true },
  // 阶段 1 已接入(A 类标量 `ownerTargetId` 下推 DDB;
  // 🔴 一期建源只在主控区 ⇒ 非 home 视角必然空,空态由 ScopeEmptyHint 说清「主控区有 N 个」)
  "/datasources": { scope: "global-and-target", wired: true },
  // (批次 A)—— 读侧已真过滤:列表过 `?scope=`,三级回落归主控区
  // (存量任务**确实**只在主控区跑过);新建行由 `bindingForNewSyncTask` 从数据源落点盖章;
  // 🔴 执行侧另有 `assertDefinitionRunsHere` 反向卡 ⇒ 章与真跑的区不可能分叉。
  // 逐区执行下推(源可达性 + 各区 Glue/DMS)仍是,页面上由说明条与空态如实讲清。
  "/sync": { scope: "global-and-target", wired: true },
  // 已接入(ETL 与 EMR 引擎作业同页混排,两条 API 都过 scope)
  "/etl-jobs": { scope: "global-and-target", wired: true },
  // (批次 A)—— 读侧已真过滤;发布逐区扇出 =(页面说明条讲清)
  "/workflow": { scope: "global-and-target", wired: true },
  // 左侧库表树按**编辑器自己的执行目标**取(`?targetId=`),
  // 多区并行结果仍走 §4septies 的多 sheet;该区未装数仓 ⇒ 树位置说清原因
  "/redshift": { scope: "global-and-target", wired: true, scopeCompare: true },
  // (批次 B)—— 数据湖侧按区:`resolveAthenaPlace`(region + 工作组 +
  // 结果桶)与 `resolveS3TablesPlace`(表桶 + 联邦目录引用)两个落点解析器;🔴 取状态 / 取结果 /
  // 取消都带上落点(QueryExecutionId 只在它自己的 region 存在,打错区的症状是「状态永远查不到」);
  // 🔴 顺手关掉一个真缺口:问数的数据湖引擎原来对非主控区 `assertHomeOnly` 直接抛 ⇒ 现在真能跑。
  "/athena": { scope: "global-and-target", wired: true },
  // 已接入。用户 2026-09-10:「一定要加这个维度,不然白干了,
  // 所有任务都在自己的区域跑,不然没有意义。」落地的是**执行下推**,不只是读侧过滤:
  //   · 作业行加 `targets[]`,新建时默认落顶栏视角那个区,服务端**当场真解析一遍**落点(缺 flink 组件 /
  //     角色不是本 target 的 / 桶缺项 ⇒ 400 可修),不先存下来等启动时才炸;
  //   · `flink-service` 落点化:原来 6 个模块级主控区客户端全删,MSAF / S3 / CloudWatch / RDS / Secrets
  //     一律按该作业的区取;runner JAR 不在那个区就从主控区跨区复制(`ensureRunnerJar`);
  //   · 启动路由有**反向卡**:章说别区而那个区的 Flink 通道解析不出来 ⇒ 409 拒跑,绝不静默落主控区。
  "/realtime-compute": { scope: "global-and-target", wired: true },
  // 🔴🔴 用户拍板「连问数都可以切区」:SQL 打到该区数仓;
  // 🔴🔴 2026-09-10 用户再拍板「都走同一个 AgentCore」⇒ 落点做成 payload,不再按区分叉
  "/genbi": { scope: "target-only", wired: true },
  // 🔴 原为 global-only。技能定义是全局的,但**可用性按区**(问数现在真按区跑;技能里写死主控区
  // 资源的那几个在别的区会直接失败)⇒ 必须能按区看「这个区哪些技能真能用」。
  // (批次 E)—— 技能**清单**是全平台一份(一个 AgentCore),
  // 但**用量与报错按区**(「这个区的问数把哪个技能调爆了」)⇒ 用量统计过 scope,清单不过。
  "/skills": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "「调用量 / 报错」按执行范围(问数会话行带真实落点);技能**清单与定义**是全平台一份(所有区共用同一个 AgentCore 与同一批技能),不分区",
    },
  },
  // (批次 A)—— 🔴 实测订正:问数**历史行**原来并没有 targetId
  // (有章的是任务表),所以这一刀先给历史行盖章(`executeGenBiAsk` 回真落点 → `recordGenBiHistory`),
  // 再按章过滤会话与工具调用两块。AgentCore / 技能 Lambda 的运行时指标是单实例,不按区。
  "/observability": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "「问数会话」与「工具调用」已按执行范围(历史行现在带上了真实落点);「AgentCore 运行时」与「技能 Lambda」两块是单实例指标 —— 全平台只有一套 AgentCore(2026-09-10 拍板),按区拆没有对应物",
    },
  },
  // (批次 B)—— 取数落点按区,且落点是 **widget 级**(SPEC §8.3:
  // 一张仪表盘可以并排放两个区的图)⇒ 页面范围只作**新建时的默认值**,已保存的 widget 用它自己的。
  // 🔴 字段配置器的**可选表清单**也按区取(否则在别的区拖出一张主控区才有的表,保存后一跑就报表不存在)。
  "/bi": {
    scope: "global-and-target",
    wired: true,
    partial: {
      // 🔴🔴 用户 2026-09-10 第二轮:「**这个我没看懂,到底是做了分区
      // 过滤还是没做?我觉得可以增加一个过滤能力,默认不过滤。**」⇒ 上一版把「视觉对象级落点」当成
      // 交付,却没回答用户真正问的「列表能不能按区筛」。定案 = **定义级加可选过滤,默认不过滤**
      // (与顶栏范围解耦:顶栏切区不该悄悄藏掉别区的报表,但要能主动筛)。由实现。
      note: "取数落点已到「视觉对象」级(一张仪表盘可以并排放不同区的图,顶栏范围只决定新建时的默认落点);但报表 / 分析**列表本身**还不能按区筛 —— 定义行上缺「涉及哪些区」的派生维度,故要加一个可选过滤器(默认不过滤)",
    },
  },
  "/requirements": { scope: "global-only", globalReason: "doc-only", insteadSee: "/copilot/plans" },
  // 目录 / 质量 / 敏感扫描三件都按区查;🔴🔴 2026-09-10 用户拍板
  // 「治理目录必须走同一个 OpenMetadata」⇒ 「哪个区」= OM 的 service 维度,不再按区分叉
  "/governance": { scope: "global-and-target", wired: true },
  // 🔴 施工中实测后**从批次 A 重排到批次 D**:表全集虽然能按区取
  // (`introspectSchema` 换成该区落点即可),但质量 / 血缘 / 分类三路信号的键里**没有区维**
  // (`health-service.ts:87` 按 `fqn` 聚合)⇒ 两个区的同名表会互相顶,按区出分会**串味**。
  // 只做半截(表全集按区、信号仍是全平台)比不做更坏:分数看着像那个区的,其实混了别区的覆盖率。
  // 已接入。用户 2026-09-10 点名的根因已修
  // 质量 / 血缘 / 分类三路信号的分区键改成 `<targetId>::<fqn>`(**home 保持裸 fqn ⇒ 存量零迁移**),
  // 所以同名表跨区不再互相顶;健康分的**表全集**也改成从那个区的数仓探(用主控区的 workgroup 探
  // 别的区,分母就是错的而分数看起来正常);进程内缓存按 target 分键(全局缓存会让切区后 60 秒内
  // 看到主控区的分)。OM 那半边的区维在 fqn 自带的 service 名里(用户拍板「一个 OM,区 = service 维度」)。
  "/governance-workbench": { scope: "global-and-target", wired: true },
  // 阶段 1 已接入(码表 + 维度建模两个 Tab 按 `targets[]` 过滤;
  // 分层/数据域/数据标准/指标是平台级定义不分区,页面上有一条说明条如实讲清)
  // 原先只在页面正文里写了「哪四个 Tab 不分区」,现在结构化登记
  // (口头说明会被下一个接手的人漏掉,这正是用户 2026-09-10 点名的那类问题)。
  // 🔴🔴 **用户 2026-09-10 第二轮拍板驳回了上一版的措辞**:
  //   我写「分层 / 数据域 / 数据标准 / 指标是平台级定义,本身不分区(设计如此,不是欠账)」,
  //   用户答「**这里为什么不能做成区域维度?我认为都可以切出来的。**」
  // ⇒ 那句「设计如此」是**自我豁免**,不成立。分层/数据域/数据标准是治理约定,**哪些区已落地**
  //   是运维要看的;「指标」更是有**计算值**的东西(值就是从某个区的数仓算出来的)⇒ 必须能按区看。
  //   改成带工单的欠账,由实现(定义行加 `targets[]` + 指标计算结果盖落点章)。
  "/modeling": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "六类全部按执行范围:「码表」「维度建模」按 targets[] 过滤;「分层 / 数据域 / 数据标准」是治理约定 ⇒ 行上可声明**适用区**,未声明 = 全平台通用(所以带上范围也不会让存量定义消失);「指标」有计算值 ⇒ 值按区存(valueByTarget),单区视角给那个区的值、没算过如实回「这个区还没算过」而不是端出别区的数字",
    },
  },
  // 🔴 原为 global-only。业务口径本身是全局定义,但「这条口径在哪些区已经落地 / 哪个区还没落」
  // 是运维每天要看的东西 —— 一句「不受执行范围影响」把这件事整个盖住了。
  // (批次 E)—— 🔴 复核后的结论:业务口径**确实**只有一份。
  // 用户 2026-09-10 拍板「都走同一个 AgentCore」⇒ 记忆 / 技能 / 口径全区共用同一份,
  // 不存在「这条口径在 A 区生效、在 B 区没落地」这种状态(那是我上一版想当然写的)。
  // ⇒ 它对得上理由码 `platform-wide-definition`,如实改回真全局并给出「按区看该去哪」。
  "/knowledge": { scope: "global-only", globalReason: "platform-wide-definition", insteadSee: "/genbi" },
  // (批次 A)—— 按区列出该区对应的 OM service 并可直接点进去
  // (OM 是同一个实例,区的差别只在 service 名后缀上;主控区不带后缀)。
  "/openmetadata": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "「按执行范围的 OpenMetadata 服务」按区列出并可直达;OM 控制台本身是同一个实例的全局界面(打开后请在服务维度内浏览)",
    },
  },
  // 第 5 步单元 3 已接入(scope 为主轴,原 region 筛降为次级;护栏 1 用列表自带计数)
  "/monitor": { scope: "global-and-target", wired: true },
  "/multi-region": { scope: "global-only", globalReason: "cross-region-view", insteadSee: "self", scopeCompare: true },
  // 阶段 1 已接入(B 类绑定列表,字段名是 `execTargets`)
  "/backfill": { scope: "global-and-target", wired: true },
  // (批次 D)—— 🔴🔴 这一页修的不是显示,是**静默漏告**:
  // 聚合类条件(成功率 / 断流)改**默认按区分别评估**(合同 INTERACTION §4sexies 早就这么写,
  // 实现一直是池化的),窗口桶键带上 targetId(不带的话第一个越阈值的区会把这个窗口用掉,
  // 同窗口里第二个区再挂也不再告);事件行盖区章;规则可只盯某几个区;事件列表显示「哪个区」。
  "/alerting": { scope: "global-and-target", wired: true },
  // (批次 A)—— 任务成本 + 成本异常两个 Tab 已按区(成本行本来就有 `targetId`)。
  // 🔴 `partial` 摘掉:四个 Tab 现在**都**按执行范围
  // 账单按 SERVICE × REGION 采进 v2 分区(大盘区卡片 / 预算按区 / 服务级异常按区),任务成本按 target 分行并按区对账。
  // 账单只到 region 粒度(CE 没有「执行环境」维)这件事写在大盘卡片标题上,不是「没接入」。
  "/finops": {
    scope: "global-and-target",
    wired: true,
    scopeCompare: true,
  },
  // 🔴 原为 global-only。运维大屏是全平台一锅端的聚合,恰恰是最需要按区看的一页。
  // (批次 D)—— run 与最近告警都按区过滤后再算派生指标;
  // 资源名字典**刻意不过滤**(过滤它只会让名字退化成 id)。
  "/ops": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "任务态分布、今日统计、甘特与最近告警已按执行范围;「SLA 风险看板」那一块还没有区维(基线行按任务聚合、跨区混在一起)",
    },
  },
  // 🔴 原为 global-only。知识库里的条目多数由**某个区**的成本突增 / 告警沉淀而来。
  // 已接入:故障主档加 `targets[]`(这类故障在哪些区
  // 发生过)、单次发生加 `targetId`,章从**诊断关联的 run 行**上读(零侵入:那次读取本来就有)。
  // 列表与顶部健康度**用同一个 scope**(否则「覆盖率 60%」配一张两行的表,两个数字自相矛盾);
  // 空态经 `ScopeEmptyHint` 说出「别的范围里还有 N 条」(新增 countable kind `incident`)。
  "/incidents": { scope: "global-and-target", wired: true },
  // 🔴 原为 global-only。项目本身是全局对象,但它有**按 target 的白名单**(accessAllows),
  // 「本项目在这个区能不能用」是数据驻留的核心问题,页面上完全没有。
  // (批次 E)—— 单区视角只列**在该区获授权**的项目
  // (`ExecutionTarget.access` 白名单,判定复用 `accessAllows` 不另写);🔴 读不到授权清单时
  // **不过滤**并在响应里说明,绝不「读不到就当没授权」把项目藏起来。
  "/projects": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "项目列表按「在当前执行环境是否获授权」过滤(执行环境的项目白名单);「发现并申请加入」刻意仍列全平台的项目(它的用途就是找到还没加入的)",
    },
  },
  "/exec-envs": { scope: "global-only", globalReason: "manages-regions", insteadSee: "self" },
  "/admin/users": { scope: "global-only", globalReason: "identity-global", insteadSee: "/projects" },
  // (批次 B)—— 审计条目现在带区章:执行环境类动作由 `resourceId`
  // 派生(那 12 条 `/api/admin/exec-envs/[targetId]/**` 路由的 resourceId 就是 targetId),
  // 数据面动作(同步启动 / 质量运行)由调用方显式传真落点;读侧**翻页**后再按章过滤
  // (DDB 的 Limit 是过滤前的量,不翻页 = 审计日志被静默截断)。
  "/audit": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "自 2026-09-10 起的条目带执行环境标记并可按区过滤;此前的存量条目没有标记,按「控制面在主控区」归主控区(跨区动作的存量条目因此也落在主控区视角)",
    },
  },
  // (批次 B)—— 🔴🔴 这一页原来是全平台**唯一一处硬撒谎**:
  // 声明「不受执行范围影响」,却把主控区的 Redshift 工作组 / Glue 桶 / MWAA 桶 / VPC 当
  // 「平台配置」渲染给所有区看(`app/settings/page.tsx:79-86`)。现在逐项从**该 target 自己的
  // 描述符资源袋**取,并把取值来源标出来;读不到就说读不到,**绝不拿主控区的值顶上**。
  // 身份(Cognito 单池)拆成单独一张卡明说「与执行范围无关」。
  "/settings": {
    scope: "global-and-target",
    wired: true,
    partial: {
      note: "「执行环境资源」与「服务状态」里的 Redshift 已按执行范围;「全局身份」那张卡是单一用户池(与区无关,已单独成卡);AI 模型的区维另有归属",
    },
  },
} as const satisfies Record<string, ScopeDecl>;

/** 菜单叶子的合法 key(= 本表的键)。`routes.tsx` 的 `Leaf.key` 用它 ⇒ 漏登记即 tsc 红。 */
export type MenuRouteKey = keyof typeof MENU_ROUTE_SCOPE;

export function menuRouteScope(key: string): ScopeDecl | undefined {
  return (MENU_ROUTE_SCOPE as Record<string, ScopeDecl>)[key];
}

/**
 * 🔴🔴 **棘轮**:「还没按执行范围过滤」的路由条数上限(菜单表 + 非菜单表合计)。
 *
 * 开工基线 **22**(= 原先 15 个 `scopeWired:false` + 翻出来的 7 处伪全局)。
 * 规矩只有一条:**这个数字只许改小**。
 * · 新增一页而不接入 ⇒ 实际条数 > 上限 ⇒ 门禁 `scope-coverage-guard` 红;
 * · 接好一页 ⇒ 必须在同一笔提交里把这个数字减 1(门禁断言**恰好相等**,多减也红)。
 * 这就是用户那句「我不想再说第二次」的机械保证:靠人记会忘,靠这个数字不会。
 */
export const NOT_WIRED_LIMIT = 0;
