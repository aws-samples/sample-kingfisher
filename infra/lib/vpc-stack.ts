import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
// 执行环境地址池(唯一作者;home 侧那条放行规则按**整池**写一条)
import { EXEC_ENV_VPC_CIDR_POOL } from "./exec-env/vpc-cidr";

export class VpcStack extends cdk.Stack {
  /**
   * 类型是 `IVpc` 而非 `Vpc` —— 因为支持"导入现有 VPC"模式(见下)。下游各栈的 props
   * 也一并放宽到 `ec2.IVpc`,否则导入模式编译不过。
   */
  public readonly vpc: ec2.IVpc;
  /** true = 复用账号里已有的 VPC(此时本栈不拥有 VPC,绝不可改它的子网/路由表)。 */
  public readonly imported: boolean;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 导入现有 VPC 模式 ────────────────────────────────────────────────
    // 触发方式(二选一):`-c existingVpcId=vpc-xxxx` 或环境变量 `EXISTING_VPC_ID=vpc-xxxx`。
    //
    // 为什么需要:**region 的 VPC 配额是账号级硬限(默认 5)**。在配额已满的账号里(典型 =
    // 与他人共用的 workshop/临时账号),新建 VPC 会直接 `VpcLimitExceeded` 失败,整个部署第一步
    // 就卡死。此时复用一个已有的、拓扑合适的 VPC 是唯一出路。
    //
    // 🔴 对被导入 VPC 的硬要求:**≥2 个 AZ 各有一个带 NAT 出口的私有子网**。平台的 ECS/Redshift/
    // RDS/OpenSearch/MWAA/EMR 全部落私有子网,只有公有子网的 VPC(如 default VPC)撑不起来。
    // 若被导入 VPC 由 CDK 建成,其子网会带 `aws-cdk:subnet-type` 标签,`fromLookup` 据此正确
    // 分出 public/private,下游 `selectSubnets({ subnetType: PRIVATE_WITH_EGRESS })` 才拿得到东西。
    //
    // 🔴 导入模式下**故意不建 S3 Gateway Endpoint**:网关端点要往私有子网的**路由表**里写条目,
    // 而那些路由表属于**别的 CloudFormation 栈**。往别人的栈里塞资源会给对方造成 drift、甚至在
    // 对方栈更新时互相踩踏。少一个免费端点只是 S3 流量走 NAT(有少量流量费),换来的是不碰别人
    // 的基建 —— 这个取舍在共用账号里必须这么选。
    const existingVpcId =
      (this.node.tryGetContext("existingVpcId") as string | undefined) || process.env.EXISTING_VPC_ID;

