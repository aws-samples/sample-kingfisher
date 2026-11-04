// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion as readHomeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { GlueClient, CreateConnectionCommand, DeleteConnectionCommand, TestConnectionCommand, GetConnectionCommand, UpdateConnectionCommand } from "@aws-sdk/client-glue";
import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { EC2Client, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, DeleteSecurityGroupCommand, DescribeNetworkInterfacesCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand, CreateTagsCommand } from "@aws-sdk/client-ec2";
import { IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
// JDBC URL / 默认端口由数据源 SPI 提供(取代此前本文件写死的 JDBC_URL/DB_PORT 表)。
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
// 凭证读写抽到 datasource-spi/secrets.ts;本文件内部(createGlueConnection)也需 getSecret。
import { getSecret } from "@/lib/datasource-spi/secrets";
// 按区客户端的唯一工厂(不在本文件 new)
import { glueClientFor, rdsClientFor, ec2ClientFor } from "@/lib/exec-env/target-clients";

// 🔴🔴 用户 2026-09-10:「**所有的任务都要创建在当前区域,不能只是创建在主控区,没意义,
// 除非在主控区创建任务,可以选择在主控区下发到其他指定区域执行。不然也是白干了。**」
//
// 建源是这条链的**第一环**:同步任务的落点由它引用的数据源的 `ownerTargetId` 派生
// (`bindingForNewSyncTask`),所以「数据源只能建在主控区」= 同步任务只能落主控区。
// 而「只能建在主控区」的原因就在下面这几行:5 个模块级主控区客户端 + 三个 `DEFAULT_*` env
// (那是部署时注入的**主控区**网络事实)。
//
// 🔴 一律改成按区解析。区不合法就抛 —— 在别的区建源却把安全组建在主控区,
// 后果是 Glue 连接引用一个跨区的 SG:创建时不报错,**跑作业时才炸**,而报错指向网络配置。
const homeRegion = readHomeRegion();
/** 该区的一组客户端(全部走 `target-clients` 的按区缓存工厂;home 与改动前同一个 region)。 */
async function dsClients(region: string) {
  const [glue, rds, ec2] = await Promise.all([
    glueClientFor(region),
    rdsClientFor(region),
    ec2ClientFor(region),
  ]);
  return { glue, rds, ec2 };
}
// IAM 是**全局**服务(无 region 概念)⇒ 保留单例;Secrets 的 ListSecrets 用于 RDS 发现,按区建。
const iam = sdkClient("control-plane", IAMClient, { region: homeRegion });

// ============ DS-04: Secrets Manager ============
// 凭证读写抽到 lib/datasource-spi/secrets.ts(与类型无关的底层,断循环依赖)。
// 此处 re-export 保持其他消费方(api/datasources/route.ts 等)的 import 路径零改动。
export { createSecret, getSecret, updateSecret, deleteSecret } from "@/lib/datasource-spi/secrets";

// ============ DS-03: Auto Network ============

/**
 * 建源落点:区 + 该区的网络事实。home 时只需要 region(其余走既有 `DEFAULT_*` env ⇒ 逐字节等价)。
 */
export interface DsPlace {
  region: string;
  home: boolean;
  /** 落点 id(平台自建组的归属标签 `bgp:targetId`);由 `resolveDsPlace` 给出,🔴 必填(落点不许可选) */
  targetId: string;
  vpcId?: string;
  subnetId?: string;
  availabilityZone?: string;
}

/**
 * 自动探测出的网络接入(老路径:没指定网络 ⇒ 平台在该 VPC 新建 `bgp-ds-*` 组)。
 * `securityGroupId` = 平台自建的那个组。
 */
export interface NetworkConfig {
  vpcId: string;
  subnetId: string;
  /** 可用区。第二刀起**可缺**:源行(2.1.2 及之前)从不落它、用户指定网络也可不给;写 Glue 连接的两个作者一律按子网事实取,这里只是回显 / 核对用。 */
  availabilityZone?: string;
  securityGroupId: string;
  isRds: boolean;
  rdsInstanceId?: string;
}

/**
 * 用户在建源时**指定了**子网与安全组时的网络接入。
 * 🔴 这条路径平台**一个安全组都不建**、不改任何规则(原来照样先建一个 `bgp-ds-*` 而且不用它,
 *   在客户生产 VPC 里留下闲置组);用户给的组**全部**进 Glue 连接(原来只取第一个)。
 * `securityGroupId` = 第一个(存量消费者读它,不能删);`securityGroupIds` = 全部。
 */
export interface UserNetworkConfig extends NetworkConfig {
  securityGroupIds: readonly [string, ...string[]];
}

/** 用户在建源请求里给的网络(由路由解析;非空元组 ⇒ 「指定了但一个组都没有」写不出来)。 */
export interface UserDsNetwork {
  subnetId: string;
  securityGroupIds: readonly [string, ...string[]];
  /** 显式给出 undefined = 用户没选 AZ(第二刀起由写连接的作者按用户子网自己的事实取,不再沿用探测出的另一子网的 AZ)。 */
  availabilityZone: string | undefined;
}

/** 只读探测的结果:不含安全组。 */
export interface NetworkProbe {
  vpcId: string;
  subnetId: string;
  availabilityZone: string;
  isRds: boolean;
  rdsInstanceId?: string;
}

/**
 * **只探测、不写**:落点网络事实 + (RDS 主机时)从子网组识别 VPC / 子网 / AZ。
 * 🔴 这里只许有读调用(DescribeDBInstances);建组 / 改规则在 `createPlatformDsSecurityGroup`。
 */
export async function probeNetwork(host: string, place: DsPlace): Promise<NetworkProbe> {
  // 🔴 `DEFAULT_VPC_ID` / `DEFAULT_SUBNET_ID` / `DEFAULT_AZ`
  // 是**主控区**的部署时快照。非主控区必须用那个区自己的网络事实(描述符 core 袋里的
  // `emrSubnetIds` / `emrSecurityGroupId` —— 那就是该区的私有子网与安全组,EMR 现在就用它们跑)。
  // 拿主控区的子网去建 SG,SG 会建在主控区的 VPC 里,Glue 连接引用一个跨区 SG ⇒ 建的时候不报错、
  // **跑作业时才炸**,而报错指向网络配置(排障方向完全错)。
  const p = place;
  const { rds } = await dsClients(p.region);
  const defaultVpc = p.home ? (process.env.DEFAULT_VPC_ID || "") : (p.vpcId || "");
  const defaultSubnet = p.home ? (process.env.DEFAULT_SUBNET_ID || "") : (p.subnetId || "");
  const defaultAz = p.home ? (process.env.DEFAULT_AZ || "us-east-1a") : (p.availabilityZone || "");
  if (!p.home && (!defaultSubnet || !defaultVpc)) {
    throw new Error(
      `不能在 ${p.region} 建数据源:那个执行环境的描述符里读不到私有子网 / VPC` +
        `(core 袋的 emrSubnetIds)。🔴 平台刻意不回落主控区的网络 —— 那会把安全组建在主控区,` +
        `Glue 连接引用一个跨区安全组,创建时不报错、跑作业时才炸`
    );
  }

  let vpcId = defaultVpc;
  let subnetId = defaultSubnet;
  let az = defaultAz;
  let isRds = false;
  let rdsInstanceId: string | undefined;

  // Try to detect RDS instance
  if (host.includes(".rds.amazonaws.com")) {
    try {
      const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));
      const match = DBInstances.find((i) => i.Endpoint?.Address === host);
      if (match) {
        isRds = true;
        rdsInstanceId = match.DBInstanceIdentifier;
        vpcId = match.DBSubnetGroup?.VpcId || defaultVpc;
        const privateSubnet = match.DBSubnetGroup?.Subnets?.find((s) => s.SubnetAvailabilityZone);
        if (privateSubnet) {
          subnetId = privateSubnet.SubnetIdentifier!;
          az = privateSubnet.SubnetAvailabilityZone!.Name!;
        }
      }
    } catch {}
  }

  return { vpcId, subnetId, availabilityZone: az, isRds, rdsInstanceId };
}

