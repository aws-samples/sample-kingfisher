// @kf-batch 50-G2R
// G2R(模块 50)—— per-target 特权凭证工厂 `getPrivilegedCred()`(50 SPEC §3.9 + §3.9b v3.3)。
//
// 🔴 **仍是"空转"**:本模块**没有任何生产调用方**(既有 16 处 `getRedshiftSecretArn()` 调用、
// 分布在 14 个文件里,一处未动)。SPEC §S10 明确把「禁裸调」这条 lint 推迟到 P52.5a。
// ⇒ 上线对现网行为影响为 0。**P0-3 / P0-5 均"仍未关闭"**(拍板 C 口径)。
//
// ── 三类 purpose 的枚举名以 52 §3.4 为准(v3.0 统一)────────────────────────────
// 早前 50 与 52 各立了一套枚举、而且**同名 `governance-read` 语义相反** ——
// 照旧版 50 实现会让治理/指标/质量/敏感扫描全被 fail-closed 拒,那正是 52 P0-3 要防的失败模式。
//
// ── v3.3 相对 v3.2 改了什么(外部审核 v2 P0-3 整改,用户拍板 A)────────────────────
// 旧实现用 `!capabilities.includes("per-project-cred")` 决定是否回落 admin。两处硬伤(实测坐实):
//   ① **负向推断决定权限**:字段丢失 / 回滚 / DDB 读失败都会被解释成"legacy" ⇒ 已隔离的 target
//      可以重新拿到 admin = fail-open。
//   ② **回落结果进了无 TTL 进程缓存** ⇒ 探针实测:capability 切到就绪后,**第二次调用仍返回
//      `degraded=true` 的旧 admin**,隔离切换永远收敛不了。
// 现改为 §3.9b 的**持久化、单调不可逆**状态机:
//   · 状态**必须显式存在**(`credentialIsolationState`);缺失/未知 ⇒ **拒绝**,绝不隐式当 legacy;
//   · `isolated` ⇒ 缺项目凭证即 fail-closed,**永不回落**;
//   · 回落**只允许** `legacy-seeded` / 受控 `provisioning`,且**结果不进缓存**;
//   · 缓存键含 `credentialEpoch` ⇒ 状态迁移/secret 轮换后旧槽自然失效。
//
// 🔴 **legacy 回落本身保留,没有删**:删掉它会在 per-project 凭证供给完成前打断
// execute / GenBI / data-service = 砍核心功能(建议书 §5 拒绝清单第 1 条)。
//
// ── class③ 为什么不在这里 ────────────────────────────────────────────────────
// 外部审核 v1 P0-5:旧稿的 admin-ddl 分支最后 `return cached(admin)`,**把 raw admin secret 交给调用方**。
// 定案:admin-ddl 一律走 §3.9a 的闭合执行器。本文件的 admin-ddl 分支**直接抛**。
// 🔴 类型层硬约束(验收可断):**本模块不导出任何返回 Secret / SecretArn 的 admin 路径。**

import { requireReadyTarget, type ExecutionTarget } from "@/lib/exec-env/registry";
import { credCacheKey, ProcessCache } from "@/lib/exec-env/cred-cache";
import { assertProjectId } from "@/lib/exec-env/project-schema";
// @kf-batch 52-P52.5a-supply
import { lookupProjectSecretArn } from "@/lib/exec-env/project-secret";
import { reportCredentialFallback, reportProvisioningExpired } from "@/lib/exec-env/cred-observability";

export type Purpose = "project-context" | "governance-read" | "admin-ddl";

/** 凭证隔离状态(50 SPEC §3.9b)。**单调不可逆**:legacy-seeded → provisioning → isolated。 */
export type CredentialIsolationState = "legacy-seeded" | "provisioning" | "isolated";

const ISOLATION_STATES: ReadonlySet<string> = new Set<CredentialIsolationState>([
  "legacy-seeded",
  "provisioning",
  "isolated",
]);

export interface CredentialIsolation {
  state: CredentialIsolationState;
  epoch: number;
  /**
   * 🔴 `provisioning` 窗口的截止时间(§3.9b:"回落不得无期限")。
   * v3.7 起它**参与准入判定**,不再只是个存着好看的字段(外部审核 v4 P1-4)。
   */
  provisioningDeadlineAt?: string;
}

