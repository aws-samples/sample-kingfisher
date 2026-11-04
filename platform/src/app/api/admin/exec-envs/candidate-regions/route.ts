export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP27b-n-region-auto
// GET /api/admin/exec-envs/candidate-regions —— **新建执行环境时可选的 region**,从账号真值派生。
//
// 【为什么有这个路由 —— 用户 2026-09-20 原话】
//   「你不一定要跑第三个区域,只要第二个区域和第一个区域的逻辑是对的,后面在正式账号上运行,
//     即便是开 N 个区域,也是一样的。所以,你主要验证两个区域的就 OK,**不能硬编码两个,
//     应该是多区域自动的**。」
//   勘定结果:**后端本来就是 N 区自动的** —— `registerTarget` 只校验 region 的形态
//   (`/^[a-z]{2}(-[a-z]+)+-\d$/`),任何合法区都收。天花板只在**界面**:
//   `CreateWizard.tsx` 里 `REGION_OPTIONS` 是**写死的 7 个区**,而且默认值写死 `us-west-2`。
//   ⇒ 真实账号里开第 8 个区(比如 `ap-south-1`)在页面上根本选不到;
//     而那个默认值本身也有案底 —— 「那个默认值在 2026-09-15 真建出第 5 套环境」(段 w5a 的拒因原文)。
//
// 【这个路由回什么】
//   · `regions`:**这个账号真正启用了哪些 region**(`ec2:DescribeRegions`,账号级真值,不是我编的清单);
//   · `occupied`:其中**已经有执行环境**的那些(带占位者 targetId / status)——
//     🔴 「一个区域只能有一个执行环境」是用户反复拍板的产品守卫(`registerTarget` → 409)。
//     原来这条只在**提交之后**以 409 的形式告诉用户;现在把它**提前摆在选区那一刻**,
//     而且按「禁用而不是隐藏」的做法:看得见、点不动、说得出为什么。
//   · 占位口径刻意用「**非死状态**」而不是「能承接」:`registered`(注册了还没装出来)**也算占位**
//     (同一张表的三种口径,见 vlib.serviceable_targets 的注释;混用过三次了)。
import { NextRequest, NextResponse } from "next/server";
import { EC2Client, DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { listTargetsRaw } from "@/lib/exec-env/registry";
// 序 48 —— 控制面已放行(含安装 / 升级时预授权的候选区)的区:向导在选区那一刻就标出「建完即可用」还是「构建后还要运维放行」
import { controlPlaneRegions } from "@/lib/exec-env/control-plane-regions";
// @kf-batch 50-B40-candidate-blocked —— 被组织 SCP 拦住部署必需动作的区:列出但禁用,写明被拦的动作与拒因层
import { classifyRegionsByOrgPolicy } from "@/lib/exec-env/region-org-block";
// @kf-batch 50-WP31-seq5-dataplane-role —— 散建收口到唯一工厂(序 5:数据面凭证注入点只有这一处)
import { sdkClient } from "@/lib/aws/clients";

/** 已删除 / 正在删的描述符**不占位**(它们腾出来的区可以再建)。 */
const DEAD_STATUSES = new Set(["deleted", "deleting", "removed", "delete-failed", "gone"]);

export async function GET(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  try {
    // 账号启用了哪些 region —— 账号级真值。`AllRegions: false` = 只回**已启用**的
    //   (未启用的区建栈必失败,列出来只会把用户带进一个注定 500 的路径)。
    const ec2 = sdkClient("control-plane", EC2Client, { region: homeRegion() });
    const out = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
    const regions = (out.Regions ?? [])
      .map((r) => String(r.RegionName ?? ""))
      .filter((r) => r.length > 0)
      .sort();
    const targets = await listTargetsRaw();
    const occupied = targets
      .filter((t) => !DEAD_STATUSES.has(String(t.status)))
      .map((t) => ({ region: String(t.region), targetId: String(t.targetId), status: String(t.status) }))
      .sort((a, b) => a.region.localeCompare(b.region));
    const occupiedSet = new Set(occupied.map((o) => o.region));
    // @kf-batch 50-B40-candidate-blocked —— 🔴 「已启用」是必要不充分:组织 SCP 拦住的区,部署必在 PRE_BUILD 被显式拒(B-40)。
    //   只量**还没被占**的区(已占的本来就不可选,不必为它们多打模拟)。量不了的区进 unverified、仍可选但照实标注。
    const org = await classifyRegionsByOrgPolicy(regions.filter((r) => !occupiedSet.has(r)));
    const blockedSet = new Set(org.blocked.map((b) => b.region));
    // 序 48:控制面放行清单(env EXECUTION_REGIONS = IAM 区域条件烘入的那份;含 home 与预授权候选区)。只读视图,这里不做任何放行。
    const enabledSet = new Set(controlPlaneRegions());
    const res = apiOk({
      regions,
      occupied,
      // 在账号清单里且控制面已放行的区:在这些区新建 ⇒ 构建完直接「检测初始化」→「启用」,不需要运维再跑 redeploy-platform.sh
      controlPlaneEnabled: regions.filter((r) => enabledSet.has(r)),
      // 可直接新建的那些(= 账号启用 ∧ 还没被占 ∧ 没被组织策略拦)。界面仍要把 occupied / blocked 的**列出来但禁用**,
      // 所以这个字段只是给调用方省一次集合运算,不是「界面只许显示这些」。
      available: regions.filter((r) => !occupiedSet.has(r) && !blockedSet.has(r)),
      blocked: org.blocked,
      orgPolicy: { principal: org.principal, unverified: org.unverified, checkedAt: org.checkedAt, source: "iam:SimulatePrincipalPolicy(OrganizationsDecisionDetail)" },
      source: "ec2:DescribeRegions + bgp-execution-envs + iam:SimulatePrincipalPolicy",
      note:
        "一个 region 只允许一套执行环境:已占的区会列出来但不可选,并写明占位者。" +
        "本清单来自账号真值,不是写死的候选表 —— 账号里开了多少区就能建多少区。" +
        "被账号所在组织策略(SCP)拦住部署必需动作的区也会列出来但不可选,并写明被拦的动作。",
      // 🔴 每次请求都真查一次(用户 2026-10-09:「每次刷新列表都去真实查询一次」)⇒ 回带查询时刻,界面照实显示
      queriedAt: new Date().toISOString(),
    });
    // 不许任何一层(浏览器 / CloudFront)缓存这份清单:账号里新开一个区,下一次刷新就必须看得见
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    // 🔴 拿不到账号 region 清单时**不许静默回落到一份写死的清单** —— 那正是这个路由要消灭的东西。
    //   响亮报错 + 说清缺什么权限(`ec2:DescribeRegions` 已随本刀登记进 IAM 清单)。
    return apiError(
      `读不到账号启用的 region 清单(ec2:DescribeRegions):${msg}。` +
        `⇒ 界面不会拿一份写死的候选表糊弄你;请确认 TaskRole 有 ec2:DescribeRegions。`,
      500,
      { code: "INTERNAL" }
    );
  }
}
