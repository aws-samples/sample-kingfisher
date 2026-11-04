export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// MWAA 桶只经解析器
import { homeMwaaConfigured, homeMwaaEndpoint } from "@/lib/scheduler/mwaa-endpoint";
import { NextRequest, NextResponse } from "next/server";
import { apiOk } from "@/lib/api-response";
// 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup } from "@/lib/redshift/warehouse-location";
// INTERACTION §3「非 admin 只读展示当前生效模型 + 来源」:/api/admin/** 对非 admin 403,
// 故把只读的生效值挂在本端点(登录即可读;不含 overrides / 探测明细 / 配置能力)。
import { resolveModelRuntime } from "@/lib/ai/model";
// 执行范围。
// 🔴🔴 这一页原来是**全平台唯一一处硬撒谎**:它声明「此页属于全局控制平面,不受当前执行范围影响」,
// 却把**主控区的** Redshift 工作组 / Glue 脚本桶 / MWAA DAG 桶 / 默认 VPC / AWS Region 当作
// 「平台配置」渲染给**所有**区看。切到 us-west-2 的用户看到的是主控区的桶名 —— 而且页面还
// 明确否认自己与区有关,连怀疑的机会都不给。⇒ 现在逐项从**该 target 自己的描述符资源袋**取。
import { requireScope } from "@/lib/exec-env/scope";
import { getActiveProjectId } from "@/lib/projects/guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { scopeTargets } from "@/lib/scope/scope";

const NOT_CONFIGURED = "未配置";

/** 资源袋里取一个字符串键;缺就回 `未配置`(不猜、不回落到别的区的值)。 */
function res(bag: Record<string, unknown> | undefined, key: string): string {
  const v = bag?.[key];
  return typeof v === "string" && v.length > 0 ? v : NOT_CONFIGURED;
}

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, getActiveProjectId(req));
  if (scope instanceof NextResponse) return scope;

  const aiModel = await resolveModelRuntime("genbi").catch(() => null);
  const aiBlock = aiModel
    ? { modelId: aiModel.modelId, source: aiModel.source, stale: !!aiModel.stale }
    : null;

  // 单区视角 ⇒ 取那个区;「全部」/ 对比 ⇒ 仍以主控区为准并**在响应里说清**(页面据此显示提示)。
  const ids = scopeTargets(scope);
  const targetId = ids.length === 1 ? ids[0] : HOME_TARGET_ID;
  const viewIsSingleTarget = ids.length === 1;

  const t = await getTargetRaw(targetId).catch(() => null);
  const bag = (t?.resources ?? undefined) as Record<string, unknown> | undefined;
  const components: string[] = Array.isArray(t?.components) ? (t!.components as string[]) : [];

  // 🔴 主控区在**描述符读不到**时才回落到进程环境变量,并把来源如实标出来(`valuesFrom`)。
  // 为什么这不是「缺省回落 env」那种 fail-open:回落只发生在**被点名的就是主控区**时,
  // 值仍然是主控区自己的;非主控区读不到描述符 ⇒ 一律 `未配置`,绝不拿主控区的值顶上。
  const homeFallback = isHome(targetId) && !bag;

  const payload = {
    aiModel: aiBlock,
    // 这几项现在是「**这个执行环境的**」而不是「平台的」
    targetId,
    displayName: t?.displayName || (isHome(targetId) ? "Home(控制面所在区)" : targetId),
    isHome: isHome(targetId),
    /** `descriptor` = 从该 target 的资源袋取;`env` = 主控区且描述符读不到时的回落 */
    valuesFrom: bag ? "descriptor" : homeFallback ? "env" : "unavailable",
    /** 视角不是单个区时,下面这些值仍是主控区的 —— 页面必须照此提示,不许沉默 */
    valuesAreForSingleTarget: viewIsSingleTarget,
    components,
    warehouseInstalled: components.includes("redshift"),
    // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
    region: t?.region || (homeFallback ? homeRegion() : NOT_CONFIGURED),
    // 身份是单池全局资源:它**不随区变**,页面上要单独标注(不然用户会以为它也是这个区的)
    cognitoUserPoolId:
      process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || NOT_CONFIGURED,
    redshiftWorkgroup: bag
      ? res(bag, "redshiftWorkgroup")
      : homeFallback
        ? homeWorkgroup()
        : NOT_CONFIGURED,
    redshiftDatabase: bag ? res(bag, "redshiftDatabase") : NOT_CONFIGURED,
    glueScriptsBucket: bag
      ? res(bag, "scriptsBucket")
      : homeFallback
        ? process.env.GLUE_SCRIPTS_BUCKET || NOT_CONFIGURED
        : NOT_CONFIGURED,
    glueRoleArn: bag ? res(bag, "glueRoleArn") : homeFallback ? process.env.GLUE_ROLE_ARN || NOT_CONFIGURED : NOT_CONFIGURED,
    datalakeBucket: bag ? res(bag, "datalakeBucket") : NOT_CONFIGURED,
    tableBucket: bag ? res(bag, "tableBucket") : NOT_CONFIGURED,
    athenaWorkgroup: bag ? res(bag, "athenaWorkgroup") : NOT_CONFIGURED,
    mwaaDagBucket: bag
      ? res(bag, "dagBucket")
      : homeFallback && homeMwaaConfigured()
        ? homeMwaaEndpoint().dagBucket
        : NOT_CONFIGURED,
    defaultVpcId: bag
      ? res(bag, "vpcId")
      : homeFallback
        ? process.env.DEFAULT_VPC_ID || NOT_CONFIGURED
        : NOT_CONFIGURED,
  };
  return apiOk(payload);
}
