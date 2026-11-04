// Kinesis provider(流范式 stream)。
//
// 【为什么】实时计算(Flink)要支持多数据源、两层选择、按需新建源。Kinesis 是流范式首个 provider,
// 把此前散落在 realtime-compute/page.tsx 的硬编码 kinesis 源接线收编到 SPI(与 mysql-cdc 走 datasourceId 同构)。
// 见 DESIGN.md §10.3。MSK(§6.4)是同范式姊妹,收编底座就位后加它 = registry 加一行。
//
// 连接袋:{streamName, region}。凭证=iam-role(用 FlinkRole/平台角色,无需存密钥 → 无 secret)。
// 只做【读能力】(introspect/ping/buildConnection);provision(新建流)。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  KinesisClient,
  DescribeStreamSummaryCommand,
  ListShardsCommand,
  CreateStreamCommand,
  AddTagsToStreamCommand,
} from "@aws-sdk/client-kinesis";
import type { SourceRef, DataSourceProvider } from "../spi";
import type {
  ConnectionModel,
  SourceDataset,
  TestResult,
  PingResult,
  DataSourceCapabilities,
} from "../types";

// L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
const REGION = homeRegion();

const capabilities: DataSourceCapabilities = {
  paradigm: "stream",
  credentialKind: "iam-role", // 用平台/Flink 角色访问,无需存密钥
  isVpcBound: false, // Kinesis 是 AWS 托管服务(不像 JDBC/MSK 要子网/SG)
  canIntrospect: true, // DescribeStreamSummary + ListShards
  canPing: true, // DescribeStreamSummary 轻量探活
  supportsCdc: false, // 流本身即增量语义,无「全量 vs 增量」之分
  needsGlueConnection: false, // 不走 Glue Connection
  syncChannels: ["flink-cdc"], // Flink 消费 → S3Tables/Redshift(复用实时计算底座)
  analysisChannels: [], // 流不被查询引擎直查(需先落地)
  canProvision: true, // 🔴 可按需新建流(实现 provision);UI 第二层显示「➕ 新建流」
  icon: "🌊",
  label: "Kinesis 流",
};

// 从 SourceRef 解出 {streamName, region}(连接袋归一后)。
function resolveStream(ref: SourceRef): { streamName: string; region: string } | null {
  const c = ref.connection || {};
  const streamName = (c.streamName || c.name || "").toString().trim();
  if (!streamName) return null;
  return { streamName, region: (c.region || REGION).toString() };
}

