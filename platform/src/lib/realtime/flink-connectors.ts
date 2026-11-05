// 自定义连接器(用户上传的 sink JAR)注册表 + 启动时装配。
//
// 生产顶层设计:MSAF 应用代码只认【单一 uber-jar】(≤512MB)。自定义 sink = 用户上传一个连接器 JAR,
// 平台在【作业启动时】把它与基础 runner(flink-sql-runner.jar)合并成一个 per-job uber-jar(合并
// META-INF/services SPI 工厂,使 kinesis 源 + 用户 sink 工厂都能被 Flink 发现),交给 MSAF。
//
// JAR 本体存代码桶(FLINK_CODE_BUCKET)的 flink/connectors/ 前缀;元数据存 DynamoDB(连接器标识/大小/
// 上传者/项目+环境)。不硬编码任何账号/桶名 —— 全部来自 flink-config(CDK 注入的 env 派生)。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { PutCommand, GetCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { FLINK } from "./flink-config";
import { resolveModules, type ConnectorModuleId } from "./connector-modules";

// 🔴 这里原来是一个模块级主控区 S3 客户端 + 到处直接用 `FLINK.codeBucket`。后果非常具体:
// 一个自定义 sink 作业在 us-west-2 启动时,合并出的 per-job uber-jar 被写进**主控区**的桶,
// 而 MSAF 应用去**本区**的桶找那个 key ⇒ 「取不到 fileKey」启动即失败
// (与第 4 条「部署漏传模块 jar」是同一个形状)。
//
// 分工定死:**连接器 JAR 的规范副本永远在主控区**(用户上传一次,不必按区各传一份);
// 装配时**从主控区读源、把合并结果写进作业所在区**的代码桶 —— 一次跨区读、一次本区写。
const homeS3 = sdkClient("data-plane", S3Client, { region: FLINK.region });

/** 装配落点(只需要「写到哪个桶、用哪个区的客户端」两件事)。
 *  收尾:三个入口的落点**必填**(原来缺省 `HOME_JAR_PLACE` = 主控区代码桶,
 *  漏传 ⇒ 合并结果静默写回主控区,而 MSAF 去本区找 ⇒「取不到 fileKey」)。 */
export interface JarPlace { region: string; codeBucket: string }
async function s3For(place: JarPlace) {
  if (place.region === FLINK.region) return homeS3;
  const { s3ClientFor } = await import("@/lib/exec-env/target-clients");
  return (await s3ClientFor(place.region)) as unknown as S3Client;
}
const USER_ID = "default-user";

export interface FlinkConnector {
  userId: string;
  connectorId: string;
  name: string;
  connectorIdentifier: string; // Flink SQL 里 'connector'='<identifier>' 的值,如 opensearch-2
  fileName: string;
  s3Key: string;
  sizeBytes: number;
  projectId: string;
  env: string;
  createdBy: string;
  createdAt: string;
}

async function s3GetBuffer(key: string): Promise<Buffer> {
  const r = await homeS3.send(new GetObjectCommand({ Bucket: FLINK.codeBucket, Key: key }));
  const bytes = await r.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/** 上传连接器 JAR 到代码桶受控前缀,返回 S3 key 与大小。 */
export async function uploadConnectorJar(buf: Buffer, fileName: string): Promise<{ s3Key: string; sizeBytes: number }> {
  const safe = (fileName || "connector.jar").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
  const s3Key = `${FLINK.connectorsPrefix}${ulid()}-${safe}`;
  await homeS3.send(new PutObjectCommand({ Bucket: FLINK.codeBucket, Key: s3Key, Body: buf, ContentType: "application/java-archive" }));
  return { s3Key, sizeBytes: buf.length };
}

export async function createConnector(meta: Omit<FlinkConnector, "userId" | "connectorId" | "createdAt">): Promise<FlinkConnector> {
  const item: FlinkConnector = { userId: USER_ID, connectorId: ulid(), createdAt: new Date().toISOString(), ...meta };
  await docClient.send(new PutCommand({ TableName: TABLES.FLINK_CONNECTORS, Item: item }));
  return item;
}

export async function listConnectors(projectId: string, env: string): Promise<FlinkConnector[]> {
  const { Items = [] } = await docClient.send(new ScanCommand({
    TableName: TABLES.FLINK_CONNECTORS,
    FilterExpression: "userId = :u AND projectId = :p AND #e = :env",
    ExpressionAttributeNames: { "#e": "env" },
    ExpressionAttributeValues: { ":u": USER_ID, ":p": projectId, ":env": env },
  }));
  return (Items as FlinkConnector[]).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function getConnector(connectorId: string): Promise<FlinkConnector | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_CONNECTORS, Key: { userId: USER_ID, connectorId } }));
  return (Item as FlinkConnector) || null;
}

