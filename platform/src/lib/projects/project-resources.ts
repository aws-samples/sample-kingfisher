// 🔴 **删项目空间的前置校验:该项目下还有什么**(52 DESIGN §D4 最后一条,R9 深审补的设计缺口)。
//
// 【为什么必须有】改动前 `DELETE /api/projects/[id]` 只删 project 行 + 成员行,**不看资源**。
// 于是删一个还有资源的项目会留下:
//   · 悬空 `projectId` 的数据源/同步/作业/工作流…(列表里按项目过滤 ⇒ 谁也再看不到,
//     但它们的 Glue job / MWAA DAG / DMS 任务**还在真跑、还在计费**);
//   · 数据面孤儿 schema `proj_<id>`(建的表还在,占存储、还带着业务数据);
//   · 成员行虽然被删了,用户却再也没有入口去处置自己的东西。
// ⇒ 对齐**删执行环境**的同款策略(50 §4.4:绑定资源/调度/run 全为 0 才可删):
//   **默认禁止 + 400 列明细**,不级联删除(级联删数据风险过高,列二期)。
//
// 【口径:什么算"资源"】只数**资源定义**(用户创建、会真的去跑/被引用的东西),
// 不数运行记录/审计/版本/历史(那些删了项目也不会变成"还在跑的孤儿",且量大)。
//
// 🔴 **本清单必须覆盖全部"归属项目的资源类型",漏一类 = 漏一类孤儿**。因此:
//   · attr 类统一走一个分页 COUNT Scan(键布局相同,7 张表配置化);
//   · 键式隔离类**复用各模块自己的 list 函数**(不在这里重抄一遍键布局 —— 抄一遍就是
//     52 SPEC §3.0 点名的"三套 sanitize"那类分叉);
//   · 有门禁测试钉住清单长度与每一项,加了新的项目级资源类型必须同步加行。
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { listReports } from "@/lib/bi/reports";
import { listContextOwnedByProject } from "@/lib/genbi/context";
import { listSkillsOwnedByProject } from "@/lib/genbi/skills";
import { listRules } from "@/lib/alerting/rules";
// 三类「项目删了还在 / 还在跑」的孤儿(真环境清理 128 个夹具项目时抓到)
import { listOpenPlansOwnedByProject } from "@/lib/copilot/plan/plan-service";
import { listOpenPlansOwnedByProject as listOpenBackfillPlansOwnedByProject } from "@/lib/backfill/service";
import { listActionSchedulesOwnedByProject } from "@/lib/scheduler/action-schedules";
import { ACTION_SCHEDULE_TASK_TYPES, type ActionScheduleTaskType } from "@/lib/scheduler/carrier-ledger";
import { listMembers, getProject } from "./project-service";
// 等 Redshift Data 终态的唯一原语(本函数只能在长操作 project-delete 的执行上下文里被调;请求路径直接调 ⇒ 抛)
import { awaitTerminal, LongOpWaitBudgetExceeded } from "@/lib/long-ops/await-terminal";
// 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup } from "@/lib/redshift/warehouse-location";
// 「看不清 ⇒ 视为不安全」那一条的既有实现(含账号号脱敏),
//   blockers 会经 HTTP 响应 + 审计外泄 ⇒ 绝不把 AWS 原文直接拼进去。
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";

export interface ResourceCount {
  kind: string;
  label: string;
  /**
   * 该项目下这类资源的条数;**`null` = 没能核实**(表不可达 / 无权限 / list 抛异常)。
   * 🔴 `null` 与 `0` 是两个不同的事实,合成一个值就会让删除放行 —— 见 §「不许把读不到静默回成没有」。
   */
  count: number | null;
  /** `count === null` 时的原因(已脱敏);仅用于把「为什么看不清」说给管理员。 */
  error?: string;
}

