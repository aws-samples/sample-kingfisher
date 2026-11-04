import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

interface Props extends cdk.StackProps { vpc: ec2.IVpc; dataKey: kms.IKey; }

export class OmSearchStack extends cdk.Stack {
  public readonly domain: opensearch.Domain;
  public readonly esSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    // NOTE: The OpenSearch/Elasticsearch service-linked role
    // (AWSServiceRoleForAmazonElasticsearchService, service `es.amazonaws.com`) is an
    // ACCOUNT-GLOBAL singleton. Creating it as a stack resource breaks redeployment on any
    // account where it already exists ("...has been taken in this account", AlreadyExists).
    // It is therefore handled idempotently out-of-band as a deploy prerequisite — see the
    // runbook ("ensure-service-linked-roles" step):
    //   aws iam create-service-linked-role --aws-service-name es.amazonaws.com 2>/dev/null || true
    // (AWS also auto-creates it on first OpenSearch domain creation when permitted.)

    this.esSg = new ec2.SecurityGroup(this, "OmEsSg", { vpc: props.vpc, description: "OpenMetadata ES" });
    this.esSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443));

    // (WS2 — 高可用): 由「1 节点 / 单 AZ」升级为「2 数据节点 + 3 专用主节点 / 2 AZ
    // zone-awareness」。原先单节点单 AZ 是 SPOF——节点或 AZ 故障即 OM 搜索/元数据查询不可用。
    // 专用主节点(奇数 3 个)保证脑裂保护下的稳定选主。
    // (WS1 — 加密): 静态加密用数据域 CMK + 节点间加密 + 强制 HTTPS(传输加密)。
    this.domain = new opensearch.Domain(this, "OmSearch", {
      domainName: "bgp-om-search",
      version: opensearch.EngineVersion.OPENSEARCH_2_11,
      vpc: props.vpc,
      // 跨 2 个私有子网(2 AZ),与 zoneAwareness 配合分布数据节点。
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      securityGroups: [this.esSg],
      capacity: {
        dataNodeInstanceType: "t3.small.search",
        dataNodes: 2,
        masterNodeInstanceType: "t3.small.search",
        masterNodes: 3,
      },
      zoneAwareness: { enabled: true, availabilityZoneCount: 2 },
      ebs: { volumeSize: 20 },
      encryptionAtRest: { enabled: true, kmsKey: props.dataKey },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      accessPolicies: [new iam.PolicyStatement({ actions: ["es:*"], principals: [new iam.AnyPrincipal()], resources: ["*"] })],
    });

    new cdk.CfnOutput(this, "SearchEndpoint", { value: this.domain.domainEndpoint });
  }
}