export async function deleteConnector(connectorId: string): Promise<void> {
  const c = await getConnector(connectorId);
  if (c?.s3Key) { try { await homeS3.send(new DeleteObjectCommand({ Bucket: FLINK.codeBucket, Key: c.s3Key })); } catch { /* best-effort */ } }
  await docClient.send(new DeleteCommand({ TableName: TABLES.FLINK_CONNECTORS, Key: { userId: USER_ID, connectorId } }));
}

// §2.4 约束②:字节级冲突检测的"稳定门面"白名单。
//  同名类字节不同时:命中白名单前缀 → WARN 放行(先加入者胜安全);否则(核心库)→ FAIL 抛错。
//  🔴 白名单只收「API 极稳、多版本行为一致,且现有已跑通实证」的日志门面:
//     commons-logging —— 现有 base runner 本就内嵌 30 个同类并已跑通多时(实测)。
//  新增项须有"现有已跑通实证"依据,禁止随意扩(否则退化回"静默先来者胜"的埋雷老路)。
const CONFLICT_WARN_WHITELIST = [
  "org/apache/commons/logging/",
];

/** 合并基础 runner + 若干连接器 JAR 为单一 uber-jar(SPI 工厂拼接;base 的 MANIFEST/类优先)。
 *
 *  §2.4 约束②冲突检测(分级):遇同名类且【字节不同】——
 *   · 命中稳定门面白名单(commons-logging 等)→ WARN 放行(先加入者胜,行为一致);
 *   · 否则(核心库 flink/iceberg/jackson 等)→ 抛错中止(让版本分叉在拼装期暴露,而非运行期静默崩)。
 *  字节相同的同名类静默去重(占绝大多数,合并无害)。
 *
 *  🔴 向后兼容:签名不变;strict 默认 true。自定义 sink 现有调用(mergeJars(base, adds))行为保持——
 *     用户连接器与 base 版本对齐时无冲突;真撞核心库本就该拦(旧"静默先来者胜"是隐患,现在显式化)。 */
