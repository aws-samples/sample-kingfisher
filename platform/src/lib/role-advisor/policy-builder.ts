// 角色顾问确定性引擎:据 engine + 资源画像,生成【信任策略 + 最小权限策略 + 逐条理由】。
// 规则驱动(IAM 策略本就是规则),不用大模型——避免模型编出错误/过宽权限。

import type {
  RoleAdviceRequest,
  RoleAdvice,
  RoleEngine,
  PolicyDocument,
  PolicyStatement,
  PermissionNote,
} from "./types";
import { engineBaseline } from "./engine-baseline";
import { ROLE_APPLY_BUTTON_LABEL } from "./labels";

const ENGINE_SERVICE: Record<RoleEngine, string> = {
  glue: "glue.amazonaws.com",
  emr: "emr-serverless.amazonaws.com",
  dms: "dms.amazonaws.com",
  flink: "kinesisanalytics.amazonaws.com",
};

const ENGINE_LABEL: Record<RoleEngine, string> = {
  glue: "Glue", emr: "EMR Serverless", dms: "DMS", flink: "Flink (MSAF)",
};

export const ROLE_NAME_PREFIX = "bgp-job-role-";

/** 去掉首尾的 `-`(下标扫描;不用 `/^-+|-+$/` —— 用户可控文本上那个正则会多项式回溯)。 */
function trimDashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 45) a++;
  while (b > a && s.charCodeAt(b - 1) === 45) b--;
  return s.slice(a, b);
}

// 规范化角色名:强制受控前缀 + 仅安全字符(防注入/防越权命名)。
export function normalizeRoleName(hint: string | undefined, engine: RoleEngine): string {
  const base = trimDashes((hint || "").replace(/[^a-zA-Z0-9-]/g, "")).slice(0, 40);
  const safe = base || `${engine}`;
  return safe.startsWith(ROLE_NAME_PREFIX) ? safe : `${ROLE_NAME_PREFIX}${safe}`;
}

