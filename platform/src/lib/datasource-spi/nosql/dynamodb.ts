// DynamoDB provider(NoSQL 范式 nosql)。
//
// 【为什么】数据源 SPI 的第一个 NoSQL 范式 provider。DynamoDB 无固定 schema(每个 item 属性可不同),
// 与 JDBC(INFORMATION_SCHEMA 有确定列)、stream(无 schema)都不同 → introspect 靠 DescribeTable 拿
// 键 schema(pk/sk/GSI 确定有) + Scan 采样一批 item 求属性并集来「推断」列。见 DESIGN.md §6.3。
//
// 连接袋:{tableName, region}。凭证=iam-role(用平台 TaskRole / Glue role,无需存密钥 → 无 secret,
//   与 stream/kinesis 同构)。canProvision=false(库表是用户既有的,平台不建表,与 JDBC 一致)。
//
// 天然通道:syncChannels=["glue"](Glue DynamoDB 连接器批读入湖仓 → Redshift/S3Tables);
//   analysisChannels=[](一期不直查;DDB→Athena/Redshift federated 需额外 connector 配置,二期)。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  DynamoDBClient,
  DescribeTableCommand,
  ScanCommand,
  type AttributeValue,
  type KeySchemaElement,
  type AttributeDefinition,
} from "@aws-sdk/client-dynamodb";
import type { SourceRef, DataSourceProvider } from "../spi";
import type {
  ConnectionModel,
  SourceColumn,
  SourceDataset,
  TestResult,
  PingResult,
  DataSourceCapabilities,
} from "../types";

// L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
const REGION = homeRegion();

// introspect 采样条数:DDB 无固定 schema,Scan 一批 item 求属性并集推断列。
// 取 50 足以覆盖常见业务表的属性集,又不至于 Scan 太多消耗读容量(且 Limit 只算被检视的 item 数)。
const SAMPLE_LIMIT = 50;

const capabilities: DataSourceCapabilities = {
  paradigm: "nosql",
  credentialKind: "iam-role", // 用平台/Glue 角色访问,无需存密钥(与 Kinesis 同)
  isVpcBound: false, // DynamoDB 是 AWS 托管服务(不像 JDBC/MSK 要子网/SG)
  canIntrospect: true, // DescribeTable(键 schema) + Scan 采样(属性并集)
  canPing: true, // DescribeTable 轻量探活(表存在且 ACTIVE)
  supportsCdc: false, // 一期批读;DDB Streams 增量为二期
  needsGlueConnection: false, // 不走 Glue Connection(IAM 直连)
  canProvision: false, // 平台不代劳建表(库表是用户既有的,与 JDBC 一致)
  syncChannels: ["glue"], // Glue DynamoDB 连接器批读 → S3Tables/Redshift
  analysisChannels: [], // 一期不直查(federated 二期)
  icon: "🔑",
  label: "DynamoDB",
};

// 从 SourceRef 解出 {tableName, region}(连接袋归一后)。
function resolveTable(ref: SourceRef): { tableName: string; region: string } | null {
  const c = ref.connection || {};
  const tableName = (c.tableName || c.table || c.name || "").toString().trim();
  if (!tableName) return null;
  return { tableName, region: (c.region || REGION).toString() };
}

// DynamoDB 属性值(AttributeValue)→ 可读类型标签。DDB item 的每个属性是 {S|N|B|BOOL|L|M|SS|NS|BS|NULL:...}。
// 取其唯一的 key 作为类型(与 Glue/Athena 对 DDB 的类型呈现一致:string/number/binary/boolean/list/map/…)。
const DDB_TYPE_LABEL: Record<string, string> = {
  S: "string",
  N: "number",
  B: "binary",
  BOOL: "boolean",
  L: "list",
  M: "map",
  SS: "string-set",
  NS: "number-set",
  BS: "binary-set",
  NULL: "null",
};
function attrType(v: AttributeValue | undefined): string {
  if (!v || typeof v !== "object") return "unknown";
  const k = Object.keys(v)[0];
  return DDB_TYPE_LABEL[k] || k || "unknown";
}