    if (existingVpcId) {
      this.imported = true;
      // fromLookup 需要具体的 account/region(不能是 agnostic 栈),部署链路里由
      // CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION 提供;查到的结果缓存进 cdk.context.json(已 gitignore)。
      this.vpc = ec2.Vpc.fromLookup(this, "BgpVpcImported", { vpcId: existingVpcId });
      new cdk.CfnOutput(this, "VpcMode", { value: `imported:${existingVpcId}` });
    } else {
      this.imported = false;
      // (WS2 — 高可用): NAT 网关由 1 提升到 2(每个 AZ 一个)。原先单 NAT 是 P0 单点
      // 它所在 AZ 故障会让全部私有子网失去出站(平台/RDS/Redshift/OM/MWAA 间通信中断)。
      const vpc = new ec2.Vpc(this, "BgpVpc", {
        maxAzs: 2,
        natGateways: 2, // WS2: 去单点,每 AZ 一个 NAT
        subnetConfiguration: [
          { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        ],
      });

      // (WS4 — 审计预留): VPC Flow Logs 在 WS4 接入(→ CloudWatch/S3,加密用 logsKey)。

      // S3 Gateway endpoint(免费):多组件受益(Glue COPY staging、DMS Serverless→Redshift 中转、
      // Redshift COPY)。必须与私有路由表【同栈】——否则跨栈引用路由表 export 会把 VpcStack "钉住",
      // 后续任何栈部署一碰 VpcStack 就因 "Cannot delete export ... in use" 回滚(实测踩坑)。常驻、零费用。
      vpc.addGatewayEndpoint("S3Gw", { service: ec2.GatewayVpcEndpointAwsService.S3 });

      // ── 🔴🔴 **跨区私网通路的 home 侧落点**(SPEC §3.14ter)──
      //
      // 【它承担什么】非 home 执行环境要把 run 台账写回主控区的 `bgp-*` 表(§3.14「控制面回写 =
      //   唯一跨区例外」)。零出网 ⇒ 那条调用不能走公网;而**跨区** PrivateLink 被组织 SCP 拦
      //   (`vpce:AllowMultiRegion` 的 `AllowedByOrganizations=False`,账号内放不开)。
      //   定案改成:**跨区 peering + 这里这个「同区」接口端点 + 对端 VPC 里的私有托管域**。
      //   于是非 home 的任务解析 `dynamodb.<home>.amazonaws.com` 得到本端点 ENI 的私有 IP,
      //   经 peering 直达 ⇒ **产品代码零改动**(2026-09-14 一次性 probe 已实测坐实)。
      //
      // 🔴🔴 **`privateDnsEnabled` 必须是 false** —— 开了它会把 **home 自己这一区**的
      //   `dynamodb.us-east-1.amazonaws.com` 也解析到这个接口端点上,于是本区所有 DynamoDB 流量
      //   从**不计流量费的公共路径**改走**按 GB 计费的接口端点**。症状是**账单**,不是报错
      //   (本仓最怕的那一类)。对端要用默认域名 ⇒ 由对端 VPC 自己的私有托管域完成劫持,
      //   而私有托管域**只影响它关联的那个 VPC**,不会溢回 home。
      //
      // 🔴 SG 只放行**整个地址池**一条规则(不按 target 逐条加):
      //   逐条加意味着有人要从栈外改这个 SG 的规则,而 CFN 更新 SG 时可能把栈外规则收回去 ⇒
      //   症状是「某个区的台账回写忽然超时」,离根因极远。池子与 home 网段构造上不相交(vpc-cidr.ts),
      //   且只有**已建立 peering** 的 VPC 才路由得到这里 ⇒ 一条静态规则既够用又不会漂。
      // 💰 常驻成本:接口端点 ≈ $0.01/AZ/h(两个 AZ ≈ $15/月)+ 处理量费。这是多区域能力的底价。
      const xrSg = new ec2.SecurityGroup(this, "XregionDdbEndpointSg", {
        vpc,
        description: "BGP cross-region link: DynamoDB interface endpoint (443 from exec-env VPC pool only)",
        allowAllOutbound: false,
      });
      // 🔴 规则描述必须 ASCII(2026-09-08 真环境:中文 ⇒ 400 Invalid rule description ⇒ 整栈回滚)
      xrSg.addIngressRule(
        ec2.Peer.ipv4(EXEC_ENV_VPC_CIDR_POOL),
        ec2.Port.tcp(443),
        "exec-env VPCs reach home DynamoDB over cross-region peering"
      );
      const xrDdb = new ec2.InterfaceVpcEndpoint(this, "XregionDdbEndpoint", {
        vpc,
        service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${cdk.Stack.of(this).region}.dynamodb`, 443),
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [xrSg],
        // 🔴 见上:开了会把 home 本区流量劫到计费路径上
        privateDnsEnabled: false,
        // 🔴 `open` 默认 **true** ⇒ CDK 会**再加一条**「从本 VPC CIDR 放行 443」的规则。
        //    这个端点只为跨区 peering 而存在,home 本区压根不该经它走 ⇒ 关掉,SG 里就只剩池子那一条。
        //    (synth 出来才发现多了一条规则 —— 又一次「默认值替你做了决定」)
        open: false,
      });
      this.vpc = vpc;
      new cdk.CfnOutput(this, "VpcMode", { value: "created" });
      // 非 home 的底座栈要靠这三个值建 peering + 路由 + 私有托管域。
      // 🔴 跨 region 不能用 CFN Export/ImportValue ⇒ 由部署 buildspec 读**本栈的 Outputs** 后当 `-c` 传下去
      //    (单一真值源仍是这个栈:它才是这些资源的作者)。
      new cdk.CfnOutput(this, "VpcCidr", { value: vpc.vpcCidrBlock });
      new cdk.CfnOutput(this, "XregionDdbEndpointId", { value: xrDdb.vpcEndpointId });
    }

    new cdk.CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
  }
}
