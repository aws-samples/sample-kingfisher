// L1 助手：把抽象 Target 解析成可裁决的具体网络坐标（ResolvedTarget）。
//
// 复用 datasource-service.ts 的 RDS 探测思路（DescribeDBInstances 按 endpoint 匹配 → VPC/SG）；
// 新增 Redshift provisioned/serverless 解析、AWS 服务 endpoint 模型判定。
// 不可发现（跨账号/SaaS）→ discoverable=false，交 L2 出 needs-input + questions。

// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { regionalClient } from "@/lib/aws/clients";
import { DescribeDBInstancesCommand, DescribeDBClustersCommand } from "@aws-sdk/client-rds";
import { DescribeClustersCommand } from "@aws-sdk/client-redshift";
import { GetWorkgroupCommand } from "@aws-sdk/client-redshift-serverless";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { TARGET_DEFAULT_PORT, DEFAULT_DB_PORT } from "./config";
import type { AwsServiceName, ResolvedTarget, Target } from "./types";

const USER_ID = process.env.PLATFORM_USER_ID || "default-user";

/**
 * 解析上下文:降级记录 + **落点 region**。
 * RDS / Redshift / Redshift Serverless 都是区域服务:客户端按 ctx.region 经唯一工厂建、按区缓存;
 *   原来是三个模块级主控区客户端 ⇒ 别的区的实例永远「未发现」、安全组解析为空。
 */
export interface ResolveCtx {
  degraded: boolean;
  missing: string[];
  region: string;
}
function note(ctx: ResolveCtx, what: string, err: unknown) {
  ctx.degraded = true;
  ctx.missing.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
}

// 用于缓存键：把目标集合压成稳定签名（不含敏感值）。
export function targetSignature(targets: Target[]): string {
  return targets
    .map((t) => {
      switch (t.kind) {
        case "datasource": return `ds:${t.datasourceId}`;
        case "rds": return `rds:${t.instanceId || t.endpoint || "?"}`;
        case "aurora": return `aurora:${t.clusterId}:${t.role || "writer"}`;
        case "redshift": return `rs:${t.flavor}:${t.identifier}`;
        case "aws-service": return `svc:${t.service}`;
        case "msk": return `msk:${t.clusterArn}`;
        case "opensearch": return `os:${t.domainOrEndpoint}`;
        case "host": return `host:${t.host}:${t.port}`;
        case "external": return `ext:${t.vendor || "other"}:${t.host}:${t.port}`;
      }
    })
    .sort()
    .join(",");
}

// gateway endpoint 仅 S3 + DynamoDB（移植自 AWS networking skill 的 MUST 规则）。
const GATEWAY_SERVICES: AwsServiceName[] = ["s3", "s3tables", "dynamodb"];

function resolveAwsService(service: AwsServiceName): Pick<ResolvedTarget, "endpointModel" | "port" | "discoverable" | "notes"> {
  if (GATEWAY_SERVICES.includes(service)) {
    return { endpointModel: "needs-gateway-endpoint", port: 443, discoverable: true, notes: ["S3/DynamoDB 走 gateway endpoint（免费，挂子网路由表）"] };
  }
  return { endpointModel: "needs-interface-endpoint", port: 443, discoverable: true, notes: ["interface endpoint：需 SG 放行 :443 来自 VPC CIDR + VPC 开启私有 DNS"] };
}

// 按 endpoint 地址匹配 RDS 实例 → VPC/SG/AZ。复用 datasource-service.detectNetwork 同思路。
async function resolveRdsByEndpoint(endpoint: string | undefined, instanceId: string | undefined, port: number, ctx: ResolveCtx): Promise<Partial<ResolvedTarget>> {
  try {
    const { DBInstances = [] } = await (await regionalClient("rds", ctx.region)).send(new DescribeDBInstancesCommand({}));
    const inst = DBInstances.find((i) =>
      (endpoint && i.Endpoint?.Address === endpoint) || (instanceId && i.DBInstanceIdentifier === instanceId)
    );
    if (!inst) return { discoverable: false, notes: ["未在本账号发现该 RDS 实例（可能跨账号/外部）"] };
    return {
      vpcId: inst.DBSubnetGroup?.VpcId,
      port: inst.Endpoint?.Port || port,
      azs: (inst.DBSubnetGroup?.Subnets || []).map((s) => s.SubnetAvailabilityZone?.Name || "").filter(Boolean),
      securityGroupIds: (inst.VpcSecurityGroups || []).map((s) => s.VpcSecurityGroupId!).filter(Boolean),
      endpointModel: inst.PubliclyAccessible ? "managed-public" : "in-vpc",
      discoverable: true,
    };
  } catch (e) {
    note(ctx, "rds:DescribeDBInstances", e);
    return { discoverable: false };
  }
}

