import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

interface FinOpsStackProps extends cdk.StackProps {
  // 与 DatabaseStack 相同的数据域 CMK(WS1),表静态加密。
  dataKey: kms.IKey;
}

// 模块 40 — FinOps 资产与成本治理。独立栈(不并入 BgpDatabaseStack):FinOps 是大功能,
// 隔离靠"独立栈"本身——改本栈不触碰任何现有栈,下线 = cdk destroy BgpFinOpsStack。
// 仅 3 张按需 DynamoDB 表,零常驻计费,故无条件实例化(默认安装,开箱即用)。
export class FinOpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FinOpsStackProps) {
    super(scope, id, props);

    // 与 DatabaseStack 一致的生产化加固表选项(WS1 CMK / WS3 PITR+RETAIN)。
    const hardened = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dataKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    } as const;

    // L1 服务日成本快照:pk = "costv2#<yyyy-MM>",sk = "<date>#<service>#<region>"(@kf-batch 50-WP6-cost-by-region;
    // 旧分区 "cost#<yyyy-MM>" 不再读写、不删除)。
    // 另有 meta item(pk="costmeta", sk="watermark#<kind>")记采集/归因水位。
    new dynamodb.Table(this, "CostDaily", {
      tableName: "bgp-cost-daily",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });

    // L3 run 级成本归因:pk = "taskcost#<taskId>",sk = runId。条件写幂等;TTL 180d。
    new dynamodb.Table(this, "CostRuns", {
      tableName: "bgp-cost-runs",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      ...hardened,
    });

    // 预算护栏:pk = "budget#<projectId|global>",sk = budgetId(ULID)。version 乐观锁。
    new dynamodb.Table(this, "Budgets", {
      tableName: "bgp-budgets",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...hardened,
    });
  }
}
