// 执行环境栈组的**入参解析与校验**(50 DESIGN §4.1a-4:app.ts 加 `-c exec-env-*` 时只实例化该 target 的栈组)。
//
// 【为什么单独一个文件】栈组的正确性第一关是"入参对不对":region 写错 ⇒ 资源建到错的地方;
// components 拼错 ⇒ 静默少装一个组件、到运行期才发现。这些判断必须**在 synth 前**做完并且能被单测/门禁打,
// 不能散在各 stack 的 constructor 里。
//
// 🔴 fail-closed:任何一项不合法就 **throw**,让 `cdk synth` 当场失败。
//    绝不"猜一个默认值继续" —— 部署期猜错的代价是建出一批名字/位置都错的真实资源。
import { HOME_TARGET_ID, RESOURCE_KINDS } from "../shared/naming";
// CIDR 的唯一作者(为什么必须显式给见那个文件的头注释)
import { EXEC_ENV_VPC_CIDR_POOL, HOME_EXEC_ENV_VPC_CIDR, cidrsOverlap, parseExecEnvVpcCidr } from "./vpc-cidr";

/** 50 SPEC §1.1 的组件枚举(与 platform 侧 `registry.ts` 的 `TARGET_COMPONENTS` 同集合)。 */
export const EXEC_ENV_COMPONENTS = [
  "core",
  "redshift",
  "kafka",
  "mwaa",
  "dms",
  "flink",
  "agentcore",
  "residency-api",
  // (SPEC v3.27 §3.15)
  "airflow-serverless",
] as const;
export type ExecEnvComponent = (typeof EXEC_ENV_COMPONENTS)[number];

/**
 * ② —— 🔴🔴 每个执行环境都必须装齐的组件(用户 2026-10-10 拍板,不提供精简形态)。
 * 平台侧唯一作者 = `platform/src/lib/exec-env/implemented-components.ts` 的 `BASE_REQUIRED_COMPONENTS` /
 * `requiredComponentsFor`;这里是 infra 那道构建边界的副本,由平台侧 parity 单测逐字节钉住。
 * 法域 ≠ home 另装 residency-api;agentcore 只属主控区且不由栈组部署(external),broker 不判它。
 */
export const EXEC_ENV_REQUIRED_BASE_COMPONENTS = ["core", "redshift", "dms", "flink", "airflow-serverless"] as const;

/**
 * 栈后缀里额外允许的**非组件**值。
 * `base` 是**底座**(VPC + CMK)而不是组件:它不出现在描述符的 `components` 里,
 * 但每个 target 都必须有,且所有组件栈都依赖它。写在这里而不是塞进组件枚举,
 * 是为了不污染"组件 = 用户勾选项"这个语义(§1.1 的 components 是勾选结果)。
 */
export const BASE_STACK_SUFFIX = "base";

/** targetId 正则(与 platform 侧 `target-id.ts` 同款;infra 跨不过构建边界,由 parity 门禁钉住)。 */
const TARGET_ID_RE = /^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ACCOUNT_RE = /^\d{12}$/;