/**
 * 在 `vpcId` 里建平台自己的 `bgp-ds-*` 组并放行(自引用 + 源库端口对本 VPC CIDR)。
 * 🔴 只给「没指定网络」的老路径用;用户指定了安全组时绝不调用。
 */
/** 平台自建对象的归属标签键(清理工具 / 人按它识别「这是平台的、还在用」;IAM 加固条件也按它)。 */
export const PLATFORM_DS_MANAGED_TAG_KEY = "bgp:managed";
export const PLATFORM_DS_MANAGED_TAG_VALUE = "datasource";
export const PLATFORM_DS_OWNER_TAG_KEY = "bgp:datasourceId";
export const PLATFORM_DS_TARGET_TAG_KEY = "bgp:targetId";

/** 平台为数据源自建的安全组该带的标签(建组与存量补标签同一份)。 */
export function platformDsSgTags(datasourceId: string, targetId: string): Array<{ Key: string; Value: string }> {
  return [
    { Key: PLATFORM_DS_MANAGED_TAG_KEY, Value: PLATFORM_DS_MANAGED_TAG_VALUE },
    { Key: PLATFORM_DS_OWNER_TAG_KEY, Value: datasourceId },
    { Key: PLATFORM_DS_TARGET_TAG_KEY, Value: targetId },
  ];
}

