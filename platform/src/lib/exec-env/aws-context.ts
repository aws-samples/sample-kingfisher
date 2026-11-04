// 控制面自身的 AWS 上下文(账号/region/partition)—— register 与 seed-home 的**唯一**来源。
//
// 🔴 用户拍板(2026-09-01):「执行环境初始化不应该让用户提供账号,严格只能在控制中心的账号下的
//    不同区域增加执行环境。」⇒ accountId/partition **一律服务端自取,客户端字段直接拒**
//    (与 broker 的入参白名单同哲学:拒而不是忽略)。跨账号 target 一期明确不做
//    (buildspec 早有同语义护栏:目标账号 ≠ build 身份账号即 fail)。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { partitionForRegion } from "@/lib/exec-env/registry";

const HOME_REGION = homeRegion();
const sts = sdkClient("control-plane", STSClient, { region: HOME_REGION });

let cached: { accountId: string; region: string; partition: string } | null = null;

/**
 * 控制面账号/region/partition。账号经 STS GetCallerIdentity(免权限、恒可用),进程内缓存
 * (账号在任务生命周期内不变)。region 从运行时环境取(ECS 注入),partition 由 region 推导。
 */
export async function getControlPlaneContext(): Promise<{ accountId: string; region: string; partition: string }> {
  if (cached) return cached;
  const out = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = out.Account ?? "";
  if (!/^\d{12}$/.test(accountId)) {
    throw new Error(`STS 返回的账号非法:${JSON.stringify(out.Account)} —— 不猜、不回落 env`);
  }
  cached = { accountId, region: HOME_REGION, partition: partitionForRegion(HOME_REGION) };
  return cached;
}

/** 测试用:清缓存。 */
export function __resetAwsContext(): void {
  cached = null;
}
