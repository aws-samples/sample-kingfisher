// @kf-batch 50-WP28-platform-action-node
// 🔴🔴 **「按时跑一次平台动作」的主控区一侧**(WP-28 序 2 + 序 3):命令表 + 分发 Lambda + 内部密钥。
//
// 链路:执行区 DAG 的 platform-action 节点 →(IAM,跨区回主控区 DynamoDB = 唯一获准例外)
//       → **本构件的命令表** bgp-action-commands(INSERT, pending)→ Streams(只收 INSERT)
//       → **本构件的分发 Lambda**(平台 VPC 内)→ ALB 私网地址 → 平台内部端点 /api/internal/actions/run
//       → 平台校验 + 抢单 + 执行白名单动作的库函数 → 命令行写终态 → DAG 轮询到终态。
//
// 【为什么命令表建在这里而不是 BgpDatabaseStack】WORK-PACKAGES WP-28 序 2 写的是 database-stack;
//   施工时改到与消费端同一个构件,理由只有一条:Lambda 的事件源要 **Stream ARN**(带时间戳、不可推导),
//   放在别的栈就得跨栈导出 —— 而跨栈导出会把两个栈钉死(本仓记过 export 死锁)。命令表是 7 天 TTL 的
//   传声筒、运行历史在 bgp-task-runs,与消费端同生命周期是对的。表名不变(执行区角色按 `bgp-*` 授权)。
//
// 【鉴权 = 最小爆炸半径】内部密钥由 Secrets Manager 生成,只给两个主体读:本 Lambda + 平台 TaskRole
//   (后者原本就有 `secret:*` 的 GetSecretValue,这里不再加宽)。平台侧另有两道:不经 CloudFront + 来源头。
//   请求里只带 commandId —— 动作与参数平台从命令行读(写命令行要 IAM),密钥泄露 ≈「重放表里已有的白名单命令」。
//
// 【网络】ALB 是 internet-facing,公网 DNS 从 VPC 内走会绕 NAT(源地址变成 NAT 的公网 IP,SG 认不出来)
//   ⇒ Lambda 按网卡描述查 ALB 的**私网地址**直连;ALB 的 SG 单独给 Lambda 的 SG 开 80 入站(独立的
//   SecurityGroupIngress 资源,不受平台栈「清空内联入站」那条覆盖影响)。Lambda 出站只放:VPC 内 80(→ ALB)
//   + 443(→ Secrets Manager / EC2 / DynamoDB 的 API,走 NAT 或 VPC 端点)。
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as path from "path";
import { Construct } from "constructs";

/** 与平台 `lib/scheduler/action-commands.ts` 的 `ACTION_COMMANDS_TABLE` 同值(平台单测钉两处相等)。 */
export const ACTION_COMMANDS_TABLE_NAME = "bgp-action-commands";
/** 调度对象表(治理定时任务 / 问数卡片定时刷新)。与命令表同栈:平台重部署即建出(见下方 ①b)。 */
export const ACTION_SCHEDULES_TABLE_NAME = "bgp-action-schedules";
/** 内部密钥的名字(平台单测钉:平台读的环境变量就是它的 ARN)。 */
export const ACTION_DISPATCH_SECRET_NAME = "bgp/internal/action-dispatch-key";

export interface ActionDispatchProps {
  vpc: ec2.IVpc;
  /** 数据域 CMK(命令表与全部 bgp-* 表同一把;Streams 读取要 kms:Decrypt)。 */
  dataKey: kms.IKey;
  /** 平台 ALB 的安全组(要给分发 Lambda 开 80 入站)。 */
  albSecurityGroup: ec2.ISecurityGroup;
  /** 平台 ALB 的 full name(`app/<name>/<id>`;网卡描述 = `ELB <fullName>`)。 */
  loadBalancerFullName: string;
  /** ALB 监听端口(平台栈是 80)。 */
  listenerPort: number;
}

export class ActionDispatch extends Construct {
  public readonly table: dynamodb.Table;
  public readonly secret: secretsmanager.Secret;
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: ActionDispatchProps) {
    super(scope, id);

    // ① 命令表(传声筒):Streams NEW_IMAGE + TTL 7 天(`ttl` 属性由写入方算好)。
    //    🔴 RETAIN:主控区数据类资源一律 Retain(synth-gate §9r);它只有 7 天的传声筒数据,留着无害。
    this.table = new dynamodb.Table(this, "Commands", {
      tableName: ACTION_COMMANDS_TABLE_NAME,
      partitionKey: { name: "commandId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dataKey,
      timeToLiveAttribute: "ttl",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ①b 调度对象表:pk = "default-user"(单分区,低量配置数据),sk = taskId(`gov_<ulid>` / `gcard_<cardId>`)。
    //    发布台账 `deployments[targetId]` 落在这一行(CarrierLedger);run 台账的 taskId 就是它。
    //    🔴 只存非数据值(动作 id / 参数 / 归属 / cron);卡片的结果与标题仍在该区 S3。
    //    🔴 放在平台栈(不是 BgpDatabaseStack):两栈互不依赖,只重部署平台栈的环境否则缺表(序 33 ③ 部署前勘定)。
    new dynamodb.Table(this, "Schedules", {
      tableName: ACTION_SCHEDULES_TABLE_NAME,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "taskId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dataKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ② 内部共享密钥(平台侧 internal-guard 按 ARN 读)
    this.secret = new secretsmanager.Secret(this, "InternalKey", {
      secretName: ACTION_DISPATCH_SECRET_NAME,
      description: "平台内部端点 /api/internal/** 的共享密钥(分发 Lambda ↔ 平台;WP-28)",
      generateSecretString: { passwordLength: 48, excludePunctuation: true, includeSpace: false },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ③ 网络:Lambda 自己的 SG(出站收窄)+ ALB 给它开的那条入站
    const sg = new ec2.SecurityGroup(this, "FnSg", {
      vpc: props.vpc,
      allowAllOutbound: false,
      description: "bgp action-dispatcher Lambda (to platform ALB private IPs + AWS APIs)",
    });
    sg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(props.listenerPort), "to platform ALB (private IPs)");
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "AWS APIs (Secrets Manager / EC2 / DynamoDB)");
    props.albSecurityGroup.addIngressRule(sg, ec2.Port.tcp(props.listenerPort), "Allow action-dispatcher Lambda (WP-28)");

    // ④ 分发 Lambda
    this.fn = new lambda.Function(this, "Fn", {
      functionName: "bgp-action-dispatcher",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "action-dispatcher")),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        TABLE_NAME: this.table.tableName,
        SECRET_ARN: this.secret.secretArn,
        LB_FULL_NAME: props.loadBalancerFullName,
        PLATFORM_PORT: String(props.listenerPort),
      },
      description: "WP-28:把平台动作命令(DDB Streams)转交平台内部端点;不做任何业务",
    });
    this.secret.grantRead(this.fn);
    // 只许把**仍是 pending** 的命令判 failed(条件写在代码里;IAM 只给 UpdateItem 这一项写)
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:UpdateItem"],
      resources: [this.table.tableArn],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      // 查 ALB 的私网地址(不支持资源级权限)
      actions: ["ec2:DescribeNetworkInterfaces"],
      resources: ["*"],
    }));
    this.fn.addEventSource(new DynamoEventSource(this.table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 2,
      bisectBatchOnError: true,
      // 🔴 只收 INSERT:平台写终态(MODIFY)/ TTL 删除(REMOVE)也会产生流事件,不许再触发分发
      filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual("INSERT") })],
    }));
  }
}