export async function createPlatformDsSecurityGroup(args: {
  vpcId: string;
  dbType: string;
  datasourceId: string;
  region: string;
  /** 归属标签 `bgp:targetId`(🔴 必填:组建在哪个落点就标哪个) */
  targetId: string;
}): Promise<string> {
  const { vpcId, dbType, datasourceId } = args;
  const { ec2 } = await dsClients(args.region);
  // Create security group
  const sgName = platformDsSgName(datasourceId);
  let sgId: string;
  try {
    const { GroupId } = await ec2.send(new CreateSecurityGroupCommand({
      GroupName: sgName,
      Description: `BGP datasource ${datasourceId}`,
      VpcId: vpcId,
      // 建组即带归属标签 —— 这个组大部分时间零网卡,任何按「无网卡即孤儿」清理的工具都会删它;
      //   标签让清理流程能排除、让人能看出归属(2026-10-28 测试账号真撞:只有 Description 可看,被当孤儿误删 ⇒ 该源同步全败)。
      TagSpecifications: [{ ResourceType: "security-group", Tags: platformDsSgTags(datasourceId, args.targetId) }],
    }));
    sgId = GroupId!;

    // Allow Glue SG self-reference (required for Glue)
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{ IpProtocol: "-1", UserIdGroupPairs: [{ GroupId: sgId }] }],
    }));

    // Allow access to DB port from this SG(默认端口取自 provider capabilities)
    const port = (isDataSourceType(dbType) ? getProvider(dbType).capabilities.defaultPort : undefined) || 3306;
    // 🔴 放行段必须是**这个 VPC 自己的** CIDR,不能写死 10.0.0.0/16。
    //   原来那个字面量是「主控区 VPC 的 CIDR」的硬编码:非 home 执行环境的 VPC 从地址池取段
    //   (10.128.0.0/9,与主控区**不重叠**,否则跨区 peering 建不出来)⇒ 在那个区建数据源时,
    //   写死的 10.0.0.0/16 **一条也放行不到** ⇒ 症状是「连接建好了、浏览表 0 张」
    //   (与 [[jdbc-source-sg-port-ingress]] 那次一模一样的症状,而根因换成了网段)。
    //   🔴 查不到就**抛**:回落 10.0.0.0/16 = 在非 home 建出一个永远连不上的数据源(静默默认值那一类)。
    const { Vpcs = [] } = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
    const vpcCidr = Vpcs[0]?.CidrBlock;
    if (!vpcCidr) {
      throw new Error(
        `读不到 VPC ${vpcId} 的 CIDR(region=${args.region})—— 无法确定数据源安全组该放行哪一段。` +
          `🔴 不回落 10.0.0.0/16:那是主控区的网段,在别的区放行它等于一条也没放行(建得出来、浏览表 0 张)`
      );
    }
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [{ IpProtocol: "tcp", FromPort: port, ToPort: port, IpRanges: [{ CidrIp: vpcCidr }] }],
    }));
  } catch (e: any) {
    // SG might already exist
    if (e.Code === "InvalidGroup.Duplicate") {
      const { SecurityGroups } = await ec2.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [sgName] }, { Name: "vpc-id", Values: [vpcId] }],
      }));
      sgId = SecurityGroups![0].GroupId!;
    } else {
      throw e;
    }
  }
  return sgId;
}

/**
 * 老路径(没指定网络):探测 + 新建平台自己的 `bgp-ds-*` 组。
 * 调用序列与改动前逐字节相同(`create-network-assembly.test.ts` ① 组钉住)。
 */
export async function detectNetwork(host: string, dbType: string, datasourceId: string, place: DsPlace): Promise<NetworkConfig> {
  // 落点必填(原来 `place ?? 主控区` 是一条静默默认 —— 唯一调用方 long-ops 早已总是传 resolveDsPlace 的结果)
  const p = place;
  const probe = await probeNetwork(host, p);
  const sgId = await createPlatformDsSecurityGroup({ vpcId: probe.vpcId, dbType, datasourceId, region: p.region, targetId: p.targetId });
  return { vpcId: probe.vpcId, subnetId: probe.subnetId, availabilityZone: probe.availabilityZone, securityGroupId: sgId, isRds: probe.isRds, rdsInstanceId: probe.rdsInstanceId };
}

/**
 * 用户指定了子网 + 安全组:只探测(VPC / RDS 识别),**不建任何组、不改任何规则**;AZ 不兜底(第二刀,见下)。
 */
export async function userSpecifiedNetwork(host: string, place: DsPlace, user: UserDsNetwork): Promise<UserNetworkConfig> {
  const probe = await probeNetwork(host, place);
  return {
    vpcId: probe.vpcId,
    subnetId: user.subnetId,
    // 🔴 第二刀:不再用探测出的 AZ 兜底 —— 那是**另一个子网**(RDS 子网组 / 缺省子网)的可用区,与用户选的子网未必同区;
    //   用户没给就留空,写 Glue 连接的作者按用户子网自己的事实取(给了则与事实核对,矛盾即拒)
    availabilityZone: user.availabilityZone,
    securityGroupId: user.securityGroupIds[0],
    securityGroupIds: user.securityGroupIds,
    isRds: probe.isRds,
    rdsInstanceId: probe.rdsInstanceId,
  };
}

/**
 * 解析建源请求里的 `network`(路由文件不许导出非路由符号 ⇒ 放这里)。三态显式返回(不用静默缺省):
 *   · `none`    —— 没给,或只给了一半(有子网没组 / 有组没子网):走自动探测老路径(与改动前一致);
 *   · `user`    —— 子网 + 至少一个组:平台不建组,用户的组全部进 Glue 连接;
 *   · `invalid` —— 给了子网与组清单,但清单里有非字符串 / 空串:400(原来会原样传给 Glue 才炸)。
 */