/**
 * 数据面 schema 表数核实结果(`null` 表数永远只配 unavailable)。
 * 曾加过第三态 `pending`(45s 预算到期仍排队 ⇒ 路由 202「正在唤醒数仓」+ 页面自动重发);把删项目改成长操作后,
 * 盘点语句在执行体里等到终态,专用协议退役 ⇒ 两态。
 */
export type SchemaCheck = "ok" | "unavailable";
export type SchemaCount = { tables: number | null; check: SchemaCheck; statementStatus?: string; waitedMs?: number };

export interface ProjectInventory {
  /** 资源定义(按类型;count>0 的才列出)。 */
  resources: ResourceCount[];
  /** 🔴 **没能核实**的类型(`count === null`)—— 非空即阻断删除,不许当成「没有」。 */
  unresolved: ResourceCount[];
  /** 除项目 owner 之外的成员数(owner 自己不算"待处置")。 */
  otherMembers: number;
  /** 数据面 schema(`proj_<id>`)内的表数;`null` = 没能核实(见 schemaCheck)。 */
  schemaTables: number | null;
  /** `ok` 已核实 / `unavailable` 查不到(无数仓凭证、查询失败或等到预算上限仍未出结果)。 */
  schemaCheck: SchemaCheck;
  /** 数据面 schema 名(回给前端便于人去查)。 */
  schemaName: string;
  /** 盘点语句最后一次看到的状态;没提交成语句时缺省。 */
  schemaStatementStatus?: string;
  /** 盘点语句实际等了多久(ms)。 */
  schemaWaitedMs?: number;
  /** 阻断删除的原因(空数组 = 可删)。 */
  blockers: string[];
}

/**
 * `projectId` 属性型资源表(pk 仍是 `LEGACY_PARTITION`,归属在 `projectId` 属性上)。
 * 与各自读路径的 `projectFilter()` 同一批表 —— 那 7 条读路径就是"这些资源按项目隔离"的证据。
 */
const ATTR_TABLES: ReadonlyArray<{ kind: string; label: string; table: string }> = [
  { kind: "datasource", label: "数据源", table: TABLES.DATASOURCES },
  { kind: "sync", label: "同步任务", table: TABLES.SYNC_TASKS },
  { kind: "etl", label: "离线作业(Glue/SQL)", table: TABLES.ETL_JOBS },
  { kind: "engine", label: "多引擎作业(EMR 等)", table: TABLES.ENGINE_JOBS },
  { kind: "flink", label: "实时作业(Flink)", table: TABLES.FLINK_JOBS },
  { kind: "workflow", label: "工作流", table: TABLES.WORKFLOWS },
  { kind: "redshift-task", label: "Redshift 任务", table: TABLES.REDSHIFT_TASKS },
];

/**
 * **按用户分区、但归属项目**的表(pk = 用户 sub,`projectId` 在属性上)。
 *
 * 🔴 为什么单列一类而不塞进 `ATTR_TABLES`:remediation 路径**不一样**。上面那 7 类管理员自己就能删,
 *    而这一类是**别人的个人资产**(每人各自 100 张上限),管理员删不了、也不该替他删 ⇒ 阻断文案必须
 *    告诉他「去找这些人自己删」,否则他会以为平台坏了。
 * 🔴 为什么不做级联删除:项目是**共享**的、卡片是**个人**的 —— 级联就等于一个人删项目、
 *    悄悄销毁另外几个人保存的对话(54 DESIGN §9 反模式 1 的同一条「不丢东西」)。
 * ⚠️ `quota#` 那一行没有 `projectId` 属性 ⇒ 不会被 `projectId = :pid` 过滤命中,不虚增计数。
 */
const USER_OWNED_TABLES: ReadonlyArray<{ kind: string; label: string; table: string }> = [
  { kind: "genbi-card", label: "问数会话卡片(属个人,需本人删除)", table: TABLES.GENBI_CARDS },
];

