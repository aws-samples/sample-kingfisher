// EMR PySpark 脚本落 S3。
// 复刻 lib/etl/job-service.ts 的 S3 上传范式;前缀 emr-scripts/<jobId>.py(与 Glue 的 glue-scripts/etl/ 隔离)。
//
// 🔴 **桶与客户端都按 target 来**(W3-g:EMR 作业可以在非 home 跑了)。
// 原来是模块级 home 客户端 + `EMR_CODE_BUCKET` ⇒ 非 home 的 job-run 会去**home 的桶**找 entryPoint,
// 而 application 在另一个区 ⇒ 要么拉不到脚本(AccessDenied/NoSuchKey),要么更糟:
// 脚本跨区读成功、**产物却写回 home**(驻留承诺当场破,而且没有任何报错)。

import { homeRegion } from "@/lib/place/home-region";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3ClientFor } from "@/lib/exec-env/target-clients";

/** 该 target 的代码桶(home 缺省与改动前逐字节一致)。 */
export function codeBucketFor(landing?: { scriptsBucket?: string } | null): string {
  return (
    (landing?.scriptsBucket || "").trim() ||
    process.env.EMR_CODE_BUCKET ||
    `bgp-glue-scripts-${process.env.AWS_ACCOUNT_ID}`
  );
}

export function scriptKeyFor(jobId: string): string {
  return `emr-scripts/${jobId}.py`;
}

export function entryPointUri(jobId: string, landing?: { scriptsBucket?: string } | null): string {
  return `s3://${codeBucketFor(landing)}/${scriptKeyFor(jobId)}`;
}

/** 上传脚本,返回 s3:// entryPoint URI(供 StartJobRun 的 jobDriver.sparkSubmit.entryPoint)。 */
export async function uploadScript(
  jobId: string,
  script: string,
  // 🔴 缺省 = home(逐字节等价):调度路径本期仍只发 home 的 DAG(engine-job 的**定时**多区扇出
  //    另属一刀,已如实登记);运行路径必须显式传该 target 的落点。
  landing?: { region: string; scriptsBucket: string } | null
): Promise<string> {
  const Bucket = codeBucketFor(landing);
  const Key = scriptKeyFor(jobId);
  // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
  const s3 = await s3ClientFor(landing?.region || homeRegion());
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: script, ContentType: "text/x-python" }));
  return `s3://${Bucket}/${Key}`;
}

/**
 * 确保 **S3 Tables catalog 的 runtime jar** 在该 target 的代码桶里,返回它的 s3:// URI。
 *
 * 🔴 为什么必须做这一步:平台**恒定注入** `--jars <s3tables jar>`,而那个 jar 原来只在
 * **home** 的脚本桶里(实测 per-target 脚本桶是空的)。非 home 的 job-run 启动时拉不到它
 * ⇒ 作业在"还没跑到用户代码"的地方失败,错误信息离根因极远。
 * 做法 = **幂等的服务端 CopyObject**(HeadObject 命中就复用),不是每次上传。
 */
/**
 * 该 target 上 S3 Tables runtime jar **会在哪个 URI**(纯函数,不碰 S3)。
 * 与 `ensureS3TablesJar` 的返回值逐字同值(它只是把对象真复制过去再回这个 URI);工作流离线作业节点在发布期只读解析 spec 时用它,
 * 真复制留在发布的写阶段(job-node-prepare.ts)。home 逐字节不变;URI 形态不对即抛(与 ensure 同口径)。
 */
export function s3TablesJarUriFor(landing: { scriptsBucket: string; home: boolean }, homeJarUri: string): string {
  if (!homeJarUri) return "";
  if (landing.home) return homeJarUri; // home 逐字节不变
  const m = homeJarUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`S3 Tables jar 的 URI 形态不对:${homeJarUri}`);
  return `s3://${landing.scriptsBucket}/${m[2]}`; // 同 key ⇒ 两边路径一致,便于对账
}

export async function ensureS3TablesJar(
  landing: { region: string; scriptsBucket: string; home: boolean },
  homeJarUri: string
): Promise<string> {
  if (!homeJarUri) return "";
  if (landing.home) return homeJarUri; // home 逐字节不变
  const m = homeJarUri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`S3 Tables jar 的 URI 形态不对:${homeJarUri}`);
  const [, srcBucket, srcKey] = m;
  const destBucket = landing.scriptsBucket;
  const destKey = srcKey; // 同 key ⇒ 两边路径一致,便于对账
  const { HeadObjectCommand, CopyObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = await s3ClientFor(landing.region);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: destBucket, Key: destKey }));
    return s3TablesJarUriFor(landing, homeJarUri);
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotFound" && (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 404) {
      // 🔴 读失败**不等于**"不存在":拒绝当"不存在"去覆盖(那会把一次限流变成每次都复制 28MB)。
      throw new Error(`检查 ${destBucket}/${destKey} 是否存在时失败(拒绝当成不存在):${(e as Error)?.message}`);
    }
  }
  await s3.send(
    new CopyObjectCommand({ Bucket: destBucket, Key: destKey, CopySource: `${srcBucket}/${srcKey}` })
  );
  return s3TablesJarUriFor(landing, homeJarUri);
}