export function parseUserDsNetwork(raw: unknown):
  | { kind: "none" }
  | { kind: "user"; net: UserDsNetwork }
  | { kind: "invalid"; reason: string } {
  const n = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : undefined;
  const subnetId = n?.subnetId;
  const sgs = n?.securityGroupIds;
  if (!subnetId || !Array.isArray(sgs) || sgs.length === 0) return { kind: "none" };
  if (typeof subnetId !== "string" || !subnetId.trim()) return { kind: "invalid", reason: "network.subnetId 必须是非空字符串" };
  if (!sgs.every((x) => typeof x === "string" && x.trim())) {
    return { kind: "invalid", reason: "network.securityGroupIds 里每一项都必须是非空字符串" };
  }
  const ids = sgs as string[];
  const az = n?.availabilityZone;
  return {
    kind: "user",
    net: {
      subnetId,
      securityGroupIds: [ids[0], ...ids.slice(1)],
      availabilityZone: typeof az === "string" && az ? az : undefined,
    },
  };
}

/** 这份网络接入是不是用户指定的(只有 `userSpecifiedNetwork` 产出带 `securityGroupIds` 的形态)。 */
export function isUserNetworkConfig(network: NetworkConfig | UserNetworkConfig): network is UserNetworkConfig {
  return Array.isArray((network as Partial<UserNetworkConfig>).securityGroupIds);
}

/** Glue 连接要引用的安全组清单:用户指定 ⇒ 全部;自动探测 ⇒ 平台自建的那一个。 */
export function glueSecurityGroupIds(network: NetworkConfig | UserNetworkConfig): string[] {
  return isUserNetworkConfig(network) ? [...network.securityGroupIds] : [network.securityGroupId];
}

/** 平台为数据源自建的安全组名前缀。 */
export const PLATFORM_DS_SG_PREFIX = "bgp-ds-";

/**
 * 平台为**这一条**数据源自建的安全组名 —— 建组(`createPlatformDsSecurityGroup`)与删组归属判定
 * (`deleteSecurityGroup`)的唯一作者。
 */
export function platformDsSgName(datasourceId: string): string {
  return `${PLATFORM_DS_SG_PREFIX}${datasourceId.slice(-8)}`;
}

/** 平台为数据源建的 Glue 连接名(唯一作者;建源与自愈重建同一规则,源行 glueConnectionName 必须等于它) */
export const PLATFORM_GLUE_CONN_PREFIX = "bgp-conn-";
export function platformGlueConnectionName(datasourceId: string): string {
  return `${PLATFORM_GLUE_CONN_PREFIX}${datasourceId.slice(-12)}`;
}

export type SgDeleteOutcome = "deleted" | "skipped-not-platform" | "gone" | "failed" | "failed-dependency";

/**
 * 删数据源时清理安全组。🔴 生产上线批次 A:**只删平台自建的组**(组名 `bgp-ds-` 开头)。
 * 原来用户在建数据源时指定了**自己的**安全组,记录里存的就是它,删数据源时一并 DeleteSecurityGroup、
 * 错误还被吞掉 ⇒ 客户的安全组被删(或删失败也没人知道)。现在先查组名再决定,结果如实回给调用方。
 */
// 🔴 归属判定从「组名以 bgp-ds- 开头」收紧成「组名**恰好等于**本数据源的平台组名」:
//   用户建源时可能选中**另一条数据源**的 bgp-ds-* 组,前缀判定会在删这条源时把别人的组删掉。
//   `datasourceId` 与 `region` 都必填、无缺省(静默缺省值是一类缺陷的温床)。
export async function deleteSecurityGroup(sgId: string, region: string, datasourceId: string): Promise<SgDeleteOutcome> {
  const { ec2 } = await dsClients(region);
  let name: string | undefined;
  try {
    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
    name = SecurityGroups[0]?.GroupName;
  } catch (e: any) {
    if (String(e?.name || e?.Code || "").includes("InvalidGroup.NotFound")) return "gone";
    return "failed";
  }
  if (!name) return "gone";
  if (name !== platformDsSgName(datasourceId)) return "skipped-not-platform";
  try {
    await ec2.send(new DeleteSecurityGroupCommand({ GroupId: sgId }));
    return "deleted";
  } catch (e: any) {
    // Glue 作业跑过这条连接后,它的网卡要几分钟才释放;这期间 DeleteSecurityGroup 回 DependencyViolation。
    //   原来一律吞成 failed ⇒ 平台自建的组静默漏在 VPC 里(真环境 2026-10-12 第二轮撞到)。如实区分,由调用方后台重试。
    if (String(e?.name || e?.Code || "").includes("DependencyViolation")) return "failed-dependency";
    return "failed";
  }
}

/**
 * 这个安全组现在被多少张网卡引用(DescribeNetworkInterfaces 按 group-id 过滤,翻到底)。
 * 持久清理作业按它决定「等」还是「删」:> 0 时 DeleteSecurityGroup 必 DependencyViolation,不必白试。
 * 🔴 读失败就抛(调用方回 retry),不回 0 —— 0 会被当成「可以删」。组不存在时 EC2 回空清单(= 0),删除那一步再按 `gone` 收口。
 */
export async function countNetworkInterfacesInSecurityGroup(sgId: string, region: string): Promise<number> {
  const { ec2 } = await dsClients(region);
  let total = 0;
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await ec2.send(new DescribeNetworkInterfacesCommand({
      Filters: [{ Name: "group-id", Values: [sgId] }],
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));
    total += (r.NetworkInterfaces ?? []).length;
    nextToken = r.NextToken;
    if (!nextToken) return total;
  }
  throw new Error(`DescribeNetworkInterfaces(group-id=${sgId}) 翻页超过 20 页 —— 拒绝给出可能不完整的计数`);
}

