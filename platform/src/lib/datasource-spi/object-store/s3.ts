// S3 provider(对象存储范式 object-store)。
//
// 【为什么】数据源 SPI 的第一个对象存储范式 provider。S3 无库无表无端口:一个 bucket + prefix 下是
// 一堆文件(CSV/Parquet/JSON)。introspect 靠 ListObjectsV2 按【一级子前缀】分组成「逻辑数据集」
// (每个子前缀 ≈ 一张 Hive 分区表的根),CSV 再采样文件头推断列名。见 DESIGN.md §6.2。
//
// 连接袋:{bucket, prefix, region, format?:"auto"|"csv"|"parquet"|"json", hasHeader?}。凭证=iam-role
//   (用平台 TaskRole 访问,无需存密钥,与 Kinesis/DynamoDB 同构)。canProvision=false(桶是用户既有的)。
//
// 天然通道:analysisChannels=["athena"](对 s3://bucket/prefix 建 Athena 外部表直查,见 S3 分析通道);
//   syncChannels=["glue"](Glue 读 S3 文件入湖仓)。
//
// 【一期诚实边界】CSV 有表头时能采样推断列名;Parquet/JSON 的精确 schema 在「Athena 建外部表 /
//   Glue crawler」阶段才权威确定,introspect 阶段对它们只识别 format、列留空(kind:"prefix" + meta.format)。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
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

// introspect 列 prefix 下对象的上限(只为分组出「逻辑数据集」+ 找采样文件,不需要拉全量)。
const LIST_MAX = 300;
// CSV 头部采样字节数(足够覆盖表头 + 前几行推断类型,又不拉整个大文件)。
const CSV_SNIFF_BYTES = 16 * 1024;

const capabilities: DataSourceCapabilities = {
  paradigm: "object-store",
  credentialKind: "iam-role", // 用平台角色访问,无需存密钥
  isVpcBound: false, // S3 是 AWS 托管服务
  canIntrospect: true, // ListObjectsV2 分组 + 采样推断
  canPing: true, // HeadBucket 轻量探活
  supportsCdc: false, // 对象存储无 CDC 语义
  needsGlueConnection: false, // 不走 Glue Connection(IAM 直连)
  canProvision: false, // 平台不代劳建桶
  syncChannels: ["glue"], // Glue 读 S3 → 湖仓
  analysisChannels: ["athena"], // 🔴 差异化:建 Athena 外部表直查(复用现有 Athena 底座)
  icon: "🪣",
  label: "S3 对象存储",
};

// 从 SourceRef 解出 {bucket, prefix, region, format, hasHeader}。
function resolveS3(ref: SourceRef): {
  bucket: string;
  prefix: string;
  region: string;
  format: string;
  hasHeader: boolean;
} | null {
  const c = ref.connection || {};
  const bucket = (c.bucket || "").toString().trim();
  if (!bucket) return null;
  // prefix 规范化:去掉前导 /,确保尾部 /(便于 Delimiter 分组);空 prefix = 桶根。
  let prefix = (c.prefix || "").toString().trim().replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return {
    bucket,
    prefix,
    region: (c.region || REGION).toString(),
    format: (c.format || "auto").toString(),
    hasHeader: c.hasHeader === undefined ? true : !!c.hasHeader,
  };
}

// 从对象 key 推断文件格式(format=auto 时用)。
function sniffFormat(key: string): string {
  const k = key.toLowerCase();
  if (k.endsWith(".parquet") || k.endsWith(".parq")) return "parquet";
  if (k.endsWith(".json") || k.endsWith(".jsonl") || k.endsWith(".ndjson")) return "json";
  if (k.endsWith(".csv") || k.endsWith(".tsv") || k.endsWith(".txt")) return "csv";
  return "unknown";
}

// 极轻量 CSV 值类型猜测(仅 introspect 展示用;权威类型由 Athena/Glue 定)。
function guessCsvType(v: string): string {
  const s = (v || "").trim();
  if (s === "") return "string";
  if (/^-?\d+$/.test(s)) return "bigint";
  if (/^-?\d*\.\d+$/.test(s)) return "double";
  if (/^(true|false)$/i.test(s)) return "boolean";
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(s)) return "timestamp";
  return "string";
}

