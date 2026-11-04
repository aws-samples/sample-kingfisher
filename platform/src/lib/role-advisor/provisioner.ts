// 角色顾问 B —— 一键创建执行角色(受控、不提权)。
//
// 安全边界:
//  1) 角色名强制受控前缀 bgp-job-role-*(CDK 只把 iam:CreateRole 等放宽到该前缀,建不了别的名)。
//  2) 强制挂 PermissionsBoundary(env ROLE_PERMISSIONS_BOUNDARY_ARN)——建出的角色实际权限 = 内联策略 ∩ 边界,
//     即便策略写宽了也超不过平台设定的上限,杜绝提权。无边界 ARN 时拒绝创建(fail-safe)。
//  3) 信任策略/权限策略均来自确定性推荐引擎(`advise.adviseRole` = 必备基线 + 代码/绑定/配方扫描),
//     不接受客户端任意策略。
//  4) 🔴🔴 **对账补齐(reconcile),不是「存在就跳过」**(2026-09-22 改)。
//     原来写的是「同名角色已存在则复用,不报错、**不覆盖已有策略**」——那让一个建坏了的角色
//     **永远修不好**(再点一万次一键创建也不动它),用户只能来找人手改 IAM;
//     而必备基线是会演进的,「不覆盖」等于「演进永远到不了存量角色」。
//     现在每次都把当前权威策略写上去(`PutRolePolicy` 本身幂等覆盖),并回显补了哪些 Sid。
//     只碰平台自己那份内联策略 `bgp-least-privilege`;上限仍由 PermissionsBoundary 兜着 ⇒ 不可能提权。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  IAMClient, GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand, AttachRolePolicyCommand,
  GetRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { normalizeRoleName } from "./policy-builder";
import { adviseRole, type AdviseInput } from "./advise";
import type { PolicyDocument } from "./types";

const INLINE_POLICY_NAME = "bgp-least-privilege";

/**
 * 把**当前权威策略**写到已存在的角色上,并回报「补了哪些 Sid」。
 *
 * 🔴 判据是**最终状态**(角色上那份策略 == 权威策略),不是「我执行过 PutRolePolicy」——
 *   本仓纪律:「建了必撤」「改了必收口」都不是一个动作,是一条判据。
 * 🔴 读不到现状时**不静默跳过**:照样写权威策略(fail-closed 到「至少是对的」),
 *   但把 `added` 标成全量,让回显如实说「无法比对,已整份覆盖」。
 */
async function reconcilePolicy(roleName: string, want: PolicyDocument): Promise<{ added: string[]; reconciled: boolean }> {
  const wantSids = want.Statement.map((s) => String(s.Sid || "")).filter(Boolean);
  let haveSids: string[] | null = null;
  try {
    const cur = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: INLINE_POLICY_NAME }));
    const doc = JSON.parse(decodeURIComponent(String(cur.PolicyDocument || "{}"))) as PolicyDocument;
    haveSids = (doc.Statement || []).map((s) => String(s.Sid || "")).filter(Boolean);
  } catch {
    haveSids = null; // 没有这份内联策略 / 读不到 ⇒ 当作「一条都没有」,整份写上去
  }
  const missing = haveSids === null ? wantSids : wantSids.filter((s) => !haveSids!.includes(s));
  // 🔴 `PutRolePolicy` 是幂等覆盖 ⇒ **每次都写**。只在「缺了什么」上做回显,不在「要不要写」上做判断:
  //   「看起来齐了就不写」会让**同名 Sid 但内容变窄/变旧**的语句永远留在存量角色上(演进到不了存量)。
  if (want.Statement.length) {
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName, PolicyName: INLINE_POLICY_NAME, PolicyDocument: JSON.stringify(want),
    }));
  }
  return { added: missing, reconciled: missing.length > 0 || haveSids === null };
}

const region = homeRegion();
const iam = sdkClient("control-plane", IAMClient, { region });
const BOUNDARY_ARN = process.env.ROLE_PERMISSIONS_BOUNDARY_ARN || "";

export interface CreateRoleResult {
  roleArn: string;
  roleName: string;
  created: boolean; // true=本次新建;false=已存在
  /** 已存在的角色本次是否**被补齐**了权限(对账结果)。 */
  reconciled?: boolean;
  /** 对账补齐了哪些语句的 Sid(给界面/审计回显;空 = 本来就是齐的)。 */
  reconciledSids?: string[];
  permissionsBoundary: string;
}