export function buildRoleAdvice(req: RoleAdviceRequest): RoleAdvice {
  const engine = req.engine;
  const region = req.region || "us-east-1";
  // 🔴🔴 `accountId` 缺失时原来退化成 `"*"` ⇒ 建出 `arn:aws:s3:::bgp-datalake-*` 这种**跨账号通配**的
  //   资源面,而调用方一个字的提示都收不到。这正是本仓那条「有静默合法默认值的参数 = 一整类缺陷」。
  //   ⇒ 不再静默兜底:拿不到账号号就**在这里**说清楚(provisionRole 会据此拒绝创建,fail-closed)。
  const acct = req.accountId || "";
  const res = req.resources || {};
  const needsLogs = res.needsCloudWatchLogs !== false; // 默认写日志

  // ── 信任策略:只允许目标服务 assume ──
  const trustPolicy: PolicyDocument = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["sts:AssumeRole"], Resource: [], Condition: { StringEquals: { "aws:SourceAccount": acct } } }],
  };
  // trust 的 Principal 结构与普通语句不同,单独在展示层拼(此处用 Sid 标注服务)。
  (trustPolicy.Statement[0] as any).Principal = { Service: ENGINE_SERVICE[engine] };
  delete (trustPolicy.Statement[0] as any).Resource; // trust 语句无 Resource

  const stmts: PolicyStatement[] = [];
  const notes: PermissionNote[] = [];
  const cautions: string[] = [];
  const managedPolicyArns: string[] = [];

  // ── Secrets Manager:读数据源密钥(收敛到具体 ARN,拿不到则收敛到 bgp/* 前缀)──
  if (res.secretArns?.length) {
    stmts.push({ Sid: "ReadDataSourceSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: res.secretArns });
    notes.push({ action: "secretsmanager:GetSecretValue", why: "读取数据源连接密钥(用户名/密码)以连库", scoped: true });
  } else {
    stmts.push({ Sid: "ReadDataSourceSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: `arn:aws:secretsmanager:${region}:${acct}:secret:bgp/*` });
    notes.push({ action: "secretsmanager:GetSecretValue", why: "读取数据源密钥;未指定具体密钥,已收敛到 bgp/* 前缀(建议改为精确 ARN)", scoped: false });
    cautions.push("未提供数据源密钥 ARN:密钥权限收敛到 bgp/* 前缀,建议改为该作业实际用到的精确密钥 ARN。");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── ⓿ **引擎必备基线**(无条件并入;唯一真值源 `engine-baseline.ts`)──────────
  //
  // 🔴🔴 2026-09-22 事故的根治位置。原来本函数把权限**全部**交给调用方的资源画像决定:
  //   调用方没填 `s3Buckets` ⇒ 只往 `cautions` 塞一句提示文字,**然后照样把角色建出来**
  //   ⇒ copilot 建的 EMR 作业一跑就 `AccessDenied: s3:PutObject .../emr-logs/.../job-metadata.log`,
  //     而那个角色其实**一条 S3 语句都没有**(脚本也读不到、输出也写不了)。
  // 🔴 一句 `cautions` 提示文字**挡不住一个坏角色被创建** —— 本仓铁律「登记不算过关」的同一形状。
  // ⇒ 「这个引擎跑起来就必须有的权限」不再依赖调用方填对,由平台自己派生;
  //   资源画像从此只负责**额外**的收敛(用户自己的桶/密钥),不负责必备项。
  // 封闭判据:**一键建出来的角色必须至少能跑通平台默认角色能跑通的那件事。**
  // ══════════════════════════════════════════════════════════════════════════
  if (acct) {
    for (const need of engineBaseline(engine, { region, accountId: acct })) {
      stmts.push({ Sid: need.sid, Effect: "Allow", Action: need.actions, Resource: need.resources });
      notes.push({ action: need.actions.slice(0, 3).join(" / "), why: `【必备】${need.why}`, scoped: !need.resources.includes("*") });
    }
  } else {
    cautions.push("🔴 未提供 accountId:无法派生引擎必备权限(日志落点 / 脚本桶 / 日志组)的资源 ARN ——"
      + "一键创建会被拒绝(fail-closed),免得建出一个一跑就 AccessDenied 的角色。");
  }

  // ── S3:读写数据桶(收敛到桶;缺则提示)──
  if (res.s3Buckets?.length) {
    const bucketArns = res.s3Buckets.map((b) => `arn:aws:s3:::${b}`);
    const objectArns = res.s3Buckets.map((b) => `arn:aws:s3:::${b}/*`);
    stmts.push({ Sid: "S3DataAccess", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"], Resource: [...bucketArns, ...objectArns] });
    notes.push({ action: "s3:GetObject/PutObject/ListBucket", why: `读写数据/脚本/结果所在 S3 桶(${res.s3Buckets.join(", ")})`, scoped: true });
  } else {
    cautions.push("未提供 S3 桶:请补充脚本桶/数据桶/S3 Tables 表桶,以便把 S3 权限收敛到具体桶(而非 *)。");
  }

  // ── S3 Tables(Iceberg):需 s3tables + glue catalog + lakeformation ──
  if (res.needsS3Tables) {
    stmts.push({ Sid: "S3TablesIceberg", Effect: "Allow", Action: ["s3tables:GetTable", "s3tables:GetTableData", "s3tables:PutTableData", "s3tables:GetNamespace", "s3tables:ListTables", "s3tables:GetTableBucket"], Resource: "*" });
    stmts.push({ Sid: "LakeFormationForS3Tables", Effect: "Allow", Action: ["lakeformation:GetDataAccess"], Resource: "*" });
    notes.push({ action: "s3tables:* / lakeformation:GetDataAccess", why: "读写 S3 Tables(Iceberg)表数据;S3 Tables 资源级 ARN 支持有限,部分需 *", scoped: false });
    res.needsGlueCatalog = true; // S3 Tables 经 Glue catalog 访问
  }

  // ── Glue 数据目录 ──
  if (res.needsGlueCatalog) {
    stmts.push({ Sid: "GlueCatalog", Effect: "Allow", Action: ["glue:GetDatabase", "glue:GetDatabases", "glue:GetTable", "glue:GetTables", "glue:GetPartition", "glue:GetPartitions", "glue:CreateTable", "glue:UpdateTable", "glue:BatchCreatePartition"], Resource: [`arn:aws:glue:${region}:${acct}:catalog`, `arn:aws:glue:${region}:${acct}:database/*`, `arn:aws:glue:${region}:${acct}:table/*`] });
    notes.push({ action: "glue:Get*/Create*/Update* (catalog)", why: "读写 Glue 数据目录的库/表/分区元数据", scoped: true });
  }

  // ── Redshift Data API ──
  if (res.needsRedshift) {
    stmts.push({ Sid: "RedshiftDataApi", Effect: "Allow", Action: ["redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement", "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-serverless:GetCredentials"], Resource: "*" });
    notes.push({ action: "redshift-data:* / redshift-serverless:GetCredentials", why: "经 Redshift Data API 写数仓(建表/COPY/查询);Data API 多为账号级动作", scoped: false });
  }

  // ── CloudWatch Logs ──
  // 🔴🔴 **这一块已移入必备基线**(`engine-baseline.ts` 的 `BaselineCloudWatchLogs`)。
  //   原实现对**所有**引擎都写 `arn:...:log-group:/aws-glue/*:*` —— 那是 **Glue** 的日志组:
  //   EMR Serverless 用 `/aws/emr-serverless/*`、Flink 用 `/aws/kinesis-analytics/*`、DMS 用 `dms-tasks-*`。
  //   于是「看起来给了日志权限」而对三个引擎实际一条也没给(线上那个坏角色就是这样)。
  //   这是「有静默合法默认值的参数 = 一整类缺陷」的又一例:对 Glue 正确的默认值,套到别的引擎上是**静默错误**。
  // 🔴 `needsCloudWatchLogs: false` 这个开关随之废掉:四个引擎**都**要写日志,把它做成可关的开关
  //   就等于留了一个「一关就静默跑不起来」的口子。字段保留只为兼容老调用方,不再影响产出。
  if (!needsLogs) {
    cautions.push("`needsCloudWatchLogs: false` 已不再生效:写日志是各引擎的必备权限(见必备基线),"
      + "关掉它只会让作业静默失败。");
  }

  // ── 引擎专属托管策略(AWS 官方最小 service-role)──
  if (engine === "glue") managedPolicyArns.push("arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole");

  const permissionPolicy: PolicyDocument = { Version: "2012-10-17", Statement: stmts };

  const scopedCount = notes.filter((n) => n.scoped).length;
  const reasoning = [
    `为 ${ENGINE_LABEL[engine]} 作业推荐的最小权限执行角色:信任策略仅允许 ${ENGINE_SERVICE[engine]} 承担本角色;`,
    `权限按本作业实际访问的资源收敛(${scopedCount}/${notes.length} 项已精确到资源 ARN)。`,
    cautions.length ? `有 ${cautions.length} 处因缺少输入用了较宽范围,建议补全后收敛(见提示)。` : `全部权限已尽量收敛到具体资源。`,
    `可「复制策略」自建角色后贴 ARN,或「${ROLE_APPLY_BUTTON_LABEL}」(平台建为 ${normalizeRoleName(req.roleNameHint, engine)};已存在则按必备权限清单对账补齐;挂权限边界防提权)。`,
  ].join("");

  return {
    engine,
    trustPolicy,
    permissionPolicy,
    managedPolicyArns,
    notes,
    reasoning,
    proposedRoleName: normalizeRoleName(req.roleNameHint, engine),
    cautions,
  };
}
