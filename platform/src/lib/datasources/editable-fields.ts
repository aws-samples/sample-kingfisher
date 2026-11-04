// (用户 2026-10-15 反馈 ①「编辑数据源改名报错」)
// 🔴 数据源「编辑」能改哪些字段 —— **闭合清单,单一作者**:编辑弹窗按它挑出要提交的字段,PUT /api/datasources/[id] 按它过滤请求体。
//
// 为什么存在(…7698 页面复现,2026-10-15 05:24Z):编辑弹窗打开时把**整条记录**灌进表单(`form.setFieldsValue(editing)`),
//   JDBC 类型提交时又把 `form.getFieldsValue(true)` 原样 PUT 回去 —— 带着主键 `datasourceId`、租户 `userId`、服务端字段
//   `updatedAt / createdAt / status / secretArn / glueConnectionName / networkConfig / heartbeat / discovery …`;服务端只删了几个租户字段
//   就把其余全部拼进 DynamoDB `SET`,又另加 `#upd = :now` ⇒ DynamoDB 拒「Two document paths overlap … [updatedAt]」⇒ 500,
//   用户看到的就是「改个名字都报错」。根因是「哪些字段可编辑」没有定义处(AGENTS §11 第 2 条:不许有静默合法默认值 / 清单先于接线)。
//
// 边界(诚实):改 host / port / database / username 只改记录,**不**同步改 Glue 连接的 JDBC URL / secret 里的用户名
//   (那是另一条待办,见台账);密码改了会同步到 Secrets Manager(服务端既有逻辑)。

/** 用户在编辑弹窗里能改、服务端允许落库的字段(按范式取交集;不在清单里的键一律丢弃并记日志)。 */
export const DS_EDITABLE_FIELDS = [
  "name",         // 显示名
  "type",         // 数据库类型(改类型会改变范式,仍允许:与新建时的 type 同一校验路径)
  "env",          // 环境标签 dev / test / prod
  "tags",         // 标签
  "description",  // 说明
  "host", "port", "database", "username", "password", // JDBC 连接(password 只在用户填了时才带,服务端同步到 secret 后不落库)
  "jdbcParams",   // 附加 JDBC 连接参数(空串 = 清空;变了与改 host 同列,先同步 Glue 连接再落库)
  "connection",   // 非 JDBC 范式的连接袋(kinesis / msk / dynamodb / s3)
  "probeVia",     // 探测方式(闭合清单,服务端另校验)
  "network",      // 网络接入 { subnetId, securityGroupIds[], availabilityZone? }(服务端转成 networkConfig 并改 Glue 连接)
] as const;

export type DsEditableField = (typeof DS_EDITABLE_FIELDS)[number];

const EDITABLE = new Set<string>(DS_EDITABLE_FIELDS);

/**
 * 从任意对象里挑出可编辑字段;`undefined` 值丢弃(DynamoDB 不接受 undefined,且「没填」≠「清空」),
 * `password` 为空串也丢弃(编辑时密码框留空 = 不改密码)。返回 `{ picked, dropped }`,dropped 给调用方记日志。
 */
export function pickEditableDatasourceFields(body: Record<string, unknown> | null | undefined): { picked: Record<string, unknown>; dropped: string[] } {
  const picked: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    if (!EDITABLE.has(k)) { dropped.push(k); continue; }
    if (v === undefined) continue;
    if (k === "password" && (v === "" || v === null)) continue;
    picked[k] = v;
  }
  return { picked, dropped };
}