export async function provisionRole(req: AdviseInput): Promise<CreateRoleResult> {
  if (!BOUNDARY_ARN) {
    throw new Error("未配置权限边界(ROLE_PERMISSIONS_BOUNDARY_ARN):为防提权,一键创建必须挂 PermissionsBoundary,请先部署基建。");
  }
  // 🔴🔴 fail-closed(2026-09-22):拿不到账号号就**不许建** —— 否则引擎必备权限的资源 ARN 派生不出来,
  //   会建出一个「一跑就 AccessDenied」的角色,而调用方只收到一句无人看的 caution。
  //   本仓铁律:缺前提要**在这里**停,不许把缺陷推到运行期(那时报错离根因很远)。
  if (!req.accountId) {
    throw new Error("一键创建被拒绝:缺少 accountId,无法派生该引擎的**必备权限**(日志落点 / 脚本桶 / 日志组)"
      + "的资源 ARN。请由调用方带上账号号后重试 —— 建一个缺必备权限的角色,等于把一次 AccessDenied 推到作业运行时。");
  }
  // 🔴 走**带扫描推导**的唯一入口(代码解析 + 源头/目标绑定 + 配方库匹配),不是纯规则那层。
  const advice = await adviseRole(req);
  const roleName = normalizeRoleName(req.roleNameHint, req.engine);

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴🔴🔴 **对账补齐**,不是「存在就跳过」(2026-09-22 用户原话:
  //   「这种能力我认为需要加入到配方库里面,**不能我每次都需要手动处理这种错误**。」)
  //
  // 原实现:`GetRole` 成功就直接返回,注释写着「幂等:同名角色已存在则复用,不报错、不覆盖已有策略」。
  // 后果:**一个建坏了的角色,再点一万次「一键创建」也永远修不好** —— 用户只能来找人手改 IAM。
  // 而必备基线是会演进的(今天补日志落点,明天补别的),「不覆盖」等于「演进永远到不了存量角色」。
  //
  // ⇒ 改成**对账**(reconcile):`PutRolePolicy` 本身就是幂等覆盖 ⇒ 每次都把**当前权威策略**写上去,
  //   并把「补了哪些 Sid」回显给界面与审计。
  // 🔴 只覆盖平台自己那一份内联策略 `bgp-least-privilege`;用户另外挂的策略一个字不碰。
  // 🔴 权限上限仍由 PermissionsBoundary 兜着 ⇒ 对账不可能提权。
  // ══════════════════════════════════════════════════════════════════════════
  // 🔴🔴 **try 只许包住 `GetRole` 这一件事**(2026-09-22 真环境当场吃到教训):
  //   第一版把 `reconcilePolicy` 也放进同一个 try ⇒ `PutRolePolicy` 报 MalformedPolicyDocument 时,
  //   错误被下面那段 catch 抓走、报成「**查角色 xxx 是否已存在时失败**」—— **归因错了**,
  //   而报错文本还很自信。同族于本仓铁律「『判不了』不许说成结论」:一个 catch 罩住两件事,
  //   就必然把 B 的失败说成 A 的失败。
  let existing: string | null = null;
  try {
    const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    existing = Role?.Arn || null;
  } catch (e) {
    // 🔴 只有「角色不存在」才走创建分支。别的错误(没权限 / 被限流)**不许**当成「不存在」——
    //   那会让我们去 CreateRole 然后报一个完全不相干的错(「判不了」不许说成结论)。
    const name = (e as { name?: string })?.name || "";
    if (name !== "NoSuchEntityException" && name !== "NoSuchEntity") {
      throw new Error(`查角色 ${roleName} 是否已存在时失败(${name || "未知错误"}):`
        + `这不代表它不存在 ⇒ 不做任何创建动作,请排查后重试。原始错误:${String((e as Error)?.message || e).slice(0, 200)}`);
    }
  }

  // 角色已存在 ⇒ 对账补齐(补齐失败就**按补齐失败报**,不许混进上面那句「查角色失败」)
  if (existing) {
    const { added, reconciled } = await reconcilePolicy(roleName, advice.permissionPolicy);
    return {
      roleArn: existing, roleName, created: false,
      reconciled, reconciledSids: added, permissionsBoundary: BOUNDARY_ARN,
    };
  }

  // 信任策略:policy-builder 生成的 trustPolicy(含 Principal),序列化。
  const assumeDoc = JSON.stringify(advice.trustPolicy);

  const { Role } = await iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: assumeDoc,
    PermissionsBoundary: BOUNDARY_ARN, // 强制边界,防提权
    // IAM Description 只接受 ASCII/Latin-1(不能中文),故用英文。
    Description: `Kingfisher role-advisor one-click role for ${req.engine} job (least-privilege, permission-boundary constrained)`,
    // 不带 Tags:CreateRole 带 Tags 需额外 iam:TagRole 权限且受边界条件干扰;标识改走 Description。
  }));
  const roleArn = Role!.Arn!;

  // 内联最小权限策略。
  if (advice.permissionPolicy.Statement.length) {
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: INLINE_POLICY_NAME,
      PolicyDocument: JSON.stringify(advice.permissionPolicy),
    }));
  }
  // 附加建议的 AWS 托管策略(如 Glue service-role)。best-effort。
  for (const arn of advice.managedPolicyArns) {
    try { await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: arn })); } catch { /* 边界会兜底,忽略单条失败 */ }
  }

  return { roleArn, roleName, created: true, permissionsBoundary: BOUNDARY_ARN };
}