// ============ DS-02: Auto IAM Role ============

const GLUE_ROLE_NAME = "bgp-glue-role";

// ②:`bgp-glue-role` 是平台栈(infra/lib/platform-stack.ts GlueRole)部署期就建好的基础设施,原来却在**每次建源的请求路径上**
//   都去 IAM 核一遍(GetRole 经 NAT 到公网 IAM 端点)—— 第四十七轮实测这一跳停顿 64 秒就把整条建源请求撞成 504。
//   现在进程内只核一次:成功就缓存 ARN(角色不会在运行期消失;真被人删了,Glue 作业启动会如实报错,不在建源这一跳猜);
//   失败不缓存(下次建源再核);🔴 只有 **NoSuchEntity** 才走补建分支(老环境自愈)—— 原来 `catch {}` 把网络超时 / 限流也当成「角色不存在」去 CreateRole,
//   撞 EntityAlreadyExists 后整条建源 500,错误指向 IAM 而真因是一次网络抖动。
// 🔴 缓存挂 globalThis Symbol.for:Next 产物里同一源文件可能是多个模块实例,模块级变量不是进程级单例([[next-bundle-duplicate-module-instances]])。
const GLUE_ROLE_CACHE_KEY = Symbol.for("bgp.datasource-service.glueRoleArn");
type GlueRoleCache = { pending?: Promise<string> };
function glueRoleCache(): GlueRoleCache {
  const g = globalThis as unknown as Record<symbol, GlueRoleCache | undefined>;
  return (g[GLUE_ROLE_CACHE_KEY] ??= {});
}
/** 单测 / 排障用:清掉进程内缓存(下一次 ensureGlueRole 重新核一次)。 */
export function __resetGlueRoleCache(): void {
  delete glueRoleCache().pending;
}

function isNoSuchEntity(e: unknown): boolean {
  const name = String((e as { name?: unknown; Code?: unknown })?.name ?? (e as { Code?: unknown })?.Code ?? "");
  return /NoSuchEntity/.test(name);
}

export async function ensureGlueRole(): Promise<string> {
  const cache = glueRoleCache();
  if (!cache.pending) {
    cache.pending = verifyOrCreateGlueRole().catch((e: unknown) => {
      delete cache.pending;
      throw e;
    });
  }
  return cache.pending;
}

async function verifyOrCreateGlueRole(): Promise<string> {
  try {
    const { Role } = await iam.send(new GetRoleCommand({ RoleName: GLUE_ROLE_NAME }));
    return Role!.Arn!;
  } catch (e: unknown) {
    if (!isNoSuchEntity(e)) throw e;
  }
  {
    // 角色确实不存在(CDK 平台栈之前的老环境):补建一次(策略形态沿用)
    const { Role } = await iam.send(new CreateRoleCommand({
      RoleName: GLUE_ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "glue.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    }));

    const policies = [
      "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole",
      "arn:aws:iam::aws:policy/AmazonS3FullAccess",
      "arn:aws:iam::aws:policy/AmazonRedshiftDataFullAccess",
    ];
    for (const arn of policies) {
      await iam.send(new AttachRolePolicyCommand({ RoleName: GLUE_ROLE_NAME, PolicyArn: arn }));
    }

    await iam.send(new PutRolePolicyCommand({
      RoleName: GLUE_ROLE_NAME,
      PolicyName: "bgp-secrets-read",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "arn:aws:secretsmanager:*:*:secret:bgp/*" },
          { Effect: "Allow", Action: ["s3tables:*", "lakeformation:*", "glue:*"], Resource: "*" },
        ],
      }),
    }));

    return Role!.Arn!;
  }
}

// ============ DS-01: Auto Glue Connection ============

/** JDBC URL 的唯一作者(建连接 / 改连接都用它;类型不在 SPI 清单 ⇒ 空串,由调用方决定拒不拒)。 */
// 第五个参数 = 用户附加 JDBC 参数(已归一化的 `k=v&k=v`;方言默认参数由 provider 自己带)。
export function jdbcUrlFor(type: string, host: string, port: number, database: string, jdbcParams?: string): string {
  return isDataSourceType(type)
    ? (getProvider(type).buildConnection({ type, connection: { host, port, database, ...(jdbcParams ? { jdbcParams } : {}) } }).jdbcUrl || "")
    : "";
}

