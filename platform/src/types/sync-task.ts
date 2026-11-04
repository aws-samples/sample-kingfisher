import type { SyncCapabilityFields } from "@/lib/sync/run-vars";

export interface SyncTask {
  userId: string;
  taskId: string;
  name: string;
  // DDB 行已带(读侧 `api/datasources`/`api/sync` 在按它 projectFilter),类型层此前缺失。
  // run 盖章以任务行的 projectId 为权威,故必须在类型上可见。存量行没有 ⇒ 可选。
  projectId?: string;
  datasourceId: string;
  // 源库名只有 JDBC 范式的源才有(S3 / DynamoDB 源的定位在数据源连接袋里,这类任务行上没有这个键)
  sourceDatabase?: string;
  sourceTables: string[];
  targetType: "s3-tables" | "redshift" | "both";
  s3Config?: {
    tableBucketArn: string;
    namespace: string;
    partitionFields: { field: string; type: string }[];
  };
  redshiftConfig?: {
    workgroupName: string;
    database: string;
    schema: string;
    sortKeys: string[];
    distKey: string;
    distStyle: "auto" | "key" | "even" | "all";
  };
  syncMode: "full" | "incremental";
  writeMode: "append" | "overwrite" | "merge";
  mergeKeys: string[];
  channel: "zero-etl" | "glue" | "dms";
  // Glue 通道作业资源(对齐 Glue console 创建页,参数齐全暴露;不填用平台默认)。
  glueConfig?: {
    workerType?: string; // G.1X | G.2X | G.4X
    numberOfWorkers?: number; // 2..20
    glueVersion?: string; // 闭合清单 + 缺省见 lib/sync/glue-version.ts(缺省最高,可降版)
    timeoutMinutes?: number; // Job timeout
    maxRetries?: number; // Number of retries
    executionRoleArn?: string; // 执行角色(留空=平台默认 GLUE_ROLE_ARN;填=自定义最小权限角色)
  };
  // 网络配置(Glue/DMS 通道连 VPC 内源库或私有目标时用;留空=沿用数据源的 Glue Connection/平台默认)。
  // 网络顾问「应用建议」把裁决出的私有子网+SG 回填到这里,使建议真正落地(此前只诊断不能应用)。
  network?: {
    subnetIds?: string[];
    securityGroupIds?: string[];
  };
  // DMS 通道任务设置(对齐 DMS console 创建任务页 Task settings;不填用 AWS 默认)。
  dmsSettings?: {
    targetTablePrepMode?: "DO_NOTHING" | "DROP_AND_CREATE" | "TRUNCATE_BEFORE_LOAD";
    lobMode?: "limited" | "full" | "none";
    lobMaxSizeKB?: number;
    batchApplyEnabled?: boolean;
    validationEnabled?: boolean;
    fullLoadMaxSubTasks?: number;
    commitRate?: number;
  };
  // succeeded:批同步(glue 通道)跑成后的终态;stopped 仅表示人工停止/常驻通道关闭。
  status: "draft" | "running" | "succeeded" | "stopped" | "error";
  glueJobName?: string;
  integrationArn?: string;
  cronExpression?: string;
  // SCH-03 dependency scheduling: IDs of downstream sync tasks / workflows to trigger
  // automatically when this task's run succeeds.
  triggers?: string[];
  // SYNC-07 target table naming: uniform prefix/suffix + optional per-source overrides.
  targetTablePrefix?: string;
  targetTableSuffix?: string;
  targetTableNames?: Record<string, string>;
  // 新能力(全部可选,不填 = 改动前行为)。合法形态的唯一作者 =
  //   lib/sync/run-vars.ts(validateSyncCapabilityFields);语义见那里的文件头。
  whereClause?: SyncCapabilityFields["whereClause"];
  businessTimezone?: SyncCapabilityFields["businessTimezone"];
  derivedColumns?: SyncCapabilityFields["derivedColumns"];
  overwriteScope?: SyncCapabilityFields["overwriteScope"];
  partitionKeys?: SyncCapabilityFields["partitionKeys"];
  allowEmptyOverwrite?: SyncCapabilityFields["allowEmptyOverwrite"];
  sourceColumns?: SyncCapabilityFields["sourceColumns"];
  // 带日期变量的源表名 → 样例表(源库里一张同结构的真表;只用来读列结构,不会被同步)。
  //   向导据此给模板一份列映射(fieldMappings[模板] = 样例表的列),第 1 步 / 建表预览 / 派生列候选都能看到列。
  templateSampleTables?: Record<string, string>;
  // 生产上线批次 A:用户逐表确认过「整表清空」的目标表(Redshift `schema.table` 与 S3 Tables
  //   `s3tablescatalog.namespace.table` 两种形态;唯一作者 lib/sync/target-table-guard.ts)。
  overwriteConfirmedTables?: string[];
  // 升级兼容:既有目标收养的时间戳(ISO)。🔴 只有服务端写(lib/sync/foreign-guard-adoption.ts,
  //   首次运行时一次性写入);PUT 路由剔除客户端传来的这个键。存在 = 收养已判过(不再查 run 台账)。
  foreignGuardAdoptedAt?: string;
  createdAt: string;
  updatedAt: string;
}
