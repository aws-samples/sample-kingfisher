// 新建执行环境的候选区:哪些区被**组织策略(SCP)**拦住了部署必需的动作(BUG-LEDGER)。
//
// 【为什么要有】候选区原来 = `ec2:DescribeRegions(AllRegions=false)` ∖ 已占区。「已启用」是必要不充分 ——
//   账号所在组织的 SCP 拦住的区照样出现在可选里 ⇒ 用户选它、点部署,几分钟后 CodeBuild PRE_BUILD 被显式拒
//   (`s3tables:ListTableBuckets … explicit deny in a service control policy`),描述符卡在 initializing,
//   只能靠弃置收拾(2026-10-09 第十五轮 w5a 真撞 ap-northeast-1)。
//
// 【真值源】与 redeploy 的 IAM 模拟门(scripts/iam-simulate-gate.py)同一个判据:`SimulatePrincipalPolicy` 回的
//   `OrganizationsDecisionDetail.AllowedByOrganizations === false` = 组织层拒。模拟的身份是**部署真正用的那个**
//   (CodeBuild 项目 bgp-exec-env-deploy 的 serviceRole;SCP 可能按身份豁免,拿平台自己的身份去量会量错人)。
//   🔴 不写死任何区名 —— 换到没有这条 SCP 的账号,同一段代码自动把那个区放回可选(正控制)。
// 【三态】blocked(组织层明确拒)/ unverified(量不了:没权限 / 限流 / 读不到 build 角色)/ 其余 = 可选。
//   🔴 unverified **不等于** blocked:量具坏了不许把整张候选表都判死(那会让一个权限缺口变成「哪都建不了」);
//   但也不许装作量过 —— 界面照实标「未能核实组织策略」。
import { BatchGetProjectsCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { SimulatePrincipalPolicyCommand, IAMClient } from "@aws-sdk/client-iam";
import { EXEC_ENV_PROJECT_NAME, sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import { sdkClient } from "@/lib/aws/clients";
import { homeRegion } from "@/lib/exec-env/target-clients";

/**
 * 部署一个执行环境**在目标区**必定要发的动作(代表性、全是区域服务)。
 * 🔴 清单与 buildspec 的部署路径对齐:单测 `region-org-block` 读 infra/buildspec/exec-env-deploy.yml,
 *    要求它在部署路径上的每个**区域性** aws 调用都在这里(少一个 = 那个动作被 SCP 拦时我们看不见)。
 *    另加 CDK 部署本身的两个(建栈 / 读 bootstrap 版本参数)。
 */
export const DEPLOY_PROBE_ACTIONS = [
  "cloudformation:CreateStack",
  "cloudformation:DescribeStacks",
  "cloudformation:DescribeStackResources",
  "ssm:GetParameter",
  "ec2:DescribeAvailabilityZones",
  "ec2:DescribeVpcEndpointServices",
  "ec2:DescribeSubnets",
  "ec2:DescribeVpcs",
  "s3tables:ListTableBuckets",
  "s3tables:ListNamespaces",
  "s3tables:ListTables",
] as const;

/** buildspec 里那些**不在目标区**发的调用(全局服务 / 主控区),不进上面的清单 —— 单测用它做闭合核对。 */
export const DEPLOY_PROBE_EXCLUDED = {
  "sts:GetCallerIdentity": "全局服务(账号护栏);不受区域 SCP 影响",
} as const;

export interface BlockedRegion {
  region: string;
  /** 被组织层拒的动作(一个都不省略) */
  actions: string[];
  /** 拒因层:目前只认组织 SCP 这一层(与 iam-simulate-gate 的三态同一判别) */
  layer: "organizations-scp";
  reason: string;
}

export interface OrgPolicyVerdict {
  /** 量的是谁(部署身份);读不到 = null */
  principal: string | null;
  blocked: BlockedRegion[];
  unverified: Array<{ region: string; reason: string }>;
  checkedAt: string;
}

/** 部署身份 = CodeBuild 项目的 serviceRole(项目定义里的那个,不是平台自己的 TaskRole)。 */
async function deployPrincipalArn(cb: CodeBuildClient): Promise<string> {
  const out = await cb.send(new BatchGetProjectsCommand({ names: [EXEC_ENV_PROJECT_NAME] }));
  const role = out.projects?.[0]?.serviceRole;
  if (!role) throw new Error(`读不到 CodeBuild 项目 ${EXEC_ENV_PROJECT_NAME} 的 serviceRole(部署机制没装?)`);
  return role;
}

/** 单个区:被组织层拒的动作列表(空 = 没拦)。只认**显式 false**(字段缺失 / null ≠ 被拦)。 */
export async function orgDeniedActionsIn(iam: IAMClient, principal: string, region: string): Promise<string[]> {
  const denied: string[] = [];
  let marker: string | undefined;
  for (let page = 0; page < 10; page++) {
    const out = await iam.send(
      new SimulatePrincipalPolicyCommand({
        PolicySourceArn: principal,
        ActionNames: [...DEPLOY_PROBE_ACTIONS],
        ResourceArns: ["*"],
        ContextEntries: [{ ContextKeyName: "aws:RequestedRegion", ContextKeyValues: [region], ContextKeyType: "string" }],
        ...(marker ? { Marker: marker } : {}),
      })
    );
    for (const r of out.EvaluationResults ?? []) {
      if (r.OrganizationsDecisionDetail?.AllowedByOrganizations === false && r.EvalActionName) denied.push(r.EvalActionName);
    }
    if (!out.IsTruncated || !out.Marker) break;
    marker = out.Marker;
  }
  return Array.from(new Set(denied)).sort();
}

/** IAM 限流(`Throttling` / `Rate exceeded`)—— 只有它值得重试;别的失败(无权限 / 参数错)重试也不会变。 */
export function isIamThrottle(e: unknown): boolean {
  const x = e as { name?: string; Code?: string; message?: string } | null;
  return /^Throttl/i.test(String(x?.name ?? x?.Code ?? "")) || /rate exceeded/i.test(String(x?.message ?? ""));
}

/**
 * 🔴 (第二十四轮补跑实测):每区一次模拟、4 路并发、零重试 ⇒ 一被 IAM 限流就把那个区记成「未能核实」。
 *   连调三次候选区接口,每次 6 个左右的区随机落进 unverified(「Rate exceeded」),**被拦的区在向导里时而可选时而不可选**
 *   用户点进一个其实被组织 SCP 拦死的区、部署几分钟后才在 PRE_BUILD 失败,正是要消灭的那条路。
 *   ⇒ 只对限流做**有界** full-jitter 重试(`random() * min(cap, base·2^n)`,同一批并发不会齐步重撞;见记忆 bounded-retry-needs-full-jitter),
 *   预算由最坏并发推:3 路并发 × 每区 ≤ 6 次 ⇒ 十几个区总时长仍在十秒量级;用完预算仍限流 ⇒ 照实 unverified(不装作量过)。
 *   并发 4 → 3。不加服务端缓存:向导的契约是「打开 / 刷新都真查一次账号」。
 */
const THROTTLE_ATTEMPTS = 6;
const THROTTLE_BASE_MS = 250;
const THROTTLE_CAP_MS = 4000;
const CONCURRENCY = 3;

async function withThrottleRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (!isIamThrottle(e) || n + 1 >= THROTTLE_ATTEMPTS) throw e;
      await sleep(Math.random() * Math.min(THROTTLE_CAP_MS, THROTTLE_BASE_MS * 2 ** n));
    }
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 给一批候选区分出 blocked / unverified。并发 3(每区一次模拟,限流有界重试)。
 * 任何失败都**按区**落进 unverified,不抛(候选表本身还要能出来)。
 */
export async function classifyRegionsByOrgPolicy(
  regions: string[],
  clients: { codebuild?: CodeBuildClient; iam?: IAMClient; sleep?: (ms: number) => Promise<void> } = {}
): Promise<OrgPolicyVerdict> {
  const sleep = clients.sleep ?? realSleep;
  const checkedAt = new Date().toISOString();
  // 两者都是主控区发起的**控制面**调用(部署项目在主控区;IAM 是全局服务,从主控区端点发)
  // 🔴 不许走数据面工厂 —— 那会让 observe 先用数据面角色试一次(被拒再重发 = IAM 请求量翻倍 ⇒ 限流)
  const cb = clients.codebuild ?? sdkClient("control-plane", CodeBuildClient, { region: homeRegion() });
  const iam = clients.iam ?? sdkClient("control-plane", IAMClient, { region: homeRegion() });
  let principal: string;
  try {
    principal = await deployPrincipalArn(cb);
  } catch (e) {
    const reason = `未能核实组织策略:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 200)}`;
    return { principal: null, blocked: [], unverified: regions.map((region) => ({ region, reason })), checkedAt };
  }
  const blocked: BlockedRegion[] = [];
  const unverified: OrgPolicyVerdict["unverified"] = [];
  const throttled: string[] = [];
  const unverifiedReason = (e: unknown) =>
    `未能核实组织策略:${sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 200)}`;
  const recordVerdict = (r: string, actions: string[]) => {
    if (actions.length === 0) return;
    blocked.push({
      region: r,
      actions,
      layer: "organizations-scp",
      reason: `账号所在组织的服务控制策略(SCP)拒绝了部署必需的动作:${actions.join(", ")}(AllowedByOrganizations=false)`,
    });
  };
  const queue = [...regions];
  const worker = async () => {
    for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
      try {
        recordVerdict(r, await withThrottleRetry(() => orgDeniedActionsIn(iam, principal, r), sleep));
      } catch (e) {
        if (isIamThrottle(e)) throttled.push(r);
        else unverified.push({ region: r, reason: unverifiedReason(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, regions.length) }, worker));
  // 🔴 第一遍预算用完仍被限流的区(实测独占跑也会剩 1 个,sa-east-1)——
  //   用户 10/09 定的契约是「每次刷新都真查」⇒ 不许用缓存糊过去。并发池安静下来后**冷却一个上限时长**,
  //   再**逐个串行**补查一遍(新的一份有界预算;串行 ⇒ 不再与自己的并发互相抢令牌)。补查仍失败 ⇒ 照实 unverified。
  if (throttled.length > 0) {
    await sleep(THROTTLE_CAP_MS);
    for (const r of throttled) {
      try {
        recordVerdict(r, await withThrottleRetry(() => orgDeniedActionsIn(iam, principal, r), sleep));
      } catch (e) {
        unverified.push({ region: r, reason: unverifiedReason(e) });
      }
    }
  }
  blocked.sort((a, b) => a.region.localeCompare(b.region));
  unverified.sort((a, b) => a.region.localeCompare(b.region));
  // 只回角色名(不回完整 ARN —— 带账号号)
  return { principal: principal.split("/").pop() ?? null, blocked, unverified, checkedAt };
}
