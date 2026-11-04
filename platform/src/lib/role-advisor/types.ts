// 角色顾问(IAM Role Advisor)— 公共契约。
//
// 定位:托管服务(Glue/EMR/DMS/Flink)创建任务必须指定执行角色,但用户不知道该建什么角色、给哪些权限。
// 与网络顾问 / 参数顾问平级——凡是要填「执行角色 ARN」的地方,都提供:
//   A. 推荐:据作业引擎 + 数据源/目标,生成【最小权限策略 JSON + 信任策略】,可复制自建后贴 ARN。
//   B. 一键创建:平台按推荐直接建角色(受控前缀 bgp-job-role-* + PermissionsBoundary 防提权),返回 ARN。
//   C. 贴 ARN:用户自带角色(已有执行角色字段)。
// 推荐值恒由确定性引擎(规则驱动,IAM 策略本就是规则)给出——不用大模型编策略,杜绝幻觉出错误权限。

// 作业引擎——决定信任策略的 Principal(哪个 AWS 服务 assume 这个角色)。
export type RoleEngine = "glue" | "emr" | "dms" | "flink";

// 作业要访问的资源(据此收敛最小权限)。全部可选:消费方能填多少填多少,缺失则给保守占位。
export interface RoleResourceProfile {
  // 读源:数据源密钥(Secrets Manager)ARN / 前缀。
  secretArns?: string[];
  // 读/写数据湖:S3 桶名(数据桶 + 脚本桶 + S3 Tables 表桶)。
  s3Buckets?: string[];
  // 写数仓:是否需要 Redshift Data API(BatchExecuteStatement 等)。
  needsRedshift?: boolean;
  // 是否读写 S3 Tables(Iceberg)——需 s3tables + glue catalog + lakeformation。
  needsS3Tables?: boolean;
  // 是否需要 Glue 数据目录(Glue/EMR 读 catalog)。
  needsGlueCatalog?: boolean;
  // CloudWatch Logs(几乎都需要,写作业日志)。默认 true。
  needsCloudWatchLogs?: boolean;
}

// 顾问入口请求——消费方(各作业面板)填这个。
export interface RoleAdviceRequest {
  engine: RoleEngine;
  resources?: RoleResourceProfile;
  region?: string;
  accountId?: string;
  // 期望角色名(一键创建用;省略则平台按引擎+时间生成受控名)。仅字母数字/连字符,平台强制加 bgp-job-role- 前缀。
  roleNameHint?: string;
}

// 一条 IAM 语句(展示用,结构与 AWS policy 一致)。
export interface PolicyStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
}

export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
}

// 一条权限说明(给用户看"为什么要这个权限")。
export interface PermissionNote {
  action: string; // 如 "secretsmanager:GetSecretValue"
  why: string; // 人话:为什么需要
  scoped: boolean; // 是否已收敛到具体资源(false=不得不用 * ,提示用户)
}

// 顾问产物。
export interface RoleAdvice {
  engine: RoleEngine;
  trustPolicy: PolicyDocument; // AssumeRolePolicyDocument(信任哪个服务)
  permissionPolicy: PolicyDocument; // 内联最小权限策略
  managedPolicyArns: string[]; // 建议附加的 AWS 托管策略(如 service-role/AWSGlueServiceRole)
  notes: PermissionNote[]; // 逐条权限理由
  reasoning: string; // 总体人话说明
  // 一键创建时平台将使用的受控角色名(前缀固定);仅供预览。
  proposedRoleName: string;
  // 建议但需用户补的信息(如未提供 secret/桶,给占位并提示)。
  cautions: string[];
}