/**
 * 平台动作调度对象(`bgp-action-schedules`)按种类进清单 —— 🔴 **从闭合词表 `ACTION_SCHEDULE_TASK_TYPES` 派生**,
 * 不手写三行:将来新增一种调度对象(第四种),它**自动**进删项目的前置校验;而标签表是
 * `Record<ActionScheduleTaskType, string>` ⇒ 新种类不给标签 `tsc` 就不过(类型堵死「加了种类、忘了数它」)。
 * 🔴 这一类是**还在真跑**的孤儿:载体在该区的 MWAA Serverless 上按 cron 触发,项目删了照样到点执行。
 *    处置路径 = 在各自页面删掉调度对象(删除走 `deleteActionSchedule`:先撤载体、撤不下来不删行)。
 * ⚠️ 问数卡片的定时刷新随卡片走(删卡先删它),而卡片本身已经阻断删除 —— 照样单列,
 *    是为了把「卡片已删、定时还在」那种不一致也数出来,而不是赌那条链永远不断。
 */
const ACTION_SCHEDULE_LABELS: Readonly<Record<ActionScheduleTaskType, string>> = {
  governance: "定时治理任务(到点仍会在该区触发)",
  seed: "定时造数任务(到点仍会在该区触发)",
  "genbi-card": "问数卡片定时刷新(属个人,需本人删除)",
};
function actionScheduleResourceKind(k: ActionScheduleTaskType): string {
  return `${k}-schedule`;
}

/** 键式隔离型(pk 里就带 projectId)—— 复用模块自己的 list,不重抄键布局。 */
const OWN_LIST_KINDS: ReadonlyArray<{
  kind: string;
  label: string;
  list: (projectId: string) => Promise<unknown[]>;
}> = [
  { kind: "bi-report", label: "BI 报表/看板", list: listReports },
  // 「数据服务 API」一类已随能力下线去掉(2026-09-05,50 SPEC §3.9c):代码不再认识 bgp-data-apis 表,
  //   留着会让删项目去查一张代码不再认识的表。表实测 0 条、infra 保留,不构成孤儿资源。
  // 🔴🔴 这两行必须用 **owned-only** 的版本:模块自己的 `listContext` / `listSkills` 为了问数可用性
  //    **合并 `global` 作用域**,拿它当「归属」判据 ⇒ 刚建的空项目被全局共享条目挡住、删不掉,
  //    而拒因让用户去删**别人也在用**的东西(真环境 GC-15 抓到:13 条全局口径)。
  //    「这个项目能看见什么」与「这个项目拥有什么」是两件事,两个作者。
  { kind: "genbi-context", label: "问数业务口径", list: listContextOwnedByProject },
  { kind: "genbi-skill", label: "问数技能", list: listSkillsOwnedByProject },
  { kind: "alert-rule", label: "告警规则", list: listRules },
  // 🔴 Copilot 执行计划:只数**未收口**的(还会被确认 / 被 L3 推进 / 还会建出作业)。已收口的是历史记录,
  //    且计划没有删除入口 —— 连它也算 ⇒ 跑过一次 Copilot 的项目永远删不掉。口径的唯一作者是 `isPlanOpen`。
  { kind: "copilot-plan", label: "Copilot 执行计划(未收口;可在计划中心取消)", list: listOpenPlansOwnedByProject },
  // 🔴 补数计划:同上,只数**未收口**的(还会被 tick 推进、在执行区真跑实例)。口径唯一作者 = `isBackfillPlanOpen`。
  { kind: "backfill-plan", label: "补数计划(未收口;可在补数页取消)", list: listOpenBackfillPlansOwnedByProject },
  ...ACTION_SCHEDULE_TASK_TYPES.map((k) => ({
    kind: actionScheduleResourceKind(k),
    label: ACTION_SCHEDULE_LABELS[k],
    list: (projectId: string) => listActionSchedulesOwnedByProject(k, projectId),
  })),
];

