export const dynamic = "force-dynamic";
// @kf-batch 50-P50.2c-control-api
// POST /api/admin/exec-envs/register —— 注册新执行目标(SPEC §2.1:身份/位置的唯一写通道)。
//
// 🔴 **服务端生成 targetId**(SPEC §1.1a:客户端不得指定)—— body 里若带 targetId 一律 400,
//    不是忽略:忽略会让调用方以为"我指定的 id 生效了"。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { registerTarget, RegisterValidationError, RegisterNamespaceExhausted, RegionAlreadyHasEnvironmentError, partitionForRegion, type RegisterTargetInput } from "@/lib/exec-env/registry";
import { getControlPlaneContext } from "@/lib/exec-env/aws-context";
// @kf-batch 50-W5-seg2-WP10a —— 注册时的同意同时留存到 S13
import { HOME_JURISDICTION } from "@/lib/exec-env/residency";
import { putAck } from "@/lib/exec-env/residency-store";
import { DISCLAIMER_TEXT_HASH, DISCLAIMER_VERSION } from "@/lib/residency/disclaimer";
// @kf-batch 50-init-region-enablement —— 注册那一刻就告诉人「控制面尚未放行该 region」(不拒注册:注册正是放行流程的第一步)
import { isControlPlaneRegionEnabled, regionNotEnabledHint } from "@/lib/exec-env/control-plane-regions";

/**
 * 🔴 客户端字段白名单(用户拍板 2026-09-01:「执行环境初始化不应该让用户提供账号,严格只能在
 * 控制中心的账号下的不同区域增加执行环境」)。accountId/partition **服务端自取**,收到即 400
 * —— 拒而不是忽略(忽略会让调用方以为指定的账号生效了,与 broker 白名单同哲学)。
 */
// @kf-batch 50-W5-seg1-WP10a:+residencyAck(跨法域必带,服务端逐字核对当前版本;SPEC §2.1 v3.22)
// @kf-batch 50-WP16-zero-egress:K-5 的 `networkProfile` **从白名单里去掉** —— 零出网之后没有 NAT 档可选
// (存量描述符里的旧值保留、只读;SPEC §3.16-E)。客户端再传它 = 未知字段 ⇒ 由白名单机制拒掉。
const CLIENT_FIELDS = ["region", "cellId", "stage", "jurisdiction", "components", "residencyAck"];

export async function POST(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  if (body && typeof body === "object" && "targetId" in body) {
    return apiError("targetId 由服务端生成,客户端不得指定(SPEC §1.1a)", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length > 0) {
    return apiError(
      `入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")};` +
        `accountId/partition 由服务端自取 —— 执行环境严格限定控制面同账号,用户拍板 2026-09-01)`,
      400,
      { code: "VALIDATION_FAILED" }
    );
  }

  try {
    const ctx = await getControlPlaneContext();
    const region = (body as { region?: unknown }).region;
    // 🔴 同账号拍板的必然推论:跨 partition 的 region 直接拒(一个 aws 分区账号建不了 aws-cn 的 target;
    //    放行到 registerTarget 会因 partition 交叉校验以更晦涩的理由拒 —— 这里把话说白)。
    if (typeof region === "string" && partitionForRegion(region) !== ctx.partition) {
      return apiError(
        `region ${region} 属于 ${partitionForRegion(region)} 分区,与控制面账号所在分区(${ctx.partition})不同 —— ` +
          `执行环境严格限定控制面同账号(跨账号/跨分区一期不做)`,
        400,
        { code: "VALIDATION_FAILED" }
      );
    }
    const input = { ...(body as object), accountId: ctx.accountId, partition: typeof region === "string" ? partitionForRegion(region) : ctx.partition };
    const result = await registerTarget(input as unknown as RegisterTargetInput, identity.username);
    // @kf-batch 50-W5-seg2-WP10a
    // 🔴 注册跨法域 target 时 admin 勾的免责告知 = 这个人对这个 target 的同意 ⇒ **同时**写进同意留存表 S13(source=register,带 sub)。
    //    否则注册者第一次直查 / 落地 / 运行还会再弹一次同一段文案(同意是个人行为,但同一人对同一 target 同一版本只该同意一次)。
    //    描述符上的 residencyAck 照旧(合同字段;不可改);S13 写失败不回滚注册(注册已成),只记 warn —— 用户首次数据操作时会被 409 兜住,不漏审。
    const jur = (body as { jurisdiction?: unknown }).jurisdiction;
    if (typeof jur === "string" && jur !== HOME_JURISDICTION) {
      try {
        await putAck({
          userSub: identity.sub,
          username: identity.email || identity.username || identity.sub,
          targetId: result.targetId,
          version: DISCLAIMER_VERSION,
          textHash: DISCLAIMER_TEXT_HASH,
          at: new Date().toISOString(),
          ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined,
          ua: req.headers.get("user-agent") || undefined,
          source: "register",
        });
      } catch (e) {
        console.warn("[exec-env.register] 注册时同意写入 S13 失败(注册已成;注册者首次数据操作会被 409 兜住)", result.targetId, String((e as Error)?.message ?? e));
      }
    }
    recordAudit(req, "exec-env.register", {
      resourceType: "exec-env",
      resourceId: result.targetId,
      detail: {
        region: (body as { region?: string }).region,
        components: (body as { components?: string[] }).components,
        jurisdiction: (body as { jurisdiction?: string }).jurisdiction ?? "home",
        residencyAck: (body as { residencyAck?: unknown }).residencyAck ?? null,
      },
    }).catch(() => {});
    // @kf-batch 50-init-region-enablement
    // 🔴 不拒注册(注册 = 放行流程的第一步,§1b 从注册表推导清单),但把「接下来会卡在哪、运维要做什么」在**当场**说清:
    //    否则用户看到的是「注册成功 → 部署成功 → 检测初始化 9 行红」这条离根因很远的路(init 段 I-4 真撞)。
    const regionEnabled = typeof region === "string" ? isControlPlaneRegionEnabled(region) : true;
    return apiOk(
      {
        ...result,
        controlPlaneRegionEnabled: regionEnabled,
        ...(regionEnabled || typeof region !== "string" ? {} : { notice: regionNotEnabledHint(region) }),
      },
      201
    );
  } catch (e: unknown) {
    if (e instanceof RegisterValidationError) {
      return apiError(e.message, 400, { code: "VALIDATION_FAILED" });
    }
    // 🔴 命名空间用满是**用户可修**的(删一个不用的环境),不是平台故障 ⇒ 409 而不是 500;
    //    500 + 「请稍后重试」会让运维一直重试一件永远不会成的事。
    // @kf-batch 50-WP23-one-env-per-region:同区已有执行环境 = **用户可修**(先删那个),不是平台故障
    if (e instanceof RegionAlreadyHasEnvironmentError) {
      return apiError(e.message, 409, {
        code: "CONFLICT",
        detail: { reason: "region-already-has-environment", region: e.region, existing: e.existing },
      });
    }
    if (e instanceof RegisterNamespaceExhausted) {
      return apiError(e.message, 409, { code: "CONFLICT", detail: { reason: "cell-namespace-exhausted", region: e.region, cellSpace: e.cellSpace } });
    }
    return apiError(`注册执行目标失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
