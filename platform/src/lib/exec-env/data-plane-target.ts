// 数据面执行体的 **target 绑定解析** —— 唯一作者(50 SPEC §3.1 / §3.4 / §3.8 的 `assertCapability`)。
//
// ── 这个文件解决的是什么 ────────────────────────────────────────────────────
// 核心价值是那句「**作业真在第二区域跑**」。要让它成立,一个执行体必须同时拿到**四样**东西
//   ① 客户端的 **region**    ② **workgroup**    ③ **database**    ④ **凭证 ARN**
// 现网这四样各自散在不同地方(region 取 `process.env.AWS_REGION`、workgroup 走三级兜底、
// 凭证走 `getRedshiftSecretArn()`),而且**只有 home 那一套**。
// 🔴 只补其中一两样是**最危险**的形态:region 对了但 workgroup 还是 home ⇒ 不报错,
// 只是"看起来正常地连到了别的区域"(`warehouse-location.ts` 文件头记的正是这个)。
// ⇒ 本文件把四样**焊在一起解析**,要么四样都是该 target 的,要么当场拒。
//
// ── 与既有件的分工(别造第二个作者)────────────────────────────────────────
// · 准入(ready / status / 新鲜度 / 整包校验)= `registry.requireReadyTarget()`(强一致读,不缓存);
// · 落点(region / workgroup / database)     = `target-clients.resolveTargetWarehouse()`;
// · 凭证                                      = `privileged-cred.getPrivilegedCred()`(§3.9 工厂);
// · 客户端                                    = `target-clients.redshiftDataClientFor(region)`。
// 本文件只做**组装 + 组件前置 + home 等价性**这三件它们各自都不该管的事。
//
// ── 🔴 home 必须逐字节等价 ─────────────────────────────────────────────────
// home(或不传 target)走的仍是**现网那条路**:region = `process.env.AWS_REGION`、
// workgroup/database 走 `warehouse-location` 的三级兜底、凭证走 `getRedshiftSecretArn()`
// (它自己按 `PER_PROJECT_CRED` flag 决定要不要转 §3.9 工厂)。
// 🔴 **刻意不让 home 也走 §3.9 工厂**:`tgt_home` 现在处于 `provisioning`(deadline 2026-10-04),
// 一旦让 home 的执行路径依赖那个工厂,窗口过期后 home 的离线作业会全部 fail-closed ——
// 那是把一个"过渡态的收敛压力"变成"存量业务被打挂"。home 的凭证口径改动。
//
// ── 🔴 非 home 为什么可以不依赖 `PER_PROJECT_CRED` flag ─────────────────────
// `getPrivilegedCred(purpose:"project-context")` 在 `legacy-seeded` / 未过期 `provisioning` 下会
// **显式回落到该 target 自己的 admin secret**(取自描述符实名资源袋)并留下审计/指标/告警;
// `isolated` 下缺 per-project 凭证则 fail-closed。⇒ 它对非 home 天然可用,不需要开 flag。
// 而那个 flag 管的是**存量 18 个调用点**要不要切身份(见 `admin-secret.ts`),两件事不同。

import { homeRegion } from "@/lib/place/home-region";
// 观测模式的落点决策记账(只记录;必须在第一个 await 之前调,见 place/context.ts)
import { notePlaceDecision } from "@/lib/place/context";
import { getTargetRaw, requireReadyTarget, type ExecutionTarget } from "@/lib/exec-env/registry";
// 项目白名单判据的单一作者(SPEC §3.12 v3.22)
import { accessAllows, accessDeniedReason } from "@/lib/exec-env/residency";
import { HOME_TARGET_ID, isHome, isValidTargetId, targetOfStamp } from "@/lib/exec-env/target-id";
// 维度清单与调度组件值域都只 import 单一作者,不手抄字面
import type { ExecTargetCapabilityDim } from "@/lib/exec-env/exec-targets-dims";
import { SCHEDULER_PREFERENCE_COMPONENT } from "@/lib/exec-env/scheduler-preference";
import { TargetBindingRejected, regionOfTarget } from "@/lib/exec-env/target-region";
// 「能看」判据的单一作者
import { viewabilityVerdict } from "@/lib/place/resolve";
import { resolveDatabase, resolveWorkgroup } from "@/lib/redshift/warehouse-location";
import {
  resolveTargetWarehouse,
  resolveTargetGlue,
  glueClientFor,
  type TargetSparkLanding, resolveTargetEmr,
} from "@/lib/exec-env/target-clients";

