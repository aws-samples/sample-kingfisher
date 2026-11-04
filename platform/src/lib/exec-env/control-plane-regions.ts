// 控制面**已放行**的执行 region 清单(运行时只读视图)。
//
// 【为什么需要它(2026-09-06 新账号真撞,init 段 I-4)】平台 TaskRole 的 `aws:RequestedRegion` 条件在 **synth 期**烘入
//   (infra/lib/shared/execution-regions.ts;§12.1 刻意不让 exec-env buildspec 碰控制面 IAM)。于是「向导注册 us-west-2 →
//   CodeBuild 把 5 个栈真建好 → 页面『检测初始化』」这一步,平台去 us-west-2 DescribeSecret 被自己的 IAM 拒,
//   页面却只显示衍生症状「描述符缺 resources.*(先 finalizeTargetResources 回写资源袋)」×9 —— 真因(控制面尚未放行该 region、
//   要先 `redeploy-platform.sh`)藏在 API 的 `finalizeError` 里,页面根本不渲染。
// ⇒ 让平台**知道自己被烘入了哪些 region**(平台栈把同一份 `-c execution-regions` 解析结果注进 env `EXECUTION_REGIONS`),
//   注册 / 探活 / 列表都能据此把「控制面尚未放行」说成人话 + 给出确切运维命令,而不是让人对着 9 行红猜。
// 🔴 只读、零副作用:放行清单本身只能由控制面重部署改(§12.0);本文件不做任何「自动放行」。
// 🔴 缺 env ⇒ 视为只放行 home(与 execution-regions.ts「不传 context ⇒ 只 home」同口径;不猜宽)。

import { homeRegionOf } from "@/lib/place/home-region";

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** 已放行 region 全集(含 home;去重排序)。 */
export function controlPlaneRegions(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homeRegionOf(env).trim(); // L4:读区只经唯一作者 lib/place/home-region
  const raw = (env.EXECUTION_REGIONS || "").trim();
  const extra = raw ? raw.split(",").map((s) => s.trim()).filter((s) => REGION_RE.test(s)) : [];
  return Array.from(new Set([home, ...extra])).sort();
}

export function isControlPlaneRegionEnabled(region: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return controlPlaneRegions(env).includes(region);
}

/** 用户 / 运维可直接照做的话(页面 Alert 与 API `finalizeError` 前缀都用这一句 —— 单一作者)。 */
export function regionNotEnabledHint(region: string, env: NodeJS.ProcessEnv = process.env): string {
  return (
    `控制面尚未放行 region ${region}(当前只放行:${controlPlaneRegions(env).join(", ")})。` +
    `该 region 的栈可以建成,但平台在「检测初始化」时会被自己的 IAM 区域条件拒绝。` +
    `运维:bash scripts/redeploy-platform.sh <profile> <home-region>(§1b 自动从执行环境注册表推导放行清单并重部署控制面;控制面 ECS 会滚动一次),完成后再点「检测初始化」。` +
    `以后不想每加一区都跑一次:同一命令前加 EXEC_REGION_CANDIDATES=<区1,区2,…>(或 all-enabled)一次性预授权候选区,候选区内新建的执行区在页面即可完成。`
  );
}
