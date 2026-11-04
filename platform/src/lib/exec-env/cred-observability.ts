// @kf-batch 52-P52.5a-supply
// 凭证过渡态的**可观测闭环**(50 SPEC §3.9b「回落可观测(闭环)」格)。
//
// ── 为什么必须有这个文件 ──────────────────────────────────────────────────────
// §3.9b 原文钉了一句很硬的话:「🔴 **仅 `console.warn` + 进程内 Map 不算可观测闭环**」。
// 而 `privileged-cred.noteDegradation` 在 G 批交付时就正好是那个形状,文件里也如实登记了
// 「还缺:审计事件、按 target·project 的指标、provisioning 超时告警、`isolated` 出现 fallback
// 的零容忍告警。补齐属 P52.5a」。本文件就是那四件。
//
// ── 四件里最要紧的是第四件 ───────────────────────────────────────────────────
// 🔴 `isolated` 状态下**出现回落**不是一个"指标偏高"的问题,而是隔离边界已经破了。
// 所以这里的处理不是"记一条告警",而是 **P1 告警 + 直接抛**:
// 让这个不变量在**两个地方**各挡一次(`getPrivilegedCred` 里的 `state === "isolated"` 分支,
// 以及本文件)。将来谁把那个分支挪到回落之后(顺序 bug 在本仓已经出过好几次),
// 这里会立刻炸,而不是安静地发一封告警邮件然后继续把 admin 交出去。
//
// ── 审计为什么是 best-effort、但**不是**静默 best-effort ──────────────────────
// fail-closed-on-audit 是 §3.9a 给 **admin-DDL** 定的(那是低频的权限边界变更)。
// 本文件在 execute / GenBI / data-service 的**热读路径**上:审计表抖一下就把查询页打挂,
// 是拿可用性换了一个本可以补记的证据。⇒ 审计失败**吞异常但计数并告警**,
// 于是"审计静默失效"本身也是可见的 —— 这是与"吞掉就完了"的关键区别。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { putEventIfNew } from "@/lib/alerting/events";
import { writeAuditRecord } from "@/lib/audit";

/** 指标命名空间。与 infra 侧 `cloudwatch:namespace` 条件**逐字一致**(改一处必改两处)。 */
export const CRED_METRIC_NAMESPACE = "BGP/ExecEnv";

const ALERT_RULE_ID = "exec-env-cred-fallback";

export interface CredentialFallbackReport {
  targetId: string;
  projectId: string;
  purpose: string;
  state: string;
  epoch: number;
  provisioningDeadlineAt?: string;
  /** 为什么会回落(进审计,便于区分"还没供给"与"读不到") */
  reason: string;
  /** 可选请求关联 id(§3.9b 要求记 requestId) */
  requestId?: string;
}

// ── 进程内计数(**保留**:单测与 `/api/admin` 排障面要读它;它是补充,不是替代)──
const fallbackCounts = new Map<string, number>();
const failureCounts = { audit: 0, metric: 0, alert: 0 };

export function getCredFallbackCounts(): Record<string, number> {
  return Object.fromEntries(fallbackCounts);
}

/** 可观测通道自身的失败次数。🔴 **"审计写不进去"必须自己也是可见的**,否则等于没有审计。 */
export function getCredObservabilityFailures(): Readonly<typeof failureCounts> {
  return { ...failureCounts };
}

export function __resetCredObservability(): void {
  fallbackCounts.clear();
  resetFailureCounts();
}

function resetFailureCounts(): void {
  failureCounts.audit = 0;
  failureCounts.metric = 0;
  failureCounts.alert = 0;
}

/**
 * 记录一次**过渡态回落**(用了共享 admin 而不是 per-project 凭证)。
 *
 * 🔴 `state === "isolated"` ⇒ **抛**。见文件头第四件。
 */
