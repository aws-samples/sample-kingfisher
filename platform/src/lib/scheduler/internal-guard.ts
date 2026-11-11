// 🔴🔴 **平台内部端点的守卫**(`/api/internal/**`)—— 只认「主控区的分发 Lambda」这一个来源。
//
// 【鉴权方式 = 最小爆炸半径】「共享密钥落 Secrets Manager;身份只映射到系统主体,只允许白名单动作」。
//   三道,缺一道都拒:
//   ① **来源不是 CloudFront**:平台对公网的唯一入口是 CloudFront → ALB,CloudFront 一定会给回源请求带
//      `X-Amz-Cf-Id`(浏览器去不掉)⇒ 带着它 = 从公网进来的 ⇒ 403。分发 Lambda 在平台 VPC 内直连 ALB 的
//      私网地址(ALB 的 SG 单独给 Lambda 的 SG 开了一条入站),它的请求里没有这个头。
//      中间件(edge)对 `/api/internal/` 先拦一次同样的条件,路由这里再判一次(纵深防御)。
//   ② **来源声明头** `x-bgp-internal-source: action-dispatcher`(不是安全边界,是防误调:别的内部工具
//      哪天也想用这个端点,必须先在这里登记一个来源名)。
//   ③ **共享密钥头** `x-bgp-internal-key` == Secrets Manager 里那一份(常量时间比较)。
//      密钥只存在两处:Secrets Manager 与分发 Lambda 的内存。平台进程按 ARN 读、缓存 5 分钟。
//      没配 ARN / 读不到密钥 ⇒ **503 fail-closed**(绝不「没配就放行」)。
//
// 【就算密钥泄露,能做的事也被收窄到最小】内部端点只收一个 `commandId`,动作与参数**从命令表那一行读**,
//   而写那张表要 IAM(执行区的调度角色 / 平台自己);动作还得在白名单里、参数还得过校验。
//   ⇒ 泄露的密钥 ≈ 「把表里已有的白名单命令再触发一次」,不是平台 API 的通用钥匙。
//
// 【映射成谁】系统主体 `system:action-dispatcher`,审计一律带 `via=schedule`;它**没有** Cognito 身份,
//   不走任何 `requireProject` —— 项目归属从命令行的 `projectId` 显式来(由执行体自己再校验对象归属)。
import { timingSafeEqual } from "node:crypto";

import {
  ALERTING_PUMP_PRINCIPAL,
  BACKFILL_PUMP_PRINCIPAL,
  CLOUDFRONT_ORIGIN_HEADER,
  DATAPLANE_JOB_PUMP_PRINCIPAL,
  INTERNAL_KEY_HEADER,
  INTERNAL_PRINCIPAL,
  INTERNAL_SOURCE_ACTION_DISPATCHER,
  INTERNAL_SOURCE_ALERTING_PUMP,
  INTERNAL_SOURCE_BACKFILL_PUMP,
  INTERNAL_SOURCE_DATAPLANE_JOB_PUMP,
  INTERNAL_SOURCE_HEADER,
  internalSourceVerdict,
  type InternalPrincipal,
  type InternalVerdict,
} from "@/lib/scheduler/internal-source";

export {
  ALERTING_PUMP_PRINCIPAL,
  BACKFILL_PUMP_PRINCIPAL,
  CLOUDFRONT_ORIGIN_HEADER,
  DATAPLANE_JOB_PUMP_PRINCIPAL,
  INTERNAL_KEY_HEADER,
  INTERNAL_PRINCIPAL,
  INTERNAL_SOURCE_ACTION_DISPATCHER,
  INTERNAL_SOURCE_ALERTING_PUMP,
  INTERNAL_SOURCE_BACKFILL_PUMP,
  INTERNAL_SOURCE_DATAPLANE_JOB_PUMP,
  INTERNAL_SOURCE_HEADER,
  internalSourceVerdict,
};