/**
 * class② 的返回形态。
 *
 * ⚠️ **如实登记(外部审核 v2 P1-3,仍未修)**:这仍然只是个**声明式 marker**,不是受控只读执行能力
 * —— 52 §3.4 要求的四道收口里,本类型只体现了 (a) 只读身份;**(b) 返回形态约束、(c) 强 RBAC、
 * (d) 全程审计**尚未落地,而且任何内部代码都能构造同形对象。
 * 改成不透明的受控 executor 属 P52.5a;在那之前**不要**把它当成隔离保证。
 */
export interface GovernanceReadIdentity {
  kind: "governance-read";
  targetId: string;
  readOnly: true;
}

/** class① 的返回形态:项目上下文凭证的 **ARN**(不是密钥明文)。 */
export interface ProjectContextCred {
  kind: "project-context";
  targetId: string;
  project: string;
  secretArn: string;
  /** `true` = 走了过渡回落(用的是单一 admin secret,不是 per-project 凭证)。 */
  degradedToLegacyAdmin: boolean;
  /** 本次判定所依据的隔离状态与世代(进审计,便于事后复盘"当时凭什么放行")。 */
  isolation: CredentialIsolation;
}

export type PrivilegedCred = ProjectContextCred | GovernanceReadIdentity;

const cache = new ProcessCache<PrivilegedCred>();

export function __resetCredCache(): void {
  cache.clear();
}

// ——————————————————————————————————————————————————————————————
// 过渡态可观测性
// ——————————————————————————————————————————————————————————————

const degradation = new Map<string, number>();

/**
 * 过渡回落计数(按 `targetId#project#state#epoch`)。
 *
 * @kf-batch 52-P52.5a-supply
 * ✅ **§3.9b 的可观测闭环已在本批补齐**(此前这里只有计数 + `console.warn`,而 §3.9b 明写
 * 「仅 `console.warn` + 进程内 Map 不算可观测闭环」)。四件都落在
 * `cred-observability.ts`:审计事件 / 按 target·project 的指标 / provisioning 超时告警 /
 * `isolated` 出现 fallback 的**零容忍告警(P1 + 直接抛)**。
 * 本计数**保留**:它是单测与排障面的读点,是补充而不是替代。
 */
export function getCredDegradationCount(): Record<string, number> {
  return Object.fromEntries(degradation);
}

export function __resetCredDegradation(): void {
  degradation.clear();
}

/**
 * 🔴 `async` 了 —— 因为可观测闭环要落审计/指标/告警(都是 IO)。
 * 调用点必须 `await`:不 await 就等于"回落已经发生、证据还在天上飞",
 * 而请求可能先返回、进程可能先被回收(ECS 滚动时尤其容易)。
 */
async function noteDegradation(targetId: string, project: string, iso: CredentialIsolation): Promise<void> {
  const k = `${targetId}#${project}#${iso.state}#e${iso.epoch}`;
  degradation.set(k, (degradation.get(k) ?? 0) + 1);
  await reportCredentialFallback({
    targetId,
    projectId: project,
    purpose: "project-context",
    state: iso.state,
    epoch: iso.epoch,
    ...(iso.provisioningDeadlineAt ? { provisioningDeadlineAt: iso.provisioningDeadlineAt } : {}),
    reason: "no-per-project-secret",
  });
}

// ——————————————————————————————————————————————————————————————
// 状态读取(禁止推导)
// ——————————————————————————————————————————————————————————————

/**
 * 读凭证隔离状态。
 *
 * 🔴 **缺失 / 未知 / epoch 非法 ⇒ 一律抛**(§3.9b:"缺状态不得解释为 legacy")。
 * 这正是 v3.2 那版最危险的地方:它把"读不到"当成 legacy,于是任何字段丢失都变成一次提权。
 */
