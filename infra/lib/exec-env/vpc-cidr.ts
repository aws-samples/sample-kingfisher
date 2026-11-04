// 执行环境 VPC 的 **CIDR 唯一作者**(50 SPEC §3.14ter)。
//
// 【为什么这个文件必须存在 —— 2026-09-14 开步 2 时勘定出来的硬阻断】
//   跨区私网通路定案成 **peering + home 侧同区接口端点 + 非 home 侧 PHZ**,而
//   **VPC peering 硬性要求两侧 CIDR 不重叠**。真环境实测:
//     · home VPC(`BgpVpcStack/BgpVpc`)= `10.0.0.0/16`(`vpc-stack.ts` 没给 `ipAddresses` ⇒ CDK 默认值);
//     · 执行环境 VPC(`base-stack.ts`)**也没给** ⇒ 同一个默认值 `10.0.0.0/16`。
//   ⇒ 两侧逐位相同,peering **物理上建不出来**。这条事实 2026-09-08 就写在 base-stack 的注释里
//     (「peering 那条路建不出来」),而我 2026-09-14 换选型时**只重勘了 SCP、没重勘 CIDR**,
//     一次性 probe 用的是 `10.90.0.0/16` / `10.91.0.0/16` 两个 throwaway VPC ⇒ 前提被悄悄换掉了。
//   🔴 教训(与 [[stale-blockers-must-be-reprobed]] 互为反面):**旧结论会过期,旧结论的「前提」也会**。
//     probe 坐实的是「这条路通」,不是「我们的底座能走这条路」—— 两者之间隔着一个 CIDR。
//
// 【设计:让「与 home 重叠」在类型层不可表达(change-safety A4)】
//   池子刻意选在 `10.128.0.0/9`(第二段 128–255),与 home 的 `10.0.0.0/16` **在构造上不相交** ——
//   不是「运行期检查一下有没有撞」,而是**合法值域根本不含**能撞的地址。
//   于是 home 侧那条 SG 放行规则可以写成**一条静态规则**(整池 443),永不随 target 增减而改
//   —— 这一条很关键:平台栈里的 SG 若要按 target 逐条加规则,就得由 API 侧改栈外资源,
//   而 CFN 更新那个 SG 时可能把栈外加的规则收回去 ⇒ 症状是「某个区的台账回写突然超时」,离根因极远。
//
// 🔴 **不许有第二处默认值**:`ExecEnvContext.vpcCidr` 是**必填**;缺就 `cdk synth` 当场抛。
//   「有静默合法默认值的参数」正是本项目累计翻车最多的一类(见记忆 silent-default-is-a-defect-class):
//   这里一旦允许「不传就用 10.0.0.0/16」,症状会是**部署成功、peering 建失败、回写静默超时**。

/** 池子(CIDR 记法,仅供文案/门禁引用;真正的判据是下面的正则)。 */
export const EXEC_ENV_VPC_CIDR_POOL = "10.128.0.0/9";

/** 池内第一个 /16 的第二段。 */
export const EXEC_ENV_VPC_CIDR_FIRST_OCTET = 128;

/** 池内槽位数 = `10.128.0.0/16` … `10.255.0.0/16`。 */
export const EXEC_ENV_VPC_CIDR_SLOTS = 128;

/**
 * 合法执行环境 VPC CIDR。
 * 🔴 只收 `/16`:base 栈的子网按 `cidrMask: 24` 切(私有子网落 `x.x.2.0/24` / `x.x.3.0/24`),
 *    换掉掩码宽度会让**所有子网 CidrBlock 变化 ⇒ 子网被替换**(ACCEPTANCE N0-10 明令禁止的破坏性路径)。
 *    只动第二段 ⇒ 池内任何取值的子网切法逐字节同形。
 */
export const EXEC_ENV_VPC_CIDR_RE = /^10\.(12[89]|1[3-9]\d|2[0-4]\d|25[0-5])\.0\.0\/16$/;

/** 池子用尽 —— **确定性**耗尽,不是瞬态争抢(与 `RegisterNamespaceExhausted` 同款语义)。 */
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

/** 槽位 → CIDR(唯一构造点)。 */
export function execEnvVpcCidrForSlot(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= EXEC_ENV_VPC_CIDR_SLOTS) {
    throw new Error(`执行环境 CIDR 槽位越界:${slot}(合法 0..${EXEC_ENV_VPC_CIDR_SLOTS - 1})`);
  }
  return `10.${EXEC_ENV_VPC_CIDR_FIRST_OCTET + slot}.0.0/16`;
}

