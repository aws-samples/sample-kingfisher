// MSK / Kafka provider(流范式 stream)。
//
// 【为什么】实时计算(Flink)要支持多数据源。MSK 是流范式第二个 provider,与 Kinesis 同范式(stream)
// 但能力标相反的三处全数据驱动:isVpcBound=true(broker 在私有 VPC)、canProvision=false(不代劳建集群,
// 重运维决策)、credentialKind 双形态(IAM 无密钥 / SASL-SCRAM 存密钥)。见 DESIGN.md §11。
//
// 一个 provider 两 flavor:
//  · mskFlavor="msk"  托管:选集群(clusterArn)→ GetBootstrapBrokers 自动拿 broker(按 auth 取对应端口串)。
//  · mskFlavor="self" 自建:用户手填 bootstrapServers(生产场景,用户自己的 Kafka)。
// 两种认证:iam(仅 MSK 托管,端口 9098,无密钥)/ scram(SASL/SCRAM-SHA-512,端口 9096,账密存 secret)。
//
// 连接袋:{ mskFlavor, clusterArn?, bootstrapServers?, auth:"iam"|"scram", region }。
// 只做【读能力】(introspect/ping/testConnection/buildConnection);无 provision(不建集群)。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  KafkaClient,
  DescribeClusterV2Command,
  GetBootstrapBrokersCommand,
} from "@aws-sdk/client-kafka";
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

// MSK 认证 → 端口 + Kafka 客户端属性(security.protocol / sasl.mechanism)。数据驱动,勿散落。
const AUTH_PORT: Record<string, number> = { iam: 9098, scram: 9096, tls: 9094, plaintext: 9092 };

const capabilities: DataSourceCapabilities = {
  paradigm: "stream",
  // 🔴 静态标取「最宽超集」:MSK 一个 provider 支持 iam(无密钥)与 scram(有密钥)两认证,而 capabilities
  //    是静态的、无法随连接袋变。故固定标 sasl-scram(可能需密钥),建源 API 按连接袋 auth 决定是否真建
  //    secret(iam→跳过)。见 DESIGN §11.2/§11.6。
  credentialKind: "sasl-scram",
  isVpcBound: true, // broker 在私有 VPC(9098/9096)——与 Kinesis(AWS 公网 API)相反
  canIntrospect: true, // DescribeClusterV2 拿集群状态;topic 列举在 VPC 外降级手填(见 introspect)
  canPing: true, // 托管:DescribeClusterV2 轻量探活;自建:仅校验 bootstrap 格式
  supportsCdc: false, // 流本身即增量语义
  needsGlueConnection: false, // 不走 Glue Connection(Flink 直连消费)
  canProvision: false, // 🔴 不代劳建集群(重运维决策,20-30 分钟+常驻高计费)。UI 第二层无「➕ 新建」
  syncChannels: ["flink-cdc"], // Flink 消费 Kafka → S3Tables/Redshift(复用实时计算底座)
  analysisChannels: [], // 流不被查询引擎直查
  icon: "📨",
  label: "MSK / Kafka",
};

interface MskConn {
  mskFlavor: "msk" | "self";
  clusterArn?: string;
  bootstrapServers?: string;
  auth: "iam" | "scram";
  region: string;
}

// 从 SourceRef 解出规整的 MSK 连接信息(连接袋归一后)。缺关键字段返回 null。
function resolveMsk(ref: SourceRef): MskConn | null {
  const c = ref.connection || {};
  const flavor = c.mskFlavor === "self" ? "self" : c.mskFlavor === "msk" ? "msk" : null;
  if (!flavor) return null;
  const auth = c.auth === "scram" ? "scram" : c.auth === "iam" ? "iam" : null;
  if (!auth) return null;
  const region = (c.region || REGION).toString();
  const clusterArn = (c.clusterArn || "").toString().trim() || undefined;
  const bootstrapServers = (c.bootstrapServers || "").toString().trim() || undefined;
  // 托管必有 clusterArn;自建必有 bootstrapServers。
  if (flavor === "msk" && !clusterArn) return null;
  if (flavor === "self" && !bootstrapServers) return null;
  // 自建 flavor 不支持 iam(IAM 认证是 MSK 专属)。
  if (flavor === "self" && auth === "iam") return null;
  return { mskFlavor: flavor, clusterArn, bootstrapServers, auth, region };
}

// bootstrapServers 格式校验:逗号分隔的 host:port(≥1 个)。防把整段乱填进去。
function isValidBootstrap(s: string): boolean {
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => /^[A-Za-z0-9._-]+:\d{1,5}$/.test(p));
}