/** 门禁用:清单快照(改了要同步改门禁,防"悄悄少数一类")。 */
/**
 * 门禁用:`kind → 面向管理员的标签`。导出的**唯一理由**是让判据能断**产品里真实那一行**字 ——
 * 🔴 变异测试当场逮到过:判据把 label 当参数传进纯函数再断,于是改坏产品里的真实标签**判据不红**
 *    (「负向/存在性断言不要靠猜、要打真值源」的又一个形状)。
 */
export const PROJECT_RESOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([...ATTR_TABLES, ...USER_OWNED_TABLES, ...OWN_LIST_KINDS].map((t) => [t.kind, t.label]))
);

/**
 * 🔴 **按项目存、但刻意不数**的类型 —— 把「为什么不数」写成数据,门禁钉住(不许悄悄从清单里消失,也不许没理由地漏)。
 * 判据:只数**资源定义**(用户建的、会跑 / 被引用 / 有处置入口的东西);下面这些要么是历史 / 派生知识,
 * 要么是系统代管(由产品自己回收),阻断删除只会让项目永远删不掉而管理员无从处置。
 */
export const PROJECT_SCOPED_NOT_COUNTED: Readonly<Record<string, string>> = Object.freeze({
  incident:
    "运维知识库条目(bgp-incidents,pk=incident#<projectId>):由失败诊断**自动归并**生成,人只在上面补修复手册 / 静默;" +
    "不会跑、没有载体、也没有任何删除入口 ⇒ 它是运行历史的派生知识(与运行记录 / 审计同一口径),不是资源定义。" +
    "项目删掉后它不再被任何路径读到(唯一读法 listMasters 按项目 pk、只在该项目页面上触发对账),按历史留存。",
  "copilot-plan-task": "Copilot 规划的异步任务行(bgp-copilot-plan-tasks):7 天 TTL 的执行中间态,产物是 copilot-plan(已数)。",
  "copilot-step / backfill-instance": "计划下的步骤 / 实例行:90 天 TTL,随计划;计划本身已按「未收口」数。",
  "project-credential": "per-project 凭证 secret(bgp/project/<slug>/<pid>):系统代管,删项目时由回收作业自动删(project-cred-reclaim.ts)。",
});

export const PROJECT_RESOURCE_KINDS: readonly string[] = [
  ...ATTR_TABLES.map((t) => t.kind),
  ...USER_OWNED_TABLES.map((t) => t.kind),
  ...OWN_LIST_KINDS.map((t) => t.kind),
];

/**
 * 数一张 attr 型表里属于该项目的条数。
 *
 * 🔴 **必须翻页**:DDB 的 Scan 一次最多扫 1MB,`Count` 只是**本页**过滤后的数量。
 *    不翻页 ⇒ 大表上永远数出 0 ⇒ "看起来没资源"于是放行删除(fail-open,正好是最坏方向)。
 * 🔴 用 `Select: "COUNT"`:只要数量,不把 item 拉回来。
 * 🔴 **只按 `projectId = :pid` 精确匹配,不带 legacy 兜底**(`projectFilter` 对默认空间会
 *    把无 projectId 的存量算进来)—— 默认空间本来就不允许删除,而对自建项目,
 *    "无 projectId 的存量"属于默认空间、不属于它。
 */
async function countAttrTable(table: string, projectId: string): Promise<number> {
  return countAllPages((ExclusiveStartKey) =>
    docClient.send(
      new ScanCommand({
        TableName: table,
        Select: "COUNT",
        FilterExpression: "projectId = :pid",
        ExpressionAttributeValues: { ":pid": projectId },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      })
    )
  );
}