/** CIDR → 槽位;不在池内 ⇒ `null`(**不抛**:用来筛「哪些已用值算在池内」)。 */
export function execEnvVpcCidrSlotOf(cidr: string | undefined | null): number | null {
  if (typeof cidr !== "string" || !EXEC_ENV_VPC_CIDR_RE.test(cidr)) return null;
  return Number(cidr.split(".")[1]) - EXEC_ENV_VPC_CIDR_FIRST_OCTET;
}

/**
 * 解析并校验(fail-closed)。
 * @param who 出错文案里的来源名(`-c exec-env-vpc-cidr` / 描述符字段 …),便于一眼定位。
 */
export function parseExecEnvVpcCidr(raw: string | undefined, who: string): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) {
    throw new Error(
      `${who} 缺失 —— 执行环境 VPC 的 CIDR **必须显式给**,不接受默认值:` +
        `CDK 的默认 10.0.0.0/16 与主控区 VPC 逐位相同,跨区 peering 建不出来(SPEC §3.14ter)`
    );
  }
  if (!EXEC_ENV_VPC_CIDR_RE.test(v)) {
    throw new Error(
      `${who} 非法:${v} —— 必须是地址池 ${EXEC_ENV_VPC_CIDR_POOL} 里的一个 /16` +
        `(形如 10.128.0.0/16 … 10.255.0.0/16)。池子刻意与主控区 10.0.0.0/16 不相交,` +
        `这样「与 home 重叠」这种非法状态压根写不出来`
    );
  }
  return v;
}

/**
 * 从**已用清单**里取最小空闲槽位。纯函数(注册路径调它;单测穷举)。
 * 🔴 传进来的是「现存描述符的 vpcCidr 全集」——不在池内的值(如存量 home 的空缺)直接忽略,
 *    绝不因为看不懂就跳过分配。
 */
export function allocateExecEnvVpcCidr(used: readonly (string | undefined | null)[]): string {
  const taken = new Set<number>();
  for (const u of used) {
    const slot = execEnvVpcCidrSlotOf(u);
    if (slot !== null) taken.add(slot);
  }
  for (let slot = 0; slot < EXEC_ENV_VPC_CIDR_SLOTS; slot++) {
    if (!taken.has(slot)) return execEnvVpcCidrForSlot(slot);
  }
  throw new ExecEnvCidrPoolExhausted([...taken].sort((a, b) => a - b).map(execEnvVpcCidrForSlot));
}

/**
 * 两个 IPv4 CIDR 是否相交(**门禁用**:断「池子 ∩ home = ∅」、断「本 target 与 home 不重叠」)。
 * 🔴 这个函数**不是**放行路径上的兜底 —— 放行靠 `EXEC_ENV_VPC_CIDR_RE`(构造上不相交)。
 *    它存在的意义是让「池子选对了没有」这件事可被断言,而不是靠读注释相信。
 */
export function cidrsOverlap(a: string, b: string): boolean {
  const ra = cidrRange(a);
  const rb = cidrRange(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

function cidrRange(cidr: string): { start: number; end: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) throw new Error(`不是合法 IPv4 CIDR:${cidr}`);
  const octets = [1, 2, 3, 4].map((i) => Number(m[i]));
  if (octets.some((o) => o > 255)) throw new Error(`IPv4 段越界:${cidr}`);
  const prefix = Number(m[5]);
  if (prefix > 32) throw new Error(`前缀长度越界:${cidr}`);
  const ip = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix);
  const start = Math.floor(ip / size) * size;
  return { start, end: start + size - 1 };
}

/**
 * 🔴 **home 的存量值**(唯一一处 `10.0.0.0/16` 字面量,且刻意不在池内)。
 *
 * home 的执行环境栈组几乎不会被部署(home 的组件由 `deploy-all` 建),但它**可以**被 synth
 * (门禁、`add-components` 走 broker 时)。对 home 而言这个值是对的:它不与自己 peering,
 * 沿用 CDK 的历史默认 ⇒ **对 home 的行为逐字节不变**。
 * ⚠️ 它与主控区 VPC 重叠 —— 这正是「home 的执行环境 VPC 不参与跨区私网通路」的物理表现,
 *    不是笔误;非 home 一律走池子。
 */
export const HOME_EXEC_ENV_VPC_CIDR = "10.0.0.0/16";
