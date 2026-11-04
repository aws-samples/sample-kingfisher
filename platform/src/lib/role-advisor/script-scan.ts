// 从**脚本代码 + 源头/目标绑定**自动推导「这个作业需要哪些权限」。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴🔴 用户 2026-09-22 拍板(逐字):
//   「这种能力我认为需要加入到配方库里面,不能我每次都需要手动处理这种错误。」
//   「**他需要知道这种任务需要添加哪些权限**,而不是报错了之后我通过你改源代码重新发布解决问题。」
//   「**目标/源头,都要扫描,自动生成所需要的权限**,这里面涉及到代码解析,匹配配方库等操作。」
//
// 【定位】三个证据来源合成一份权限清单,每条都带**证据**(为什么要它):
//   ① `baseline`  引擎必备(唯一真值源 `engine-baseline.ts`)—— 与代码写什么无关,跑起来就得有;
//   ② `code`      **代码解析**:脚本里出现的信号(boto3 client / s3:// 字面量 / catalog 名 / jdbc …);
//   ③ `binding`   **源头/目标绑定**:数据源的 secret、落点桶、数仓、表桶 —— 这些平台自己知道,不必猜;
//   ④ `recipe`    **匹配配方库**:命中某条配方的 `detect` ⇒ 并入它声明的 `requiredPermissions`。
//
// 【🔴 最要紧的一条设计:认不出来的信号必须**说出来**,不许静默丢掉】
//   扫到一个平台不认识的信号(例如 `boto3.client("comprehend")`)⇒ 进 `unknown`,界面照实说
//   「你的代码用到了 X,平台的权限知识库里没有它 ⇒ 请补一条配方」。
//   这才是让知识库**自己长大**的机制;静默忽略 = 又回到「等 AccessDenied 再找人改源码」。
//   (本仓铁律:「判不了」不许说成结论,更不许被吞掉。)
//
// 【封闭式,不是枚举违规】下面的 `SIGNALS` 列的是「**平台认识的信号**」这张白名单,
//   凡不在表里的一律进 `unknown` ⇒ 覆盖面本身是可见的、可增长的,不会静默漏第 N+1 种。
// ══════════════════════════════════════════════════════════════════════════════

import type { RoleEngine, PolicyStatement } from "./types";
import { engineBaseline, type BaselineCtx } from "./engine-baseline";
import { emrLogBucket, emrScriptBucket } from "../engines/emr/log-destination";
import type { Recipe } from "../cookbook/types";

export type NeedOrigin = "baseline" | "code" | "binding" | "recipe";

export interface NeedEvidence {
  origin: NeedOrigin;
  /** 命中的原文片段(代码信号)/ 绑定名 / 配方 id。 */
  match: string;
  /** 代码里的行号(1 起;只有 origin=code/recipe 才有)。 */
  line?: number;
  recipeId?: string;
}

export interface InferredNeed {
  sid: string;
  actions: string[];
  resources: string[];
  why: string;
  evidence: NeedEvidence[];
}

export interface ScanBinding {
  /** 人读名字(界面回显证据用)。 */
  name: string;
  /** 数据源密钥 ARN(读源库口令)。 */
  secretArn?: string;
  /** S3 桶名(源头对象存储 / 落点桶)。 */
  bucket?: string;
  /** 是否是 Redshift 数仓落点。 */
  redshift?: boolean;
  /** S3 Tables 表桶 ARN。 */
  tableBucketArn?: string;
  /** DynamoDB 表名。 */
  dynamodbTable?: string;
}

export interface ScanInput {
  engine: RoleEngine;
  region: string;
  accountId: string;
  /** 脚本正文(PySpark / boto3 / SQL)。缺省 = 只按基线 + 绑定推导。 */
  script?: string;
  /** 源头(数据源)绑定。 */
  sources?: ScanBinding[];
  /** 目标(落点)绑定。 */
  targets?: ScanBinding[];
  /** 该引擎的配方(调用方从 cookbook 传进来;不在本模块 import seed,避免循环依赖)。 */
  recipes?: Recipe[];
  logBucket?: string;
  scriptBucket?: string;
}