/**
 * 🔴🔴 **「读不到」绝不静默回成「没有」**(2026-09-13 补的一个真 fail-open)。
 *
 * 改动前 `OWN_LIST_KINDS` 那一行写着 `t.list(projectId).catch(() => [])`:BI 报表 / 问数口径 /
 * 技能 / 告警规则任意一类**读失败**(表不可达、限流、权限被收回)⇒ 计数变 0 ⇒ 不产生阻断 ⇒
 * **带着孤儿把项目删了**,而且删完再也没人能发现少数了一类。这与 `countSchemaTables` 那条
 * 「查不到就是查不到,绝不当 0」是同一条纪律,只是当时只在数据面那一项落实了。
 *
 * 现在全部各类(数目见门禁 `PROJECT_RESOURCE_KINDS`)走同一个包装:失败 ⇒ `count: null` + 脱敏原因 ⇒ 调用方**必须**把它变成阻断项。
 * 顺带把 attr 型的失败从「整条盘点抛 → 500」升级成「400 + 说清是哪张表」——两者都不会误删,
 * 但后者管理员看一眼就知道该修什么。
 */
export async function safeCount(
  kind: string,
  label: string,
  read: () => Promise<number>
): Promise<ResourceCount> {
  try {
    return { kind, label, count: await read() };
  } catch (e) {
    return { kind, label, count: null, error: sanitizeAwsErrorMessage(String((e as Error)?.message || e)) };
  }
}

/**
 * 把"翻完所有页再求和"抽成**可注入的纯逻辑** —— 唯一原因是它必须被**可执行断言**钉住。
 *
 * 🔴 教训(2026-09-03 当场踩到):第一版门禁只扫源码里有没有 `LastEvaluatedKey`/`ExclusiveStartKey`
 *    这两个词。我把 `ExclusiveStartKey = res.LastEvaluatedKey` 变异成 `= undefined`(即只数第一页)
 *    ⇒ **两个词都还在,门禁全绿** = 典型的空断言假门禁。现在测试直接喂一个"两页"的假 pager
 *    断总数,变异必红。
 */
export async function countAllPages(
  scanPage: (
    startKey?: Record<string, unknown>
  ) => Promise<{ Count?: number; LastEvaluatedKey?: Record<string, unknown> }>,
  maxPages = 50 // 兜底上限:异常情况下不无限翻(真实配置表都远小于此)
): Promise<number> {
  let total = 0;
  let startKey: Record<string, unknown> | undefined = undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await scanPage(startKey);
    total += res.Count || 0;
    startKey = res.LastEvaluatedKey;
    if (!startKey) break;
  }
  return total;
}

/** 盘点语句最多等多少轮(500ms 起 ×1.5 顶 2s ⇒ 约 290s,贴着长操作 300s 天花板;到顶 ⇒ unavailable fail-closed)。 */
export const SCHEMA_COUNT_MAX_POLLS = 150;

/**
 * 盘点语句提交之后的等待(抽成可注入的纯逻辑,与 `countAllPages` 同一个理由:必须被可执行断言钉住)。
 *
 * 两态:FINISHED ⇒ `ok`(拿结果);FAILED / ABORTED / 结果不是数 / 等到轮数上限 ⇒ `unavailable`(fail-closed)。
 * 🔴 原该缺陷的「45s 预算到期 ⇒ pending ⇒ 202 warming ⇒ 页面重发」退役 —— 等待经唯一原语 awaitTerminal,
 *    数仓冷恢复期间整条删除由 submitLongOp 转 202,页面右下「正在后台执行:删除项目空间」;这里只管等到终态。
 * 轮询间隔 500ms 起、每次 ×1.5、顶 2s:冷启动 30–90s 的等待不该每半秒打一次 DescribeStatement。
 */
