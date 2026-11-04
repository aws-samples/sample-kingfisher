// 模块 31 (R5) — DMS→Redshift 目标侧准备(固化踩坑 ④⑤⑥ 的解法)。
//
// DMS 直连 Redshift 做 COPY 有三个隐蔽前置,本模块用 Redshift Data API(admin 身份)+
// redshift-serverless SDK 幂等完成:
//  ④ 建专用用户 dms_ingest(密码自控、无 DMS 禁用字符 {},;),写完整字段的专用 secret;
//     (Redshift 托管 admin secret 缺 host/port 且密码含禁用字符,不能直接喂 DMS)
//  ⑤ 预建目标 schema(DMS 默认用源 schema 名作目标 schema,但不自动建);
//  ⑥ 把 DMS COPY 角色关联到 Redshift namespace(否则 COPY 报 role not associated to cluster)。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { randomBytes } from "crypto";
import { logger } from "@/lib/observability/logger";
// @kf-batch 50-P50.1-workgroup-ssot — 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup } from "@/lib/redshift/warehouse-location";

const region = homeRegion();
const WORKGROUP = homeWorkgroup();
const NAMESPACE = process.env.REDSHIFT_NAMESPACE || "bgp-namespace";
const DATABASE = process.env.REDSHIFT_DATABASE || "dev";
const DMS_TARGET_SECRET_ID = process.env.DMS_TARGET_SECRET_ID || "bgp/dms/redshift-target";
const DMS_INGEST_USER = "dms_ingest";

// 生成无 DMS 禁用字符({},;)、足够强的密码。base64url 不含这些字符。
function genDmsSafePassword(): string {
  return "Dms" + randomBytes(18).toString("base64url") + "9";
}

// 用 Redshift Data API 以 admin 身份执行 SQL,等待 FINISHED(轮询)。
async function execAdminSql(sql: string): Promise<void> {
  const { ExecuteStatementCommand, DescribeStatementCommand } = await import(
    "@aws-sdk/client-redshift-data"
  );
  const { redshiftClientForHomeOnly } = await import("@/lib/exec-env/target-clients");
  const { getRedshiftSecretArn } = await import("@/lib/redshift/admin-secret");
  // @kf-batch 50-WP2-directquery —— 合同 home-only(正确归宿是闭合执行器的 dms-ingest-bootstrap,归 P50.3 DMS 批次)
  const client = redshiftClientForHomeOnly("dms-bootstrap-home");
  // @kf-batch 52-P52.5a-supply — 静态归类:**admin-DDL / bootstrap**(建 dms_ingest 用户与 schema)。
  // 🔴 **不传 project**:它建的是 target 级的固定摄入身份,不属任何项目。
  // 🔴 **正确归宿是 `executeAdminDdl({operation:"dms-ingest-bootstrap"})`** —— 那条 operation 已经
  //    落地(模板 + 执行器都在),但把 realtime 整条链切过去要连 `ensureRedshiftDmsUser` 的口令路径
  //    一起改(它自己也在 `CREATE USER … PASSWORD` 里拼字面量),属 P50.3 的 DMS 组件批次。
  //    在此之前这里维持现状,**不假装已收口**。
  const SecretArn = await getRedshiftSecretArn();
  const { Id } = await client.send(
    new ExecuteStatementCommand({ Sql: sql, WorkgroupName: WORKGROUP, Database: DATABASE, ...(SecretArn ? { SecretArn } : {}) })
  );
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const d = await client.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FINISHED") return;
    if (d.Status === "FAILED" || d.Status === "ABORTED") throw new Error(`Redshift SQL 失败: ${d.Error || d.Status}`);
  }
  throw new Error("Redshift SQL 超时");
}