/** 数据面执行体跑一条 Redshift 语句所需的全部落点信息。 */
export interface RedshiftBinding {
  targetId: string;
  region: string;
  workgroup: string;
  database: string;
  /**
   * 凭证 ARN。
   * 🔴 **非 home 恒为非空**(解析不到就抛);**home 可能为 `undefined`** ——
   * 那是现网既有语义(无密钥的本地/裸环境回落调用方 IAM 身份),本批**刻意不改**:
   * 改它属于"顺手改了现网行为",不在 下推范围里。
   */
  secretArn?: string;
  /** `true` = 用的是该 target 的共享 admin(过渡态),`false` = per-project 凭证 */
  degradedToLegacyAdmin: boolean;
  /** `true` = home(等价路径),便于调用方保留既有三元写法 */
  home: boolean;
  /**
   * 该目标的法域(`home` / 其它)。多 region 直查据它判「结果能不能合并」——
   * 🔴 跨法域自动合并 = 把区内明细搬到中央落地 = 数据出境(INTERACTION §4bis.3)。
   * 放在 binding 里而不是让调用方再读一次注册表:两次读会有两个说法。
   */
  jurisdiction: string;
}

// 🔴 `TargetBindingRejected` 与 `regionOfTarget` **搬到** `target-region.ts`(轻量层)并在此
// re-export —— 理由见那个文件的文件头:周期 reconciler(instrumentation)一侧只能依赖不碰
// node 内置的模块,否则 **edge bundle 编译期**就炸(动态 import 也救不了)。
// 搬的是**同一份实现**(不是抄一份)⇒ 单一作者不变,现有 `instanceof` 判据继续成立。
export { TargetBindingRejected, regionOfTarget, __resetRegionCache } from "@/lib/exec-env/target-region";

/**
 * 组件前置校验(§3.8 的 `assertCapability`)。
 *
 * 🔴 判据用 **`components`(观测态)**,**不用 `capabilities`** —— SPEC §1.1 明写
 * 「`capabilities` 可用于**展示能力**,**不能代替权限状态机**」,而且它的词表至今未定稿。
 * 起 `components` 是纯观测态(部署真装了什么),正是"这个 target 能不能跑 Redshift"的事实源。
 *
 * 🔴 **缺组件是拒,不是降级到 home**(SPEC §3.4 说的"降级"是 **UI 置灰 / 直查返回能力不可用**,
 * 不是偷偷换个 target 跑)。回落 home 等于"用户选了欧洲区、数据在美国算完了"。
 */
export function assertTargetComponent(t: ExecutionTarget, component: string): void {
  const installed = Array.isArray(t.components) ? t.components.map(String) : [];
  if (!installed.includes(component)) {
    throw new TargetBindingRejected(
      "missing-component",
      `执行目标 ${t.targetId} 没有安装 ${component} 组件(已装:${installed.join("/") || "(空)"})⇒ 拒绝下推。` +
        `请先在执行环境管理页给它补装该组件,或换一个已装的目标。` +
        `🔴 这里刻意不回落 home —— 回落等于"你选了这个区域,活却在别的区域干完了"`
    );
  }
}

/**
 * 解析一个执行体在某 target 上跑 Redshift 所需的四样东西。
 *
 * @param targetId  **必填**(原来缺省 = 主控区,漏传静默落主控区);`tgt_home` ⇒ 走**逐字节等价**的 home 路径
 * @param projectId 该执行体归属的项目(取**资源行**,不取请求头 —— 与 `resolveRunStamp` 同一条判据)
 * @param workgroupOverride / databaseOverride 执行体自带的配置(如 `job.redshiftConfig`)
 */