export interface ExecEnvContext {
  targetId: string;
  region: string;
  account: string;
  /** 已去重、已按枚举顺序排序、必含 `core`。 */
  components: ExecEnvComponent[];
  // 🔴 `natGateways` **已删除**(不是改默认值,是从类型里消失)。
  //    执行环境零出网,NAT 数恒为 0;把入参留着 = 留一个「可以再开 NAT」的口子,
  //    而那正是 change-safety A4「让非法状态无法表达」要消灭的东西。传 `-c exec-env-nat-gateways`
  //    会在 `readExecEnvContext` 直接抛(不是忽略 —— 静默忽略会让运维以为自己调了档)。
  /**
   * 🔴 **显式 AZ 名**(不走 CDK 的 AZ 查找)。
   * 缺省 `[<region>a, <region>b]`;可 `-c exec-env-azs=us-west-2a,us-west-2c` 覆盖。
   * 为什么必须显式:见 base-stack 的「零 context 查找」说明。
   */
  azs: string[];
  /** 是否是 home target(home 走存量实名豁免)。 */
  isHome: boolean;
  /**
   * 🔴 **控制面(home)所在 region** —— 只有 `mwaa` 组件需要:该区 MWAA 的 DAG 回写 run 台账到 home 的 `bgp-*` 表
   * (SPEC v3.26 §3.14「控制面回写 = 唯一跨区例外」),角色策略里的 DDB ARN / KMS via-service 都要它。
   * 来自 `-c exec-env-home-region`(buildspec 传 CodeBuild 自身 `$AWS_REGION` = 控制面 region);
   * 不含 mwaa 时可缺(undefined),含 mwaa 时缺即 synth 抛(fail-closed,不猜 home 在哪)。
   */
  homeRegion?: string;
  /**
   * 🔴 本执行环境 VPC 的 CIDR —— **必填**(类型上不可缺)。
   * 非 home 由 `-c exec-env-vpc-cidr` 给(值来自描述符 `vpcCidr`,注册时从地址池分配);
   * home 走存量值(见 `HOME_EXEC_ENV_VPC_CIDR`)。
   * 为什么不能有「不传就用 CDK 默认 10.0.0.0/16」这条退路:那个默认值与主控区 VPC 逐位相同,
   * 跨区 peering 建不出来,而症状是**部署全绿、台账回写静默超时**(SPEC §3.14ter)。
   */
  vpcCidr: string;
  /**
   * 🔴 主控区那一侧的三件事实,**要么三个都有、要么整个不存在**(非 home 必有;home 没有)。
   *
   * 为什么捆成一个对象而不是三个可选字段:三个字段各自可选 ⇒ 「只有两个」这种状态在类型上是**可表达**的,
   * 而那种状态部署出来的形态是「peering 建了、回程路由没加」= 请求发得出去、响应永远回不来
   * (change-safety A4:让非法状态无法表达)。
   *
   * 值由部署 buildspec 从 `BgpVpcStack` 的 Outputs 读出后经 `-c` 传入 —— 跨 region 用不了
   * CFN Export/ImportValue,而那个栈才是这些资源的作者(单一真值源仍在它那边)。
   */
  homeLink?: {
    /** home VPC id(peering 的对端)。 */
    vpcId: string;
    /** home VPC 的 CIDR(本区私有路由表指向 peering 的目的地段)。 */
    vpcCidr: string;
    /** home 侧那个**同区** DynamoDB 接口端点(privateDns=false);私有托管域要指向它的 ENI。 */
    ddbEndpointId: string;
  };
}