// 编辑数据源改了 host / port / database / type 或登录名 / 口令 ⇒ 同步到 Glue 连接(台账)。
// 原来只有「网络接入」会改 Glue 连接,改 host 只落库:同步作业 / 发现作业 / 探测走的 Glue 连接仍指着旧库。
// UpdateConnection 需回传完整 ConnectionInput:先 Get,保留网络(PhysicalConnectionRequirements),只换连接串 / 凭证属性。
export async function updateGlueConnectionEndpoint(
  connName: string,
  conn: { type: string; host: string; port: number; database: string; username?: string; password?: string; jdbcParams?: string },
  region: string
): Promise<{ jdbcUrl: string }> {
  const jdbcUrl = jdbcUrlFor(conn.type, conn.host, conn.port, conn.database, conn.jdbcParams);
  if (!jdbcUrl) throw new Error(`无法为类型 ${JSON.stringify(conn.type)} 生成 JDBC URL`);
  const { glue } = await dsClients(region);
  const { Connection } = await glue.send(new GetConnectionCommand({ Name: connName }));
  if (!Connection) throw new Error(`Glue 连接不存在: ${connName}`);
  await glue.send(new UpdateConnectionCommand({
    Name: connName,
    ConnectionInput: {
      Name: connName,
      ConnectionType: (Connection.ConnectionType as any) || "JDBC",
      ConnectionProperties: {
        ...(Connection.ConnectionProperties || {}),
        JDBC_CONNECTION_URL: jdbcUrl,
        ...(conn.username !== undefined ? { USERNAME: conn.username } : {}),
        ...(conn.password !== undefined ? { PASSWORD: conn.password } : {}),
      },
      PhysicalConnectionRequirements: Connection.PhysicalConnectionRequirements,
    },
  }));
  return { jdbcUrl };
}

export async function createGlueConnection(
  datasourceId: string,
  type: string,
  host: string,
  port: number,
  database: string,
  secretArn: string,
  network: NetworkConfig | UserNetworkConfig,
  region: string = homeRegion,
  jdbcParams?: string
): Promise<string> {
  // 🔴 Glue 连接是**区域资源**:建在主控区而同步作业在别的区跑,作业引用连接名时报「连接不存在」。
  const { glue } = await dsClients(region);
  const connName = platformGlueConnectionName(datasourceId);
  // JDBC URL 由 provider 产出(取代写死的 JDBC_URL 表);建 / 改同一个作者 jdbcUrlFor。
  // 用户附加参数也进 Glue 连接的 JDBC_CONNECTION_URL(与同步脚本 / 发现脚本同一条 URL)。
  const jdbcUrl = jdbcUrlFor(type, host, port, database, jdbcParams);
  const { username, password } = await getSecret(secretArn);

  try {
    await glue.send(new CreateConnectionCommand({
      ConnectionInput: {
        Name: connName,
        ConnectionType: "JDBC",
        ConnectionProperties: {
          JDBC_CONNECTION_URL: jdbcUrl,
          USERNAME: username,
          PASSWORD: password,
        },
        PhysicalConnectionRequirements: {
          SubnetId: network.subnetId,
          SecurityGroupIdList: glueSecurityGroupIds(network),
          // 🔴 第二刀:AZ 按子网事实取(源行不存 AZ,自愈重建时 network.availabilityZone 为空)
          AvailabilityZone: await resolveConnectionAvailabilityZone(network.subnetId, region, network.availabilityZone),
        },
      },
    }));
  } catch (e: any) {
    if (!e.message?.includes("already exists")) throw e;
  }

  return connName;
}

export async function deleteGlueConnection(connName: string, region: string = homeRegion) {
  try {
    const { glue } = await dsClients(region);
    await glue.send(new DeleteConnectionCommand({ ConnectionName: connName }));
  } catch {}
}

// 只更新 Glue 连接的【网络接入】(子网/SG/AZ),不动 JDBC 连接串(host/库/密码)——
// 解决"数据源网络自动探测后用户改不了、网络顾问建议无处应用"的痛点(不碰生产数据库连接信息)。
// UpdateConnection 需回传完整 ConnectionInput,故先 Get 现有连接,只替换 PhysicalConnectionRequirements。
export async function updateGlueConnectionNetwork(
  connName: string,
  net: { subnetId: string; securityGroupIds: string[]; availabilityZone?: string },
  region: string = homeRegion
): Promise<void> {
  const { glue } = await dsClients(region);
  const { Connection } = await glue.send(new GetConnectionCommand({ Name: connName }));
  if (!Connection) throw new Error(`Glue 连接不存在: ${connName}`);
  await glue.send(new UpdateConnectionCommand({
    Name: connName,
    ConnectionInput: {
      Name: connName,
      ConnectionType: (Connection.ConnectionType as any) || "JDBC",
      // 保留原连接串/凭证属性(host/库/用户名/密码),只换网络。
      ConnectionProperties: Connection.ConnectionProperties || {},
      PhysicalConnectionRequirements: {
        SubnetId: net.subnetId,
        SecurityGroupIdList: net.securityGroupIds,
        // 🔴 第二刀:UpdateConnection 整体替换 PhysicalConnectionRequirements,原先调用方不给 AZ 就把连接上已有的 AZ 冲掉 ⇒ 作业起不来;一律按子网事实补齐
        AvailabilityZone: await resolveConnectionAvailabilityZone(net.subnetId, region, net.availabilityZone),
      },
    },
  }));
}

// ============:外部对象事实读取(漂移核对用;只读,读不到就抛,由调用方判 unverifiable) ============

export interface SecurityGroupFact {
  groupId: string;
  groupName: string;
  tags: Record<string, string>;
}