export async function resolveRedshiftBinding(args: {
  targetId: string;
  projectId?: string | null;
  workgroupOverride?: string | null;
  databaseOverride?: string | null;
}): Promise<RedshiftBinding> {
  notePlaceDecision({ targetId: args.targetId, via: "resolveRedshiftBinding" });
  const targetId = args.targetId;
  if (!isValidTargetId(targetId)) {
    throw new TargetBindingRejected("invalid-target", `非法 targetId:${JSON.stringify(args.targetId)}`);
  }

  // ── home:现网那条路,一字不改 ──────────────────────────────────────────
  if (isHome(targetId)) {
    const { getRedshiftSecretArn } = await import("@/lib/redshift/admin-secret");
    return {
      targetId,
      region: homeRegion(),
      workgroup: resolveWorkgroup(args.workgroupOverride),
      database: resolveDatabase(args.databaseOverride),
      secretArn: await getRedshiftSecretArn(args.projectId ? { project: args.projectId } : undefined),
      degradedToLegacyAdmin: true, // home 目前就是共享 admin(per-project 化)
      home: true,
      jurisdiction: "home",
    };
  }

  // ── 非 home:准入 → 组件 → 落点 → 凭证,四样都必须是**这个 target 的** ──
  const t = await requireReadyTarget(targetId); // 强一致 + 整包校验 + 可服务性(不缓存)
  assertTargetComponent(t, "redshift");
  const wh = resolveTargetWarehouse(t); // region / workgroup / database 全取描述符

  // 🔴 执行体自带的 workgroup/database 与该 target 的描述符**不一致时拒,不静默取一个**。
  // 现网 UI 会把 workgroup 预填成 home 的 `bgp-workgroup`;若这里"以描述符为准"静默覆盖,
  // 用户看到的是自己填的值、真跑的是另一个 ⇒ 正是本模块要消灭的那类"看起来正常"。
  assertNoWarehouseConflict("workgroup", args.workgroupOverride, wh.workgroup, targetId);
  assertNoWarehouseConflict("database", args.databaseOverride, wh.database, targetId);

  const { getPrivilegedCred } = await import("@/lib/exec-env/privileged-cred");
  const projectId = args.projectId || undefined;
  if (!projectId) {
    // project-context **必须**带 projectId(§3.9b);没有它就没有可判定的凭证归属。
    throw new TargetBindingRejected(
      "no-credential",
      `在非 home 目标 ${targetId} 上执行必须带 projectId(§3.9b:project-context 不接受缺 projectId)`
    );
  }
  const cred = await getPrivilegedCred(targetId, { purpose: "project-context", project: projectId });
  if (cred.kind !== "project-context" || !cred.secretArn) {
    throw new TargetBindingRejected(
      "no-credential",
      `解析不到目标 ${targetId} 的执行凭证 ⇒ 拒绝执行(§3.9a:禁 IAM fallback,` +
        `绝不省略 SecretArn 退回联邦身份 —— 那会造成表属主分叉)`
    );
  }

  return {
    targetId,
    region: wh.region,
    workgroup: wh.workgroup,
    database: wh.database,
    secretArn: cred.secretArn,
    degradedToLegacyAdmin: cred.degradedToLegacyAdmin,
    home: false,
    jurisdiction: String(t.jurisdiction || "home"),
  };
}

function assertNoWarehouseConflict(
  what: string,
  override: string | null | undefined,
  authoritative: string,
  targetId: string
): void {
  const v = typeof override === "string" ? override.trim() : "";
  if (!v || v === authoritative) return;
  throw new TargetBindingRejected(
    "warehouse-conflict",
    `执行体自带的 ${what}=${JSON.stringify(v)} 与目标 ${targetId} 的实际 ${what}=${JSON.stringify(authoritative)} 不一致 ⇒ 拒绝。` +
      `非 home 的落点只能来自该目标的描述符(50 SPEC §1.1);` +
      `请把该字段清空或改成目标的实际值(界面选择执行目标后会自动带上)`
  );
}

/**
 * 执行体绑定的 target 集合 —— **唯一归一口**(50 SPEC §1.3a-S1:`targets?: string[]`,缺省 `["tgt_home"]`)。
 *
 * 🔴 **为什么要归一而不是直接读字段**:并存三种形态 ——
 *   ① 合同形态 `targets: [...]`;
 *   ② **W3-a 我先落的单值 `targetId`**(那一刀把合同的 `targets[]` 读窄了,已订正;
 *      真环境已经产生了带 `targetId` 的行,不能当它不存在);
 *   ③ 存量行两个都没有(= home)。
 * 三种都必须映到同一个答案,否则"这个作业绑了哪些区"会有三个说法。
 *
 * 🔴 **去重 + 过滤空值**:重复的 target 会让下发跑两遍、矩阵出两列;
 * 空串会让 `lockAttrFor` 产出 home 的属性名(静默串行)。
 */
