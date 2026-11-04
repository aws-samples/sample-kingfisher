import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { cloudfrontOriginFacingPrefixList } from "./shared/cloudfront-prefix-list";

interface Props extends cdk.StackProps {
  vpc: ec2.IVpc;
  db: rds.DatabaseInstance;
  searchEndpoint: string;
  /** 🔴 生产上线批次 A:OM 专用 WebACL(waf-stack 的 omWebAclArn;CLOUDFRONT scope)。 */
  webAclArn: string;
}

export class OmServiceStack extends cdk.Stack {
  public readonly albDnsName: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const vpc = props.vpc;
    const omSg = new ec2.SecurityGroup(this, "OmSg", { vpc, description: "OpenMetadata Service" });
    omSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80));

    const cluster = new ecs.Cluster(this, "OmCluster", { vpc, clusterName: "bgp-om-cluster" });

    const taskDef = new ecs.FargateTaskDefinition(this, "OmTaskDef", { cpu: 2048, memoryLimitMiB: 4096 });
    taskDef.executionRole?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"));

    taskDef.addContainer("openmetadata", {
      image: ecs.ContainerImage.fromRegistry("docker.getcollate.io/openmetadata/server:1.6.1"),
      portMappings: [{ containerPort: 8585 }],
      environment: {
        OPENMETADATA_CLUSTER_NAME: "bgp-openmetadata",
        DB_DRIVER_CLASS: "com.mysql.cj.jdbc.Driver",
        DB_SCHEME: "mysql",
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        // (WS1 — 传输加密): OM ↔ MySQL 由明文改为 TLS。
        DB_USE_SSL: "true",
        OM_DATABASE: "openmetadata_db",
        SEARCH_TYPE: "opensearch",
        ELASTICSEARCH_HOST: props.searchEndpoint,
        ELASTICSEARCH_PORT: "443",
        ELASTICSEARCH_SCHEME: "https",
        SERVER_PORT: "8585",
        SERVER_ADMIN_PORT: "8586",
        AUTHENTICATION_PROVIDER: "basic",
        AUTHORIZER_PRINCIPAL_DOMAIN: "open-metadata.org",
        MIGRATION_LIMIT_PARAM: "1200",
      },
      secrets: {
        DB_USER_PASSWORD: ecs.Secret.fromSecretsManager(props.db.secret!, "password"),
        DB_USER: ecs.Secret.fromSecretsManager(props.db.secret!, "username"),
      },
      command: ["-c", "./bootstrap/openmetadata-ops.sh migrate && /openmetadata-start.sh"],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "openmetadata", logRetention: logs.RetentionDays.ONE_WEEK }),
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "OmAlb", { vpc, internetFacing: true, securityGroup: omSg });
    this.albDnsName = alb.loadBalancerDnsName;
    // Do not auto-open 0.0.0.0/0. Restrict the (internet-facing) ALB to the
    // CloudFront origin-facing prefix list + VPC internal traffic only.
    const listener = alb.addListener("OmListener", { port: 80, open: false });

    // 🔴 生产上线批次 A:两件密钥,都 RETAIN。
    //   · 管理员口令:OM basic 认证出厂是 admin/admin,且 OM 对公网可达 ⇒ 部署时由
    //     scripts/om-secure-admin.sh 换成这里生成的随机口令;平台 / 问数技能从同一个密钥读。
    //     🔴 RETAIN 的理由:OM 数据库里已经是新口令,密钥若随删栈丢失就再也登不进去。
    //   · 回源校验值:CloudFront 回源时带上它,ALB 只认带对的请求 —— 否则任何人自建一个 CloudFront
    //     分发(同样落在 origin-facing 前缀列表里)就能绕过本分发的 WAF 直打 ALB。
    const omAdminSecret = new secretsmanager.Secret(this, "OmAdminPassword", {
      secretName: "bgp/om/admin-password",
      description: "OpenMetadata admin password (replaces the factory default)",
      generateSecretString: { passwordLength: 24, requireEachIncludedType: true, excludeCharacters: "\"'`\\/@ " },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const originVerify = new secretsmanager.Secret(this, "OmOriginVerify", {
      secretName: "bgp/om/origin-verify",
      description: "CloudFront to OpenMetadata ALB origin verification header value",
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const ORIGIN_HEADER = "X-Bgp-Origin-Verify";
    const originVerifyValue = originVerify.secretValue.unsafeUnwrap(); // 合成为 {{resolve:secretsmanager:…}} 动态引用
    new cdk.CfnOutput(this, "OmAdminSecretArn", { value: omAdminSecret.secretArn });
    // 🔴 原来这里是 `if (omCfPrefixListId) { …addIngressRule }`:
    //   查不到 id 就**静默跳过**,于是 OM 的 ALB 少一条 CloudFront 入站规则 —— 部署一路绿灯、
    //   OM 页面却打不开(源站对 CloudFront 不可达)。现在与 platform-stack **同一个作者、同一种失败语义**:
    //   取不到就抛,不许悄悄少一条规则。
    const omCfPrefixListId = cloudfrontOriginFacingPrefixList(this); // 部署期按名查本区真值(h)
    {
      omSg.addIngressRule(
        ec2.Peer.prefixList(omCfPrefixListId),
        ec2.Port.tcp(80),
        "Allow CloudFront only"
      );
    }

    // (WS2 — 可用性): OM 保持 desiredCount=1。OM server 启动会跑 `migrate`(DB schema
    // 迁移),并发多副本同时迁移有竞态/损坏风险——真正的 OM 多副本需把迁移外置为一次性 Job
    // (留待后续)。当前依赖 ECS 在任务/AZ 故障时自动重新调度实现"重启级"可用性;底层 OM-DB
    // 已 Multi-AZ(WS2),OpenSearch 已多节点(WS2),故 OM 的有状态依赖均已去单点。
    const service = new ecs.FargateService(this, "OmService", {
      cluster, taskDefinition: taskDef, desiredCount: 1,
      assignPublicIp: false, securityGroups: [omSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(600),
      minHealthyPercent: 0, // 单副本滚动部署:允许先停旧再起新(避免端口/迁移冲突)
      maxHealthyPercent: 100,
    });

    // 默认动作 403;只有带对回源头的请求才转发给 OM(健康检查走目标组,不经监听器规则,不受影响)。
    listener.addAction("DenyWithoutOriginHeader", {
      action: elbv2.ListenerAction.fixedResponse(403, { contentType: "text/plain", messageBody: "Forbidden" }),
    });
    listener.addTargets("OmTarget", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_HEADER, [originVerifyValue])],
      port: 8585, protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: "/api/v1/system/version", interval: cdk.Duration.seconds(60), healthyThresholdCount: 2, unhealthyThresholdCount: 10 },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Front OpenMetadata with CloudFront (HTTPS) so browsers can reach it without the
    // ALB being open to the internet, and so the HTTPS platform iframe avoids mixed-content.
    const distribution = new cloudfront.Distribution(this, "OmCdn", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: { [ORIGIN_HEADER]: originVerifyValue },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      webAclId: props.webAclArn,
    });

    new cdk.CfnOutput(this, "OpenMetadataUrl", { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, "OpenMetadataCdnUrl", { value: `https://${distribution.distributionDomainName}` });
  }
}
