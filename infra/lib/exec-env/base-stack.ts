// 执行环境**底座**栈:自建 VPC + 自建数据域 CMK(50 DESIGN §4.1a-2)。
//
// 【为什么必须自建、不能注入控制面构造】
//   R1 核查坐实:现有 `mwaa-stack` / `redshift-stack` / `emr-stack` / `realtime-stack` / `flink-stack`
//   吃的是控制面的**活 CDK 构造**(`props.vpc` / `props.dataKey` / `props.albSecurityGroup`),
//   而第二个 region **根本没有控制面栈** —— 没有 VPC、没有数据域 CMK(🔴 **KMS key 是 region 级、
//   不可跨 region 共享**)、没有 platform 建的 dag 桶与 ALB SG。
//   ⇒ 栈组必须自洽:底座在**本 region 内**建齐,不引用任何 home 构造。
//
// 🔴 与控制面 `BgpVpcStack` / `BgpKmsStack` 是**刻意的两份实现**,不是漏合并:
//   · 控制面那两个栈的产物要注入 21 个 home 栈,签名与生命周期都绑在 home;
//   · 本栈的产物只服务本 target,且**销毁语义不同**(见下 RETAIN)。
//   两份的"名字"由命名 SSOT 统一(别名走 `resourceName("dataKeyAlias")`),这是防漂移的那一层。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as path from "path";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
import { buildPlatformDataRole } from "../shared/platform-data-role";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";
// 端点清单的唯一作者
import { endpointPlanFor, endpointServiceName } from "./endpoints";
import { EXEC_ENV_PRIVATE_SUBNET_TYPE, EXEC_ENV_PRIVATE_SUBNET_SELECTION, execEnvPrivateSubnets } from "./private-subnets";

export type ExecEnvBaseStackProps = ExecEnvStackProps;

export class ExecEnvBaseStack extends ExecEnvStack {
  public readonly vpc: ec2.Vpc;
  public readonly dataKey: kms.Key;