async function resolveOne(t: Target, ctx: ResolveCtx): Promise<ResolvedTarget> {
  const base: ResolvedTarget = { target: t, port: 0, securityGroupIds: [], endpointModel: "unknown", discoverable: false };

  switch (t.kind) {
    case "datasource": {
      // 查平台数据源表拿 host/type，再按 host 匹配 RDS。
      try {
        const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: t.datasourceId } }));
        if (!ds) return { ...base, notes: ["数据源不存在"] };
        const port = t.port || ds.port || DEFAULT_DB_PORT[ds.type] || 3306;
        // 已存 networkConfig 直接用（datasource-service.detectNetwork 的产物）。
        if (ds.networkConfig?.vpcId) {
          return {
            ...base,
            vpcId: ds.networkConfig.vpcId,
            port,
            // 用户指定的多个组(建源 / 改网络时落库的 securityGroupIds)全部算上;
            //   存量行只有 securityGroupId ⇒ 与改动前一致。
            securityGroupIds: Array.isArray(ds.networkConfig.securityGroupIds) && ds.networkConfig.securityGroupIds.length
              ? [...ds.networkConfig.securityGroupIds]
              : ds.networkConfig.securityGroupId ? [ds.networkConfig.securityGroupId] : [],
            endpointModel: "in-vpc",
            discoverable: true,
            notes: ["复用数据源已探测的 networkConfig"],
          };
        }
        // 否则按 host 现探 RDS。
        const r = await resolveRdsByEndpoint(ds.host, undefined, port, ctx);
        return { ...base, port, ...r };
      } catch (e) {
        note(ctx, "datasource lookup", e);
        return base;
      }
    }
    case "rds": {
      const port = t.port || TARGET_DEFAULT_PORT.rds;
      const r = await resolveRdsByEndpoint(t.endpoint, t.instanceId, port, ctx);
      return { ...base, port, ...r };
    }
    case "aurora": {
      const port = t.port || TARGET_DEFAULT_PORT.aurora;
      try {
        const { DBClusters = [] } = await (await regionalClient("rds", ctx.region)).send(new DescribeDBClustersCommand({ DBClusterIdentifier: t.clusterId }));
        const c = DBClusters[0];
        if (!c) return { ...base, port, discoverable: false, notes: ["未发现该 Aurora 集群"] };
        return {
          ...base,
          port: c.Port || port,
          securityGroupIds: (c.VpcSecurityGroups || []).map((s) => s.VpcSecurityGroupId!).filter(Boolean),
          // Aurora writer/reader 共享集群 SG；VPC 经子网组（此处尽力，详情 L1 探 VPC 时补）。
          endpointModel: "in-vpc",
          discoverable: true,
          notes: [`Aurora ${t.role || "writer"} 端点；writer/reader 共享集群 SG`],
        };
      } catch (e) {
        note(ctx, "rds:DescribeDBClusters", e);
        return { ...base, port, discoverable: false };
      }
    }
    case "redshift": {
      const port = t.port || TARGET_DEFAULT_PORT.redshift;
      if (t.flavor === "provisioned") {
        try {
          const { Clusters = [] } = await (await regionalClient("redshift", ctx.region)).send(new DescribeClustersCommand({ ClusterIdentifier: t.identifier }));
          const c = Clusters[0];
          if (!c) return { ...base, port, discoverable: false, notes: ["未发现该 Redshift 集群"] };
          return {
            ...base,
            vpcId: c.VpcId,
            port: c.Endpoint?.Port || port,
            securityGroupIds: (c.VpcSecurityGroups || []).map((s) => s.VpcSecurityGroupId!).filter(Boolean),
            endpointModel: c.PubliclyAccessible ? "managed-public" : "in-vpc",
            discoverable: true,
          };
        } catch (e) {
          note(ctx, "redshift:DescribeClusters", e);
          return { ...base, port, discoverable: false };
        }
      }
      // serverless：托管 VPC，不暴露 ENI 放置；连通性走 Data API / Zero-ETL，无需子网/SG 选择。
      try {
        const { workgroup } = await (await regionalClient("redshiftServerless", ctx.region)).send(new GetWorkgroupCommand({ workgroupName: t.identifier }));
        return {
          ...base,
          vpcId: undefined,
          port: workgroup?.endpoint?.port || port,
          endpointModel: "managed-vpc",
          discoverable: true,
          notes: ["Redshift Serverless：AWS 托管网络，无需选择子网/SG；连通走 Data API / Zero-ETL"],
        };
      } catch (e) {
        note(ctx, "redshift-serverless:GetWorkgroup", e);
        return { ...base, port, endpointModel: "managed-vpc", discoverable: true, notes: ["Redshift Serverless（托管网络）"] };
      }
    }
    case "aws-service": {
      const r = resolveAwsService(t.service);
      return { ...base, ...r };
    }
    case "msk": {
      const portByAuth: Record<string, number> = { iam: 9098, "sasl-scram": 9096, tls: 9094, plaintext: 9092 };
      const port = portByAuth[t.auth || "iam"] || TARGET_DEFAULT_PORT.msk;
      // 无 client-kafka 依赖 → Phase 1 不深探 broker SG；标 in-vpc 需用户/后续补 SG。
      return { ...base, port, endpointModel: "in-vpc", discoverable: false, notes: [`MSK（${t.auth || "iam"} 认证，端口 ${port}）；broker SG 需用户确认或后续补探`] };
    }
    case "opensearch": {
      const port = t.port || TARGET_DEFAULT_PORT.opensearch;
      return { ...base, port, endpointModel: "in-vpc", discoverable: false, notes: ["OpenSearch in-VPC 域（:443）；域 SG 需用户确认或后续补探"] };
    }
    case "host": {
      // 自建 EC2/本地，按 host/IP——无法可靠反查 SG（除非同 VPC ENI），标 unknown 交 L2。
      return { ...base, port: t.port, endpointModel: "unknown", discoverable: false, notes: ["按主机/IP 指定：无法自动反查目标 SG/VPC，需用户提供或经 Reachability 验证"] };
    }
    case "external": {
      return { ...base, port: t.port, endpointModel: "internet", discoverable: false, notes: [`外部 SaaS（${t.vendor || "other"}）：需出网（NAT/PrivateLink）`] };
    }
  }
}

export async function resolveTargets(targets: Target[], ctx: ResolveCtx): Promise<ResolvedTarget[]> {
  return Promise.all(targets.map((t) => resolveOne(t, ctx)));
}