export interface ScanResult {
  needs: InferredNeed[];
  /** 🔴 认不出来的信号 —— 必须回显,不许静默丢掉。 */
  unknown: { match: string; line: number; hint: string }[];
  /** 扫了多少行代码(0 = 没给脚本;让调用方能分清「没扫」和「扫了没发现」)。 */
  scannedLines: number;
}

// ── 占位符(闭合清单:配方是数据不是代码,只许用这几个)────────────────────────────
type PlaceholderCtx = { region: string; account: string; datalakeBucket: string; scriptBucket: string; tableBucket: string };

function fillPlaceholders(s: string, c: PlaceholderCtx): string {
  return s
    .replace(/\{region\}/g, c.region)
    .replace(/\{account\}/g, c.account)
    .replace(/\{datalakeBucket\}/g, c.datalakeBucket)
    .replace(/\{scriptBucket\}/g, c.scriptBucket)
    .replace(/\{tableBucket\}/g, c.tableBucket);
}

// ══════════════════════════════════════════════════════════════════════════════
// **平台认识的代码信号**白名单。不在这张表里的一律进 `unknown`。
// 🔴 `why` 一律写「人话 + 为什么」,因为它会原样出现在界面与预检报错里。
// ══════════════════════════════════════════════════════════════════════════════
interface SignalRule {
  sid: string;
  detect: RegExp;
  actions: string[];
  /** 资源面;`m` 是命中的正则结果(可用捕获组把**代码里的字面量**变成资源 ARN)。 */
  resources: (c: PlaceholderCtx, m: RegExpExecArray) => string[];
  why: string;
}

