// @kf-batch 50-G2
// Redshift 统一执行身份（admin 超级用户密钥）。
//
// 平台所有 Redshift Data API 调用（ETL 作业、调度 DAG、Redshift 查询页、GenBI、指标、质量）
// 都应以这一个 admin 身份执行，确保：
//   1) 表属主一致——任意路径建的表，其它路径都能读/改（修复 v1.6.1 的跨身份属主问题，
//      以及"作业建的表在查询页/智能问数 permission denied"）。
//   2) 行为可预期。
// 解析失败（无密钥）时回退到调用者的联邦身份（本地/无密钥环境）。
//
// ── 🔴 G6(模块 50)改造:进程级**单值**缓存 → **复合键**缓存 ───────────────────────
// 原状:`let _arn` 是一个进程级单值。单 region + 单 project 时它是对的;一旦多 target,
// **第一个 target 解析出的 secret 会被所有 target 复用** —— 那是跨边界串值,
// 而且不会报错、只会"看起来正常地连到别的区域"。
// 改法:键 = `${targetId}#${project ?? "-"}#${purpose}`(SSOT 见 lib/exec-env/cred-cache.ts)。
// `purpose` 维不可省:少了它,class② 只读治理身份与 class③ admin-DDL 会共用缓存槽 = 权限提升。
//
// 🔴 **本次改造刻意不改函数签名、不改 home 行为**:既有的 **16 处调用表达式、分布 14 个文件** 一处未动(SPEC §S10 明确把
// (🔴 数字口径:`node scripts/ast-count-callsites.mjs getRedshiftSecretArn`,**AST 计数、不含测试、不含定义文件自引用**。
//  此处原写 17/15 是错的 —— 用 grep 数会把注释里出现的函数名也算进去,外部审核 v2 P2-3 已坐实。)
// 「禁裸调 getRedshiftSecretArn」这条 lint 推迟到 P52.5a)。无参调用 == 从前的 home 路径,
// 逐字节等价:同一个 env、同一个 DescribeSecret、同样缓存负结果。
// 非 home target **不在本函数职责内**(它不该从 env 猜别的区域的 secret)⇒ 显式抛错并指向
// `getPrivilegedCred`(§3.9)。G 阶段无人传非 home,故行为变化为 0。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { credCacheKey, ProcessCache } from "@/lib/exec-env/cred-cache";

const region = homeRegion();
const REDSHIFT_SECRET_ID = process.env.REDSHIFT_SECRET_ID || "redshift!bgp-namespace-admin";

/**
 * 复合键缓存。value 为 `null` 表示"解析过但不可用"——
 * 与改造前 `_arn = null` 的语义一致(不可用也要缓存,否则每次调用都打一次 Secrets Manager)。
 */
const arnCache = new ProcessCache<string>();

/** 本文件代表的凭证用途:过渡期的**单一 admin secret**。与 §3.9 的三类枚举区分开,便于审计与 grep。 */
const PURPOSE = "legacy-single-admin";

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 52-P52.5a-supply —— per-project 身份的**接线开关**
//
// 用户 2026-09-03 拍板「一笔做完,用 env flag 兜」,并明确接受代价:
// **flag 是永久分叉点,两条身份路径都要长期维护和测试**。所以这里有两条硬纪律:
//   ① **缺省 off = 现网行为逐字节不变**(同 env、同 DescribeSecret、同缓存键);
//   ② **on / off 两态都必须跑同一组断言** —— 用户接受了代价,那就得把代价兑现成测试,
//      而不是"加了个 flag,只测了关着的那一态"。
//
// 🔴 **判定按调用点静态归类**(§3.9 原文:"非运行时看 SQL 猜"):
// 传了 `project` 的调用点 = project-context;不传的 = governance-read / bootstrap / 清点类,
// 它们**继续用共享 admin**,而且这是**合同规定的**(§3.9 case "governance-read":
// 「🔴 【绝不】走 lookupProjectSecretArn(它们本无 project ⇒ 会被误判 fail-closed)」)。
//
// 🔴 **flag=on 不等于"随时可以开"**:per-project 身份只看得见 `proj_<id>` 与 `shared`,
// 而现网数据仍在 `public`(数据面搬迁是 **P52.5b**)。⇒ 开 flag 的正确前提是 P52.5b 已落。
// 这条约束如实写在这里,不靠"验收时再发现"。
// ══════════════════════════════════════════════════════════════════════════════

/** per-project 身份是否启用。🔴 缺省 **off**;只认字面量 `on`(避免 "1"/"true"/"yes" 各家一套)。 */
export function perProjectCredEnabled(): boolean {
  return String(process.env.PER_PROJECT_CRED ?? "").trim().toLowerCase() === "on";
}

export async function getRedshiftSecretArn(opts?: {
  /** 缺省 home;非 home 且未开 flag 请走 getPrivilegedCred(§3.9)。 */
  targetId?: string;
  /**
   * 🔴 **调用点的静态归类**:传了它 = 该调用点属 project-context。
   * flag=off 时它**只参与缓存键**(与改造前逐字节等价);flag=on 时它决定走 per-project 身份。
   */
  project?: string;
}): Promise<string | undefined> {
  const targetId = opts?.targetId ?? HOME_TARGET_ID;

  if (perProjectCredEnabled() && opts?.project) {
    // 转调 §3.9 的工厂:状态机判定 / per-project 查找 / 受控回落 / 可观测闭环全在它里面。
    // 🔴 这里**不做任何兜底**:工厂抛就抛(fail-closed)。加 `catch → 回落 admin` 等于把
    //    §3.9b 的整套状态机作废(拒绝清单第 5 条:"用 feature flag 默认关安全逻辑、异常自动回旧 admin")。
    const { getPrivilegedCred } = await import("@/lib/exec-env/privileged-cred");
    const cred = await getPrivilegedCred(targetId, { purpose: "project-context", project: opts.project });
    if (cred.kind !== "project-context") {
      throw new Error(`purpose=project-context 却拿到 ${cred.kind} 形态的凭证 ⇒ 拒绝(形态不符不得放行)`);
    }
    return cred.secretArn;
  }

  if (!isHome(targetId)) {
    throw new Error(
      `getRedshiftSecretArn 只负责 home 的单一 admin secret;target ${targetId} 请走 ` +
        `getPrivilegedCred(targetId, { purpose: "project-context" })(50 SPEC §3.9)`
    );
  }
  const key = credCacheKey({ targetId, project: opts?.project, purpose: PURPOSE });
  const v = await arnCache.resolve(key, async () => {
    try {
      const { SecretsManagerClient, DescribeSecretCommand } = await import("@aws-sdk/client-secrets-manager");
      const sm = sdkClient("data-plane", SecretsManagerClient, { region });
      const r = await sm.send(new DescribeSecretCommand({ SecretId: REDSHIFT_SECRET_ID }));
      return r.ARN || null;
    } catch {
      return null;
    }
  });
  return v || undefined;
}

/** 单测 / 排障用:清缓存。 */
export function __resetRedshiftSecretArnCache(): void {
  arnCache.clear();
}
