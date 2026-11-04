// **数仓直查:多 region 并行提交**(50 INTERACTION §4septies,用户 2026-09-04 定的交互)。
//
// ── 这一刀解决什么 ──────────────────────────────────────────────────────────
// 用户要的是「一条 SQL 打多个 region,结果用多个 sheet 展示,切 sheet 看各区数据」,
// 并且明确了两条约束:
//   ① 🔴 **各区快慢不一,不许等所有区都回来再展示**;
//   ② 🔴 某区报错(表不存在 / 权限 / 其它)就把**错误展示在它自己的 sheet 里**。
//
// ── 落地形态:提交与取结果**彻底拆开** ─────────────────────────────────────
// Redshift Data API 本来就是异步的(submit → `statementId` → poll),所以不需要发明机制:
//   · 本文件只负责 **提交**:逐 target 并发 submit,立刻返回每个 target 的
//     `{statementId?, handleId?, submitError?}` —— **一个都不等**;
//   · 取结果由 `/api/redshift/result/[id]` 逐 sheet 各自轮询(region 取自**句柄**)。
// ⇒ "谁先回来谁先能看" 是这个拆分的**自然结果**,而不是靠前端 setTimeout 凑出来的。
//
// ── 🔴 与「发布下推」相反:这里**不 fail-fast** ─────────────────────────────
// 下发是**写**:一个区失败要停住(避免把半套产物撒出去)。
// 直查是**只读**:一个区失败,别的区的结果照样有价值 ⇒ 逐 target 各自 try,失败只记在那一行。
// 这条差异写在这里,免得后人"统一"成同一套而把其中一个弄坏。
//
// ── 🔴 提交阶段的错误必须与执行阶段的错误分开 ──────────────────────────────
// 「目标没装 redshift / 落点冲突 / 缺凭证 / 跨法域」在**提交前**就能判定 ⇒ 那一行直接给
// `submitError`,**不进入轮询**。让它假装"正在执行"是最坏的形态:用户会一直等一个永远不会回来的结果。

import { homeRegion } from "@/lib/place/home-region";
// 多区扇出的唯一写法(L10)
import { forEachTargetPlace } from "@/lib/place/fanout";
import { ExecuteStatementCommand } from "@aws-sdk/client-redshift-data";
import { resolveRedshiftBinding, TargetBindingRejected, bindingTargets } from "@/lib/exec-env/data-plane-target";
import { redshiftDataClientFor } from "@/lib/exec-env/target-clients";
// 可审计闭包(跨法域 target 提交前写区域审计;写不成即拒)
import { residencyAudit, userActor, isResidencyError } from "@/lib/exec-env/residency-audit";
import { AuditUnavailable } from "@/lib/exec-env/residency";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { ZEROETL_WORKGROUP, getZeroEtlSecretArn } from "@/lib/realtime/zeroetl-service";
import { issueHandle } from "@/lib/security/query-handle";
import type { Identity } from "@/lib/auth/identity";

/**
 * 一次点击最多打几个区。
 *
 * 🔴 **N 个区 = N 份费用 + N 份连接**。不设上限的话,一个「全选活跃区」在有 30 个 region 的
 * 部署里会把一次点击放大成 30 次扫描 —— 那属于"界面把爆炸半径悄悄放大",本仓已为同类问题立过规矩。
 * 界面侧另外要把区数写在按钮上(与离线计算的「立即运行(2 个区各跑一次)」同一条口径)。
 */
export const MAX_QUERY_FANOUT = 8;

export type QueryErrorKind =
  | "table-missing"
  | "permission-denied"
  | "target-not-ready"
  | "warehouse-conflict"
  | "credential-missing"
  | "timeout"
  | "syntax"
  // 跨法域 target 的两类拒因(审计完整性 / 同意前置),不是引擎错
  | "audit-unavailable"
  | "ack-required"
  | "other";

export interface ClassifiedError {
  kind: QueryErrorKind;
  /** 一句**可执行**的处置建议(去哪修),不是复述错误。 */
  hint: string;
}

const HINTS: Record<QueryErrorKind, string> = {
  "table-missing": "该区域还没有这张表 —— 去「数据同步」给它建一条到该执行目标的同步任务,或改查该区确实存在的表。",
  "audit-unavailable": "该执行目标的区域审计表当前写不进去,查询未提交(审计完整性:写不成即拒)—— 稍后重试;持续出现请检查该目标的 residency-api 组件探活。",
  "ack-required": "对该跨法域执行目标的操作需要先同意免责告知 —— 页面会弹出告知,同意后重试即可。",
  "permission-denied": "该区域的执行身份没有这张表的权限 —— 去「执行环境管理 › 凭证状态」给本项目补供给,或让表属主授权。",
  "target-not-ready": "该执行目标未就绪或没装 redshift 组件 —— 去「执行环境管理」补充部署该组件、等初始化完成后重试。",
  "warehouse-conflict": "你指定的 workgroup/database 与该目标描述符不一致 —— 清空这两个输入框,让平台按目标的实际落点执行。",
  "credential-missing": "解析不到该目标的执行凭证 —— 去「执行环境管理 › 凭证状态」给本项目做一次凭证供给。",
  timeout: "该区域执行超时 —— 后台可能仍在跑;可继续等,或只取消这一个区域(不影响其它 sheet)。",
  syntax: "SQL 语法错误 —— 各区跑的是同一条 SQL,若只有这个区报语法错,通常是该区方言/版本差异。",
  other: "看上面的原始错误;若判断不了,把该区落点(region / workgroup / database)一起发给运维。",
};

