// DMS→Redshift 目标侧准备(固化踩坑 ④⑤⑥ 的解法),**按任务落点的那个区**做。
//
// DMS 直连 Redshift 做 COPY 有三个隐蔽前置:
//  ④ 专用数仓用户(口令自控、无 DMS 禁用字符 {},;)+ 含完整连接字段的专用密钥;
//     (Redshift 托管 admin secret 缺 host/port 且口令含禁用字符,不能直接喂 DMS)
//  ⑤ 预建目标 schema(DMS 默认用源库名作目标 schema,但不自动建);
//  ⑥ 把 DMS COPY 角色关联到该区数仓的命名空间(否则 COPY 报 role not associated to cluster)。
//
// 🔴 ④⑤ 是管理员身份的 DDL ⇒ 只经**受控 DDL 执行器**(`lib/exec-env/admin-ddl-executor.ts`)做:准入、意图审计、
//    管理员凭证都在那里,本文件不碰管理员凭证、也不拼 SQL。主控区与执行区同一条路 ——
//    2026-11 之前这里握着主控区的数仓客户端自己拼 `CREATE USER … PASSWORD`,只能给主控区准备。
// 🔴 落点是带品牌的 `DmsPlace`(`lib/realtime/dms-place.ts`),每个导出函数第一个参数就是它:漏传是编译错。

import { GetNamespaceCommand, GetWorkgroupCommand, UpdateNamespaceCommand } from "@aws-sdk/client-redshift-serverless";
import { logger } from "@/lib/observability/logger";
import { executeAdminDdl, provisionDmsIngestUser, systemActor } from "@/lib/exec-env/admin-ddl-executor";
import { redshiftServerlessClientFor } from "@/lib/exec-env/target-clients";
import type { DmsPlace } from "@/lib/realtime/dms-place";

/** 系统主体的用途名(审计里一眼认出是哪条后台流程)。 */
const ACTOR_REASON = "dms-ingest-bootstrap";

/** 同一个区的「建用户 + 写密钥」在本进程内排队:两条任务同时首次启动时,后到的那条等前一条写完、直接复用密钥。 */
const provisioning = new Map<string, Promise<unknown>>();

export interface DmsIngestUserReady {
  /** 目标端点引用的密钥名(该区 Secrets Manager) */
  secretId: string;
  /** 本次是否新供给(建用户 / 重设口令);false = 密钥已在、原样复用 */
  provisioned: boolean;
}

/**
 * 踩坑④:该区数仓里的 DMS 摄入用户与连接密钥就位。
 * 缺省「有则复用」;`rotate` = 重设口令并覆盖密钥(目标端连通性测试失败后由启动编排有界地调一次)。
 */
export async function ensureRedshiftDmsUser(place: DmsPlace, opts: { rotate?: boolean } = {}): Promise<DmsIngestUserReady> {
  const key = place.targetId;
  const prior = provisioning.get(key) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => provisionDmsIngestUser(systemActor(ACTOR_REASON), { targetId: place.targetId, rotate: opts.rotate === true }));
  provisioning.set(key, run);
  try {
    const r = await run;
    logger.info("realtime.redshift.dmsuser.ready", { targetId: place.targetId, outcome: r.outcome }); // 不记口令
    return { secretId: r.secretName, provisioned: r.outcome === "provisioned" };
  } finally {
    if (provisioning.get(key) === run) provisioning.delete(key);
  }
}

/** 踩坑⑤:预建目标 schema(属主 = 摄入用户;幂等,并发建同名 schema 的撞车由执行器内的重试吸收)。 */
export async function ensureTargetSchema(place: DmsPlace, schemaName: string): Promise<void> {
  await executeAdminDdl(systemActor(ACTOR_REASON), { operation: "dms-ingest-bootstrap", targetId: place.targetId, schema: schemaName });
  logger.info("realtime.redshift.schema.ready", { targetId: place.targetId, schema: schemaName });
}

// 根因治理(坑5):Redshift Serverless 命名空间【一次只允许一个变更操作】。刚在库里建完
// 摄入用户 + schema(DDL 会短暂锁 namespace),紧接着 UpdateNamespace 关联 COPY 角色
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

/**
 * 踩坑⑥:把 DMS COPY 角色关联到该区数仓的命名空间(幂等:已含则不重复)。
 * 命名空间名从该区工作组的事实里取(`GetWorkgroup`),不读环境变量、不猜名字。
 */
export async function ensureRoleAssociatedToNamespace(place: DmsPlace): Promise<void> {
  const rs = await redshiftServerlessClientFor(place.warehouse.region);
  const { workgroup } = await rs.send(new GetWorkgroupCommand({ workgroupName: place.warehouse.workgroup }));
  const namespaceName = workgroup?.namespaceName;
  if (!namespaceName) {
    throw new Error(`查不到工作组 ${place.warehouse.workgroup}(${place.warehouse.region})所属的命名空间 ⇒ 无法关联 DMS COPY 角色`);
  }
  await withNamespaceRetry(async () => {
    const { namespace } = await rs.send(new GetNamespaceCommand({ namespaceName }));
    const current = (namespace?.iamRoles || [])
      .map((r) => (r.match(/arn:aws:iam::[^,)"\s]+/) || [r])[0])
      .filter(Boolean) as string[];
    if (current.includes(place.roleArn)) return; // 已关联
    await rs.send(new UpdateNamespaceCommand({ namespaceName, iamRoles: [...current, place.roleArn] }));
    logger.info("realtime.redshift.role.associated", { targetId: place.targetId, role: place.roleArn });
  }, "associate-copy-role");
}
