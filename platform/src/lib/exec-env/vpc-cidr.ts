// @kf-batch 50-WP23-xregion-peering
// 执行环境 VPC 的 **CIDR 分配**(平台侧;50 SPEC §3.14ter)。
//
// 【为什么平台侧要有一份】CIDR 必须在**注册那一刻**就定下来并落进描述符:
//   broker 要把它透传给 `cdk deploy`(`-c exec-env-vpc-cidr=`),而 broker 只读描述符。
//   分配又必须看**全量已用值**(同一账号里任意两个执行环境的 VPC 都不许重叠 —— 否则主控区的路由表
//   没法同时指向两条 peering)⇒ 分配点只能在注册表这一侧。
//
// 🔴 常量与判据由 parity 门禁钉在 `infra/lib/exec-env/vpc-cidr.ts`(**理由与设计写在那边,不在这里抄第二份**)。
//   一句话:池子 `10.128.0.0/9` 与主控区 `10.0.0.0/16` **在构造上不相交**,
//   于是「与 home 重叠」这种非法状态压根写不出来(change-safety A4)。
//   infra 侧那份禁止跨构建边界 import,只能两份 + parity。

export const EXEC_ENV_VPC_CIDR_POOL = "10.128.0.0/9";
export const EXEC_ENV_VPC_CIDR_FIRST_OCTET = 128;
export const EXEC_ENV_VPC_CIDR_SLOTS = 128;
export const EXEC_ENV_VPC_CIDR_RE = /^10\.(12[89]|1[3-9]\d|2[0-4]\d|25[0-5])\.0\.0\/16$/;

/** 池子用尽 —— **确定性**耗尽(路由层要映射成 409 + 可操作的话,不是 500「稍后重试」)。 */
export class ExecEnvCidrPoolExhausted extends Error {
  readonly slots = EXEC_ENV_VPC_CIDR_SLOTS;
  constructor(readonly used: string[]) {
    super(
      `执行环境 VPC 地址池 ${EXEC_ENV_VPC_CIDR_POOL} 已用满(${EXEC_ENV_VPC_CIDR_SLOTS} 个 /16 全部占用)。` +
        `这不是瞬态失败,重试不会改变结果 —— 请先删除不再使用的执行环境。`
    );
    this.name = "ExecEnvCidrPoolExhausted";
  }
}

export function isExecEnvVpcCidr(v: unknown): v is string {
  return typeof v === "string" && EXEC_ENV_VPC_CIDR_RE.test(v);
}

export function execEnvVpcCidrForSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= EXEC_ENV_VPC_CIDR_SLOTS) {
    throw new Error(`执行环境 CIDR 槽位越界:${slot}(合法 0..${EXEC_ENV_VPC_CIDR_SLOTS - 1})`);
  }
  return `10.${EXEC_ENV_VPC_CIDR_FIRST_OCTET + slot}.0.0/16`;
}

export function execEnvVpcCidrSlotOf(cidr: unknown): number | null {
  if (!isExecEnvVpcCidr(cidr)) return null;
  return Number(cidr.split(".")[1]) - EXEC_ENV_VPC_CIDR_FIRST_OCTET;
}

/**
 * 取最小空闲槽位。纯函数(注册路径调它)。
 * 🔴 已用清单里不在池内的值(存量描述符没有这个字段 / home 用的是平台栈那个 VPC)一律忽略。
 */
export function allocateExecEnvVpcCidr(used: readonly unknown[]): string {
  const taken = new Set<number>();
  for (const u of used) {
    const slot = execEnvVpcCidrSlotOf(u);
    if (slot !== null) taken.add(slot);
  }
  for (let slot = 0; slot < EXEC_ENV_VPC_CIDR_SLOTS; slot++) {
    if (!taken.has(slot)) return execEnvVpcCidrForSlot(slot);
  }
  // 🔴 不用 `[...set]`:平台侧 tsconfig target 低于 es2015,展开 Set 编译不过(infra 侧可以)
  const takenSlots = Array.from(taken).sort((a, b) => a - b);
  throw new ExecEnvCidrPoolExhausted(takenSlots.map(execEnvVpcCidrForSlot));
}