/** region 前缀 → partition(与 platform 侧 registry 的 `partitionForRegion` 同规则)。 */
export function partitionForRegion(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

/**
 * 从 CDK context 读取并校验执行环境入参。
 *
 * @param get `app.node.tryGetContext`
 * @param fallbackAccount `CDK_DEFAULT_ACCOUNT`(仅当未显式传 `-c exec-env-account` 时用)
 * @returns `null` 表示**本次 synth 不是 exec-env 模式**(没传 `-c exec-env-target`)——
 *          调用方据此走原来的控制面路径,**行为一个字节不变**。
 */
export function readExecEnvContext(
  get: (key: string) => unknown,
  fallbackAccount?: string
): ExecEnvContext | null {
  const targetId = str(get("exec-env-target"));
  if (!targetId) return null; // 不是 exec-env 模式

  if (!TARGET_ID_RE.test(targetId)) {
    throw new Error(
      `-c exec-env-target 非法:${targetId}(须匹配 ${TARGET_ID_RE.source};50 SPEC §1.1a)`
    );
  }

  const region = str(get("exec-env-region"));
  if (!region || !REGION_RE.test(region)) {
    throw new Error(
      `-c exec-env-region 缺失或非法:${String(region)} —— 执行环境栈组**不接受"用默认 region"**,` +
        `必须显式指定(默认 region 会把第二个 target 的资源建到 home 去)`
    );
  }

  const account = str(get("exec-env-account")) || fallbackAccount;
  if (!account || !ACCOUNT_RE.test(account)) {
    throw new Error(`exec-env 账号缺失或非 12 位:${String(account)}(传 -c exec-env-account= 或设 CDK_DEFAULT_ACCOUNT)`);
  }

  const components = parseComponents(str(get("exec-env-components")));

  // 🔴 这个入参已退役,**传了就抛**。
  if (str(get("exec-env-nat-gateways")) !== undefined) {
    throw new Error(
      "-c exec-env-nat-gateways 已退役(50 SPEC §3.16:执行环境零出网,NAT 恒为 0)—— " +
        "请把这个入参从调用方删掉;`networkProfile` 也已无效(字段保留只为兼容存量描述符)"
    );
  }

  const azs = parseAzs(str(get("exec-env-azs")), region);

  // mwaa 组件必须知道控制面在哪个 region(回写 run 台账);其余组件不需要
  const homeRegion = str(get("exec-env-home-region"));
  if (homeRegion !== undefined && !REGION_RE.test(homeRegion)) {
    throw new Error(`-c exec-env-home-region 非法:${homeRegion}(须 region 全名,形如 us-east-1)`);
  }
  // 🔴 `homeRegion` 从「只有 mwaa 需要」升级为「**非 home target 一律必需**」。
  //    理由:零出网之后,回写 home 台账的那条路要靠**跨区 DynamoDB 接口端点 + 私有托管域**
  //    (SPEC §3.16-C),而任何跑任务的 target 都要回写台账 —— 不知道控制面在哪个 region 就建不出这条路,
  //    症状会是「任务跑成功、看板上这次运行不存在」(已经踩过一次同族的坑)。
  const isHomeTarget = targetId === HOME_TARGET_ID;
  if (!isHomeTarget && !homeRegion) {
    throw new Error(
      "-c exec-env-home-region 缺失 —— 非 home 执行环境**一律**需要它:" +
        "① 该区调度器回写 home 运行台账的角色策略(SPEC §3.14);" +
        "② 零出网下回写要走的跨区 DynamoDB 接口端点 + 私有托管域(SPEC §3.16-C)。**不猜默认值**"
    );
  }

  // VPC CIDR
  // 🔴 非 home **必须显式给**:跨区 peering 要求与主控区 CIDR 不重叠,而 CDK 的默认值恰好一模一样。
  //    home 是唯一例外 —— 它压根不与自己 peering,沿用存量值 ⇒ 对 home 的行为逐字节不变。
  const rawVpcCidr = str(get("exec-env-vpc-cidr"));
  const vpcCidr = isHomeTarget && rawVpcCidr === undefined
    ? HOME_EXEC_ENV_VPC_CIDR
    : parseExecEnvVpcCidr(rawVpcCidr, "-c exec-env-vpc-cidr");

  // 主控区那一侧的三件事实(非 home 三个都必需)
  const homeVpcId = str(get("exec-env-home-vpc-id"));
  const homeVpcCidr = str(get("exec-env-home-vpc-cidr"));
  const homeDdbEndpointId = str(get("exec-env-home-ddb-endpoint-id"));
  let homeLink: ExecEnvContext["homeLink"];
  if (!isHomeTarget) {
    const missing = [
      ...(homeVpcId ? [] : ["-c exec-env-home-vpc-id"]),
      ...(homeVpcCidr ? [] : ["-c exec-env-home-vpc-cidr"]),
      ...(homeDdbEndpointId ? [] : ["-c exec-env-home-ddb-endpoint-id"]),
    ];
    if (missing.length) {
      throw new Error(
        `${missing.join(" / ")} 缺失 —— 非 home 执行环境要靠它们建**跨区私网通路**` +
          `(peering + 主控区同区端点 + 本区私有托管域,SPEC §3.14ter):` +
          `① 对端 VPC id;② 本区私有路由表指向 peering 的目的地段;③ 私有托管域要解析到哪个端点的 ENI。` +
          `这三个值由 buildspec 从 BgpVpcStack 的 Outputs 读出;读不到通常意味着**主控区用的是导入的现有 VPC**` +
          `(那种模式下平台不碰别人的 VPC,也就没有这个端点)⇒ 该账号暂不支持非 home 执行环境。**不猜默认值**`
      );
    }
    if (!/^vpc-[0-9a-f]{8,}$/.test(homeVpcId!)) throw new Error(`-c exec-env-home-vpc-id 不像 VPC id:${homeVpcId}`);
    if (!/^vpce-[0-9a-f]{8,}$/.test(homeDdbEndpointId!)) throw new Error(`-c exec-env-home-ddb-endpoint-id 不像 VPC 端点 id:${homeDdbEndpointId}`);
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(homeVpcCidr!)) throw new Error(`-c exec-env-home-vpc-cidr 不是合法 CIDR:${homeVpcCidr}`);
    // 🔴🔴 主控区网段与**地址池**相交 ⇒ 立刻停。这一条把「有人给 home VPC 换了网段」这件事
    //    从「某个区的回写神秘超时 / 路由撞车」变成**部署期一句话**(cidrsOverlap 就是为它写的)。
    if (cidrsOverlap(homeVpcCidr!, EXEC_ENV_VPC_CIDR_POOL)) {
      throw new Error(
        `主控区 VPC 网段 ${homeVpcCidr} 与执行环境地址池 ${EXEC_ENV_VPC_CIDR_POOL} 相交 —— ` +
          `peering 要求两侧不重叠,这样任何执行环境都建不出私网通路。` +
          `池子(vpc-cidr.ts)与主控区网段必须错开;改了哪一边都要同时复核另一边`
      );
    }
    if (cidrsOverlap(homeVpcCidr!, vpcCidr)) {
      throw new Error(`主控区网段 ${homeVpcCidr} 与本执行环境网段 ${vpcCidr} 相交 —— peering 建不出来`);
    }
    homeLink = { vpcId: homeVpcId!, vpcCidr: homeVpcCidr!, ddbEndpointId: homeDdbEndpointId! };
  }
  // home 不建 peering(它就是主控区)⇒ 这三个入参对它无意义,传了也不用;**刻意不抛**:
  // buildspec 对所有 target 一律透传,给 home 抛会让「给 home 补装组件」这条路径无谓失败。

  // 自检:命名 SSOT 必须已登记这批 kind,否则栈组会在很远的地方才炸。
  for (const kind of ["datalakeBucket", "scriptsBucket", "tableBucket", "athenaWorkgroup", "emrSecurityGroup", "dataKeyAlias"]) {
    if (!RESOURCE_KINDS.includes(kind)) {
      throw new Error(`命名 SSOT 缺 kind=${kind} —— platform/naming.json 与栈组不同步`);
    }
  }

  return { targetId, region, account, components, azs, isHome: isHomeTarget, vpcCidr, ...(homeRegion ? { homeRegion } : {}), ...(homeLink ? { homeLink } : {}) };
}