export async function reportCredentialFallback(r: CredentialFallbackReport): Promise<void> {
  if (r.state === "isolated") {
    // 先尽力把告警发出去(零容忍告警的意义就在于"人必须知道"),再抛。
    await fireAlert({
      severity: "P1",
      dedupeKey: `isolated-fallback#${r.targetId}#${r.projectId}#e${r.epoch}`,
      ruleName: "凭证隔离被破坏:isolated 状态出现 admin 回落",
      message:
        `执行目标 ${r.targetId} 已处于 isolated(凭证隔离稳态),却出现了项目 ${r.projectId} 的共享 admin 回落 ——` +
        `这是隔离边界被破坏,不是指标异常。§3.9b:isolated 状态 fallback 指标必须永久为 0。`,
      projectId: r.projectId,
    });
    throw new Error(
      `凭证隔离不变量被破坏:target ${r.targetId} 处于 isolated 却走到了 admin 回落路径(project=${r.projectId}) ——` +
        `拒绝发放凭证。§3.9b:任何错误、字段缺失、缓存未命中或回滚均不得恢复 admin 回落`
    );
  }

  const key = `${r.targetId}#${r.projectId}#${r.state}#e${r.epoch}`;
  fallbackCounts.set(key, (fallbackCounts.get(key) ?? 0) + 1);

  // ① 审计事件(§3.9b 的字段清单:who / target / project / purpose / state / epoch / requestId / result / at)
  try {
    await writeAuditRecord(
      { actor: "system:privileged-cred" },
      "exec-env.credential.fallback",
      {
        resourceType: "exec-env-credential",
        resourceId: `${r.targetId}#${r.projectId}`,
        detail: {
          purpose: r.purpose,
          credentialIsolationState: r.state,
          credentialEpoch: r.epoch,
          ...(r.provisioningDeadlineAt ? { provisioningDeadlineAt: r.provisioningDeadlineAt } : {}),
          ...(r.requestId ? { requestId: r.requestId } : {}),
          reason: r.reason,
          result: "degraded-to-legacy-admin",
        },
      }
    );
  } catch {
    failureCounts.audit += 1;
    await fireAlert({
      severity: "P2",
      dedupeKey: `fallback-audit-failed#${r.targetId}#${r.projectId}#e${r.epoch}`,
      ruleName: "凭证回落审计写入失败",
      message: `执行目标 ${r.targetId} 项目 ${r.projectId} 的凭证回落**没能写进审计** —— 证据链缺口,须尽快查审计表可用性。`,
      projectId: r.projectId,
    }).catch(() => {});
  }

  // ② 按 target·project 的指标
  await putFallbackMetric(r);

  // ③ fallback 非零告警(§3.9b:"provisioning 超时与 fallback 非零告警")。
  //    dedupe 到 (target, project, state, epoch):同一世代只告一次,推进状态后 epoch++ 会重新可告。
  await fireAlert({
    severity: "P2",
    dedupeKey: `fallback#${r.targetId}#${r.projectId}#${r.state}#e${r.epoch}`,
    ruleName: "凭证过渡态回落(仍在用共享 admin)",
    message:
      `执行目标 ${r.targetId} 的项目 ${r.projectId} 仍在用共享 admin 凭证(state=${r.state},epoch=${r.epoch}` +
      `${r.provisioningDeadlineAt ? `,截止 ${r.provisioningDeadlineAt}` : ""})。` +
      `这是受控过渡态,但必须收敛:补齐 per-project 凭证后推进到 isolated。`,
    projectId: r.projectId,
  }).catch(() => {});
}

/**
 * `provisioning` 窗口**已过期**(准入侧已 fail-closed 拒绝)。
 *
 * 🔴 告警**不能替代硬拒**(§3.9b 原话),所以调用点是"拒绝之前顺手报一声",
 * 而不是"报了警就放行"。
 */
export async function reportProvisioningExpired(r: {
  targetId: string;
  projectId: string;
  provisioningDeadlineAt?: string;
  epoch: number;
}): Promise<void> {
  await fireAlert({
    severity: "P1",
    dedupeKey: `provisioning-expired#${r.targetId}#e${r.epoch}`,
    ruleName: "凭证供给窗口已过期(project-context 已 fail-closed)",
    message:
      `执行目标 ${r.targetId} 的 provisioning 窗口已过期(deadline=${r.provisioningDeadlineAt ?? "缺失"})。` +
      `自此 project-context 一律拒绝,业务会报错 —— 这是设计的收敛压力。` +
      `处置:补齐 per-project 凭证并推进到 isolated;延期必须走受审计的专用操作,不得继续用共享 admin 拖着。`,
    projectId: r.projectId,
  }).catch(() => {});
}

async function putFallbackMetric(r: CredentialFallbackReport): Promise<void> {
  try {
    const { CloudWatchClient, PutMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
    const cw = sdkClient("control-plane", CloudWatchClient, { region: homeRegion() });
    await cw.send(
      new PutMetricDataCommand({
        Namespace: CRED_METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: "CredentialFallback",
            Value: 1,
            Unit: "Count",
            Dimensions: [
              { Name: "TargetId", Value: r.targetId },
              { Name: "ProjectId", Value: r.projectId },
              { Name: "IsolationState", Value: r.state },
            ],
          },
        ],
      })
    );
  } catch {
    failureCounts.metric += 1;
  }
}

async function fireAlert(a: {
  severity: "P1" | "P2" | "P3";
  dedupeKey: string;
  ruleName: string;
  message: string;
  projectId: string;
}): Promise<void> {
  try {
    await putEventIfNew({
      ruleId: ALERT_RULE_ID,
      ruleName: a.ruleName,
      severity: a.severity,
      projectId: a.projectId,
      dedupeKey: a.dedupeKey,
      message: a.message,
      trigger: {},
    });
  } catch {
    failureCounts.alert += 1;
  }
}