/**
 * 归类**执行阶段**的错误(来自 Redshift 的 `DescribeStatement.Error` 文本)。
 *
 * 🔴 **只能靠文本匹配**(引擎只给文本),所以判据必须**降级安全**:
 * 匹配不上就是 `other`,而 `other` 仍然把**原始错误原文**展示给用户 ⇒ 归类漏了只是少一句建议,
 * 绝不会把错误吞掉或改写。这与"用文本匹配做安全判定"是两回事(那种必须禁)。
 */
export function classifyEngineError(raw: string | null | undefined): ClassifiedError {
  const m = String(raw ?? "");
  const kind: QueryErrorKind = /relation\s+"?[^"]*"?\s+does not exist|does not exist|not found|undefined table/i.test(m)
    ? "table-missing"
    : /permission denied|not authorized|access denied|must be owner|insufficient privilege/i.test(m)
      ? "permission-denied"
      : /timed?\s*out|timeout/i.test(m)
        ? "timeout"
        : /syntax error/i.test(m)
          ? "syntax"
          : "other";
  return { kind, hint: HINTS[kind] };
}

/**
 * 归类**提交阶段**的错误。
 *
 * 🔴 平台自己抛的 `TargetBindingRejected` **按 `reason` 字段判,不按文案判** ——
 * 拿自家错误的文案做判据,改一次文案就静默错分类(而文案是给人看的、经常改)。
 */
export function classifySubmitError(e: unknown): ClassifiedError {
  if (e instanceof TargetBindingRejected) {
    const kind: QueryErrorKind =
      e.reason === "missing-component"
        ? "target-not-ready"
        : e.reason === "warehouse-conflict"
          ? "warehouse-conflict"
          : e.reason === "no-credential"
            ? "credential-missing"
            : "target-not-ready"; // 原「跨法域 ⇒ 专用错误类」分支已删(不设法务门;project-not-allowed 走 target-not-ready 的可修口径)
    return { kind, hint: HINTS[kind] };
  }
  return classifyEngineError((e as Error)?.message ?? String(e));
}

/** 一个 target 的提交结果。🔴 **绝不含 secretArn / 用户名** —— 它会整包回给浏览器。 */
export interface QuerySubmission {
  targetId: string;
  region: string;
  workgroup: string;
  database: string;
  home: boolean;
  /** 执行身份**形态**(不是标识):`per-project` / `shared-admin` / `worker-iam` */
  credential: "per-project" | "shared-admin" | "worker-iam";
  /** 该目标的法域(只作 🌍 标签 + 审计维度;:不再驱动「合并」是否可用)。 */
  jurisdiction: string;
  /** 跨法域 target 的区域审计 ID(提交前写;home / 同法域无)。sheet 头显示「审计 #…」 */
  auditId?: string;
  statementId?: string;
  handleId?: string;
  /** 提交阶段就失败 ⇒ 该 sheet 立刻显示错误,**不进入轮询** */
  submitError?: string;
  errorKind?: QueryErrorKind;
  errorHint?: string;
}

/**
 * 逐 target 并发提交同一条 SQL。
 *
 * @returns 每个 target 一行,**顺序与入参一致**(界面按它排 sheet;home 在最前由调用方保证)
 *
 * 🔴 **并发而不是串行**:提交是短动作(实测 ~300ms),串行会让第 8 个区白等 2 秒;
 * 而且它们互相独立 —— 串行唯一的好处(共因错误只犯一次)在只读路径上不值这个延迟。
 */
export async function submitToTargets(args: {
  sql: string;
  targets: string[];
  projectId: string;
  identity: Identity;
  workgroupOverride?: string | null;
  databaseOverride?: string | null;
}): Promise<QuerySubmission[]> {
  const list = normalizeQueryTargets(args.targets);
  if (list.length > MAX_QUERY_FANOUT) {
    throw new Error(
      `一次最多同时查询 ${MAX_QUERY_FANOUT} 个执行目标(收到 ${list.length} 个)—— ` +
        `每个区都是一次独立扫描与计费,超过上限请分批`
    );
  }
  // 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):每个区一个分支、各自一个嵌套落点上下文。
  //   仍是并发、顺序与入参一致;解析不开的区照样交给 submitOne,由它原来的那套报错写进该 sheet 的 submitError(不改报错形状)。
  return forEachTargetPlace(list, (targetId) => submitOne(targetId, args), { via: "submitToTargets" });
}