export function requireCredentialIsolationState(t: ExecutionTarget): CredentialIsolation {
  const raw = t as unknown as Record<string, unknown>;
  const state = raw.credentialIsolationState;
  const epoch = raw.credentialEpoch;
  if (typeof state !== "string" || !ISOLATION_STATES.has(state)) {
    throw new Error(
      `target ${t.targetId} 的 credentialIsolationState 缺失或未知(${JSON.stringify(state)})—— 拒绝。` +
        `缺状态不得解释为 legacy(50 SPEC §3.9b);存量 home 须由部署迁移脚本显式 seed 为 legacy-seeded`
    );
  }
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`target ${t.targetId} 的 credentialEpoch 非法(${JSON.stringify(epoch)})—— 拒绝`);
  }
  const deadline = raw.provisioningDeadlineAt;
  // 🔴 v3.7:`provisioning` **必须**有可解析的 deadline(§3.9b + 外部审核 v4 P1-4)。
  // 之前它只在**写**的时候被检查"非空",读路径完全不看 ⇒ 用一个过去时间、
  // 或一个 `"soon"` 这样的垃圾串进了 provisioning,就能**无限期**使用共享 admin。
  if (state === "provisioning") {
    if (typeof deadline !== "string" || !Number.isFinite(Date.parse(deadline))) {
      throw new Error(
        `target ${t.targetId} 处于 provisioning 但 provisioningDeadlineAt 缺失或无法解析` +
          `(${JSON.stringify(deadline)})—— 拒绝。§3.9b:回落不得无期限;缺 deadline 不得解释为"还在窗口内"`
      );
    }
  }
  return {
    state: state as CredentialIsolationState,
    epoch,
    provisioningDeadlineAt: typeof deadline === "string" ? deadline : undefined,
  };
}

/**
 * 🔴 `provisioning` 窗口是否已过期(v3.7,外部审核 v4 P1-4)。
 *
 * 语义只有一个方向:**过期 ⇒ 与 `isolated` 同样 fail-closed**。
 * 「有告警」不能代替「准入时硬拒」—— 告警是给人看的,硬拒才是边界。
 */
export function provisioningExpired(iso: CredentialIsolation, now = Date.now()): boolean {
  if (iso.state !== "provisioning") return false;
  const ms = iso.provisioningDeadlineAt ? Date.parse(iso.provisioningDeadlineAt) : NaN;
  if (!Number.isFinite(ms)) return true; // 解析不出 = 当作已过期(fail-closed 方向)
  return now > ms;
}

// @kf-batch 52-P52.5a-supply
// 🔴 **原来这里是一个 `return undefined` 的 stub**(G 阶段正确:per-project secret 还不存在)。
// 现在换成真查找 —— 它住在 `project-secret.ts`,因为供给层也要用同一份(避免第二个作者),
// 而且**读失败必抛**(不许把读失败等价成"没有凭证" ⇒ 那会静默回落 admin)。

/**
 * 单一 admin secret 的 ARN —— **过渡态专用**,取自描述符的实名资源袋。
 * 🔴 不从 env 现读:工厂的意义就是"按 target 取",读 env 就又把 home 钉死了。
 */
function legacySingleAdminSecretArn(t: ExecutionTarget): string {
  const arn = (t.resources ?? {})["redshiftSecretArn"];
  if (typeof arn !== "string" || !arn) {
    throw new Error(
      `target ${t.targetId} 的描述符里没有 redshiftSecretArn —— 拒绝(过渡态也必须有实名 secret;` +
        `home 描述符该项由部署迁移脚本写入,不由运行时猜)`
    );
  }
  return arn;
}

// ——————————————————————————————————————————————————————————————
// 工厂
// ——————————————————————————————————————————————————————————————

/**
 * per-target 特权凭证工厂(SPEC §3.9)。
 * 判定**按调用点静态归类**(purpose 由调用点写死),**不在运行时看 SQL 猜意图**。
 */