// DescribeTable 的键 schema(HASH/RANGE)→ 列的 key 标记("PK"/"SK"),供 introspect 标注主键。
// 也收集 GSI/LSI 涉及的键属性名(建索引的属性一定在 item 里,采样漏掉也能补上)。
function keyInfo(
  keySchema: KeySchemaElement[] | undefined,
  attrDefs: AttributeDefinition[] | undefined,
): { keyRole: Record<string, string>; keyTypes: Record<string, string> } {
  const keyRole: Record<string, string> = {};
  for (const k of keySchema || []) {
    if (k.AttributeName) keyRole[k.AttributeName] = k.KeyType === "HASH" ? "PK" : k.KeyType === "RANGE" ? "SK" : "";
  }
  // 属性定义里带了键属性的标量类型(S/N/B),用于给键列一个确定类型(采样可能未覆盖)。
  const keyTypes: Record<string, string> = {};
  for (const d of attrDefs || []) {
    if (d.AttributeName && d.AttributeType) keyTypes[d.AttributeName] = DDB_TYPE_LABEL[d.AttributeType] || d.AttributeType;
  }
  return { keyRole, keyTypes };
}

export const dynamodbProvider: DataSourceProvider = {
  type: "dynamodb",
  capabilities,

  // 建源表单校验:表名必填 + 合法字符(DynamoDB 表名 [a-zA-Z0-9_.-],3~255)。
  validateConfig(conn: Record<string, any>) {
    const errors: string[] = [];
    const tableName = (conn.tableName || "").toString().trim();
    if (!tableName) errors.push("缺少表名(tableName)");
    else if (!/^[a-zA-Z0-9_.-]{3,255}$/.test(tableName)) errors.push("表名含非法字符(仅允许 字母/数字/_.-,长度 3~255)");
    return { ok: errors.length === 0, errors };
  },

  // 连接模型:NoSQL 范式产出 tableArn(供 Glue DynamoDB 连接器/同步脚本用)。
  buildConnection(ref: SourceRef): ConnectionModel {
    const t = resolveTable(ref);
    const region = t?.region || REGION;
    const acct = process.env.AWS_ACCOUNT_ID || "";
    // ARN 可确定性派生(不硬编码账号:从 env 取;缺 env 时留空,由上层解析)。
    const tableArn = t && acct ? `arn:aws:dynamodb:${region}:${acct}:table/${t.tableName}` : "";
    return {
      paradigm: "nosql",
      ...(tableArn ? { tableArn } : {}),
      props: {
        ...(t ? { tableName: t.tableName } : {}),
        region,
        ...(tableArn ? { tableArn } : {}),
      },
    };
  },

  // 真连通性测试:DescribeTable 拿到表状态 = 可达且有权限。
  async testConnection(ref: SourceRef): Promise<TestResult> {
    const start = Date.now();
    const steps: TestResult["steps"] = [];
    const t = resolveTable(ref);
    if (!t) {
      steps.push({ name: "resolve", status: "fail", message: "连接信息不完整(缺 tableName)" });
      return { success: false, steps, totalMs: Date.now() - start };
    }
    steps.push({ name: "config_check", status: "pass", message: `DynamoDB: ${t.tableName} @ ${t.region}` });
    const client = sdkClient("data-plane", DynamoDBClient, { region: t.region });
    try {
      const r = await client.send(new DescribeTableCommand({ TableName: t.tableName }));
      const status = r.Table?.TableStatus;
      const items = r.Table?.ItemCount;
      steps.push({
        name: "connectivity",
        status: status === "ACTIVE" ? "pass" : "fail",
        message: status === "ACTIVE" ? `表状态: ACTIVE (约 ${items ?? "?"} 项, ${Date.now() - start}ms)` : `表状态: ${status}`,
        latencyMs: Date.now() - start,
      });
    } catch (e: any) {
      steps.push({ name: "connectivity", status: "fail", message: String(e?.name || e?.message || e).slice(0, 200) });
    } finally {
      client.destroy();
    }
    return { success: steps.every((st) => st.status !== "fail"), steps, totalMs: Date.now() - start };
  },

  // 轻量探活:DescribeTable(表是否 ACTIVE)。
  async ping(ref: SourceRef): Promise<PingResult> {
    const t = resolveTable(ref);
    if (!t) return { reachable: false, error: "连接信息不完整(缺 tableName)" };
    const started = Date.now();
    const client = sdkClient("data-plane", DynamoDBClient, { region: t.region });
    try {
      const r = await client.send(new DescribeTableCommand({ TableName: t.tableName }));
      const active = r.Table?.TableStatus === "ACTIVE";
      return { reachable: active, latencyMs: Date.now() - started, ...(active ? {} : { error: `表状态: ${r.Table?.TableStatus}` }) };
    } catch (e: any) {
      return { reachable: false, latencyMs: Date.now() - started, error: String(e?.name || e?.message || e).slice(0, 200) };
    } finally {
      client.destroy();
    }
  },

  // introspect:DDB 的「数据集」= 这张表本身(单元素数组,与 Kinesis 一源一数据集同构)。
  //  列 = DescribeTable 键 schema(pk/sk 确定有) ∪ Scan 采样 SAMPLE_LIMIT 个 item 的属性并集(推断)。
  //  DDB 无固定 schema:不同 item 属性可不同,故「列」是采样并集的最佳努力推断(meta 标 sampled=true)。
  async introspect(ref: SourceRef): Promise<SourceDataset[]> {
    const t = resolveTable(ref);
    if (!t) return [];
    const client = sdkClient("data-plane", DynamoDBClient, { region: t.region });
    try {
      // 1) DescribeTable:拿键 schema(HASH/RANGE) + 属性定义(键属性的标量类型) + GSI。
      const desc = await client.send(new DescribeTableCommand({ TableName: t.tableName }));
      const table = desc.Table;
      const { keyRole, keyTypes } = keyInfo(table?.KeySchema, table?.AttributeDefinitions);

      // 2) Scan Limit=N 采样:求所有 item 的属性并集,推断每个属性的类型(取采样中首次出现的类型)。
      //    ConsistentRead=false(默认,省容量);只读,不写。容错:Scan 失败仍返回键列(introspect 不因采样失败而空)。
      const seen: Record<string, string> = {}; // 属性名 → 类型标签
      try {
        const scan = await client.send(new ScanCommand({ TableName: t.tableName, Limit: SAMPLE_LIMIT }));
        for (const item of scan.Items || []) {
          for (const [attr, val] of Object.entries(item)) {
            if (!(attr in seen)) seen[attr] = attrType(val as AttributeValue);
          }
        }
      } catch {
        /* 采样失败(如无 Scan 权限):降级为只返回键列,不阻断 introspect */
      }

      // 3) 合并键列(一定有,类型取属性定义) + 采样列;键列排前、标 PK/SK。
      const colMap = new Map<string, SourceColumn>();
      // 先放键列(确定存在,顺序 PK→SK)
      for (const [name, role] of Object.entries(keyRole)) {
        colMap.set(name, { name, type: keyTypes[name] || seen[name] || "string", key: role, nullable: false });
      }
      // 再放采样发现的非键属性
      for (const [name, type] of Object.entries(seen)) {
        if (!colMap.has(name)) colMap.set(name, { name, type, nullable: true });
      }

      // 键列排前(PK,SK),其余按采样顺序。
      const columns = Array.from(colMap.values()).sort((a, b) => {
        const rank = (c: SourceColumn) => (c.key === "PK" ? 0 : c.key === "SK" ? 1 : 2);
        return rank(a) - rank(b);
      });

      return [{
        name: t.tableName,
        kind: "table",
        columns,
        meta: {
          sampled: true, // 🔴 列由采样并集推断(DDB 无固定 schema),非权威 schema
          sampleLimit: SAMPLE_LIMIT,
          itemCount: table?.ItemCount,
          sizeBytes: table?.TableSizeBytes,
          keySchema: (table?.KeySchema || []).map((k) => ({ name: k.AttributeName, type: k.KeyType })),
          gsi: (table?.GlobalSecondaryIndexes || []).map((g) => g.IndexName).filter(Boolean),
          status: table?.TableStatus,
        },
      }];
    } catch {
      return []; // 不可达/无权限:上层仍可注册源(与 JDBC/Kinesis introspect 容错一致)
    } finally {
      client.destroy();
    }
  },

  // iam-role 凭证:无密钥可存 → 不实现 buildSecretPayload(返回 undefined,建源不建 secret)。
};