// 踩坑④:确保 dms_ingest 用户存在并重设已知密码,写完整字段 secret(密码不落日志)。
// 返回 DMS 目标 secret 的 id。
export async function ensureRedshiftDmsUser(redshiftHost: string): Promise<string> {
  const pwd = genDmsSafePassword();
  // CREATE 若已存在会报错→先尝试 ALTER 重设;用 IF 逻辑:先 CREATE(忽略已存在),再 ALTER 统一密码。
  try {
    await execAdminSql(`CREATE USER ${DMS_INGEST_USER} PASSWORD '${pwd}' CREATEDB;`);
  } catch {
    await execAdminSql(`ALTER USER ${DMS_INGEST_USER} PASSWORD '${pwd}';`);
  }
  // 写完整字段 secret(DMS 需要 host/port/database)。密码仅写入 Secrets Manager,不进日志。
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  const sm = sdkClient("data-plane", SecretsManagerClient, { region });
  const secretString = JSON.stringify({
    username: DMS_INGEST_USER,
    password: pwd,
    host: redshiftHost,
    port: 5439,
    database: DATABASE,
  });
  try {
    await sm.send(new CreateSecretCommand({ Name: DMS_TARGET_SECRET_ID, SecretString: secretString }));
  } catch {
    await sm.send(new PutSecretValueCommand({ SecretId: DMS_TARGET_SECRET_ID, SecretString: secretString }));
  }
  logger.info("realtime.redshift.dmsuser.ready", { user: DMS_INGEST_USER }); // 不记密码
  return DMS_TARGET_SECRET_ID;
}

// 踩坑⑤:预建目标 schema(owner=dms_ingest)。
export async function ensureTargetSchema(schemaName: string): Promise<void> {
  // 🔴 并发安全:`IF NOT EXISTS` 挡不住两个实时任务同时建同一个 schema(见 lib/redshift/concurrent-schema.ts)。
  const sql = `CREATE SCHEMA IF NOT EXISTS ${schemaName} AUTHORIZATION ${DMS_INGEST_USER};`;
  const { withSchemaCreateRetry } = await import("@/lib/redshift/concurrent-schema");
  await withSchemaCreateRetry(sql, () => execAdminSql(sql));
  logger.info("realtime.redshift.schema.ready", { schema: schemaName });
}

// 根因治理(坑5):Redshift Serverless 命名空间【一次只允许一个变更操作】。刚在库里建完
// dms_ingest 用户 + schema(DDL 会短暂锁 namespace),紧接着 UpdateNamespace 关联 COPY 角色
// 常撞 `ConflictException: There is an operation running on the namespace`。此前需人工等锁释放
// 再重试。改为带指数退避的自动重试,启动流程一次成功,后续用户零踩坑。
async function withNamespaceRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const delays = [3000, 6000, 10000, 15000, 20000]; // 最多重试 5 次(累计约 54s)
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const conflict = e?.name === "ConflictException" || /operation running on the namespace/i.test(String(e?.message));
      if (!conflict || i >= delays.length) throw e;
      logger.info("realtime.redshift.namespace.locked.retry", { label, attempt: i + 1, waitMs: delays[i] });
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

// 踩坑⑥:把 DMS COPY 角色关联到 Redshift namespace(幂等:已含则不重复)。
export async function ensureRoleAssociatedToNamespace(dmsRoleArn: string): Promise<void> {
  const { RedshiftServerlessClient, GetNamespaceCommand, UpdateNamespaceCommand } = await import(
    "@aws-sdk/client-redshift-serverless"
  );
  const rs = sdkClient("data-plane", RedshiftServerlessClient, { region });
  await withNamespaceRetry(async () => {
    const { namespace } = await rs.send(new GetNamespaceCommand({ namespaceName: NAMESPACE }));
    const current = (namespace?.iamRoles || [])
      .map((r) => (r.match(/arn:aws:iam::[^,)"\s]+/) || [r])[0])
      .filter(Boolean) as string[];
    if (current.includes(dmsRoleArn)) return; // 已关联
    await rs.send(new UpdateNamespaceCommand({ namespaceName: NAMESPACE, iamRoles: [...current, dmsRoleArn] }));
    logger.info("realtime.redshift.role.associated", { role: dmsRoleArn });
  }, "associate-copy-role");
}

export { genDmsSafePassword, DMS_INGEST_USER };