export function mergeJars(baseBuf: Buffer, addBufs: Buffer[], opts?: { strict?: boolean }): Buffer {
  const strict = opts?.strict !== false; // 默认开启冲突检测
  const out = new AdmZip();
  const services: Record<string, string[]> = {}; // META-INF/services/* → 去重后的实现类列表
  const seen = new Map<string, Buffer>();         // 类名 → 首次写入的字节(用于同名字节比对)
  const warned = new Set<string>();               // 已 WARN 的白名单冲突(去重日志噪音)
  const addEntries = (buf: Buffer, isBase: boolean) => {
    const z = new AdmZip(buf);
    for (const e of z.getEntries()) {
      if (e.isDirectory) continue;
      const name = e.entryName;
      if (/^META-INF\/.*\.(SF|DSA|RSA)$/i.test(name)) continue;     // 丢签名
      if (!isBase && name === "META-INF/MANIFEST.MF") continue;     // 只保留 base 的 MANIFEST(Main-Class)
      if (/^META-INF\/versions\//.test(name)) continue;             // 丢 multi-release
      if (name.startsWith("META-INF/services/")) {
        const bag = (services[name] = services[name] || []);
        for (const ln of e.getData().toString("utf8").split(/\r?\n/)) {
          const t = ln.trim();
          if (t && !bag.includes(t)) bag.push(t);
        }
        continue;
      }
      const data = e.getData();
      const prev = seen.get(name);
      if (prev) {
        // 同名类:字节相同→无害去重;字节不同→按 §2.4 分级(白名单 WARN / 核心库 FAIL)。
        if (strict && name.endsWith(".class") && !prev.equals(data)) {
          const whitelisted = CONFLICT_WARN_WHITELIST.some((p) => name.startsWith(p));
          if (whitelisted) {
            if (!warned.has(name)) { warned.add(name); console.warn(`[flink-merge] 同名类字节不同(稳定门面,放行,先加入者胜): ${name}`); }
          } else {
            throw new Error(
              `连接器模块合并冲突:同名类字节不同且非白名单(核心库版本分叉,拒绝静默合并以免运行期崩): ${name}。` +
              `请对齐模块版本(统一 version parent)或改用官方已 relocate 的 runtime jar。见 DESIGN §2.4。`,
            );
          }
        }
        continue; // 先加入者胜(base/前序模块优先)
      }
      seen.set(name, data);
      out.addFile(name, data);
    }
  };
  addEntries(baseBuf, true);
  for (const b of addBufs) addEntries(b, false);
  for (const [name, lines] of Object.entries(services)) {
    out.addFile(name, Buffer.from(lines.join("\n") + "\n", "utf8"));
  }
  return out.toBuffer();
}

/** 作业启动装配:取基础 runner + 选中的连接器 JAR(从 S3)→ 合并 → 传 per-job uber-jar 到代码桶,返回其 key。
 *  🔴 自定义 sink 路径(现有):strict=false 保持旧行为(用户上传连接器与 base 的同名类冲突静默先来者胜,
 *     逐字节不变、零回归)。模块化拼装(assembleModularUberJar)才用 strict 冲突检测。 */
export async function assembleUberJar(jobId: string, connectorS3Keys: string[], place: JarPlace): Promise<string> {
  // 源(基础 runner + 用户连接器)从主控区读 —— 那是规范副本所在;
  // 合并结果写进**作业所在区**的代码桶 —— MSAF 只会去那里找。
  const base = await s3GetBuffer(FLINK.codeKey);
  const adds = await Promise.all(connectorS3Keys.map((k) => s3GetBuffer(k)));
  const merged = mergeJars(base, adds, { strict: false });
  const key = `${FLINK.jobsPrefix}${jobId}.jar`;
  const c = await s3For(place);
  await c.send(new PutObjectCommand({ Bucket: place.codeBucket, Key: key, Body: merged, ContentType: "application/java-archive" }));
  return key;
}

/** S3 对象是否存在(缓存命中判断)。 */
async function s3Exists(key: string, place: JarPlace): Promise<boolean> {
  // 🔴 缓存命中必须在**目标区**判:在主控区判命中、却不往目标区写,等于启动时那个区没有这个 key。
  try {
    const c = await s3For(place);
    await c.send(new HeadObjectCommand({ Bucket: place.codeBucket, Key: key }));
    return true;
  } catch { return false; }
}

/** 计算 uber-jar 内容哈希缓存 key(纯函数,可测)。§2.1 第4点:
 *  由 base key + 模块 id 有序列表 + 用户连接器 keys(排序)算 sha256 → 相同组合→同 key→缓存命中。
 *  🔴 modules 假定已稳定排序(resolveModules 保证);userKeys 此处再排序,确保与调用顺序无关。 */
export function uberCacheKey(baseKey: string, modules: string[], userKeys: string[] = [], sourceIds: string[] = []): string {
  // 🔴 sourceIds = 各源对象(薄基础 / 模块 / 用户连接器)在主控区桶里的身份(metadata sha256,退到 ETag);
  //   不折进去的后果(2026-11-05 Flink 1.20.4 升级抓到):升级脚本重传了模块 JAR,组合没变 ⇒ key 没变 ⇒ 缓存命中 ⇒
  //   执行区的作业永远拼旧包。身份变 ⇒ key 变 ⇒ 未命中 ⇒ 重新拼装。
  const hash = createHash("sha256")
    .update([baseKey, ...modules, ...[...userKeys].sort(), ...sourceIds].join("|"))
    .digest("hex").slice(0, 32);
  return `${FLINK.uberCachePrefix}uber-${hash}.jar`;
}

/** 主控区桶里一个源对象的身份:安装 / 升级脚本写进 metadata 的 sha256;没有(老对象 / 用户上传)退到 ETag。读不到 ⇒ 抛(源缺了就不该启动)。 */
async function s3SourceIdentity(key: string): Promise<string> {
  const h = await homeS3.send(new HeadObjectCommand({ Bucket: FLINK.codeBucket, Key: key }));
  const sha = h.Metadata?.sha256;
  return sha ? `sha256:${sha}` : `etag:${(h.ETag || "").replace(/"/g, "")}`;
}

/** §2.1 第4点 — 模块化按需拼装 + 内容哈希缓存。
 *
 *  由【已注入的 finalSql】解析所需连接器模块(resolveModules,CR.1)+ 可选用户上传连接器 → 薄基础 + 各模块
 *  合并成 per-job uber-jar。内容哈希缓存:相同(base+模块集合+用户连接器)→ 同 cacheKey → 命中则复用,零重建。
 *
 *  · 模块集合来自 finalSql(稳定排序,CR.1 保证确定性)+ 用户连接器 keys(排序)→ 算 sha256 → uber-<hash>.jar。
 *  · strict 冲突检测开启(§2.4 约束②:核心库版本分叉在拼装期 FAIL,门面 WARN)。
 *  · 缓存命中直接返回缓存 key(不重传);未命中则合并+上传+存缓存。
 *
 *  🔴 与 assembleUberJar(自定义 sink)并存,不替代;由 CR.4 的 startFlinkJob 在切换开关后调用。
 *  返回:uber-jar 的 S3 key(供 MSAF CodeContent FileKey)。 */
export async function assembleModularUberJar(finalSql: string, connectorS3Keys: string[] = [], place: JarPlace): Promise<{ key: string; modules: ConnectorModuleId[]; cached: boolean; prebuilt?: boolean }> {
  const modules = resolveModules(finalSql);              // 稳定排序的模块 id 集合
  // 🔴 §2.0 分治边界(CR.4 真跑逼出):含 iceberg 重栈(8.9万条目+hadoop)的组合【不走运行期 adm-zip 合并】
  //    (撞 ZIP64 65535 条目上限),而用 maven 预构建的包(ZIP64、统一调解、已跑通多时)。
  //    轻量连接器(kinesis/kafka/jdbc/files/json)才走下面的运行期按需合并。
  if (modules.includes("iceberg-s3tables")) {
    // 🔴 Bug#5:iceberg 重栈短路是"非黑即白"——s3t 预构建包【未打 kafka connector】(SPI 无
    //    KafkaDynamicTableFactory)。kafka 源 × iceberg sink 组合原本被短路吞掉 kafka 模块 → 启动崩
    //    "Could not find any factory for identifier 'kafka'"。方案 D:预构建【kafka+iceberg 组合包】
    //    (s3t + kafka connector + msk-iam-auth + relocation,同样 ZIP64/maven 一次性 shade),此组合选它;
    //    纯 iceberg(Kinesis/CDC→S3Tables)仍用现有 s3t 包 → 零辐射零回归。真跑坐实(MSAF RUNNING +
    //    Athena 查得窗口聚合精确对上 MSK 源)。判定信息 resolveModules 已提供(modules 含 kafka)。
    const key = modules.includes("kafka") ? FLINK.s3tKafkaCodeKey : FLINK.s3tableCodeKey;
    return { key, modules, cached: true, prebuilt: true };
  }
  const userKeys = [...connectorS3Keys].sort();          // 用户连接器(排序保证确定性)
  const moduleKeys = modules.map((m) => `${FLINK.modulesPrefix}flink-module-${m}.jar`);
  // 内容哈希缓存 key(纯函数):base key + 模块 id 有序列表 + 用户连接器 keys + **各源对象的身份**。
  //   任一变 → hash 变 → 不同缓存条目;源对象被升级脚本重传(身份变)同样失效,不再永远复用旧拼装。
  const sourceIds = await Promise.all([FLINK.modularBaseKey, ...moduleKeys, ...userKeys].map((k) => s3SourceIdentity(k)));
  const cacheKey = uberCacheKey(FLINK.modularBaseKey, modules, userKeys, sourceIds);

  if (await s3Exists(cacheKey, place)) {
    return { key: cacheKey, modules, cached: true };     // 命中:零重建
  }

  // 未命中:取薄基础 + 各模块 jar + 用户连接器 → strict 合并。
  const base = await s3GetBuffer(FLINK.modularBaseKey);
  const addBufs = await Promise.all([...moduleKeys, ...userKeys].map((k) => s3GetBuffer(k)));
  const merged = mergeJars(base, addBufs, { strict: true }); // §2.4 约束②冲突检测
  const cOut = await s3For(place);
  await cOut.send(new PutObjectCommand({ Bucket: place.codeBucket, Key: cacheKey, Body: merged, ContentType: "application/java-archive" }));
  return { key: cacheKey, modules, cached: false };
}