async function submitOne(
  targetId: string,
  args: {
    sql: string;
    projectId: string;
    identity: Identity;
    workgroupOverride?: string | null;
    databaseOverride?: string | null;
  }
): Promise<QuerySubmission> {
  const home = isHome(targetId);
  try {
    const binding = await resolveRedshiftBinding({
      targetId,
      projectId: args.projectId,
      workgroupOverride: args.workgroupOverride,
      databaseOverride: args.databaseOverride,
    });
    // 🔴 **zero-etl 独立 namespace 的既有语义必须一字不动**:它有自己的 admin 密钥,
    // 主 namespace 的密钥认不过去(实测 `FATAL password authentication failed`),
    // 而 per-project 身份在那个 namespace 里根本不存在。它只在 home 出现。
    const SecretArn =
      home && binding.workgroup === ZEROETL_WORKGROUP ? await getZeroEtlSecretArn() : binding.secretArn;
    // 🔴 **提交之前**写区域审计(entry=execute;SPEC v3.23 §3.2):home / 同法域 ⇒ null,一字不变;
    //    跨法域 ⇒ 区域全量(SQL 原文 / operator)+ 中央摘要(sqlHash),写不成 ⇒ 这一 target **不提交**、sheet 显示
    //    `audit-unavailable`,其它 target 照跑(路由已在扇出前对全部 target 做过同意前置,这里的 ack-required 只剩并发竞态)。
    let auditId: string | undefined;
    try {
      const a = await residencyAudit({
        actor: userActor(args.identity),
        targetId,
        entry: "execute",
        sqlText: args.sql,
        projectId: args.projectId,
        knownJurisdiction: binding.jurisdiction,
      });
      auditId = a?.auditId;
    } catch (e) {
      if (isResidencyError(e)) {
        const kind: QueryErrorKind = e instanceof AuditUnavailable ? "audit-unavailable" : "ack-required";
        return {
          targetId,
          region: binding.region,
          workgroup: binding.workgroup,
          database: binding.database,
          home,
          credential: "worker-iam",
          jurisdiction: binding.jurisdiction,
          submitError: e.message.slice(0, 900),
          errorKind: kind,
          errorHint: HINTS[kind],
        };
      }
      throw e;
    }
    const client = redshiftDataClientFor(binding.region);
    const { Id } = await client.send(
      new ExecuteStatementCommand({
        Sql: args.sql,
        WorkgroupName: binding.workgroup,
        Database: binding.database,
        ...(SecretArn ? { SecretArn } : {}),
        // 🔴 statement ↔ 区域审计的**关联**:execute 审计是提交**之前**写的(写不成即拒的前提),
        //    行内不可能有 statementId;把 auditId 设成 Redshift 语句的 StatementName ⇒ 从 Redshift 侧一查即得「这条语句对应哪条审计」。
        //    home / 同法域没有 auditId ⇒ 不设(存量请求逐字节不变)。
        ...(auditId ? { StatementName: auditId } : {}),
      })
    );
    // 🔴 句柄带上 `targetId` —— 取结果侧凭它解析 region(statementId 是 region 内的)。
    // 不带的话:非 home 的结果永远取不回来,前端卡在「执行中」。
    const handleId = Id
      ? await issueHandle({
          statementId: Id,
          identity: args.identity,
          projectId: args.projectId,
          engine: "redshift",
          targetId,
          jurisdiction: binding.jurisdiction,
        })
      : undefined;
    return {
      targetId,
      region: binding.region,
      workgroup: binding.workgroup,
      database: binding.database,
      home,
      credential: !SecretArn ? "worker-iam" : binding.degradedToLegacyAdmin ? "shared-admin" : "per-project",
      jurisdiction: binding.jurisdiction,
      ...(auditId ? { auditId } : {}),
      statementId: Id,
      handleId,
    };
  } catch (e) {
    const c = classifySubmitError(e);
    return {
      targetId,
      region: home ? homeRegion() : "?",
      workgroup: "?",
      database: "?",
      home,
      credential: "worker-iam",
      jurisdiction: home ? "home" : "unknown",
      submitError: String((e as Error)?.message ?? e).slice(0, 900),
      errorKind: c.kind,
      errorHint: c.hint,
    };
  }
}

/**
 * 归一查询的 target 列表:去重 + 过滤空值 + 缺省 home + 🔴 **home 排最前**。
 *
 * home 排最前的理由与扇出下发一致但更弱:这里不 fail-fast,所以只是**呈现顺序**——
 * 让"本地"永远是第一个 sheet,用户的肌肉记忆不会因为勾选顺序而变。
 */
export function normalizeQueryTargets(targets: unknown): string[] {
  const list = bindingTargets({ targets });
  const dedup = list.filter((x, i) => list.indexOf(x) === i);
  return dedup.slice().sort((a, b) => (isHome(a) ? -1 : isHome(b) ? 1 : 0));
}

// 原 `crossJurisdiction()`(跨法域时禁用「合并为一张表」)**已删**:
//    DESIGN §18 决策 6quinquies(平台不设法务门):合并对跨法域 target **可用**,查询已审计(INTERACTION v2.17 §4bis.3 / §4septies.6)。

export { HOME_TARGET_ID };
