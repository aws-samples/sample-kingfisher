// DMS 写目标数仓用的**专用身份**的名字(唯一作者)。
//
// 每个执行区的数仓里各有一个同名的摄入用户,口令放在该区 Secrets Manager 里同名的密钥中
// (密钥本来就是区内对象,所以名字不必带区)。建用户 / 设口令 / 写密钥只在受控 DDL 执行器里做
// (`lib/exec-env/admin-ddl-executor.ts#provisionDmsIngestUser`);建目标 schema 的模板与 DMS 端点都从这里取名字。

/** 目标数仓里的 DMS 摄入用户名。 */
export const DMS_INGEST_USER = "dms_ingest";

/** 该用户的连接密钥名(JSON:username / password / host / port / database)。 */
export const DMS_TARGET_SECRET_NAME = "bgp/dms/redshift-target";