/**
 * 执行记录(run)上的执行区章。原来六处各写一遍 `(run as { targetId?: string }).targetId`,
 * 再交给「缺省 = 主控区」的解析器 ⇒ 落点决定藏在解析器的默认值里。规则唯一作者 = `targetOfStamp`;
 * 这里只把「章非法」翻成可修的绑定拒绝(路由按 409 报)。
 */
export function stampedTargetOf(run: unknown): string {
  const v = (run as { targetId?: unknown } | null | undefined)?.targetId;
  try {
    return targetOfStamp(v);
  } catch {
    throw new TargetBindingRejected("invalid-target", `执行记录上的执行区章非法:${JSON.stringify(v)}`);
  }
}

export function bindingTargets(row: { targets?: unknown; targetId?: unknown } | null | undefined): string[] {
  const raw = Array.isArray(row?.targets) ? (row!.targets as unknown[]) : [];
  const list = raw.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
  if (list.length === 0) {
    const single = typeof row?.targetId === "string" ? row!.targetId.trim() : "";
    if (single) list.push(single);
  }
  if (list.length === 0) return [HOME_TARGET_ID];
  return list.filter((x, i) => list.indexOf(x) === i);
}

/**
 * **写入路径**的多绑定校验:逐个过 `assertBindableTarget`,并把 home 归一进去。
 *
 * 🔴 **一个不合格就整体拒**,不做"能绑的先绑上" —— 部分绑定会让用户以为全绑上了,
 * 而看板上那几个没绑的格子显示 `—未绑定`(正常态)⇒ **漏的区永远不会被报出来**。
 * 这正是 INTERACTION §2.1 要求的"未就绪的 region **不静默绑上**,而是列出来 + 给跳转"。
 */
export async function assertBindableTargets(
  targets: unknown,
  component: string,
  opts: BindingOpts
): Promise<string[]> {
  const list = bindingTargets({ targets });
  const out: string[] = [];
  const bad: string[] = [];
  for (const t of list) {
    try {
      out.push(await assertBindableTarget(t, component, opts));
    } catch (e) {
      bad.push(`${t}(${(e as Error)?.message ?? String(e)})`);
    }
  }
  if (bad.length) {
    throw new TargetBindingRejected(
      "invalid-target",
      `以下执行目标不可绑定,已整体拒绝(不做"能绑的先绑上" —— 那会让漏掉的区在看板上显示为` +
        `「未绑定」这个正常态,于是永远不会被报出来):${bad.join("; ")}`
    );
  }
  const dedup = out.filter((x, i) => out.indexOf(x) === i);
  return dedup.length ? dedup : [HOME_TARGET_ID];
}

/**
 * 给一条**已提交的语句**取它所在 region 的客户端。
 *
 * 🔴 **为什么必须有这个口(2026-09-04 用户实测报的 bug)**:`statementId` 是 **region 内**的,
 * 而"读回 run 记录再去 Describe"的路径有三处都在用 home 客户端 ⇒ 非 home 的作业:
 *   · 作业日志显示「无法获取语句详情: Query does not exist.」(用户就是这么撞上的);
 *   · 🔴🔴 更糟的是 `reconcileEtlJob`:它把 `does not exist` 当成"执行记录已过期"⇒
 *     **把一条其实成功的 run 写成 failed**(不是只报错,是写坏状态);
 *   · AI 诊断取证拿不到 Redshift 侧信息。
 *
 * 🔴 **解析不到 region 就抛,不回落 home** —— 回落就是上面那三个症状本身。
 * 调用方按各自语义处置:写状态的路径必须"不确认就别写"(fail-closed 到不动),
 * 只读展示的路径可以显示错误。
 */
export async function redshiftClientForTarget(targetId: string) {
  notePlaceDecision({ targetId, via: "redshiftClientForTarget" });
  // 🔴 空串 / any 漏进来不许变成主控区(regionOfTarget 自己对空值仍回主控区 —— 那是下一批)
  if (!isValidTargetId(targetId)) throw new TargetBindingRejected("invalid-target", `非法 targetId:${JSON.stringify(targetId)}`);
  const { redshiftDataClientFor } = await import("@/lib/exec-env/target-clients");
  return redshiftDataClientFor(await regionOfTarget(targetId));
}