export async function awaitSchemaCountStatement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any —— 真客户端的 send 是泛型重载,这里只要「能发命令」
  rs: { send: (cmd: any) => Promise<any> },
  cmds: { DescribeStatementCommand: new (i: { Id: string }) => unknown; GetStatementResultCommand: new (i: { Id: string }) => unknown },
  statementId: string,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number; maxPolls?: number } = {}
): Promise<SchemaCount> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  let lastStatus = "SUBMITTED";
  let terminal: string;
  try {
    terminal = await awaitTerminal<string>({
      what: "盘点数据面 schema 表数",
      maxPolls: opts.maxPolls ?? SCHEMA_COUNT_MAX_POLLS,
      initialMs: 500,
      backoff: 1.5,
      maxMs: 2000,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      probe: async () => {
        const desc = await rs.send(new cmds.DescribeStatementCommand({ Id: statementId }));
        lastStatus = String(desc?.Status ?? lastStatus);
        if (lastStatus === "FINISHED" || lastStatus === "FAILED" || lastStatus === "ABORTED") return { done: true, value: lastStatus };
        return { done: false, state: lastStatus };
      },
    });
  } catch (e) {
    if (e instanceof LongOpWaitBudgetExceeded) return { tables: null, check: "unavailable", statementStatus: lastStatus, waitedMs: now() - startedAt };
    throw e;
  }
  const waitedMs = now() - startedAt;
  if (terminal !== "FINISHED") return { tables: null, check: "unavailable", statementStatus: terminal, waitedMs };
  const out = await rs.send(new cmds.GetStatementResultCommand({ Id: statementId }));
  const raw = out?.Records?.[0]?.[0]?.longValue ?? Number(out?.Records?.[0]?.[0]?.stringValue ?? NaN);
  return Number.isFinite(raw as number)
    ? { tables: Number(raw), check: "ok", statementStatus: terminal, waitedMs }
    : { tables: null, check: "unavailable", statementStatus: terminal, waitedMs };
}

/**
 * 数据面 schema 内的表数。
 *
 * 🔴 **查不到就是查不到,绝不当 0**:返回 `unavailable` 由调用方 fail-closed
 *    (把"没核实"当成"没有表"就是拿孤儿表换一次痛快)。
 * 落地前 `proj_<id>` schema 通常并不存在 ⇒ 正常返回 0(不是错误)。
 * 数仓冷恢复时语句会排队几十秒到几分钟:在长操作 project-delete 里经 awaitTerminal 等到终态(见 awaitSchemaCountStatement)。
 */
async function countSchemaTables(schemaName: string): Promise<SchemaCount> {
  try {
    const [{ ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand }, { getRedshiftSecretArn }] =
      await Promise.all([import("@aws-sdk/client-redshift-data"), import("@/lib/redshift/admin-secret")]);
    // 合同 home-only(盘的是主控区控制面资源;跨区残留归 52 删项目项)
    const { redshiftClientForHomeOnly } = await import("@/lib/exec-env/target-clients");
    const rs = redshiftClientForHomeOnly("project-inventory");
    // 静态归类:**admin / 清点**(删项目前盘点 `proj_<id>` 里的表数)。
    // 🔴 **刻意不传 project**:这条路径在项目**正在被删**时跑,用它自己的身份去数它自己的表,
    //    会在凭证已回收/项目已消失时把盘点变成"无法核实"⇒ fail-closed ⇒ **项目永远删不掉**
    //    (memory `unwired-code-is-unverified` 记的正是这一类:assertProjectId 拒掉真 projectId
    //     导致所有项目都删不了)。清点必须用能看见一切的身份。
    const SecretArn = await getRedshiftSecretArn();
    const wg = homeWorkgroup();
    // schemaName 由 projectSchema() 派生(只含 [a-z0-9_]),此处拼接结构上安全。
    const { Id } = await rs.send(
      new ExecuteStatementCommand({
        Sql: `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${schemaName}'`,
        WorkgroupName: wg,
        Database: process.env.REDSHIFT_DATABASE || "dev",
        ...(SecretArn ? { SecretArn } : {}),
      })
    );
    if (!Id) return { tables: null, check: "unavailable" };
    return await awaitSchemaCountStatement(rs, { DescribeStatementCommand, GetStatementResultCommand }, Id);
  } catch {
    return { tables: null, check: "unavailable" };
  }
}