export async function getPrivilegedCred(
  targetId: string,
  opts: { purpose: Purpose; project?: string }
): Promise<PrivilegedCred> {
  const { purpose } = opts;
  // 🔴 先过 fail-closed 的目标校验。绝不 `?? homeTarget`(v1 审核 P0-4)。
  const t = await requireReadyTarget(targetId);

  switch (purpose) {
    case "governance-read": {
      // 🔴 【绝不】走 lookupProjectSecretArn:治理类本无 project ⇒ 会被误判 fail-closed(52 P0-3)。
      const key = credCacheKey({ targetId, project: opts.project, purpose });
      const v = await cache.resolve(key, async () => ({
        kind: "governance-read" as const,
        targetId,
        readOnly: true as const,
      }));
      return v as GovernanceReadIdentity;
    }

    case "project-context": {
      // 🔴 §3.9b:project-context **必须**带 projectId,不接受可选(缺 projectId 直接拒)。
      const project = assertProjectId(opts.project);
      const iso = requireCredentialIsolationState(t); // 缺状态即拒,不隐式当 legacy

      // 命中缓存也必须是**当前 epoch** 的槽 —— 状态一迁移,旧槽自然不可命中。
      const key = credCacheKey({ targetId, project, purpose, epoch: iso.epoch });
      const hit = cache.peek(key);
      if (hit) return hit as ProjectContextCred;

      const arn = await lookupProjectSecretArn(t, project);
      if (arn) {
        const cred: ProjectContextCred = {
          kind: "project-context",
          targetId,
          project,
          secretArn: arn,
          degradedToLegacyAdmin: false,
          isolation: iso,
        };
        cache.set(key, cred); // 只缓存"真项目凭证"
        return cred;
      }

      if (iso.state === "isolated") {
        // 稳态:永不回落。任何错误/缺字段/缓存未命中都不得恢复 admin。
        throw new Error(`no per-project credential ${targetId}/${project} — refuse (state=isolated)`);
      }

      // 🔴 v3.7:`provisioning` 窗口**过期即与 isolated 同样 fail-closed**(外部审核 v4 P1-4)。
      // 这一行是"回落不得无期限"从合同文字变成可执行边界的地方。
      if (provisioningExpired(iso)) {
        // 🔴 先报警再拒 —— 顺序是语义:告警**不能替代**硬拒(§3.9b),所以它在 throw 之前
        // 而不是"报了警就放行"。报警失败也不影响拒绝(内部已吞异常)。
        await reportProvisioningExpired({
          targetId,
          projectId: project,
          provisioningDeadlineAt: iso.provisioningDeadlineAt,
          epoch: iso.epoch,
        });
        throw new Error(
          `provisioning 窗口已过期(deadline=${iso.provisioningDeadlineAt})—— 拒绝回落 admin。` +
            `§3.9b:回落必须有截止时间与不可逆收敛计划;过期后只能补齐 per-project 凭证并推进到 isolated,` +
            `延期须走受审计的专用操作,不得靠继续用共享 admin 拖着`
        );
      }

      // 仅 legacy-seeded / 未过期的受控 provisioning 的存量流量允许显式回落。
      // 🔴 必须 `await`:可观测闭环里那条「isolated 出现回落 ⇒ P1 + 抛」的零容忍断言就在里面,
      //    不 await 等于把这道纵深防御变成一个 unhandled rejection。
      await noteDegradation(targetId, project, iso);
      // 🔴 **回落结果不进缓存**(§3.9b:不做无期限缓存)。代价是每次都重新判一遍状态 ——
      //    这正是我们要的:状态一变,下一次调用立刻按新状态走,而不是等缓存过期。
      return {
        kind: "project-context",
        targetId,
        project,
        secretArn: legacySingleAdminSecretArn(t),
        degradedToLegacyAdmin: true,
        isolation: iso,
      };
    }

    case "admin-ddl":
      // 见文件头 + 50 SPEC §3.9a:admin-ddl **不由本工厂发凭证**。
      throw new Error(
        "admin-ddl 不由 getPrivilegedCred 发凭证 —— 走 50 SPEC §3.9a 的闭合执行器:" +
          "调用方只传结构化 AdminDdlRequest(lib/exec-env/admin-ddl-request.ts)," +
          "SQL 由私有模板生成(admin-ddl-templates.ts),凭证在执行器内部取用不外泄;" +
          "执行器本体随 P52.5a 交付"
      );

    default: {
      const never: never = purpose;
      throw new Error(`未知 purpose:${String(never)}`);
    }
  }
}