/**
 * **按引擎**的绑定校验 —— 写入路径的唯一入口(创建/编辑作业都走它)。
 *
 * 🔴 **Glue 本期只许绑 home,而且必须是「拒」不是「随它绑」**。三个后果叠在一起:
 *   ① `runGlueScriptJob` 写死在 home 执行(脚本上传 home 脚本桶、用 home 的 Glue 客户端)
 *      ⇒ 界面显示绑了 us-west-2、活却在 home 干完了 —— 这正是本模块要消灭的那类「看起来正常」;
 *   ② run 记录的章按 home 盖(那里是显式传 `HOME_TARGET_ID` 的),于是监控页区域筛选与绑定对不上;
 *   ③ 🔴 最硬的一条:扇出下发会按 **usw2** 算锁属性名,而手动运行按 **home** 算
 *      ⇒ 定时执行体与手动 run **各锁各的属性、根本不互斥**,DROP+CTAS 撞同表 OID
 *      (裂缝C 修过的那个事故)原地复活,而且**不报错、只是偶发**。
 * ⇒ 在写入那一刻挡掉,比在三个下游各修一遍可靠。Glue 的 per-target 下推随 W3 后续刀。
 */
/**
 * 解析某个执行目标的 **Spark(Glue / EMR)落点** —— 唯一出口(W3-g)。
 *
 * 与 `resolveRedshiftBinding` 同一条纪律:**home 逐字节等价**(全走既有 env),
 * 非 home 四样(region / 脚本桶 / 执行角色 / 产物桶 + S3Tables 桶)全取描述符实名资源袋,缺一即拒。
 * 🔴 猜错的后果不是报错,是**脚本上传到 home 的桶、作业在那个区找不到它**,
 * 或者更糟:**作业跑在那个区、产物写回了 home**(驻留承诺当场破)。
 */
export async function resolveGlueBinding(args: { targetId: string }): Promise<TargetSparkLanding & { jurisdiction: string }> {
  notePlaceDecision({ targetId: args.targetId, via: "resolveGlueBinding" });
  const targetId = args.targetId;
  if (!isValidTargetId(targetId)) {
    throw new TargetBindingRejected("invalid-target", `非法 targetId:${JSON.stringify(args.targetId)}`);
  }
  if (isHome(targetId)) {
    return { ...resolveTargetGlue({ targetId } as unknown as ExecutionTarget), jurisdiction: "home" };
  }
  const t = await requireReadyTarget(targetId);
  // 🔴 Glue/EMR 不是独立组件:它们要的四样(scriptsBucket / glueRoleArn / datalakeBucket / tableBucket)
  //    都是 **core 袋的必填项**(SPEC §1.1)⇒ 判据是"core 齐全 + 那四个键在",不是"装了 glue 组件"
  //    (组件枚举里根本没有 glue —— 硬造一个只会多一处漂移源)。
  assertTargetComponent(t, "core");
  try {
    return { ...resolveTargetGlue(t), jurisdiction: String((t as { jurisdiction?: unknown }).jurisdiction || "home") };
  } catch (e) {
    // 资源袋缺项 ⇒ 用户可修(补装/补资源),按**可修**报,不要 500
    throw new TargetBindingRejected("missing-component", String((e as Error)?.message ?? e));
  }
}

/**
 * 解析某个执行目标的 **EMR Serverless 提交落点** = Spark 落点 + 执行角色(SPEC v3.21 §6.1 段二)。
 *
 * 为什么不把角色直接塞进 `resolveGlueBinding` 的返回:Glue 作业不需要 EMR 角色,而「用不上的字段」最后总会被人
 * 拿去做默认值。EMR 的提交 / 发布 DAG 才需要它,所以单独一个出口;缺 / 不是本 target 名 ⇒ **可修**报(重新部署),不 500。
 */
export async function resolveEmrBinding(
  args: { targetId: string }
): Promise<TargetSparkLanding & { jurisdiction: string; executionRoleArn: string }> {
  const landing = await resolveGlueBinding(args);
  if (landing.home) {
    return { ...landing, ...resolveTargetEmr({ targetId: landing.targetId } as unknown as ExecutionTarget) };
  }
  const t = await requireReadyTarget(landing.targetId);
  try {
    return { ...landing, executionRoleArn: resolveTargetEmr(t).executionRoleArn };
  } catch (e) {
    throw new TargetBindingRejected("missing-component", String((e as Error)?.message ?? e));
  }
}