/** 来源 → 系统主体(封闭映射;来源与主体一一对应,审计里一眼认出是谁)。 */
const PRINCIPAL_OF_SOURCE: Record<string, InternalPrincipal> = {
  [INTERNAL_SOURCE_ACTION_DISPATCHER]: INTERNAL_PRINCIPAL,
  [INTERNAL_SOURCE_DATAPLANE_JOB_PUMP]: DATAPLANE_JOB_PUMP_PRINCIPAL,
  [INTERNAL_SOURCE_BACKFILL_PUMP]: BACKFILL_PUMP_PRINCIPAL,
  [INTERNAL_SOURCE_ALERTING_PUMP]: ALERTING_PUMP_PRINCIPAL,
};
export type { InternalVerdict };

const CACHE_MS = 5 * 60 * 1000;
let cached: { value: string; at: number } | null = null;

/** 测试用:清缓存。 */
export function __resetInternalKeyCache(): void {
  cached = null;
}

async function defaultLoadSecret(arn: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const { sdkClient } = await import("@/lib/aws/clients");
  const { ctrlRegionOf } = await import("@/lib/workflow/dag-place");
  // 🔴 密钥在主控区(与平台进程同区);客户端走工厂(落点棘轮 L3/L4),区来自控制面区的唯一作者
  // 它是**控制面**密钥 ⇒ sdkClient("control-plane")(不注入数据面角色;
  //   原来走数据面工厂,observe 模式下每次先被拒再回任务角色,enforce 模式下内部端点整条 503。与 pump.ts 的读法同一口径)
  const sm = sdkClient("control-plane", SecretsManagerClient, { region: ctrlRegionOf() });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  return String(r.SecretString || "");
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

export async function verifyInternalCaller(
  headers: Headers,
  deps: {
    secretArn?: string;
    loadSecret?: (arn: string) => Promise<string>;
    now?: () => number;
    /**
     * 本端点只收哪一个来源(缺省 = 分发 Lambda,既有端点逐字节不变)。
     * 🔴 中间件只判「登记过」,这里判「就是我要的那一个」:泵敲不开分发端点,分发 Lambda 也敲不开泵的端点。
     */
    expectedSource?: string;
  } = {}
): Promise<InternalVerdict> {
  const src = internalSourceVerdict(headers);
  if (src) return src;
  const wantSource = deps.expectedSource ?? INTERNAL_SOURCE_ACTION_DISPATCHER;
  const principal = PRINCIPAL_OF_SOURCE[wantSource];
  if (!principal || headers.get(INTERNAL_SOURCE_HEADER) !== wantSource) {
    return { ok: false, status: 403, reason: "内部调用来源与本端点不符" };
  }
  const presented = headers.get(INTERNAL_KEY_HEADER) || "";
  if (!presented) return { ok: false, status: 401, reason: "缺内部密钥头" };
  const arn = deps.secretArn ?? process.env.ACTION_DISPATCH_SECRET_ARN ?? "";
  if (!arn) return { ok: false, status: 503, reason: "平台没有配置内部密钥(ACTION_DISPATCH_SECRET_ARN)—— 拒绝服务,不放行" };
  const now = (deps.now ?? Date.now)();
  let expected = cached && now - cached.at < CACHE_MS ? cached.value : "";
  if (!expected) {
    try {
      expected = await (deps.loadSecret ?? defaultLoadSecret)(arn);
    } catch (e) {
      return { ok: false, status: 503, reason: `读不到内部密钥:${(e as Error)?.message ?? String(e)}` };
    }
    if (!expected) return { ok: false, status: 503, reason: "内部密钥为空 —— 拒绝服务,不放行" };
    cached = { value: expected, at: now };
  }
  if (!sameSecret(presented, expected)) {
    // 🔴 密钥轮换窗口:缓存里可能是旧值 ⇒ 再强读一次(只多一次,不循环;且缓存 30s 内不重读 ——
    //    否则拿错密钥狂敲就能让每个请求都打一次 Secrets Manager)
    if (cached && now - cached.at > 30_000) {
      try {
        const fresh = await (deps.loadSecret ?? defaultLoadSecret)(arn);
        if (fresh && fresh !== expected) {
          cached = { value: fresh, at: now };
          if (sameSecret(presented, fresh)) return { ok: true, principal };
        }
      } catch {
        /* 读不到就按不匹配处理 */
      }
    }
    return { ok: false, status: 401, reason: "内部密钥不匹配" };
  }
  return { ok: true, principal };
}