// 从 CSV 头部字节采样推断列(表头行 + 首数据行猜类型)。best-effort,失败返回 []。
function inferCsvColumns(text: string, hasHeader: boolean): SourceColumn[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const split = (line: string) => line.split(","); // 一期只处理标准逗号分隔(引号内逗号少见,权威 schema 走 Athena)
  const headerCells = split(lines[0]);
  const sampleCells = lines.length > 1 ? split(lines[1]) : [];
  return headerCells.map((h, i) => {
    const name = hasHeader ? h.trim().replace(/^["']|["']$/g, "") || `col${i + 1}` : `col${i + 1}`;
    const sampleVal = hasHeader ? sampleCells[i] : headerCells[i]; // 无表头时首行就是数据
    return { name, type: guessCsvType(sampleVal || ""), nullable: true };
  });
}

export const s3Provider: DataSourceProvider = {
  type: "s3",
  capabilities,

  // 建源表单校验:桶名必填 + 合法(S3 桶名 3~63,小写字母/数字/./-)。prefix 可空(=桶根)。
  validateConfig(conn: Record<string, any>) {
    const errors: string[] = [];
    const bucket = (conn.bucket || "").toString().trim();
    if (!bucket) errors.push("缺少桶名(bucket)");
    else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) errors.push("桶名不合法(小写字母/数字/.-,长度 3~63)");
    const fmt = (conn.format || "auto").toString();
    if (!["auto", "csv", "parquet", "json"].includes(fmt)) errors.push(`格式无效: ${fmt}`);
    return { ok: errors.length === 0, errors };
  },

  // 连接模型:对象存储范式产出 s3Uri(供 Athena 外部表 LOCATION / Glue 读用)。
  buildConnection(ref: SourceRef): ConnectionModel {
    const s = resolveS3(ref);
    if (!s) return { paradigm: "object-store" };
    const s3Uri = `s3://${s.bucket}/${s.prefix}`;
    return {
      paradigm: "object-store",
      s3Uri,
      props: {
        bucket: s.bucket,
        prefix: s.prefix,
        region: s.region,
        format: s.format,
        hasHeader: String(s.hasHeader),
        s3Uri,
      },
    };
  },

  // 真连通性测试:HeadBucket(桶存在且有权限) + ListObjectsV2(prefix 下能列对象)。
  async testConnection(ref: SourceRef): Promise<TestResult> {
    const start = Date.now();
    const steps: TestResult["steps"] = [];
    const s = resolveS3(ref);
    if (!s) {
      steps.push({ name: "resolve", status: "fail", message: "连接信息不完整(缺 bucket)" });
      return { success: false, steps, totalMs: Date.now() - start };
    }
    steps.push({ name: "config_check", status: "pass", message: `S3: s3://${s.bucket}/${s.prefix}` });
    const client = sdkClient("data-plane", S3Client, { region: s.region });
    try {
      await client.send(new HeadBucketCommand({ Bucket: s.bucket }));
      steps.push({ name: "head_bucket", status: "pass", message: `桶可达 (${Date.now() - start}ms)`, latencyMs: Date.now() - start });
      // 再列一下 prefix 下有无对象(空 prefix 也算通过,只是提示无数据)。
      const list = await client.send(new ListObjectsV2Command({ Bucket: s.bucket, Prefix: s.prefix, MaxKeys: 1 }));
      const has = (list.KeyCount || 0) > 0 || (list.CommonPrefixes || []).length > 0;
      steps.push({ name: "list_objects", status: "pass", message: has ? "前缀下发现对象" : "前缀下暂无对象(可后续写入)" });
    } catch (e: any) {
      steps.push({ name: "connectivity", status: "fail", message: String(e?.name || e?.message || e).slice(0, 200) });
    } finally {
      client.destroy();
    }
    return { success: steps.every((st) => st.status !== "fail"), steps, totalMs: Date.now() - start };
  },

  // 轻量探活:HeadBucket(桶是否可达且有权限)。
  async ping(ref: SourceRef): Promise<PingResult> {
    const s = resolveS3(ref);
    if (!s) return { reachable: false, error: "连接信息不完整(缺 bucket)" };
    const started = Date.now();
    const client = sdkClient("data-plane", S3Client, { region: s.region });
    try {
      await client.send(new HeadBucketCommand({ Bucket: s.bucket }));
      return { reachable: true, latencyMs: Date.now() - started };
    } catch (e: any) {
      return { reachable: false, latencyMs: Date.now() - started, error: String(e?.name || e?.message || e).slice(0, 200) };
    } finally {
      client.destroy();
    }
  },

  // introspect:列 prefix 下「逻辑数据集」。
  //  用 Delimiter="/" 把一级子前缀(CommonPrefixes)分组成数据集(每个子前缀 ≈ 一张表的根);
  //  若 prefix 下没有子前缀、只有平铺文件,则 prefix 本身作为一个数据集。
  //  CSV 采样首个数据文件推断列名;Parquet/JSON 一期列留空(schema 由 Athena/Glue 权威确定),meta 标 format。
  async introspect(ref: SourceRef): Promise<SourceDataset[]> {
    const s = resolveS3(ref);
    if (!s) return [];
    const client = sdkClient("data-plane", S3Client, { region: s.region });
    try {
      // 用 Delimiter 分组:CommonPrefixes = 一级子前缀(逻辑数据集);Contents = prefix 直属文件。
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: s.bucket,
        Prefix: s.prefix,
        Delimiter: "/",
        MaxKeys: LIST_MAX,
      }));
      const commonPrefixes = (listed.CommonPrefixes || []).map((p) => p.Prefix!).filter(Boolean);
      const directFiles = (listed.Contents || []).filter((o) => o.Key && o.Key !== s.prefix);

      const datasets: SourceDataset[] = [];

      // 情形 A:有子前缀 → 每个子前缀是一个数据集(分区表根)。为每个采样其下首个文件推断格式/列。
      for (const cp of commonPrefixes) {
        const name = cp.replace(s.prefix, "").replace(/\/$/, "") || cp;
        const cols = await sampleDataset(client, s, cp);
        datasets.push({
          name,
          kind: "prefix",
          columns: cols.columns,
          meta: { location: `s3://${s.bucket}/${cp}`, format: cols.format, hasHeader: s.hasHeader },
        });
      }

      // 情形 B:无子前缀但有直属文件 → prefix 本身作为一个数据集。
      if (commonPrefixes.length === 0 && directFiles.length > 0) {
        const cols = await sampleFromObjects(client, s, directFiles);
        datasets.push({
          name: s.prefix.replace(/\/$/, "").split("/").pop() || s.bucket,
          kind: "prefix",
          columns: cols.columns,
          meta: { location: `s3://${s.bucket}/${s.prefix}`, format: cols.format, hasHeader: s.hasHeader, fileCount: directFiles.length },
        });
      }

      return datasets;
    } catch {
      return []; // 不可达/无权限:上层仍可注册源(与其它 provider introspect 容错一致)
    } finally {
      client.destroy();
    }
  },

  // iam-role 凭证:无密钥可存 → 不实现 buildSecretPayload。
};