export const kinesisProvider: DataSourceProvider = {
  type: "kinesis",
  capabilities,

  // 建源表单校验:流名必填 + 合法字符(Kinesis 流名 [a-zA-Z0-9_.-],≤128)。
  validateConfig(conn: Record<string, any>) {
    const errors: string[] = [];
    const streamName = (conn.streamName || "").toString().trim();
    if (!streamName) errors.push("缺少流名称(streamName)");
    else if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(streamName)) errors.push("流名称含非法字符(仅允许 字母/数字/_.-,≤128)");
    return { ok: errors.length === 0, errors };
  },

  // 连接模型:流范式产出 streamArn(供 Flink SQL 注入 'stream.arn')。
  buildConnection(ref: SourceRef): ConnectionModel {
    const s = resolveStream(ref);
    const region = s?.region || REGION;
    const acct = process.env.AWS_ACCOUNT_ID || "";
    // ARN 可确定性派生(不硬编码账号:从 env 取;缺 env 时留空,由上层解析)。
    const streamArn = s && acct ? `arn:aws:kinesis:${region}:${acct}:stream/${s.streamName}` : "";
    return {
      paradigm: "stream",
      props: {
        ...(s ? { streamName: s.streamName } : {}),
        region,
        ...(streamArn ? { streamArn } : {}),
      },
    };
  },

  // 真连通性测试:DescribeStreamSummary 拿到流状态 = 可达且有权限。
  async testConnection(ref: SourceRef): Promise<TestResult> {
    const start = Date.now();
    const steps: TestResult["steps"] = [];
    const s = resolveStream(ref);
    if (!s) {
      steps.push({ name: "resolve", status: "fail", message: "连接信息不完整(缺 streamName)" });
      return { success: false, steps, totalMs: Date.now() - start };
    }
    steps.push({ name: "config_check", status: "pass", message: `Kinesis: ${s.streamName} @ ${s.region}` });
    const client = sdkClient("data-plane", KinesisClient, { region: s.region });
    try {
      const r = await client.send(new DescribeStreamSummaryCommand({ StreamName: s.streamName }));
      const status = r.StreamDescriptionSummary?.StreamStatus;
      steps.push({ name: "connectivity", status: "pass", message: `流状态: ${status} (${Date.now() - start}ms)`, latencyMs: Date.now() - start });
    } catch (e: any) {
      steps.push({ name: "connectivity", status: "fail", message: String(e?.name || e?.message || e).slice(0, 200) });
    } finally {
      client.destroy();
    }
    return { success: steps.every((st) => st.status !== "fail"), steps, totalMs: Date.now() - start };
  },

  // 轻量探活:DescribeStreamSummary(流是否 ACTIVE)。
  async ping(ref: SourceRef): Promise<PingResult> {
    const s = resolveStream(ref);
    if (!s) return { reachable: false, error: "连接信息不完整(缺 streamName)" };
    const started = Date.now();
    const client = sdkClient("data-plane", KinesisClient, { region: s.region });
    try {
      const r = await client.send(new DescribeStreamSummaryCommand({ StreamName: s.streamName }));
      const active = r.StreamDescriptionSummary?.StreamStatus === "ACTIVE";
      return { reachable: active, latencyMs: Date.now() - started, ...(active ? {} : { error: `流状态: ${r.StreamDescriptionSummary?.StreamStatus}` }) };
    } catch (e: any) {
      return { reachable: false, latencyMs: Date.now() - started, error: String(e?.name || e?.message || e).slice(0, 200) };
    } finally {
      client.destroy();
    }
  },

  // introspect:流的「数据集」= 流本身(一个 stream),meta 带 shard 数/保留期(供 UI/并行度顾问参考)。
  //  与 JDBC 列表返回多个表不同,Kinesis 一个数据源即一条流 → 返回单元素数组(容错返 [])。
  async introspect(ref: SourceRef): Promise<SourceDataset[]> {
    const s = resolveStream(ref);
    if (!s) return [];
    const client = sdkClient("data-plane", KinesisClient, { region: s.region });
    try {
      const summary = await client.send(new DescribeStreamSummaryCommand({ StreamName: s.streamName }));
      const d = summary.StreamDescriptionSummary;
      // shard 数:优先 summary 的 OpenShardCount;缺失则 ListShards 计数(容错)。
      let shardCount = d?.OpenShardCount;
      if (shardCount === undefined) {
        try {
          const shards = await client.send(new ListShardsCommand({ StreamName: s.streamName }));
          shardCount = (shards.Shards || []).length;
        } catch { /* best-effort */ }
      }
      return [{
        name: s.streamName,
        kind: "stream",
        columns: [], // 流消息无固定 schema(不采样;后续可 GetRecords 采样推断)
        meta: {
          shardCount,
          retentionHours: d?.RetentionPeriodHours,
          status: d?.StreamStatus,
          encryption: d?.EncryptionType,
        },
      }];
    } catch {
      return []; // 不可达/无权限:上层仍可注册源(与 JDBC introspect 容错一致)
    } finally {
      client.destroy();
    }
  },

  // 【写语义】按需新建 Kinesis 流(幂等)。见 DESIGN §10.4。
  //  🔴 幂等:流已存在(ResourceInUseException)视为成功,直接返回其连接袋——支持"新建但恰好同名已存在"。
  //  🔴 必须由用户在页面显式确认(含成本告知)后,经建源 API 调用;不在此层做确认(纯函数职责)。
  //  建流后轮询等 ACTIVE(CreateStream 是异步的,刚建时 CREATING,直接用会连不上)。
  async provision(input: Record<string, any>): Promise<{ connection: Record<string, any>; note?: string }> {
    const streamName = (input.streamName || "").toString().trim();
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(streamName)) {
      throw new Error(`流名称非法(仅允许 字母/数字/_.-,≤128): ${streamName || "(空)"}`);
    }
    const region = (input.region || REGION).toString();
    const shardCount = Math.max(1, Math.min(Number(input.shardCount) || 1, 10)); // 默认 1;上限 10 防误建大流
    const client = sdkClient("data-plane", KinesisClient, { region });
    let created = false;
    try {
      try {
        // 用 PROVISIONED 模式显式指定 shard 数(ON_DEMAND 无 shard 概念、按量计费更贵,平台默认 PROVISIONED 1 shard)。
        await client.send(new CreateStreamCommand({ StreamName: streamName, ShardCount: shardCount }));
        created = true;
      } catch (e: any) {
        // 幂等:已存在同名流 → 视为成功(不报错,直接复用)。其余错误(权限/配额)冒泡。
        if (e?.name !== "ResourceInUseException") throw e;
      }
      // 轮询等 ACTIVE(新建的流 CREATING→ACTIVE 通常数十秒;已存在的流首轮即 ACTIVE)。
      let status = "";
      for (let i = 0; i < 40; i++) {
        try {
          const r = await client.send(new DescribeStreamSummaryCommand({ StreamName: streamName }));
          status = r.StreamDescriptionSummary?.StreamStatus || "";
          if (status === "ACTIVE") break;
        } catch { /* CREATING 初期可能短暂查不到,继续等 */ }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (status !== "ACTIVE") throw new Error(`流 ${streamName} 建后未在预期时间内变为 ACTIVE(当前: ${status || "未知"})`);
      // 打平台标签(可追溯来源;失败不阻断——标签非关键)。
      if (created) {
        try {
          await client.send(new AddTagsToStreamCommand({ StreamName: streamName, Tags: { ManagedBy: "bgp-platform", Source: "datasource-provision" } }));
        } catch { /* best-effort */ }
      }
      return {
        connection: { streamName, region },
        note: created ? `已新建 Kinesis 流 ${streamName}(${shardCount} shard)并就绪` : `流 ${streamName} 已存在,直接复用`,
      };
    } finally {
      client.destroy();
    }
  },

  // iam-role 凭证:无密钥可存 → 不实现 buildSecretPayload(返回 undefined,建源不建 secret)。
};
