export const dynamic = "force-dynamic";
// GET /api/workflow/airflow —— 换取 MWAA Web 登录 token(52 SPEC §2 缺口B 第 4 面)。
//
// 🔴 **改动前的真实状态**(2026-09-03 逐行实测,台账 52 DESIGN §11.2 第 1 项):
//   **连 `resolveIdentity` 都没有**。middleware 只验 JWT ⇒ **任一登录用户** GET 一下就拿到
//   MWAA Web 登录凭证。§0.2 把它标成「**绕过平台全部项目守卫的后门**」——其余越权面全修完,它仍在。
//
// 🔴 **为什么必须收成平台 admin 专用,而不是"项目 editor 就够"**
//   本端点铸造的是**凭证**,而平台只有**一个** MWAA 环境、Airflow 本身**没有 dagId 级授权**
//   (D3-T2 记录的**能力边界**,不是实现偷懒)⇒ 谁拿到 token,谁就能在 Airflow UI 里
//   trigger / pause **所有项目**的 DAG。
//   ⇒ 任何"项目级"角色都**不足以**授权它:给 A 项目 editor 发 token = 顺带给了 B 项目的控制权。
//   这正是"混淆代理"的教科书形态 —— 用一个窄授权换来一个宽能力。
//
// 🔴 审计只记 **who / 哪个环境 / 想看哪个 dag**,**绝不记 token 本身**
//   (它是凭证;抄进审计表等于把凭证复制到第二个地方,而审计表的读者面更宽)。
// MWAA 环境 / 桶只经解析器(home 逐字节不变)
// 🔴 Airflow 控制台入口按区:每个区一套 Airflow
// (用户 2026-09-10 第三次强调),把主控区的登录入口给别的区看,点进去看到的是**别人的 DAG 列表**。
import { schedulerEndpointFor, isServerlessEndpoint, mwaaClientFor, MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
import { isValidTargetId, HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { NextRequest } from "next/server";
// 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { CreateWebLoginTokenCommand, GetEnvironmentCommand } from "@aws-sdk/client-mwaa";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";



export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) {
    return apiError(
      "仅平台管理员(bgp-admin)可打开 Airflow 控制台:平台只有一个 MWAA 环境、Airflow 无 DAG 级授权," +
        "发出的登录凭证等于**所有项目** DAG 的控制权,任何项目级角色都不足以授权它",
      403,
      { code: "RBAC_DENIED" }
    );
  }
  const dagId = req.nextUrl.searchParams.get("dagId") || "";
  // 🔴 目标环境由 `?targetId=` 点名(原来「没给 / 非法 ⇒ 主控区」,非法值也静默改区)。解析不出来就 409 + 直达补装。
  let tid: string;
  try {
    tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "打开 Airflow 控制台");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  let ep;
  try {
    ep = await schedulerEndpointFor(tid);
  } catch (e) {
    if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
    throw e;
  }
  if (isServerlessEndpoint(ep)) {
    return apiError(
      `${ep.region} 装的是 airflow-serverless —— 它没有 Airflow Web 控制台(定义与运行都由平台侧呈现)`,
      409,
      { code: "WORKFLOW_SCHEDULER_UNSUPPORTED" }
    );
  }
  const ENV_NAME = ep.envName;
  const mwaa = mwaaClientFor(ep.region);

  try {
    const { WebToken, WebServerHostname } = await mwaa.send(
      new CreateWebLoginTokenCommand({ Name: ENV_NAME })
    );

    const loginUrl = `https://${WebServerHostname}/aws_mwaa/aws-console-sso?login=true&token=${WebToken}`;
    // 🔴 铸造凭证是高危动作 ⇒ 必须留痕(who + 环境 + 目标 dag);token 本身不入审计。
    recordAudit(req, "workflow.airflow-web-token", {
      resourceType: "mwaa-environment",
      resourceId: ENV_NAME,
      detail: { dagId: dagId || "(home)", grantedTo: identity.username },
    }).catch(() => {});

    // Get environment info
    const { Environment } = await mwaa.send(new GetEnvironmentCommand({ Name: ENV_NAME }));

    return apiOk({
      loginUrl,
      dagUrl: dagId ? `https://${WebServerHostname}/dags/${dagId}/grid` : null,
      webServerHostname: WebServerHostname,
      status: Environment?.Status,
      airflowVersion: Environment?.AirflowVersion,
      // AWS Console link as fallback
      consoleUrl: `https://${ep.region}.console.aws.amazon.com/mwaa/home#/environments/${ENV_NAME}/sso`,
      // 护栏 2:这套 Airflow 属于哪个区 / 哪个执行环境,前端要能显示
      region: ep.region,
      targetId: ep.targetId,
    });
  } catch (e: any) {
    return apiError(`MWAA 错误: ${e.message}`, 500);
  }
}
