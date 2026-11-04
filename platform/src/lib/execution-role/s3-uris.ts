// 作业**实际引用**的 S3 URI(纯函数,单一作者)。
//
// 预检要量的不是「引擎基线」那几个平台桶,而是这条作业**真会去读**的东西:
//   · Glue `--extra-jars` / `--extra-py-files`(逗号分隔的 S3 URI;客户现网 403 就是这里换成了自己的桶);
//   · 脚本正文里出现的 `s3://` 字面(spark.read / SDK 客户端调用 / 路径常量);
// 加上:依赖库「上传」只传主控区脚本桶 ⇒ 非主控区作业的 Glue 角色读不到。现在上传按作业绑定的每个落点各传一份
// (同 key),作业提交到某个区时把「平台脚本桶」形态的依赖 URI 换成**该区**的脚本桶(`localizePlatformDepUris`)。

import { resourceNamePattern } from "@/lib/aws/naming";

export interface S3Uri {
  bucket: string;
  key: string;
  /** 归一后的 `s3://bucket/key`(s3a:// 也归到 s3://)。 */
  uri: string;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** `s3://bucket/key` / `s3a://bucket/key` ⇒ 拆开;桶名不合法 / 没有 key / 不是 S3 URI ⇒ null。 */
export function parseS3Uri(raw: unknown): S3Uri | null {
  if (typeof raw !== "string") return null;
  const m = /^s3a?:\/\/([^/\s]+)\/(.+)$/.exec(raw.trim());
  if (!m) return null;
  const [, bucket, key] = m;
  if (!BUCKET_RE.test(bucket) || key.length === 0) return null;
  return { bucket, key, uri: `s3://${bucket}/${key}` };
}

/** 逗号分隔(Glue console 口径)⇒ 去空白去空项;非字符串 ⇒ []。 */
export function splitS3UriList(csv: unknown): string[] {
  if (typeof csv !== "string") return [];
  return csv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Glue 配置里两组依赖字段 ⇒ 合法 S3 URI 清单(去重,保持顺序;形态不对的项**不吞**:原样留下让预检的 ARN 形态检查去拒)。 */
export function s3UrisFromGlueConfig(cfg: { extraJars?: unknown; extraPyFiles?: unknown } | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of [...splitS3UriList(cfg?.extraJars), ...splitS3UriList(cfg?.extraPyFiles)]) {
    const p = parseS3Uri(raw);
    const v = p ? p.uri : raw;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// 脚本正文里的 S3 字面:只认静态字面(含 `{` / `$` 的是模板,量不了,不猜)。
const SCRIPT_S3_RE = /s3a?:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[^\s'"`<>()[\]{},;]+/g;

/** 脚本正文 ⇒ 其中出现的 S3 对象 URI(去重;模板化 / 带占位符的跳过)。 */
export function s3UrisFromScript(code: unknown): string[] {
  if (typeof code !== "string" || !code) return [];
  const out: string[] = [];
  const re = new RegExp(SCRIPT_S3_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (/[{}$]/.test(m[0])) continue;
    const p = parseS3Uri(m[0]);
    if (p && !out.includes(p.uri)) out.push(p.uri);
  }
  return out;
}

/** 依赖库上传的对象 key 前缀(`app/api/etl-jobs/[id]/deps` 写、`localizePlatformDepUris` 认)。 */
export const PLATFORM_DEP_KEY_PREFIX = "glue-deps/";

/**
 * `s3://<平台脚本桶>/glue-deps/<jobId>/<file>` 这种**平台上传的依赖**,在提交到某个落点时换成该落点的脚本桶
 * (上传路由已按每个绑定区各传一份、同 key)。其它桶 / 其它 key 一字不动 —— 客户自己的桶就是客户自己的桶。
 */
export function localizePlatformDepUri(uri: string, landing: { scriptsBucket: string }): string {
  const p = parseS3Uri(uri);
  if (!p || !p.key.startsWith(PLATFORM_DEP_KEY_PREFIX)) return uri;
  if (!resourceNamePattern("scriptsBucket").test(p.bucket)) return uri;
  if (p.bucket === landing.scriptsBucket) return uri;
  return `s3://${landing.scriptsBucket}/${p.key}`;
}

/** 逗号分隔清单版(Glue `--extra-jars` / `--extra-py-files` 原样是 csv);非字符串 / 空 ⇒ 原值。 */
export function localizePlatformDepUris<T>(csv: T, landing: { scriptsBucket: string }): T | string {
  if (typeof csv !== "string" || !csv.trim()) return csv;
  return splitS3UriList(csv).map((u) => localizePlatformDepUri(u, landing)).join(",");
}
