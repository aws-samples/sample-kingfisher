// 序 72 B-139(模块 56)—— 页面「执行角色」下拉的候选来源(单一作者):与 AWS 控制台「IAM role」下拉同口径,
// 账号内**该服务可承担**(信任策略 Principal.Service 含该引擎主体)的角色都列,分三组:
//   platform = 该落点解析出的平台默认角色(推荐;权限齐)· advisor = 角色顾问建的 `bgp-job-role-*` · custom = 其余(客户自建)。
// 平台内部角色(执行环境栈组的 `BgpExecEnv-*`、控制面栈 `Bgp*Stack-*`、`bgp-*` 固定编排角色)**不列**—— 它们不是给用户绑作业的;
// 本落点的平台默认角色即使也叫这些名字,仍以 platform 组第一项出现。

import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { IAMClient, ListRolesCommand, type Role } from "@aws-sdk/client-iam";
import { resolveEmrBinding, resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { resolveFlinkPlace } from "@/lib/realtime/flink-place";
import { ROLE_NAME_PREFIX } from "@/lib/role-advisor/policy-builder";
import { roleNameOfArn } from "./resolve";
import { trustsService } from "./trust";
export { trustsService };
import {
  SERVICE_PRINCIPAL_BY_ENGINE,
  type ExecRoleCandidate,
  type ExecRoleCandidateKind,
  type ExecRoleCandidates,
  type ExecRoleEngine,
} from "./types";

/** 该落点上这个引擎的**平台默认**执行角色(与启动侧同一作者解析:home 走 env,非 home 走描述符;缺 ⇒ 抛可修拒因)。 */
export async function platformDefaultRoleArn(engine: ExecRoleEngine, targetId: string): Promise<string> {
  if (engine === "glue") return (await resolveGlueBinding({ targetId })).roleArn;
  if (engine === "emr") return (await resolveEmrBinding({ targetId })).executionRoleArn;
  return (await resolveFlinkPlace(targetId)).roleArn;
}

const INTERNAL_ROLE_RE = /^(BgpExecEnv-|Bgp[A-Z][A-Za-z0-9]*Stack-|bgp-)/;

/** 分组;null = 平台内部角色,不列。`platformArn` 恒 platform(哪怕名字像内部角色)。 */
export function classifyRole(role: { arn: string; name: string; path?: string }, platformArn: string): ExecRoleCandidateKind | null {
  if (role.arn === platformArn) return "platform";
  if (role.name.startsWith(ROLE_NAME_PREFIX)) return "advisor";
  if ((role.path || "/").startsWith("/aws-service-role/")) return null;
  if (INTERNAL_ROLE_RE.test(role.name)) return null;
  return "custom";
}

function iamClient() {
  return sdkClient("control-plane", IAMClient, { region: homeRegion() });
}

/** 全量分页读账号角色(IAM 是全局服务,控制面轴)。 */
async function listAllRoles(): Promise<Role[]> {
  const iam = iamClient();
  const out: Role[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListRolesCommand({ MaxItems: 1000, Marker: marker }));
    out.push(...(page.Roles ?? []));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return out;
}

export async function listExecutionRoleCandidates(args: { engine: ExecRoleEngine; targetId: string }): Promise<ExecRoleCandidates> {
  const { engine, targetId } = args;
  const servicePrincipal = SERVICE_PRINCIPAL_BY_ENGINE[engine];
  const platformArn = await platformDefaultRoleArn(engine, targetId);
  const roles = await listAllRoles();
  const groups: Record<ExecRoleCandidateKind, ExecRoleCandidate[]> = { platform: [], advisor: [], custom: [] };
  for (const r of roles) {
    if (!r.Arn || !r.RoleName) continue;
    const kind = classifyRole({ arn: r.Arn, name: r.RoleName, path: r.Path }, platformArn);
    if (kind === null) continue;
    // 平台默认角色不看信任策略(CDK 建的,恒信任该服务);其余按「该服务能不能承担」入选 —— 与控制台下拉同口径
    if (kind !== "platform" && !trustsService(r.AssumeRolePolicyDocument, servicePrincipal)) continue;
    groups[kind].push({
      arn: r.Arn,
      name: r.RoleName,
      kind,
      ...(r.CreateDate ? { createDate: new Date(r.CreateDate).toISOString() } : {}),
      ...(r.Description ? { description: r.Description } : {}),
    });
  }
  // 平台默认角色即使 ListRoles 没回(权限 / 分页异常),下拉也必须有它 —— 它是「留空」的实名
  if (!groups.platform.length) {
    groups.platform.push({ arn: platformArn, name: roleNameOfArn(platformArn) ?? platformArn, kind: "platform" });
  }
  for (const k of ["advisor", "custom"] as const) groups[k].sort((a, b) => a.name.localeCompare(b.name));
  return {
    engine,
    targetId,
    servicePrincipal,
    groups,
    total: groups.platform.length + groups.advisor.length + groups.custom.length,
    fetchedAt: new Date().toISOString(),
  };
}
