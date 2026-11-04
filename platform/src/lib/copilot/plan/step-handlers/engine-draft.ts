// 模块 44 — EMR Serverless 作业【纯草稿】创建(供 emr StepHandler 用)。
// 与 create-service 的其它 createXxxDraft 同款纪律:只写 status=draft,【绝不碰云资源】。
//
// 关键区别于 engines route 的 POST:那个 POST 会调 provider.ensureResource 真建 EMR application(碰云);
// Copilot 建 draft 阶段【不建 application】——只落一条 draft 记录,network 留空(EMR_NETWORK_EMPTY)。
// 用户后续去引擎页确认网络配置并启动时,平台才建 application。这符合"建即草稿、跑要用户在页面点"。
// 过闸2 action-guard(engine.create 在白名单)保持与其它创建工具同款纵深校验。

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardCopilotAction } from "../../action-guard";
import { EMR_NETWORK_EMPTY } from "@/lib/engines/emr/network";
import { getEmrDefaultNetwork } from "@/lib/engines/platform-env";
import { EMR_SPEC_DEFAULT } from "@/lib/engines/emr/spec";
import type { CopilotCaller } from "../../tools/types";

const USER_ID = "default-user";
const now = () => new Date().toISOString();

export async function createEngineDraft(args: any, caller: CopilotCaller): Promise<{ jobId: string; name: string }> {
  // 闸2 冗余校验(即便被误注册也拦)。
  const g = guardCopilotAction("engine.create");
  if (!g.allowed) throw new Error(`已拒绝:${g.reason}`);

  const name = String(args?.name || "").trim();
  if (!name) throw new Error("缺少 EMR 作业名称 name");

  // network(根治·裂缝A):规划大脑若给了 subnetIds/securityGroupIds 就用它;否则【填平台默认网络 SSOT】
  // (私有子网 + bgp-emr-sg),让计划中心建的 EMR 草稿一出生就"已配置",前端不拦、开箱即跑
  // (planner 无"查网络"工具,此前恒空 EMR_NETWORK_EMPTY → 用户须去引擎页手动补网络才能跑)。
  // 兜底取不到(env 未注入子网/查不到 SG)时仍留空——运行时 ensureApplication 会再兜一次(双层)。
  const subnetIds: string[] = Array.isArray(args?.subnetIds) ? args.subnetIds : [];
  const securityGroupIds: string[] = Array.isArray(args?.securityGroupIds) ? args.securityGroupIds : [];
  let network = (subnetIds.length || securityGroupIds.length) ? { subnetIds, securityGroupIds } : EMR_NETWORK_EMPTY;
  if (network === EMR_NETWORK_EMPTY) {
    const fallback = await getEmrDefaultNetwork();
    if (fallback) network = fallback;
  }

  const item: any = {
    userId: USER_ID,
    jobId: ulid(),
    projectId: caller.projectId,
    env: caller.env,
    engine: "emr-serverless",
    name,
    script: String(args?.script || ""), // 空脚本也可,用户后续在页面补/用 AI 生成
    spec: args?.spec || EMR_SPEC_DEFAULT,
    network,
    status: "draft", // 纯草稿,不建 application、不运行
    createdBy: "copilot",
    createdByCopilot: true,
    createdAt: now(),
    updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.ENGINE_JOBS, Item: item }));
  return { jobId: item.jobId, name };
}