/** 按 id 读安全组事实:只回**存在**的那些(用 group-id 过滤器,不存在的不报错也不出现);读失败抛。 */
export async function describeSecurityGroupsById(ids: string[], region: string): Promise<Map<string, SecurityGroupFact>> {
  const out = new Map<string, SecurityGroupFact>();
  const want = Array.from(new Set(ids.filter((x) => typeof x === "string" && x.startsWith("sg-"))));
  if (!want.length) return out;
  const { ec2 } = await dsClients(region);
  for (let i = 0; i < want.length; i += 200) {
    const chunk = want.slice(i, i + 200);
    let nextToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await ec2.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-id", Values: chunk }],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }))) as { SecurityGroups?: Array<{ GroupId?: string; GroupName?: string; Tags?: Array<{ Key?: string; Value?: string }> }>; NextToken?: string };
      for (const g of r.SecurityGroups ?? []) {
        if (!g.GroupId) continue;
        out.set(g.GroupId, { groupId: g.GroupId, groupName: g.GroupName ?? "", tags: Object.fromEntries((g.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key as string, t.Value ?? ""])) });
      }
      nextToken = r.NextToken;
      if (!nextToken) break;
    }
  }
  return out;
}

export interface PlatformSgInventoryFact extends SecurityGroupFact {
  vpcId?: string;
  description?: string;
}

/**
 * 该区所有「平台为数据源建的」安全组:组名 `bgp-ds-*` ∪ 带 `bgp:managed` 标签(两个过滤器各翻到底,按 id 去重;
 * 存量组没标签靠组名,新组两者都有)。给系统设置「数据源网络对象」清单用;读失败抛(调用方把该区记成「读不到」,不当成「没有」)。
 */
export async function listPlatformDsSecurityGroups(region: string): Promise<PlatformSgInventoryFact[]> {
  const { ec2 } = await dsClients(region);
  const out = new Map<string, PlatformSgInventoryFact>();
  const filterSets: Array<Array<{ Name: string; Values: string[] }>> = [
    [{ Name: "group-name", Values: [`${PLATFORM_DS_SG_PREFIX}*`] }],
    [{ Name: "tag-key", Values: [PLATFORM_DS_MANAGED_TAG_KEY] }],
  ];
  for (const Filters of filterSets) {
    let nextToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters, ...(nextToken ? { NextToken: nextToken } : {}) }))) as {
        SecurityGroups?: Array<{ GroupId?: string; GroupName?: string; VpcId?: string; Description?: string; Tags?: Array<{ Key?: string; Value?: string }> }>;
        NextToken?: string;
      };
      for (const g of r.SecurityGroups ?? []) {
        if (!g.GroupId) continue;
        out.set(g.GroupId, {
          groupId: g.GroupId, groupName: g.GroupName ?? "", vpcId: g.VpcId, description: g.Description,
          tags: Object.fromEntries((g.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key as string, t.Value ?? ""])),
        });
      }
      nextToken = r.NextToken;
      if (!nextToken) break;
    }
  }
  return Array.from(out.values());
}

export interface SubnetFact {
  subnetId: string;
  vpcId: string;
  availabilityZone: string;
}

/** 子网事实(是否仍在 + 它的 VPC / 可用区;subnet-id 过滤器,不存在不报错回 null);读失败抛。
 *  🔴 可用区的**唯一事实源就是子网本身**(子网 ↔ 可用区不可变):Glue 连接要写的 AvailabilityZone 一律从这里取,不从源行 / 环境变量 / 调用方猜。 */
export async function describeSubnetFact(subnetId: string, region: string): Promise<SubnetFact | null> {
  if (!subnetId) return null;
  const { ec2 } = await dsClients(region);
  const r = (await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "subnet-id", Values: [subnetId] }] }))) as {
    Subnets?: Array<{ SubnetId?: string; VpcId?: string; AvailabilityZone?: string }>;
  };
  const sn = (r.Subnets ?? []).find((x) => x.SubnetId === subnetId);
  if (!sn) return null;
  if (!sn.VpcId || !sn.AvailabilityZone) throw new Error(`子网 ${subnetId}(${region})读不到 VPC / 可用区`);
  return { subnetId, vpcId: sn.VpcId, availabilityZone: sn.AvailabilityZone };
}

/**
 * 第二刀(2026-10-29 …4916 页面驱动 b133 B133-7 真撞):Glue 连接的 PhysicalConnectionRequirements **必须带 AvailabilityZone**,
 * 缺了 Glue 作业起不来 ——「Unable to resolve any valid connection」。建源落库的 networkConfig 从不存可用区,自愈 / 改网络按源行重建
 * 连接时就把它丢了(建源那次有 AZ 是因为探测结果在内存里)。根治 = 写连接的两个作者(建 / 改)都在这里按子网事实取 AZ:
 * 调用方给了就核对一致(矛盾 ⇒ 抛,不猜);没给就按子网事实补;子网不在 ⇒ 抛(不写一条起不来的连接)。
 */
async function resolveConnectionAvailabilityZone(subnetId: string, region: string, given?: string): Promise<string> {
  const fact = await describeSubnetFact(subnetId, region);
  if (!fact) throw new Error(`子网 ${subnetId}(${region})不存在,拒绝写没有可用区的 Glue 连接`);
  if (given && given !== fact.availabilityZone) {
    throw new Error(`可用区矛盾:调用方给 ${given},子网 ${subnetId} 实际在 ${fact.availabilityZone};拒绝写 Glue 连接`);
  }
  return fact.availabilityZone;
}