// 收尾:原 `resolveFlinkBinding` 已删除。它的主控区分支走 env 常量
//   (`resolveGlueBinding` + `resolveTargetFlink` 的 home 分支),与启动侧不是同一口径;现在 Flink 落点只有一个作者
//   `lib/realtime/flink-place.ts#resolveFlinkPlace`(主控区也读描述符 + 必须装 flink 组件),新建与启动共用它。

/** 该 target 的 Glue 客户端(对账/取日志等**读侧**也必须用它 —— 用 home 客户端查非 home 的 JobRun 必然查不到)。 */
export async function glueClientForTarget(targetId: string) {
  const b = await resolveGlueBinding({ targetId });
  return glueClientFor(b.region);
}

export async function assertBindableTargetsForEngine(
  engine: string,
  targets: unknown,
  component: string,
  opts: BindingOpts
): Promise<string[]> {
  const list = bindingTargets({ targets });
  if (engine === "glue" || engine === "emr-serverless") {
    // 🔴 **W3-g 起 Glue 可以绑非 home**(用户 2026-09-04 要求「多种任务在多个区域都跑成功」)。
    // 放开的前提是三处一起做掉了,少任何一处都会变成"看起来在那个区跑、其实不是":
    //   ① 脚本上传 / 建作业 / StartJobRun 全部走**该 target 的** Glue+S3 客户端与脚本桶
    //      (`resolveGlueBinding`);② 运行锁属性按 target 算(`lockAttrFor`),定时与手动同一口径;
    //   ③ 对账/取日志也按 run 的 target 建客户端(否则非 home 的 JobRun 查不到 ⇒ 写坏状态)。
    // 判据仍是**逐个真解析一遍**:资源袋缺项即拒(可修),不静默绑上。
    // 🔴 EMR Serverless 走**同一条**:它要的四样与 Glue 完全相同(脚本桶/角色/产物桶/表桶),
    //    另外还要该区的网络事实(`emrSubnetIds`/`emrSecurityGroupId`,同属 core 必填)——
    //    在 `ensureApplication` 里再校一次(那里能给出"缺哪一项"的准确话)。
    const ok = await assertBindableTargets(list, "core", opts);
    for (const t of ok) await resolveGlueBinding({ targetId: t });
    // 🔴 EMR 还要该 target 的执行角色(SPEC §6.1 段二)。在**绑定那一刻**就核,免得「绑得上、跑不了」
    //    (那是最难查的形态:界面绿、run 在 StartJobRun 那步 AccessDenied)。
    if (engine === "emr-serverless") for (const t of ok) await resolveEmrBinding({ targetId: t });
    return ok;
  }
  return assertBindableTargets(list, component, opts);
}

/**
 * **写入路径**的 target 校验(创建/编辑执行体时调)。
 *
 * 🔴 **为什么必须有**:`api/etl-jobs` 的写入是 `{ ...body, … }` 展开 ——
 * 客户端塞任何 `targetId` 都会原样落库。那个字段决定 SQL 打到哪个区域的数仓,
 * 客户端可随意指定 = **绕过准入 + 绕过跨法域门**,而且落库那一刻不报错、下次运行才发作。
 *
 * @returns 归一后的 targetId(缺省/空 ⇒ `tgt_home`)
 */
/**
 * 绑定校验的上下文:项目白名单判定(SPEC §3.12 v3.22 通用 `access`)。
 *
 * 🔴🔴 **必填判别式,没有默认值**(SPEC §3.9d.8 / 台账):
 *  · `per-project`:项目的业务数据往哪个区落 ⇒ 过 `accessAllows`(白名单的唯一作者,一个字不改);
 *    `projectId: null` = 调用方**显式声明**「这里没有项目上下文」⇒ allowlist 下照旧拒(fail-closed)。
 *  · `platform-global`:建模产物(码表 / 维度·事实表定义)**没有项目维** ⇒ 白名单这条轴对它是 dead-closed
 *    (不存在任何 projectId 能让它过)⇒ **只跳过** `accessAllows`;准入 / 组件校验照旧;
 *    🔴 调用方**必须**另过落点守卫 `assertPlatformGlobalSchema`(否则就是把 fail-closed 换成 fail-open)。
 * 原来是 `{ projectId?: string|null } = {}` —— 「忘了传」与「建模本来就没有项目」在类型上无法区分,
 * 于是建模落地被白名单永久拒、拒因写「(无项目上下文)」(记忆 silent-default-is-a-defect-class)。
 */