// 托管 flavor:按 auth 从 GetBootstrapBrokers 响应取对应端口的 broker 串(SaslIam/SaslScram)。
function pickBootstrapByAuth(resp: any, auth: string): string | undefined {
  if (auth === "iam") return resp?.BootstrapBrokerStringSaslIam || undefined;
  if (auth === "scram") return resp?.BootstrapBrokerStringSaslScram || undefined;
  if (auth === "tls") return resp?.BootstrapBrokerStringTls || undefined;
  return resp?.BootstrapBrokerString || undefined;
}

export const mskProvider: DataSourceProvider = {
  type: "msk",
  capabilities,

  // 建源表单校验:两 flavor 各自必填 + auth 合法 + bootstrap 格式。
  validateConfig(conn: Record<string, any>) {
    const errors: string[] = [];
    const flavor = conn.mskFlavor;
    if (flavor !== "msk" && flavor !== "self") {
      errors.push("缺少连接方式(mskFlavor:msk 托管 / self 自建)");
    }
    const auth = conn.auth;
    if (auth !== "iam" && auth !== "scram") {
      errors.push("认证方式非法(仅支持 iam / scram)");
    }
    if (flavor === "msk" && !(conn.clusterArn || "").toString().trim()) {
      errors.push("MSK 托管需选择集群(clusterArn)");
    }
    if (flavor === "self") {
      const bs = (conn.bootstrapServers || "").toString().trim();
      if (!bs) errors.push("自建 Kafka 需填写 bootstrap.servers");
      else if (!isValidBootstrap(bs)) errors.push("bootstrap.servers 格式非法(应为逗号分隔的 host:port)");
      if (auth === "iam") errors.push("IAM 认证仅支持 MSK 托管集群(自建 Kafka 请用 scram)");
    }
    // scram 认证必须带账密(供建源 API 建 secret)——iam 无需。
    if (auth === "scram" && (!(conn.username || "").toString().trim() || !(conn.password || "").toString())) {
      errors.push("SASL/SCRAM 认证需填写用户名和密码");
    }
    return { ok: errors.length === 0, errors };
  },

  // 连接模型:流范式产出 bootstrapServers + 认证属性(供 Flink SQL 注入 ${KAFKA_AUTH_PROPS})。
  //  托管 flavor 的 bootstrap 由启动时 GetBootstrapBrokers 动态拿(此处只带 clusterArn),故 props 可能无 bootstrap。
  buildConnection(ref: SourceRef): ConnectionModel {
    const m = resolveMsk(ref);
    const region = m?.region || REGION;
    return {
      paradigm: "stream",
      ...(m?.bootstrapServers ? { bootstrapServers: m.bootstrapServers } : {}),
      props: {
        region,
        ...(m ? { mskFlavor: m.mskFlavor, auth: m.auth, port: String(AUTH_PORT[m.auth] || 9098) } : {}),
        ...(m?.clusterArn ? { clusterArn: m.clusterArn } : {}),
      },
    };
  },

  // 真连通性测试:
  //  托管 → DescribeClusterV2 拿集群状态(可达+有权限即通过);
  //  自建 → 校验 bootstrap 格式(平台后端在 VPC 外连不到 broker,不做 TCP 探测,诚实标注)。
  async testConnection(ref: SourceRef): Promise<TestResult> {
    const start = Date.now();
    const steps: TestResult["steps"] = [];
    const m = resolveMsk(ref);
    if (!m) {
      steps.push({ name: "resolve", status: "fail", message: "连接信息不完整或非法(检查 flavor/auth/集群或 bootstrap)" });
      return { success: false, steps, totalMs: Date.now() - start };
    }
    steps.push({ name: "config_check", status: "pass", message: `MSK ${m.mskFlavor}/${m.auth} @ ${m.region}` });
    if (m.mskFlavor === "self") {
      // 自建:不做 broker TCP 探测(VPC 外不可达),仅确认 bootstrap 已配。可达性在作业 VPC 内由 Flink 真连时验证。
      steps.push({ name: "connectivity", status: "skip", message: "自建 Kafka:broker 在私有网络,可达性由作业 VPC 内 Flink 消费时验证" });
      return { success: true, steps, totalMs: Date.now() - start };
    }
    // 托管:DescribeClusterV2 拿状态。
    const client = sdkClient("data-plane", KafkaClient, { region: m.region });
    try {
      const r = await client.send(new DescribeClusterV2Command({ ClusterArn: m.clusterArn }));
      const state = r.ClusterInfo?.State;
      const ok = state === "ACTIVE";
      steps.push({
        name: "connectivity",
        status: ok ? "pass" : "fail",
        message: `集群状态: ${state} (${Date.now() - start}ms)`,
        latencyMs: Date.now() - start,
      });
    } catch (e: any) {
      steps.push({ name: "connectivity", status: "fail", message: String(e?.name || e?.message || e).slice(0, 200) });
    } finally {
      client.destroy();
    }
    return { success: steps.every((st) => st.status !== "fail"), steps, totalMs: Date.now() - start };
  },

  // 轻量探活:托管=DescribeClusterV2(集群是否 ACTIVE);自建=仅确认 bootstrap 已配(不做网络探测,返回 null 不改状态)。
  async ping(ref: SourceRef): Promise<PingResult> {
    const m = resolveMsk(ref);
    if (!m) return { reachable: false, error: "连接信息不完整或非法" };
    if (m.mskFlavor === "self") return { reachable: null }; // VPC 外无法探活自建 broker,不改状态
    const started = Date.now();
    const client = sdkClient("data-plane", KafkaClient, { region: m.region });
    try {
      const r = await client.send(new DescribeClusterV2Command({ ClusterArn: m.clusterArn }));
      const active = r.ClusterInfo?.State === "ACTIVE";
      return { reachable: active, latencyMs: Date.now() - started, ...(active ? {} : { error: `集群状态: ${r.ClusterInfo?.State}` }) };
    } catch (e: any) {
      return { reachable: false, latencyMs: Date.now() - started, error: String(e?.name || e?.message || e).slice(0, 200) };
    } finally {
      client.destroy();
    }
  },

  // introspect:【诚实降级】平台后端在 VPC 外连不到 broker → 无法 ListTopics(AdminClient 需网络可达)。
  //  故不假装能自动列 topic;返回集群级"数据集"(kind:"topic",name=集群标识),meta 带 bootstrap/状态,
  //  真正的 topic 由建作业时用户手填(混合模式 ${KAFKA_TOPIC})。见 DESIGN §11.6。
  async introspect(ref: SourceRef): Promise<SourceDataset[]> {
    const m = resolveMsk(ref);
    if (!m) return [];
    // 自建:无从查询,返回占位数据集(提示手填 topic)。
    if (m.mskFlavor === "self") {
      return [{
        name: m.bootstrapServers || "self-kafka",
        kind: "topic",
        columns: [],
        meta: { mskFlavor: "self", auth: m.auth, bootstrapServers: m.bootstrapServers, note: "topic 建作业时手填(VPC 外无法列举)" },
      }];
    }
    // 托管:DescribeClusterV2 拿状态 + GetBootstrapBrokers 拿 broker(best-effort)。
    const client = sdkClient("data-plane", KafkaClient, { region: m.region });
    try {
      const info = await client.send(new DescribeClusterV2Command({ ClusterArn: m.clusterArn }));
      let bootstrap: string | undefined;
      try {
        const bb = await client.send(new GetBootstrapBrokersCommand({ ClusterArn: m.clusterArn }));
        bootstrap = pickBootstrapByAuth(bb, m.auth);
      } catch { /* best-effort:无权限/未就绪时略过 */ }
      const ci = info.ClusterInfo;
      const clusterName = ci?.ClusterName || (m.clusterArn || "").split("/")[1] || "msk-cluster";
      return [{
        name: clusterName,
        kind: "topic",
        columns: [], // topic 消息无固定 schema(不采样);topic 名由用户手填
        meta: {
          mskFlavor: "msk",
          auth: m.auth,
          state: ci?.State,
          clusterArn: m.clusterArn,
          ...(bootstrap ? { bootstrapServers: bootstrap } : {}),
          note: "topic 建作业时手填/可选(VPC 外无法列举 topic)",
        },
      }];
    } catch {
      return []; // 不可达/无权限:上层仍可注册源(与 JDBC introspect 容错一致)
    } finally {
      client.destroy();
    }
  },

  // scram 认证:账密 → secret 字符串(JSON {username,password},与 JDBC 同形态)。iam:无密钥 → 返回 undefined。
  //  建源 API 按连接袋 auth 决定是否调用本方法(iam 跳过)。
  buildSecretPayload(input: Record<string, any>): string | undefined {
    if (input?.auth !== "scram") return undefined;
    const username = (input.username || "").toString();
    const password = (input.password || "").toString();
    if (!username || !password) return undefined;
    return JSON.stringify({ username, password });
  },

  // 无 provision(canProvision=false):不建集群。UI 第二层不显示「➕ 新建」。
};