/** `core,redshift` → 去重排序后的枚举数组;不传 / 空串 / 未知组件即抛。 */
export function parseComponents(raw: string | undefined): ExecEnvComponent[] {
  // ② —— 🔴 不再静默缺省成 core(那正是「精简形态」的入口):不传即抛。
  if (raw === undefined) {
    throw new Error("-c exec-env-components 必须显式给(组件集由控制面按完整组件集下发;不再缺省成 core)");
  }
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (wanted.length === 0) throw new Error("-c exec-env-components 不能是空串");

  const unknown = wanted.filter((c) => !(EXEC_ENV_COMPONENTS as readonly string[]).includes(c));
  if (unknown.length > 0) {
    throw new Error(
      `-c exec-env-components 含未知组件:${unknown.join(", ")}(合法:${EXEC_ENV_COMPONENTS.join(", ")})—— ` +
        `拼错一个组件如果被静默忽略,就是"以为装了、其实没装",到运行期才炸`
    );
  }
  if (!wanted.includes("core")) {
    throw new Error("-c exec-env-components 必须含 core(50 SPEC §1.1:core 必有;其余组件都建在 core 的资源之上)");
  }
  // 按枚举顺序排序 ⇒ 同一组勾选无论输入顺序如何,栈组结构逐字节一致(synth 可复现)。
  return EXEC_ENV_COMPONENTS.filter((c) => wanted.includes(c));
}

/**
 * 解析 AZ 列表。缺省取该 region 的 `a` / `b` 两个 AZ。
 *
 * 🔴 为什么不让 CDK 自己查(`maxAzs`):在**具体 account+region** 的栈上,`ec2.Vpc({maxAzs})` 会触发
 *    CDK 的 `availability-zones` context provider —— 它要**对目标账号 AssumeRole 去查**。后果两条,都不能接受:
 *    ① `cdk synth` 不再能离线跑 ⇒ §4.1a-5 要的「编译级验收先行 / CI 门禁级 synth」直接做不到;
 *    ② 实测它会拿**当前机器的 AWS 身份**去 AssumeRole(报错里就带着本机账号号)——
 *       synth 一个"另一个账号的栈"竟然会碰本机凭证,这是不该有的耦合。
 * ⇒ 定案:AZ 名显式给,synth 全程**零 context 查找**。
 * ⚠️ 代价与配套(必须一起做,否则是把风险从 synth 推到 CFN):AZ 名 `<region>a/b` 在绝大多数 region
 *    都存在,但**AZ 可用性是账号级的**(个别账号在某 region 缺某个 AZ,或需 opt-in)。
 *    ⇒ **部署前必须 preflight** `aws ec2 describe-availability-zones` 校验这两个 AZ 可用,
 *    不可用就报清楚的错并提示用 `-c exec-env-azs=` 换 —— 该 preflight 切片 b 的 buildspec。
 */
export function parseAzs(raw: string | undefined, region: string): string[] {
  const azs = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [`${region}a`, `${region}b`];
  if (azs.length < 2) {
    throw new Error(`-c exec-env-azs 至少要 2 个 AZ(私有子网须跨 AZ);收到 ${String(raw)}`);
  }
  const re = new RegExp(`^${region}[a-z]$`);
  const bad = azs.filter((a) => !re.test(a));
  if (bad.length > 0) {
    throw new Error(`-c exec-env-azs 里有不属于 region ${region} 的 AZ:${bad.join(", ")}`);
  }
  if (new Set(azs).size !== azs.length) throw new Error(`-c exec-env-azs 有重复:${azs.join(",")}`);
  return azs;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