export type BindingOpts = { scope: "per-project"; projectId: string | null } | { scope: "platform-global" };

/** 绑定 / 列表两侧共用的白名单判定(呈现 = 授权):platform-global 只跳这一道。 */
function scopeAllows(t: { access?: unknown }, opts: BindingOpts): boolean {
  return opts.scope === "platform-global" ? true : accessAllows(t, opts.projectId);
}

export async function assertBindableTarget(targetId: unknown, component: string, opts: BindingOpts): Promise<string> {
  if (targetId === undefined || targetId === null || targetId === "") return HOME_TARGET_ID;
  if (typeof targetId !== "string" || !isValidTargetId(targetId)) {
    throw new TargetBindingRejected("invalid-target", `非法 targetId:${JSON.stringify(targetId)}`);
  }
  // 🔴 home 也过白名单(通用,不对 home 特殊化 —— 一个只给某几个项目用的 home 也该能设)
  const t = isHome(targetId) ? await getTargetRaw(targetId) : await requireReadyTarget(targetId); // 非 home 强一致准入(不可缓存)
  if (t && opts.scope === "per-project" && !scopeAllows(t, opts)) {
    throw new TargetBindingRejected("project-not-allowed", accessDeniedReason(t, opts.projectId));
  }
  if (isHome(targetId)) return targetId;
  if (!t) throw new TargetBindingRejected("invalid-target", `执行目标 ${targetId} 不存在`);
  assertTargetComponent(t, component);
  // 🔴 原「跨法域一期不放开 ⇒ 拒绑」**已删**(DESIGN §18 决策 6quinquies:平台不设法务门)。
  //    跨法域 target 与同法域走同一条路;它唯一多出来的前置(装 residency-api + per-target 角色)已在
  //    `requireReadyTarget` 的准入内核里(`residencyPrerequisite`),这里不再重复判。
  return targetId;
}

/**
 * 可下推的目标清单(给创建/编辑界面用)。
 *
 * 🔴 **`listActiveTargets()` 已经逐个过了 `requireReadyTarget`**(它的文件头写着扇出下推必须再过一次),
 * 所以这里只需再叠一层"装了该组件"。返回 `unusableReason` 形态的**呈现用**结构 ——
 * 🔴 但**呈现不是授权**:真正的拒还在 `resolveRedshiftBinding`(界面拿到的清单可能已经陈旧)。
 */
/**
 * **顶栏「执行范围」下拉的唯一列表来源**(合同 SPEC v3.36 §2.6.5a)。
 *
 * 🔴 用户 2026-09-09 拍板:「可切换区域下拉列表只能显示现在**已经安装好的**,不存在/没安装的不能出现在
 * 切换区域列表中。系统刚安装初始化出来,理论上只有主控区。」
 *
 * ── 🔴 为什么**不能**复用 `listActiveTargets()`(2026-09-09 真环境当场撞到)────────────────
 * 第一版就是那么写的,结果无头验收第一条判据就红:下拉里**只剩 `tgt_home`**。
 * 原因:`listActiveTargets` 的判据是 `serviceabilityVerdict` = 「**此刻能不能承接新工作**」,它会因为
 * `health=unknown`(一次探活没确认)/ 在途 operation / `intent≠serve` 把一个**装得好好的**区筛掉。
 * 当时 `tgt_usw2_a` 正是 `health=unknown`(上一版代码留下的陈旧探活项),于是那个区**从顶栏消失了** ——
 * 而「东西不见了还不说」正是本包护栏 1 要消灭的头号痛点,更别说用户最需要看它的时候恰恰是它不健康的时候。
 *
 * ⇒ 判据分成两件事,别混:
 *   · **进不进下拉** = 「装好了吗」:描述符有效 ∧ 已完成初始化 ∧ 不是墓碑 ∧ 本项目有授权;
 *   · **能不能承接** = `describeServiceability()`,作为**每项上的徽标**回给前端,不作为过滤条件。
 * 写入路径照旧由 `assertBindableTarget` 拒 —— 那才是「呈现 ≠ 授权」这条原则的正确落点:
 * 看得见 ≠ 跑得动,但**看不见就查不了**。
 */
export async function listScopeTargets(
  opts: BindingOpts
): Promise<
  Array<{
    targetId: string;
    region: string;
    jurisdiction: string;
    isHome: boolean;
    displayName: string;
    components: string[];
    /** 此刻能否承接新工作(徽标用;**不是**过滤条件) */
    serviceable: boolean;
    /** 不可承接的原因(逐字 = 数据面拒因);`null` = 可承接 */
    unusableReason: string | null;
  }>