/**
 * 「阻断删除的原因」的**唯一算法**,抽成纯函数导出 —— 与 `countAllPages` 同一个理由:
 * 🔴 它必须被**可执行**断言钉住,而不是靠"源码里有没有出现 blockers.push"这种扫描
 *    (本仓实证:那种门禁被一个 `= undefined` 的变异整整绕过去,两个关键词都还在却全绿)。
 *
 * 三条不变量,每一条都对应一次真事故:
 *  ① 有资源 ⇒ 阻断(否则留下还在计费的孤儿);
 *  ② **没能核实** ⇒ 阻断(`null` 不是 `0`;这一条 2026-09-13 之前只在数据面那一项落实了);
 *  ③ 有其它成员 ⇒ 阻断(否则他们的东西没了入口)。
 */
export function buildBlockers(input: {
  counted: ResourceCount[];
  otherMembers: number;
  schemaName: string;
  schema: { tables: number | null; check: SchemaCheck };
}): string[] {
  const { counted, otherMembers, schemaName, schema } = input;
  const blockers: string[] = [];
  for (const r of counted) {
    if (r.count === null) {
      blockers.push(
        `无法核实「${r.label}」的数量(${r.error || "原因未知"})—— 为免留下孤儿资源,已拒绝删除;` +
          `请稍后重试或联系管理员`
      );
    } else if (r.count > 0) {
      blockers.push(`${r.label} ${r.count} 个`);
    }
  }
  if (otherMembers > 0) blockers.push(`成员 ${otherMembers} 人(除创建者)`);
  if (schema.check === "ok" && (schema.tables ?? 0) > 0) {
    blockers.push(`数据面 schema ${schemaName} 内有 ${schema.tables} 张表`);
  }
  if (schema.check === "unavailable") {
    blockers.push(
      `无法核实数据面 schema ${schemaName || "(名字无法派生)"} 内的表数(数仓不可达或无凭证)——` +
        `为免留下孤儿表,已拒绝删除;请稍后重试或联系管理员`
    );
  }
  return blockers;
}

/**
 * 盘点一个项目空间下的一切,并给出**阻断删除的原因**。
 *
 * 判据(全为 0 才可删,与§4.4 同款):资源定义 0 · 其它成员 0 · 数据面 schema 内表 0。
 * 数据面那一项若**没能核实**,同样阻断(fail-closed)。
 */
export async function inventoryProject(projectId: string): Promise<ProjectInventory> {
  const { projectSchema } = await import("@/lib/exec-env/project-schema");
  let schemaName: string;
  try {
    schemaName = projectSchema(projectId);
  } catch {
    // 非平台生成形态的 projectId(理论上不该有)⇒ 不猜 schema 名,标为无法核实。
    schemaName = "";
  }

  const [attrCounts, ownCounts, members, project, schema] = await Promise.all([
    Promise.all([...ATTR_TABLES, ...USER_OWNED_TABLES].map((t) => safeCount(t.kind, t.label, () => countAttrTable(t.table, projectId)))),
    Promise.all(OWN_LIST_KINDS.map((t) => safeCount(t.kind, t.label, async () => (await t.list(projectId)).length))),
    listMembers(projectId),
    getProject(projectId),
    schemaName ? countSchemaTables(schemaName) : Promise.resolve<SchemaCount>({ tables: null, check: "unavailable" }),
  ]);

  const counted = [...attrCounts, ...ownCounts];
  const resources = counted.filter((r) => (r.count ?? 0) > 0);
  /** 没能核实的那几类 —— fail-closed 的依据,绝不当成 0。 */
  const unresolved = counted.filter((r) => r.count === null);
  const ownerName = project?.ownerName;
  const otherMembers = members.filter((m) => !(ownerName && m.username === ownerName)).length;

  const blockers = buildBlockers({ counted, otherMembers, schemaName, schema });

  return {
    resources, unresolved, otherMembers, schemaTables: schema.tables, schemaCheck: schema.check, schemaName, blockers,
    ...(schema.statementStatus ? { schemaStatementStatus: schema.statementStatus } : {}),
    ...(schema.waitedMs !== undefined ? { schemaWaitedMs: schema.waitedMs } : {}),
  };
}