  constructor(scope: Construct, id: string, props: ExecEnvBaseStackProps) {
    super(scope, id, props);
    const { ctx } = props;

    // ── 数据域 CMK(本 region 独立一把)────────────────────────────────────
    // 🔴 别名必须经命名 SSOT:`alias/bgp-data` 是 **region 级唯一名**,同 region 两 target
    //    (蓝绿/主备)各自建 key 会撞别名。这一条是切片 a 开工时才被发现的
    //    —— 反向覆盖门禁 v1 只扫"以 bgp- 开头"的字面量,`"alias/bgp-data"` 溜过去了(门禁已加宽)。
    this.dataKey = new kms.Key(this, "ExecEnvDataKey", {
      alias: resourceName("dataKeyAlias", { targetId: ctx.targetId }),
      description: `BGP exec-env ${ctx.targetId} data-domain CMK (at-rest encryption)`,
      enableKeyRotation: true,
      // 删 CMK = 用它加密的数据永久不可解 ⇒ 与控制面同样 RETAIN + 30 天等待期。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pendingWindow: cdk.Duration.days(30),
    });
    // 🔴 `alias` 选项建出的 Alias 子资源**默认随栈删除**,只有 Key 本身 RETAIN。
    //   2026-10-11 第二账号真销毁 tgt_use1_a 实测:Key 留下了(Enabled),别名没了 ⇒ 删除预览与收口页承诺保留的
    //   `alias/bgp-data-<slug>` 找不到,运维只能拿描述文本去猜哪把钥匙解得开留下的数据桶 / 快照。
    //   ⇒ 别名与钥匙同生命周期(保持原逻辑 ID,只改 DeletionPolicy,存量栈升级不替换资源)。
    //   targetId 永不复用(删后同区重新注册是新 id)⇒ 留下的别名不会挡住任何新环境。
    const keyAlias = this.dataKey.node.tryFindChild("Alias") as kms.Alias | undefined;
    if (!keyAlias) throw new Error("数据域 CMK 的 Alias 子资源找不到 ⇒ 无法设 RETAIN(CDK 内部结构变了?)");
    keyAlias.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ── 平台数据面角色(L5;唯一作者 shared/platform-data-role.ts)──────────────────
    // 平台任务角色碰本区数据时代入它(资源只限本 target ∧ 本区)。
    //   主控区的那一个建在平台栈(同名会撞:IAM 角色名全局唯一)⇒ 这里只建非主控区的。
    if (!ctx.isHome) {
      buildPlatformDataRole(this, "PlatformDataRole", { targetId: ctx.targetId, account: ctx.account, region: ctx.region, partition: this.partition });
    }

    // ── VPC(🔴 起 **零出网**:无 NAT / 无 EIP / 无 IGW / 私有路由表无 0.0.0.0/0)──
    // 用户 2026-09-06 拍板(DESIGN §18 决策 6octies):「不都是内网地址吗?…肯定是要走端点、私有连接啊」。
    //
    // 🔴 **为什么 Public 层是 `reserved: true` 而不是直接删掉**:CDK 按 `subnetConfiguration` 的**顺序**
    //    切 CIDR。直接删掉 Public 这一层,私有子网会从 10.0.2.0/24/10.0.3.0/24 挪到 10.0.0.0/24/10.0.1.0/24
    //    ⇒ `CidrBlock` 变更 = **子网被替换** ⇒ 连带 MWAA 环境 / Redshift 子网组 / EMR 网络配置全部重建
    //    (正是 ACCEPTANCE N0-10 明令禁止的破坏性路径)。`reserved: true` 只保留地址空间、不建子网,
    //    于是**私有子网 CIDR 与逻辑 ID 都不动**,而公有子网连带 IGW / NAT / EIP 一起消失。
    // 🔴 **不传 availabilityZones** —— AZ 由基类 `ExecEnvStack` 覆写的 getter 提供(零 context 查找)。
    // 🔴🔴 **CIDR 必须显式给**(`ctx.vpcCidr`,类型上必填)。
    //    不给 `ipAddresses` 时 CDK 用默认 `10.0.0.0/16` —— 而主控区 VPC 也是这个值 ⇒ 两侧逐位相同 ⇒
    //    跨区 peering **物理上建不出来**(下面那段跨区通路的前提)。这一条 2026-09-08 就写在下面的注释里,
    //    2026-09-14 换选型时却只重勘了 SCP、没重勘 CIDR(probe 用的是两个 throwaway VPC,前提被悄悄换掉)。
    //    ⇒ 非 home 从地址池取(`vpc-cidr.ts`,与 10.0.0.0/16 构造上不相交);home 沿用存量值,行为不变。
    this.vpc = new ec2.Vpc(this, "ExecEnvVpc", {
      ipAddresses: ec2.IpAddresses.cidr(ctx.vpcCidr),
      natGateways: 0,
      maxAzs: ctx.azs.length,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, reserved: true },
        { name: "Private", subnetType: EXEC_ENV_PRIVATE_SUBNET_TYPE, cidrMask: 24 },
      ],
    });

    // ── 端点(清单唯一作者 = `endpoints.ts`;SPEC §3.16-B)────────────────────
    const plan = endpointPlanFor({ components: ctx.components, region: ctx.region, homeRegion: ctx.homeRegion });

    // 网关端点(免费)。必须与私有路由表**同栈**(控制面踩过坑:跨栈引用路由表 export 会把栈钉住,
    // 后续部署一碰就 Cannot delete export ... in use)—— 本栈自己拥有 VPC,天然同栈。
    const GATEWAY_SERVICE: Record<string, ec2.GatewayVpcEndpointAwsService> = {
      s3: ec2.GatewayVpcEndpointAwsService.S3,
      dynamodb: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    };
    // 🔴🔴 **构造 id 必须冻结**(2026-09-08 真环境撞到,台账 N-1)。
    //   S3 网关端点在此前就存在,构造 id 是 `S3Gw`。我按新命名规则算成 `GwS3` ⇒ CFN 认为
    //   这是一个**新资源**,于是一边建新的、一边老的还挂在同一张路由表上占着 S3 前缀列表:
    //   `route table rtb-… already has a route with destination-prefix-list-id pl-68a54001`
    //   ⇒ base 栈 UPDATE_ROLLBACK_COMPLETE,整次切换失败。
    //   教训:**逻辑 id 就是资源身份**;给存量资源换 id = 删了重建(网关端点这种「路由表里唯一」的资源
    //   会直接冲突,更隐蔽的是数据类资源会被静默替换)。⇒ 存量 id 逐个冻结在这张表里,新增的才用新规则。
    const GATEWAY_CONSTRUCT_ID: Record<string, string> = {
      s3: "S3Gw", // 🔴 存量 id,不许改(此前就有)
      dynamodb: "DynamodbGw", // 新增
    };
    const endpointIds: string[] = [];
    for (const svc of plan.gateway) {
      const gw = GATEWAY_SERVICE[svc];
      if (!gw) throw new Error(`端点清单里的网关端点 ${svc} 在 base-stack 没有映射 —— 加清单要同步加映射`);
      const cid = GATEWAY_CONSTRUCT_ID[svc];
      if (!cid) throw new Error(`网关端点 ${svc} 没有登记构造 id —— 逻辑 id 是资源身份,必须显式定(见上面的说明)`);
      endpointIds.push(this.vpc.addGatewayEndpoint(cid, { service: gw }).vpcEndpointId);
    }

    // 接口端点:**共用一个 SG**,只放行本 VPC CIDR 的 443(逐个端点各建一个 SG 会多出十几个资源)。
    const endpointSg = new ec2.SecurityGroup(this, "EndpointSg", {
      vpc: this.vpc,
      description: `BGP exec-env ${ctx.targetId} VPC interface endpoints (443 from VPC CIDR only)`,
      allowAllOutbound: false,
    });
    // 🔴 规则描述**必须 ASCII**(2026-09-08 真环境撞到,台账 N-2):SG 规则描述的合法字符集比
    //   `GroupDescription` 更窄(只收 `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*`),中文 ⇒ 真部署 400
    //   `Invalid rule description` ⇒ 整栈回滚。synth 不校验 ⇒ 只有真部署才暴露。中文放注释里。
    endpointSg.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "tasks in this VPC reach interface endpoints"
    );

    for (const svc of plan.iface) {
      // 🔴 用 `InterfaceVpcEndpointService` 显式拼服务名,不走 `InterfaceVpcEndpointAwsService` 枚举:
      //    清单里有几个服务(s3tables / airflow-serverless / redshift-serverless)在 CDK 枚举里未必有,
      //    而清单的**唯一真值**是 `endpoints.ts` 里的字符串 —— 让两边靠枚举对齐等于又开一处漂移。
      const ep = new ec2.InterfaceVpcEndpoint(this, `Ep${pascal(svc)}`, {
        vpc: this.vpc,
        service: new ec2.InterfaceVpcEndpointService(endpointServiceName(svc, ctx.region), 443),
        subnets: EXEC_ENV_PRIVATE_SUBNET_SELECTION,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
      endpointIds.push(ep.vpcEndpointId);
    }

    // ── 🔴🔴 唯一跨区路径:**peering + 主控区同区端点 + 本区私有托管域**(SPEC §3.14ter)────
    //
    // 【为什么不是跨区 VPC 端点了】定的是「在本区建一个 `ServiceRegion=<home>` 的跨区接口端点」,
    //   理由是「home 与所有执行环境 VPC 的 CIDR 全是 10.0.0.0/16,peering 要求不重叠 ⇒ 那条路建不出来」。
    //   2026-09-14 两件事同时被推翻:
    //     ① 跨区端点这条路**被组织 SCP 拦死** —— `vpce:AllowMultiRegion` 的 `AllowedByOrganizations=False`,
    //        角色挂 `AdministratorAccess` 也没用,账号内放不开(IAM 模拟器逐 action 量出来的);
    //     ② 「CIDR 必然重叠」不是天生的,是**没给 `ipAddresses`** 造成的 —— 现在非 home 从地址池取段
    //        (`vpc-cidr.ts`,与主控区构造上不相交)⇒ peering 反而是唯一走得通的那条。
    //   🔴 教训写在这里,因为下一个人多半会照着上面那段旧注释再绕一圈:**旧结论的前提也会过期**。
    //
    // 形态(三件一套,少一件就是「请求发得出去、响应回不来」或「名字仍解析公网」):
    //   ① 跨区 `CfnVPCPeeringConnection`(对端 = 主控区 VPC);
    //   ② **两侧**路由:本区这一侧在下面建;**主控区那一侧**由自定义资源加(它属于另一个 region 的另一个栈,
    //      且是 per-target 的 ⇒ 平台栈无法预先枚举);
    //   ③ 本区私有托管域把 `dynamodb.<home>.amazonaws.com` 解到**主控区端点 ENI 的私有 IP**
    //      ⇒ 产品代码零改动。ENI IP 由自定义资源在部署期读回,**不写死**。
    let homeLinkPeeringId: string | undefined;
    let homeLinkHostedZoneId: string | undefined;
    if (plan.homeLink.length > 0) {
      const link = ctx.homeLink;
      if (!link) {
        // `readExecEnvContext` 已经 fail-closed;这里是第二道 —— 本栈可以被别的入口直接 new,
        // 而少了这三件事实建出来的形态是「peering 有、回程路由没有」= 最难查的那一类。
        throw new Error(
          `target ${ctx.targetId} 要建跨区私网通路,但 ctx.homeLink 缺失(主控区 VPC id / 网段 / 端点 id)—— ` +
            `拒绝建一条注定回写不了的通路(SPEC §3.14ter)`
        );
      }
      const homeRegion = plan.homeLink[0].region;
      const pcx = new ec2.CfnVPCPeeringConnection(this, "HomePeering", {
        vpcId: this.vpc.vpcId,
        peerVpcId: link.vpcId,
        // 🔴 跨区 peering:同账号也**不会**被 CFN 自动接受 ⇒ 由下面的自定义资源 accept
        peerRegion: homeRegion,
      });

      // 主控区那一侧的接线(accept + 回程路由 + 读回端点 ENI 私有 IP)。
      const linkFn = new lambda.Function(this, "HomeLinkFn", {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "lambda", "xregion-peering")),
        // accept 后要等 peering 变 active(跨区传播;实测几秒,给足余量但不无限等)
        timeout: cdk.Duration.minutes(10),
        memorySize: 256,
        description: `BGP exec-env ${ctx.targetId}: accept cross-region peering + add return route in ${homeRegion}`,
      });
      linkFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "HomeSideLinkWiring",
          actions: [
            "ec2:AcceptVpcPeeringConnection",
            "ec2:DescribeVpcPeeringConnections",
            "ec2:DescribeVpcEndpoints",
            "ec2:DescribeNetworkInterfaces",
            "ec2:DescribeRouteTables",
            "ec2:CreateRoute",
            "ec2:DeleteRoute",
          ],
          // 这些 API 多不支持资源级;改用**区域**收窄:所有调用都只打主控区。
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": homeRegion } },
        })
      );
      const homeLink = new cdk.CustomResource(this, "HomeLink", {
        serviceToken: new cr.Provider(this, "HomeLinkProvider", { onEventHandler: linkFn }).serviceToken,
        properties: {
          HomeRegion: homeRegion,
          PeeringConnectionId: pcx.ref,
          // 回程路由的目的地 = **本环境**的网段
          LocalVpcCidr: ctx.vpcCidr,
          HomeDdbEndpointId: link.ddbEndpointId,
          TargetId: ctx.targetId,
        },
      });

      // 本区这一侧的路由:每张私有子网路由表一条,目的地 = 主控区网段。
      // 🔴 必须**等 accept 完成**再建 —— pending-acceptance 的 peering 加路由会被拒。
      execEnvPrivateSubnets(this.vpc).subnets.forEach((sn, i) => {
        const route = new ec2.CfnRoute(this, `HomeRoute${i + 1}`, {
          routeTableId: sn.routeTable.routeTableId,
          destinationCidrBlock: link.vpcCidr,
          vpcPeeringConnectionId: pcx.ref,
        });
        route.node.addDependency(homeLink);
      });

      for (const { service, region: peerRegion } of plan.homeLink) {
        const zone = new route53.PrivateHostedZone(this, `XZone${pascal(service)}`, {
          zoneName: `${service}.${peerRegion}.amazonaws.com`,
          vpc: this.vpc,
          comment: `BGP exec-env ${ctx.targetId}: 把 ${service}.${peerRegion} 解析到主控区端点 ENI(经 peering,零出网)`,
        });
        // 🔴 A 记录而不是 ALIAS:主控区那个端点在**另一个 region 的另一个栈**里,这边拿不到它的
        //    `DnsEntries`;而 ENI 私有 IP 在端点生命周期内稳定,由自定义资源部署期读回(不写死)。
        // 🔴 记录名 == 托管域名 ⇒ 这是**域顶点**,CNAME 在顶点非法,只有 A/ALIAS 可用。
        new route53.CfnRecordSet(this, `XAlias${pascal(service)}`, {
          hostedZoneId: zone.hostedZoneId,
          name: `${service}.${peerRegion}.amazonaws.com.`,
          type: "A",
          ttl: "300",
          resourceRecords: cdk.Fn.split(",", homeLink.getAttString("EndpointIps")),
        });
        if (service === "dynamodb") homeLinkHostedZoneId = zone.hostedZoneId;
      }
      homeLinkPeeringId = pcx.ref;
    }

    // ── Outputs:供 buildspec 回写描述符(50 SPEC §1.1 的实名资源袋)────────
    // 🔴 OutputKey 直接用**描述符字段名**,让"部署期产出"与"注册表字段"一一对应,
    //    中间不需要任何映射表(映射表就是下一处漂移源)。
    new cdk.CfnOutput(this, "vpcId", { value: this.vpc.vpcId });
    // 占用的地址段要能被看见(描述符 / 探活 / 判据都读它)
    new cdk.CfnOutput(this, "vpcCidr", { value: this.vpc.vpcCidrBlock });
    new cdk.CfnOutput(this, "dataKeyArn", { value: this.dataKey.keyArn });
    new cdk.CfnOutput(this, "privateSubnetIds", {
      // 🔴 私有子网从 PRIVATE_WITH_EGRESS 变成 PRIVATE_ISOLATED(同名同逻辑 ID、CIDR 不变),
      //    这里的 selector 必须同步改 —— 不改的话选出空集,输出变空串,下游 core/mwaa/emr 全部拿不到子网。
      value: execEnvPrivateSubnets(this.vpc).subnetIds.join(","),
    });
    // SPEC §3.16-E 的三个观测键(详情页「网络」行与探活读它)
    new cdk.CfnOutput(this, "endpointIds", { value: endpointIds.join(",") });
    // 跨区通路的两个实名产物(探活 `network:home-link` 读它们)。
    // 🔴 `crossRegionDdbEndpointId` **已退役** —— 那个形态被组织 SCP 拦死,建不出来;
    //    留着一个永远为空的字段 = 让探活对着一个不存在的形态判红(ACCEPTANCE N0-3 已改判)。
    if (homeLinkPeeringId) {
      new cdk.CfnOutput(this, "homeLinkPeeringId", { value: homeLinkPeeringId });
    }
    if (homeLinkHostedZoneId) {
      new cdk.CfnOutput(this, "homeLinkHostedZoneId", { value: homeLinkHostedZoneId });
    }
    new cdk.CfnOutput(this, "targetId", { value: ctx.targetId });
  }
}

/** `emr-serverless` → `EmrServerless`(构造 id 用;`.` 与 `-` 都不能进 CFN 逻辑 id)。 */
function pascal(svc: string): string {
  return svc
    .split(/[.\-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}