/** 给存量平台组补归属标签(幂等;建组路径已在 CreateSecurityGroup 里带标签,这里只服务 2.1.2 及之前建的组)。 */
export async function tagPlatformDsSecurityGroup(sgId: string, datasourceId: string, targetId: string, region: string): Promise<void> {
  const { ec2 } = await dsClients(region);
  await ec2.send(new CreateTagsCommand({ Resources: [sgId], Tags: platformDsSgTags(datasourceId, targetId) }));
}

export interface GlueConnectionNetworkFact {
  exists: boolean;
  subnetId?: string;
  securityGroupIds: string[];
  availabilityZone?: string;
}

/** 读 Glue 连接当前引用的网络(不存在 ⇒ exists=false,不抛;其它读失败抛)。 */
export async function getGlueConnectionNetwork(connName: string, region: string): Promise<GlueConnectionNetworkFact> {
  const { glue } = await dsClients(region);
  try {
    const { Connection } = await glue.send(new GetConnectionCommand({ Name: connName }));
    if (!Connection) return { exists: false, securityGroupIds: [] };
    const p = Connection.PhysicalConnectionRequirements ?? {};
    return { exists: true, subnetId: p.SubnetId, securityGroupIds: [...(p.SecurityGroupIdList ?? [])], availabilityZone: p.AvailabilityZone };
  } catch (e) {
    if ((e as { name?: string })?.name === "EntityNotFoundException") return { exists: false, securityGroupIds: [] };
    throw e;
  }
}

// ============ DS-16: Test Connection ============

export interface TestResult {
  success: boolean;
  steps: { name: string; status: "pass" | "fail" | "skip"; message: string; latencyMs?: number }[];
  totalMs: number;
}

export async function testConnection(connName: string, region: string = homeRegion): Promise<TestResult> {
  const { glue } = await dsClients(region);
  const start = Date.now();
  const steps: TestResult["steps"] = [];

  try {
    // Verify connection exists
    const { Connection } = await glue.send(new GetConnectionCommand({ Name: connName }));
    steps.push({ name: "connection_exists", status: "pass", message: "Glue Connection 已创建" });

    // Verify connection properties
    const jdbcUrl = Connection?.ConnectionProperties?.JDBC_CONNECTION_URL || "";
    const hasVpc = !!Connection?.PhysicalConnectionRequirements?.SubnetId;
    steps.push({ name: "config_check", status: jdbcUrl ? "pass" : "fail", message: jdbcUrl ? `JDBC: ${jdbcUrl.slice(0, 50)}...` : "JDBC URL 为空" });
    steps.push({ name: "network_check", status: hasVpc ? "pass" : "fail", message: hasVpc ? `VPC 子网: ${Connection?.PhysicalConnectionRequirements?.SubnetId}` : "未配置 VPC" });

  } catch (e: any) {
    steps.push({ name: "connection_exists", status: "fail", message: e.message || "Glue Connection 不存在" });
  }

  return { success: steps.every((s) => s.status === "pass"), steps, totalMs: Date.now() - start };
}

// ============ DS-06: RDS Discovery ============

export async function discoverRdsInstances(region: string = homeRegion) {
  // 🔴 RDS 发现按区:在 us-west-2 建源时,
  // 用主控区客户端列出来的是**主控区的实例**,用户从里面选一台,建出来的数据源指向一台
  // 那个区连不到的库(而界面上一切正常)。
  const { rds } = await dsClients(region);
  const { ListSecretsCommand } = await import("@aws-sdk/client-secrets-manager");
  const { secretsClientFor } = await import("@/lib/exec-env/target-clients");
  const sm = await secretsClientFor(region);
  const { DBInstances = [] } = await rds.send(new DescribeDBInstancesCommand({}));
  const { SecretList = [] } = await sm.send(new ListSecretsCommand({}));

  return DBInstances.filter((i: { DBInstanceStatus?: string }) => i.DBInstanceStatus === "available").map((i: any) => {
    // Try MasterUserSecret first, then find CDK-generated secret by instance identifier
    let secretArn = i.MasterUserSecret?.SecretArn || "";
    if (!secretArn && i.DBInstanceIdentifier) {
      const match = SecretList.find((s: { Name?: string; Description?: string }) => s.Name && s.Description?.includes(i.DBInstanceIdentifier!));
      if (!match) {
        // CDK names secrets like "BgpRdsStackBgpSourceMysqlSe-XXXX"
        const normalized = i.DBInstanceIdentifier.replace(/-/g, "");
        const match2 = SecretList.find((s: { Name?: string }) => s.Name?.toLowerCase().includes(normalized.toLowerCase()));
        if (match2) secretArn = match2.ARN || "";
      } else {
        secretArn = match.ARN || "";
      }
    }
    return {
      identifier: i.DBInstanceIdentifier,
      engine: i.Engine,
      engineVersion: i.EngineVersion,
      instanceClass: i.DBInstanceClass,
      endpoint: i.Endpoint?.Address,
      port: i.Endpoint?.Port,
      database: i.DBName || "",
      status: i.DBInstanceStatus,
      vpcId: i.DBSubnetGroup?.VpcId,
      isPublic: i.PubliclyAccessible,
      masterUserSecretArn: secretArn,
    };
  });
}