// 采样一个子前缀下的首个数据文件推断 format + 列(供 introspect 情形 A)。
async function sampleDataset(
  client: S3Client,
  s: { bucket: string; format: string; hasHeader: boolean },
  cp: string,
): Promise<{ format: string; columns: SourceColumn[] }> {
  try {
    const sub = await client.send(new ListObjectsV2Command({ Bucket: s.bucket, Prefix: cp, MaxKeys: 20 }));
    return sampleFromObjects(client, s, sub.Contents || []);
  } catch {
    return { format: s.format === "auto" ? "unknown" : s.format, columns: [] };
  }
}

// 从一批对象里挑首个非空数据文件,识别格式;CSV 则采样头部推断列。
async function sampleFromObjects(
  client: S3Client,
  s: { bucket: string; format: string; hasHeader: boolean },
  objects: _Object[],
): Promise<{ format: string; columns: SourceColumn[] }> {
  const dataFile = objects.find((o) => o.Key && !o.Key.endsWith("/") && (o.Size || 0) > 0);
  if (!dataFile?.Key) return { format: s.format === "auto" ? "unknown" : s.format, columns: [] };
  const fmt = s.format === "auto" ? sniffFormat(dataFile.Key) : s.format;
  // 仅 CSV 采样头部推断列;Parquet/JSON 的列由 Athena/Glue 权威确定(一期列留空)。
  if (fmt !== "csv") return { format: fmt, columns: [] };
  try {
    const obj = await client.send(new GetObjectCommand({
      Bucket: s.bucket,
      Key: dataFile.Key,
      Range: `bytes=0-${CSV_SNIFF_BYTES - 1}`, // 只拉头部,避免拉整个大文件
    }));
    const text = await obj.Body?.transformToString("utf-8");
    return { format: "csv", columns: text ? inferCsvColumns(text, s.hasHeader) : [] };
  } catch {
    return { format: "csv", columns: [] };
  }
}