const SIGNALS: SignalRule[] = [
  {
    sid: "CodeRedshiftDataApi",
    detect: /boto3\.client\(\s*['"]redshift-data['"]|redshift_data|execute_statement/,
    actions: [
      "redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement",
      "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-data:CancelStatement",
      "redshift-serverless:GetCredentials",
    ],
    resources: () => ["*"],
    why: "代码用 Redshift Data API 读写数仓(boto3 `redshift-data`)——Data API 多为账号级动作,资源面只能是 *",
  },
  {
    sid: "CodeS3TablesIceberg",
    detect: /s3tablescatalog|s3tables|format\(\s*['"]iceberg['"]\s*\)/i,
    actions: [
      "s3tables:GetTable", "s3tables:GetTableData", "s3tables:PutTableData",
      "s3tables:GetNamespace", "s3tables:ListTables", "s3tables:GetTableBucket",
    ],
    resources: (c) => (c.tableBucket ? [c.tableBucket, `${c.tableBucket}/*`] : ["*"]),
    why: "代码读写 S3 Tables(托管 Iceberg)—— 经 Glue catalog + Lake Formation 取数据访问",
  },
  {
    sid: "CodeLakeFormation",
    detect: /s3tablescatalog|s3tables|format\(\s*['"]iceberg['"]\s*\)/i,
    actions: ["lakeformation:GetDataAccess"],
    resources: () => ["*"],
    why: "S3 Tables 的数据访问由 Lake Formation 联邦发凭证,少了它 Spark 读表会被拒",
  },
  {
    sid: "CodeGlueCatalog",
    detect: /boto3\.client\(\s*['"]glue['"]|spark\.(?:table|sql)\(|awsglue|GlueContext|s3tablescatalog/,
    actions: [
      "glue:GetDatabase", "glue:GetDatabases", "glue:GetTable", "glue:GetTables",
      "glue:GetPartition", "glue:GetPartitions", "glue:CreateTable", "glue:UpdateTable", "glue:BatchCreatePartition",
    ],
    resources: (c) => [
      `arn:aws:glue:${c.region}:${c.account}:catalog`,
      `arn:aws:glue:${c.region}:${c.account}:database/*`,
      `arn:aws:glue:${c.region}:${c.account}:table/*`,
    ],
    why: "代码经 Glue 数据目录解析库/表(spark.table / GlueContext / boto3 glue)",
  },
  {
    sid: "CodeDynamoDbRead",
    detect: /boto3\.(?:client|resource)\(\s*['"]dynamodb['"]/,
    actions: ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"],
    resources: (c) => [`arn:aws:dynamodb:${c.region}:${c.account}:table/*`],
    why: "代码用 boto3 读 DynamoDB(EMR 没有 DDB 批 source,平台范式是 boto3 分片 Scan)——**只读**,不含写动作",
  },
  {
    sid: "CodeSecretsManager",
    detect: /boto3\.client\(\s*['"]secretsmanager['"]|get_secret_value/,
    actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
    resources: (c) => [
      `arn:aws:secretsmanager:${c.region}:${c.account}:secret:bgp/*`,
      `arn:aws:secretsmanager:${c.region}:${c.account}:secret:BgpRdsStack*`,
    ],
    why: "代码读 Secrets Manager 取源库口令;未指明具体密钥时收敛到平台的两个前缀",
  },
  {
    sid: "CodeS3LiteralBucket",
    // 🔴 **代码里写死的 s3:// 落点**:这是「扫目标/源头」最直接的一刀 ——
    //   作业往一个绑定里没有的桶写东西时,只有扫代码才看得见。
    detect: /s3[a-z]?:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\//gi,
    actions: [
      "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation",
      "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts",
    ],
    resources: (_c, m) => [`arn:aws:s3:::${m[1]}`, `arn:aws:s3:::${m[1]}/*`],
    why: "代码里出现了写死的 S3 路径 —— 作业会真的读/写这个桶,所以权限必须覆盖它",
  },
  {
    sid: "CodeKinesisRead",
    detect: /boto3\.client\(\s*['"]kinesis['"]|kinesis\.analytics|GetShardIterator/,
    actions: ["kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:GetRecords", "kinesis:GetShardIterator", "kinesis:ListShards"],
    resources: (c) => [`arn:aws:kinesis:${c.region}:${c.account}:stream/*`],
    why: "代码读 Kinesis 数据流",
  },
  {
    sid: "CodeAthenaQuery",
    detect: /boto3\.client\(\s*['"]athena['"]|start_query_execution/,
    actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"],
    resources: (c) => [`arn:aws:athena:${c.region}:${c.account}:workgroup/*`],
    why: "代码用 Athena 执行查询",
  },
];

/** 🔴 认得出「这是一次 AWS 调用」但**不认识那个服务** ⇒ 进 unknown(不许静默丢)。 */
const AWS_CALL_SHAPE = /boto3\.(?:client|resource)\(\s*['"]([a-z0-9-]+)['"]/g;
const KNOWN_SERVICES = new Set([
  "redshift-data", "redshift-serverless", "s3", "s3tables", "glue", "dynamodb",
  "secretsmanager", "kinesis", "athena", "logs", "cloudwatch", "sts", "ec2", "emr-serverless",
]);

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** 合并同 sid:动作/资源取并集,证据累加(不许出现两条同 sid 的语句)。 */
function merge(into: Map<string, InferredNeed>, n: InferredNeed): void {
  const cur = into.get(n.sid);
  if (!cur) { into.set(n.sid, { ...n, actions: [...n.actions], resources: [...n.resources], evidence: [...n.evidence] }); return; }
  for (const a of n.actions) if (!cur.actions.includes(a)) cur.actions.push(a);
  for (const r of n.resources) if (!cur.resources.includes(r)) cur.resources.push(r);
  for (const e of n.evidence) {
    if (!cur.evidence.some((x) => x.origin === e.origin && x.match === e.match && x.line === e.line)) cur.evidence.push(e);
  }
}

export function scanForPermissions(input: ScanInput): ScanResult {
  const code = input.script || "";
  const c: PlaceholderCtx = {
    region: input.region,
    account: input.accountId,
    datalakeBucket: input.logBucket || emrLogBucket(),
    scriptBucket: input.scriptBucket || emrScriptBucket(),
    tableBucket: (input.targets || []).find((t) => t.tableBucketArn)?.tableBucketArn
      || `arn:aws:s3tables:${input.region}:${input.accountId}:bucket/bgp-table-bucket`,
  };
  const needs = new Map<string, InferredNeed>();

  // ── ① 引擎必备基线(与代码无关)────────────────────────────────────────────
  const bctx: BaselineCtx = { region: input.region, accountId: input.accountId, logBucket: input.logBucket, scriptBucket: input.scriptBucket };
  for (const b of engineBaseline(input.engine, bctx)) {
    merge(needs, { sid: b.sid, actions: b.actions, resources: b.resources, why: b.why, evidence: [{ origin: "baseline", match: `${input.engine} 引擎必备` }] });
  }

  // ── ② 代码解析 ────────────────────────────────────────────────────────────
  for (const rule of SIGNALS) {
    // 🔴 每条规则用自己的 RegExp 实例:带 `g` 的正则有 `lastIndex` 状态,共用会**跳过命中**
    //   (本仓踩过的同形:共享可变状态让判据静默漏掉一半)。
    const re = new RegExp(rule.detect.source, rule.detect.flags.includes("g") ? rule.detect.flags : rule.detect.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      merge(needs, {
        sid: rule.sid, actions: rule.actions, resources: rule.resources(c, m), why: rule.why,
        evidence: [{ origin: "code", match: m[0].slice(0, 80), line: lineOf(code, m.index) }],
      });
      if (m[0] === "") break; // 防零宽匹配死循环
    }
  }

  // ── ③ 源头 / 目标绑定 ─────────────────────────────────────────────────────
  for (const [kind, list] of [["源头", input.sources || []], ["目标", input.targets || []]] as const) {
    for (const b of list) {
      const ev = (extra: string) => [{ origin: "binding" as const, match: `${kind}「${b.name}」${extra}` }];
      if (b.secretArn) {
        merge(needs, { sid: "BindingSecrets", actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], resources: [b.secretArn], why: `读${kind}「${b.name}」的连接密钥(已收敛到精确 ARN)`, evidence: ev("的密钥") });
      }
      if (b.bucket) {
        merge(needs, {
          sid: "BindingS3", actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts"],
          resources: [`arn:aws:s3:::${b.bucket}`, `arn:aws:s3:::${b.bucket}/*`],
          why: `读写${kind}「${b.name}」所在的 S3 桶 ${b.bucket}`, evidence: ev(`的桶 ${b.bucket}`),
        });
      }
      if (b.redshift) {
        merge(needs, { sid: "BindingRedshift", actions: ["redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement", "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-serverless:GetCredentials"], resources: ["*"], why: `经 Data API 写${kind}「${b.name}」这个 Redshift 数仓`, evidence: ev("(Redshift 数仓)") });
      }
      if (b.tableBucketArn) {
        merge(needs, { sid: "BindingS3Tables", actions: ["s3tables:GetTable", "s3tables:GetTableData", "s3tables:PutTableData", "s3tables:GetNamespace", "s3tables:ListTables", "s3tables:GetTableBucket"], resources: [b.tableBucketArn, `${b.tableBucketArn}/*`], why: `读写${kind}「${b.name}」的 S3 Tables 表桶`, evidence: ev("的表桶") });
      }
      if (b.dynamodbTable) {
        merge(needs, { sid: "BindingDynamoDb", actions: ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"], resources: [`arn:aws:dynamodb:${input.region}:${input.accountId}:table/${b.dynamodbTable}`], why: `只读${kind}「${b.name}」这张 DynamoDB 表`, evidence: ev(`的表 ${b.dynamodbTable}`) });
      }
    }
  }

  // ── ④ 匹配配方库 ──────────────────────────────────────────────────────────
  for (const r of input.recipes || []) {
    if (r.engine !== engineToCookbook(input.engine)) continue;
    if (!r.detect?.length || !r.requiredPermissions?.length) continue;
    let hitAt = -1;
    let hitText = "";
    for (const d of r.detect) {
      const re = new RegExp(d.source, d.flags.replace("g", ""));
      const m = re.exec(code);
      if (m) { hitAt = m.index; hitText = m[0].slice(0, 60); break; }
    }
    if (hitAt < 0) continue;
    for (const p of r.requiredPermissions) {
      merge(needs, {
        sid: recipeSid(r.id),
        actions: p.actions,
        resources: p.resources.map((x) => fillPlaceholders(x, c)),
        why: `【配方 ${r.id}】${p.why}`,
        evidence: [{ origin: "recipe", match: hitText, line: lineOf(code, hitAt), recipeId: r.id }],
      });
    }
  }

  // ── 🔴 认不出来的 AWS 调用 ⇒ 必须说出来 ───────────────────────────────────
  const unknown: ScanResult["unknown"] = [];
  const seen = new Set<string>();
  let um: RegExpExecArray | null;
  const ure = new RegExp(AWS_CALL_SHAPE.source, "g");
  while ((um = ure.exec(code)) !== null) {
    const svc = um[1];
    if (KNOWN_SERVICES.has(svc) || seen.has(svc)) continue;
    seen.add(svc);
    unknown.push({
      match: um[0], line: lineOf(code, um.index),
      hint: `代码用到了 AWS 服务 \`${svc}\`,但平台的权限知识库里**没有**它 ⇒ 这条权限推导不出来。`
        + `请给它补一条配方(cookbook seed,带 detect + requiredPermissions),补完这类作业就自动带上权限。`,
    });
  }

  return { needs: Array.from(needs.values()), unknown, // 🔴 结尾换行不算多一行(这个数字会显示给用户「已扫描脚本 N 行」)
    scannedLines: code ? code.replace(/\n$/, "").split("\n").length : 0 };
}

/**
 * 配方 id → **合法的 IAM Sid**。
 * 🔴🔴 IAM 的硬约束:`Statement IDs (SID) must be alpha-numeric ... [0-9A-Za-z]*`。
 *   2026-09-22 真环境当场撞到:第一版写 `Recipe_${id.replace(/[^A-Za-z0-9]/g,"_")}`,
 *   配方 id `emr.redshift-and-lake-access` 变成 `Recipe_emr_redshift_and_lake_access`
 *   ⇒ `PutRolePolicy` 报 **MalformedPolicyDocumentException**,整个「一键补齐」失败。
 *   21 条单测 + 变异 5/5 **全绿** —— 因为单测从没让这个 Sid 过一遍 IAM 的校验。
 *   (本仓记过的那条:部署后拿真环境勘定五分钟,抓到的东西是离线判据结构上看不见的。)
 * ⇒ 改成**驼峰拼接**:分隔符处大写首字母,信息不丢、也不会把两条配方拼成同一个 Sid。
 */
export function recipeSid(recipeId: string): string {
  const parts = recipeId.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return "Recipe" + parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join("");
}

/** 角色顾问的引擎枚举 → 配方库的引擎枚举(两套枚举不同,必须显式映射,不许当成同一个)。 */
function engineToCookbook(e: RoleEngine): string {
  return e === "emr" ? "emr" : e === "glue" ? "glue" : e === "flink" ? "flink" : "";
}

/** 推导结果 → IAM 语句。 */
export function inferredStatements(needs: InferredNeed[]): PolicyStatement[] {
  return needs.map((n) => ({ Sid: n.sid, Effect: "Allow" as const, Action: n.actions, Resource: n.resources }));
}