> {
  const { listTargetsRaw, descriptorViolation, describeServiceability } = await import("@/lib/exec-env/registry");
  const all = await listTargetsRaw();
  const now = Date.now();
  return all
    .filter((t) => typeof t?.targetId === "string" && t.targetId.length > 0)
    // 「能看」的三条判据收成单一作者 `viewabilityVerdict`(读接口点名
    //   `requestedRegisteredPlace` 用同一份 ⇒ 下拉里有的点进去一定解析得开,下拉里没有的点名也拒):
    //   描述符不合格的不列(那不是「装好了」,而是数据坏了)· 墓碑不列(targetId 不可复用)·
    //   🔴 「已安装好」= 初始化跑完过(`ready` 置位 / observed 到过 ready),没装好的不列(用户点名的那一条)。
    .filter((t) => viewabilityVerdict(t, descriptorViolation(t, t.targetId)) === null)
    .filter((t) => scopeAllows(t, opts))
    .map((t) => {
      const sv = describeServiceability(t, t.targetId, now);
      return {
        targetId: t.targetId,
        region: String(t.region || ""),
        jurisdiction: String(t.jurisdiction || "home"),
        isHome: isHome(t.targetId),
        displayName: String(t.displayName || t.targetId),
        components: Array.isArray(t.components) ? t.components.map(String) : [],
        serviceable: sv.usable,
        unusableReason: sv.reason,
      };
    });
}

/**
 * 维度 → 「这个目标装了它要的组件吗」的**唯一作者**(与写入路径同口径,呈现 = 授权):
 *  · redshift:`assertTargetComponent(t, "redshift")` 同一字面;
 *  · airflow:新建编排 `requireMwaaForTargets` 认的两种调度组件 = `SCHEDULER_PREFERENCE_COMPONENT` 值域
 *    (airflow-serverless / mwaa);**主控区恒通过** —— 写路径对 home 不查组件(走部署期 env),列表也不许比写路径更严;
 *  · core:每个已就位目标都有(`listActiveTargets` 已逐个过准入)。
 * 🔴 编排页要 "airflow" 清单而路由只实现了 redshift ⇒ 400 被吞成空列表、「全选当前活跃区(0)」灰了一个月。
 */
const DIM_HAS_COMPONENT: Record<ExecTargetCapabilityDim, (components: readonly string[], home: boolean) => boolean> = {
  redshift: (components) => components.includes("redshift"),
  airflow: (components, home) => home || Object.values(SCHEDULER_PREFERENCE_COMPONENT).some((k) => components.includes(k)),
  core: () => true,
};

export async function listComponentCapableTargets(
  dim: ExecTargetCapabilityDim,
  opts: BindingOpts
): Promise<Array<{ targetId: string; region: string; jurisdiction: string; isHome: boolean }>> {
  const { listActiveTargets } = await import("@/lib/exec-env/registry");
  const all = await listActiveTargets();
  const hasComponent = DIM_HAS_COMPONENT[dim];
  return all
    .filter((t) => hasComponent(Array.isArray(t.components) ? t.components.map(String) : [], isHome(t.targetId)))
    // 🔴 与 `assertBindableTarget` **同一条判据**(呈现 = 授权):项目白名单不放行的 target 不列出来 ——
    //    列出来再拒 = "按钮亮着却 403",本仓已经为这种撕裂立过规矩(判据必须单一作者 `accessAllows`)。
    // 原「跨法域本期不接受绑定 ⇒ 不列」**已删**(不设法务门);跨法域 target 照常列出、带法域标签。
    .filter((t) => scopeAllows(t, opts))
    .map((t) => ({
      targetId: t.targetId,
      region: String(t.region || ""),
      jurisdiction: String(t.jurisdiction || "home"),
      isHome: isHome(t.targetId),
    }));
}

/** 数仓维度的旧名(存量调用点 / 文档引用);等价于 `listComponentCapableTargets("redshift", opts)`。 */
export async function listRedshiftCapableTargets(
  opts: BindingOpts
): Promise<Array<{ targetId: string; region: string; jurisdiction: string; isHome: boolean }>> {
  return listComponentCapableTargets("redshift", opts);
}
