"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Table, Button, Space, Tag, Modal, Drawer, Input, message, Badge, Popconfirm,
  Card, Descriptions, Alert, Tooltip, Statistic, Select, InputNumber, Switch, Collapse, Typography,
} from "antd";
import {
  PlusOutlined, PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined,
  ThunderboltOutlined, ExperimentOutlined, ApiOutlined, UploadOutlined, DeleteOutlined,
} from "@ant-design/icons";
import Editor from "@monaco-editor/react";
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import ParamAdvisorPanel from "@/components/param-advisor/ParamAdvisorPanel";
// 序 72 B-139:执行角色改为选择器(三组下拉 + 刷新 + 手填兜底 + 检查权限;角色顾问面板在其内)
import ExecutionRolePicker from "@/components/exec-roles/ExecutionRolePicker";
import { useAuth } from "@/lib/auth/AuthProvider";
// @kf-batch 50-WP4quater-reads(工单 SC-5)—— 实时作业按执行范围。用户 2026-09-10:
// 「一定要加这个维度,不然白干了,所有任务都在自己的区域跑,不然没有意义。」
// 列表按 `?scope=` 过滤;**新建时的默认落点 = 顶栏当前视角**(单区视角 ⇒ 就建在那个区)。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { groupsFromToken } from "@/lib/auth/roles";
import { useT } from "@/lib/i18n/useT";
import { adviseFailure } from "@/lib/realtime/failure-advisor";
// 序 46 B-107 — 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";

const statusBadge: Record<string, any> = {
  draft: "default", starting: "processing", running: "success",
  stopping: "processing", stopped: "warning", error: "error", deleting: "processing", deleted: "error",
};
// 状态中文展示(deleted = AWS 平台已删除,与用户主动 stopped 区分)。
const statusLabel: Record<string, string> = {
  draft: "草稿", starting: "启动中", running: "运行中",
  stopping: "停止中", stopped: "已停止", error: "失败", deleting: "删除中", deleted: "AWS已删除",
};
const appStatusColor: Record<string, string> = {
  RUNNING: "green", STARTING: "blue", UPDATING: "blue", READY: "default",
  STOPPING: "orange", FORCE_STOPPING: "orange", DELETING: "red", NOT_DEPLOYED: "default",
};

const DEFAULT_SQL = `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

CREATE TABLE region_agg_sink (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
) WITH (
  'connector' = 'filesystem',
  'path' = '\${OUTPUT_PATH}',
  'format' = 'json',
  'sink.rolling-policy.rollover-interval' = '30 s',
  'sink.rolling-policy.check-interval' = '10 s'
);

INSERT INTO region_agg_sink
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;

const MYSQL_SQL = `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

CREATE TABLE region_agg_mysql (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT,
  PRIMARY KEY (window_start, region) NOT ENFORCED
) WITH (
  'connector' = 'jdbc',
  'url' = '\${MYSQL_URL}',
  'table-name' = 'flink_region_agg',
  'username' = '\${MYSQL_USER}',
  'password' = '\${MYSQL_PASSWORD}',
  'sink.buffer-flush.max-rows' = '200',
  'sink.buffer-flush.interval' = '3s'
);

INSERT INTO region_agg_mysql
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;

const S3TABLE_SQL = `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

CREATE CATALOG s3t WITH (
  'type' = 'iceberg',
  'catalog-impl' = 'software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse' = '\${TABLE_BUCKET_ARN}'
);

CREATE DATABASE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`;

CREATE TABLE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`.\`flink_region_agg\` (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
);

INSERT INTO s3t.\`\${S3TABLE_DB}\`.\`flink_region_agg\`
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;

const CUSTOM_SQL = `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

-- 自定义 sink(示例:OpenSearch,连接器 JAR 由你在「连接器管理」上传,启动时与基础 runner 合并)
CREATE TABLE region_agg_os (
  window_start STRING,
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT,
  PRIMARY KEY (window_start, region) NOT ENFORCED
) WITH (
  'connector' = 'opensearch-2',
  'hosts' = '\${OPENSEARCH_HOSTS}',
  'index' = 'flink_region_agg',
  'username' = '\${OPENSEARCH_USER}',
  'password' = '\${OPENSEARCH_PASSWORD}'
);

INSERT INTO region_agg_os
SELECT DATE_FORMAT(window_start, 'yyyy-MM-dd HH:mm:ss') AS window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;

// 模块32 多 source —— MySQL CDC(直接消费 binlog)→ S3 Table(Iceberg,小批次写入)。
// 源表用 'connector'='mysql-cdc'(Flink CDC 内嵌 Debezium 读 binlog);${SRC_*} 占位符启动时
// 从所选「源数据源」的 Secrets Manager 注入(不入库)。目标为 S3 Table,原样同步(不聚合)。
// 🔴 模板读的表必须在【本部署实际存在】。原模板写死 'table-name'='products',但 products 只由
//    scripts/seed_ecommerce.py 建在 ecommerce 库;平台注册的 MySQL 数据源是 gamedata 库
//    (scripts/seed_game.py 建 players/payments/game_sessions/…,没有 products)→ 开箱即崩:
//    `IllegalArgumentException: Can't find any matched tables ... database-name:[gamedata] table-name:[gamedata.products]`
//    (SplitEnumerator 启动阶段就失败,0 个 checkpoint)。改用 payments —— gamedata 里真实存在,
//    且与已跑通的样板作业(GameFlink-RT-GMV-byProduct)同源,是本部署唯一可开箱即跑的选择。
const MYSQL_CDC_S3T_SQL = `-- 源:MySQL binlog CDC(Flink CDC,直接读 binlog;需选 VPC 子网+安全组连私有 RDS)
CREATE TABLE payments_cdc (
  payment_id BIGINT,
  player_id BIGINT,
  amount_usd DECIMAL(10,2),
  product_id STRING,
  pay_time TIMESTAMP(3),
  PRIMARY KEY (payment_id) NOT ENFORCED
) WITH (
  'connector' = 'mysql-cdc',
  'hostname' = '\${SRC_HOSTNAME}',
  'port' = '\${SRC_PORT}',
  'username' = '\${SRC_USERNAME}',
  'password' = '\${SRC_PASSWORD}',
  'database-name' = '\${SRC_DATABASE}',
  'table-name' = 'payments',
  'server-id' = '5400-5404',
  'scan.incremental.snapshot.enabled' = 'true'
);

CREATE CATALOG s3t WITH (
  'type' = 'iceberg',
  'catalog-impl' = 'software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse' = '\${TABLE_BUCKET_ARN}'
);

CREATE DATABASE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`;

CREATE TABLE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`.\`payments_cdc\` (
  payment_id BIGINT,
  player_id BIGINT,
  amount_usd DECIMAL(10,2),
  product_id STRING,
  pay_time TIMESTAMP(3),
  PRIMARY KEY (payment_id) NOT ENFORCED
);

-- 小批次写入:checkpoint 间隔(默认 30s)即一批 flush 到 Iceberg。
INSERT INTO s3t.\`\${S3TABLE_DB}\`.\`payments_cdc\`
SELECT payment_id, player_id, amount_usd, product_id, pay_time FROM payments_cdc;`;

// 模块42 P42.6b/c — MSK/Kafka 源 → S3 裸文件(1 分钟滚动窗口聚合)。§11.4 定稿:
// 连接+认证全部占位注入(${KAFKA_TOPIC}/${KAFKA_AUTH_PROPS}),用户只写业务 schema/format/startup;
// 启动时 resolveMskSource 按所选 MSK 数据源展开(bootstrap+IAM/SCRAM 认证,密钥不入库)。
// 🔴 ${KAFKA_AUTH_PROPS} 是裸占位符(不在引号内),接在 'format'='json' 行后;guard 已验放行(§11.4)。
const MSK_S3_SQL = `-- 源:MSK/Kafka(需选 VPC 子网+安全组连私有 broker;topic/认证由所选 MSK 数据源注入)
CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = '\${KAFKA_TOPIC}',
  'scan.startup.mode' = 'earliest-offset',
  'format' = 'json'
  \${KAFKA_AUTH_PROPS}
);

CREATE TABLE region_agg_sink (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
) WITH (
  'connector' = 'filesystem',
  'path' = '\${OUTPUT_PATH}',
  'format' = 'json',
  'sink.rolling-policy.rollover-interval' = '30 s',
  'sink.rolling-policy.check-interval' = '10 s'
);

INSERT INTO region_agg_sink
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;

// Bug#5 — MSK/Kafka 源 → S3 Tables(托管 Iceberg)sink 组合模板。= MSK 源块(kafka connector,
// ${KAFKA_TOPIC}/${KAFKA_AUTH_PROPS} 启动注入)+ S3Tables iceberg sink 块(${TABLE_BUCKET_ARN}/${S3TABLE_DB} 注入)。
// 启动时 assembleModularUberJar 见 kafka+iceberg 组合 → 选组合包 flink-sql-runner-s3t-kafka(补 s3t 包缺的
// kafka connector)。真跑坐实 MSAF RUNNING + 窗口聚合落 Iceberg。需选 VPC 子网/SG 连私有 broker(同 MSK→S3)。
const MSK_S3T_SQL = `-- 源:MSK/Kafka(topic/认证由所选 MSK 数据源注入)→ sink:S3 Tables(托管 Iceberg)
CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = '\${KAFKA_TOPIC}',
  'scan.startup.mode' = 'earliest-offset',
  'format' = 'json'
  \${KAFKA_AUTH_PROPS}
);

CREATE CATALOG s3t WITH (
  'type' = 'iceberg',
  'catalog-impl' = 'software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse' = '\${TABLE_BUCKET_ARN}'
);

CREATE DATABASE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`;

CREATE TABLE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`.\`msk_region_agg\` (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
);

INSERT INTO s3t.\`\${S3TABLE_DB}\`.\`msk_region_agg\`
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;

export default function RealtimeComputePage() {
  const t = useT();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // 非空=编辑模式(PUT),空=新建(POST)
  // @kf-batch 50-WP18-flink-multi-region —— 新建时可**多选**执行区:流式作业天生一区一个应用 ⇒
  //   「一次发布多区」= 一次提交、每个区各建一个作业(用户 2026-09-15 点名)。
  const [newJobTargets, setNewJobTargets] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [sinkType, setSinkType] = useState("s3");
  const [sinkDsId, setSinkDsId] = useState<string | undefined>(undefined);
  // 模块32 多 source:数据源类型(kinesis 默认 / mysql-cdc 直读 binlog)。
  const [sourceType, setSourceType] = useState("kinesis");
  const [cdcDsId, setCdcDsId] = useState<string | undefined>(undefined); // MySQL CDC 源数据源(端口以数据源为准)
  // MySQL CDC 网络选择(下拉:真实 VPC/子网/SG,平台不自动猜可达性,用户选哪个透传 MSAF)。
  const [netVpcs, setNetVpcs] = useState<any[]>([]);
  const [netSubnets, setNetSubnets] = useState<any[]>([]);
  const [netSgs, setNetSgs] = useState<any[]>([]);
  const [cdcVpc, setCdcVpc] = useState<string | undefined>(undefined);
  const [cdcSubnets, setCdcSubnets] = useState<string[]>([]);
  const [cdcSgs, setCdcSgs] = useState<string[]>([]);
  const [mskTopic, setMskTopic] = useState(""); // 模块42 P42.6c:MSK 源主 topic(作业级,§11.4;注入 SQL 的 ${KAFKA_TOPIC})
  const [datasources, setDatasources] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  // 自定义连接器(上传 JAR)管理 + 自定义 sink 选择
  const [connOpen, setConnOpen] = useState(false);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [connLoading, setConnLoading] = useState(false);
  const [upName, setUpName] = useState("");
  const [upIdent, setUpIdent] = useState("");
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upLoading, setUpLoading] = useState(false);
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  // 自定义 sink 的 VPC 接入(用户自管:私有子网 + 安全组,逗号分隔)
  const [vpcSubnets, setVpcSubnets] = useState("");
  const [vpcSgs, setVpcSgs] = useState("");
  // 资源配置(KPU/并行度)
  const [parallelism, setParallelism] = useState(1);
  const [parallelismPerKPU, setParallelismPerKPU] = useState(1);
  const [execRole, setExecRole] = useState("");
  const { getToken } = useAuth();
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  // 新建落点:单区视角 = 那个区;分组 / 全部 = 主控区(与「顶栏视角决定新建默认落点」一致)
  const newJobTarget = scope.kind === "target" ? scope.targetId : undefined;
  const newJobRegion = newJobTarget ? scopeTargets?.find((x) => x.targetId === newJobTarget)?.region || newJobTarget : "";
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { (async () => { try { setIsAdmin(groupsFromToken(await getToken()).includes("bgp-admin")); } catch { /* 忽略 */ } })(); }, [getToken]);
  const [autoScaling, setAutoScaling] = useState(false);
  // 高级配置(对齐 MSAF console):checkpoint / 监控 / 快照 / 自定义运行时属性。
  const [ckEnabled, setCkEnabled] = useState(true);
  const [ckIntervalMs, setCkIntervalMs] = useState(30000);
  const [ckMinPauseMs, setCkMinPauseMs] = useState(5000);
  const [logLevel, setLogLevel] = useState("INFO");
  const [metricsLevel, setMetricsLevel] = useState("APPLICATION");
  // 默认开(与后端 normalizeResources 默认一致):有状态作业停止自动打快照、启动从快照恢复,
  // checkpointId 连续→根治 S3Tables 首帧 412。前后端默认必须一致,否则前端显式传 false 覆盖后端默认。
  const [snapshotsEnabled, setSnapshotsEnabled] = useState(true);
  const [runtimeProps, setRuntimeProps] = useState<Array<{ g: string; k: string; v: string }>>([]);
  const [detail, setDetail] = useState<any>(null); // {job, status}
  const [detailLoading, setDetailLoading] = useState(false);
  // AI 诊断(DevOps Agent):当前作业的诊断历史 + 进行中轮询
  const [diags, setDiags] = useState<any[]>([]);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagView, setDiagView] = useState<any>(null); // 查看某条诊断报告
  const diagPollRef = useRef<any>(null);
  const pollRef = useRef<any>(null);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/flink/jobs${scopeQs}`);
      const d = await r.json();
      setJobs(d.success ? d.data : Array.isArray(d) ? d : []);
    } finally { setLoading(false); }
  };
  // @kf-batch 50-WP4quater-reads —— 🔴 `scopeQs` 进 deps:切范围**不重载页面**,靠这里重拉(护栏 4)
  useEffect(() => {
    fetchJobs();
    fetchConnectors();
    // 🔴 源 / sink 数据源选择器也必须按区:在 usw2 建作业却挑到主控区的源,作业跑起来连不上
    fetch(`/api/datasources${scopeQs}`).then((r) => r.json()).then((d) => setDatasources((d.success ? d.data : d) || [])).catch(() => {});
    fetch(`/api/flink/meta?targetId=${encodeURIComponent(landingOfScope(scope))}`).then((r) => r.json()).then((d) => setMeta(d.success ? d.data : d)).catch(() => {});
    // 模块32 多 source:拉真实 VPC/子网/SG 供 MySQL CDC 作业下拉选网络。
    // @kf-batch 50-WP31-place-first-class —— 落点显式(分组 / 全部 = 主控区写明,后端不再缺省)
    fetch(`/api/flink/network?targetId=${encodeURIComponent(landingOfScope(scope))}`).then((r) => r.json()).then((d) => {
      const n = d.success ? d.data : d;
      setNetVpcs(n?.vpcs || []); setNetSubnets(n?.subnets || []); setNetSgs(n?.securityGroups || []);
    }).catch(() => {});
    return () => clearInterval(pollRef.current);
  }, [scopeQs]);

  // @kf-batch 50-B28b-flink-delete-async —— 有作业在「停止中 / 删除中」就 10s 后再拉一次,直到都稳定
  //   (删除已受理的作业会自己从列表消失 —— 用户点一次就够,不用守着刷新)。换范围时清掉旧定时器。
  useEffect(() => {
    if (!jobs.some((j) => j?.status === "stopping" || j?.status === "deleting")) return;
    const h = setTimeout(fetchJobs, 10000);
    return () => clearTimeout(h);
  }, [jobs, scopeQs]);

  const fetchConnectors = async () => {
    setConnLoading(true);
    try {
      const r = await fetch("/api/flink/connectors");
      const d = await r.json();
      setConnectors(d.success ? d.data : Array.isArray(d) ? d : []);
    } finally { setConnLoading(false); }
  };
  const uploadConnector = async () => {
    if (!upFile) { message.warning(t("请选择连接器 JAR 文件")); return; }
    if (!upIdent.trim()) { message.warning(t("请填写连接器标识(Flink SQL 中 connector= 的值,如 opensearch-2)")); return; }
    setUpLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", upFile);
      fd.append("name", upName.trim() || upFile.name);
      fd.append("connectorIdentifier", upIdent.trim());
      const r = await fetch("/api/flink/connectors", { method: "POST", body: fd });
      const d = await r.json();
      if (d.success === false) { message.error(d.error?.message || t("上传失败")); return; }
      message.success(t("连接器 JAR 已上传")); setUpName(""); setUpIdent(""); setUpFile(null); fetchConnectors();
    } catch { message.error(t("上传失败")); } finally { setUpLoading(false); }
  };
  const removeConnector = async (id: string) => {
    const r = await fetch(`/api/flink/connectors/${id}`, { method: "DELETE" });
    const d = await r.json();
    if (d.success === false) { message.error(d.error?.message || t("删除失败")); return; }
    message.success(t("已删除连接器")); fetchConnectors();
  };

  const create = async () => {
    if (!name.trim()) { message.warning(t("请输入作业名称")); return; }
    if (sinkType === "mysql" && !sinkDsId) { message.warning(t("MySQL 目标请选择数据源")); return; }
    if (sinkType === "custom" && connectorIds.length === 0) { message.warning(t("自定义 sink 请选择已上传的连接器(或先在「连接器管理」上传)")); return; }
    const isCdc = sourceType === "mysql-cdc";
    const isMsk = sourceType === "msk";
    // CDC 与 MSK 同属【源在私有 VPC】的流源:都要选源数据源 + VPC 子网/SG(接私有网络)。
    const isVpcSource = isCdc || isMsk;
    if (isCdc && !cdcDsId) { message.warning(t("MySQL CDC 源请选择源数据源")); return; }
    if (isMsk && !cdcDsId) { message.warning(t("MSK 源请选择源数据源")); return; }
    // MSK topic:页面主 topic 注入 SQL 的 ${KAFKA_TOPIC}(§11.4);若 SQL 已被用户改成写死 topic(占位符不在)则不强制。
    if (isMsk && !mskTopic.trim() && /\$\{KAFKA_TOPIC\}/.test(sql)) { message.warning(t("MSK 源请填写 Topic(或在 SQL 中直接写死 topic 名)")); return; }
    if (isVpcSource && (cdcSubnets.length === 0 || cdcSgs.length === 0)) {
      message.warning(isMsk ? t("MSK 源需选择 VPC 子网 + 安全组(连私有 broker 9098/9096)") : t("MySQL CDC 需选择 VPC 子网 + 安全组(连私有 RDS 读 binlog)"));
      return;
    }
    setSaving(true);
    try {
      const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      // MSK:把页面主 topic 注入 ${KAFKA_TOPIC}(混合模式:用户若已在 SQL 写死 topic,占位符不在则原样)。
      //   ${KAFKA_AUTH_PROPS} 仍占位,由后端 resolveMskSource 展开(认证不入库)。
      const finalSql = (isMsk && mskTopic.trim()) ? sql.replace(/\$\{KAFKA_TOPIC\}/g, mskTopic.trim()) : sql;
      const payload = {
        name: name.trim(), sql: finalSql, sinkType, sinkDatasourceId: sinkDsId,
        // 模块32/42 多 source:所选源数据源(CDC=MySQL 源;MSK=MSK 数据源;kinesis=Kinesis 数据源,可选留空回退默认流)。
        sourceType,
        sourceDatasourceId: (isVpcSource || sourceType === "kinesis") ? cdcDsId : undefined,
        connectorIds: sinkType === "custom" ? connectorIds : undefined,
        vpcSubnets: isVpcSource ? cdcSubnets : sinkType === "custom" ? csv(vpcSubnets) : undefined,
        vpcSecurityGroups: isVpcSource ? cdcSgs : sinkType === "custom" ? csv(vpcSgs) : undefined,
        parallelism, parallelismPerKPU, autoScalingEnabled: autoScaling,
        executionRoleArn: execRole.trim() || undefined,
        // 高级配置(对齐 MSAF console;"bgp" 组为平台保留,后端已过滤)。
        checkpointingEnabled: ckEnabled, checkpointIntervalMs: ckIntervalMs, minPauseBetweenCheckpointsMs: ckMinPauseMs,
        logLevel, metricsLevel, snapshotsEnabled,
        // 🔴 新建时把落点一起交给服务端(服务端会当场真解析一遍:缺 flink 组件 / 角色不对 ⇒ 400 可修,
        //    而不是先存下来、等启动时才炸)。编辑既有作业时不动它的章。
        ...(editingId
          ? {}
          : newJobTargets.length
          ? { targets: newJobTargets }
          : { targetId: landingOfScope(scope) }), // @kf-batch 50-WP31-place-first-class —— 显式落点(后端缺 ⇒ 400)
        runtimeProperties: (() => {
          const byGroup: Record<string, Record<string, string>> = {};
          runtimeProps.forEach(({ g, k, v }) => {
            const gid = g.trim(), key = k.trim();
            if (!gid || !key || gid === "bgp") return;
            (byGroup[gid] = byGroup[gid] || {})[key] = v;
          });
          return Object.entries(byGroup).map(([groupId, properties]) => ({ groupId, properties }));
        })(),
      };
      // 编辑模式 → PUT(改已有作业定义);新建 → POST。
      const r = editingId
        ? await fetch(`/api/flink/jobs/${editingId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/flink/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (d.success === false) { message.error(d.error?.message || (editingId ? t("保存失败") : t("创建失败"))); return; }
      const nCreated = Array.isArray(d?.data?.created) ? d.data.created.length : 1;
      message.success(
        editingId
          ? t("已保存修改")
          : nCreated > 1
          ? t("已在 {n} 个区各建一个流作业(草稿)", { n: nCreated })
          : t("已创建流作业(草稿)")
      );
      setCreateOpen(false); resetForm(); fetchJobs();
    } finally { setSaving(false); }
  };

  // 重置新建/编辑表单到默认。
  const resetForm = () => {
    setNewJobTargets([]);
    setEditingId(null); setName(""); setSql(DEFAULT_SQL); setSinkType("s3"); setSinkDsId(undefined); setAiPrompt("");
    setConnectorIds([]); setVpcSubnets(""); setVpcSgs(""); setParallelism(1); setParallelismPerKPU(1); setAutoScaling(false);
    setSourceType("kinesis"); setCdcDsId(undefined); setCdcVpc(undefined); setCdcSubnets([]); setCdcSgs([]); setMskTopic("");
    setCkEnabled(true); setCkIntervalMs(30000); setCkMinPauseMs(5000); setLogLevel("INFO"); setMetricsLevel("APPLICATION"); setSnapshotsEnabled(false); setRuntimeProps([]);
  };

  // 打开编辑:用作业现值预填表单(运行中不可编辑——按钮已按状态禁用)。
  const openEdit = (job: any) => {
    setEditingId(job.jobId);
    setName(job.name || "");
    setSql(job.sql || DEFAULT_SQL);
    setSinkType(job.sinkType || "s3");
    setSinkDsId(job.sinkDatasourceId || undefined);
    setSourceType(job.sourceType || "kinesis");
    setCdcDsId(job.sourceDatasourceId || undefined);
    setConnectorIds(Array.isArray(job.connectorIds) ? job.connectorIds : []);
    const subs: string[] = Array.isArray(job.vpcSubnets) ? job.vpcSubnets : [];
    const sgs: string[] = Array.isArray(job.vpcSecurityGroups) ? job.vpcSecurityGroups : [];
    if (job.sourceType === "mysql-cdc" || job.sourceType === "msk") { setCdcSubnets(subs); setCdcSgs(sgs); }
    else { setVpcSubnets(subs.join(",")); setVpcSgs(sgs.join(",")); }
    setMskTopic(""); // 编辑时 SQL 已含真实 topic(占位符已被替换),topic 框留空不再强制
    setParallelism(job.parallelism || 1); setParallelismPerKPU(job.parallelismPerKPU || 1); setAutoScaling(!!job.autoScalingEnabled);
    setExecRole(job.executionRoleArn || "");
    setCkEnabled(job.checkpointingEnabled !== false);
    setCkIntervalMs(job.checkpointIntervalMs || 30000);
    setCkMinPauseMs(job.minPauseBetweenCheckpointsMs || 5000);
    setLogLevel(job.logLevel || "INFO");
    setMetricsLevel(job.metricsLevel || "APPLICATION");
    setSnapshotsEnabled(!!job.snapshotsEnabled);
    setRuntimeProps(
      (Array.isArray(job.runtimeProperties) ? job.runtimeProperties : []).flatMap((grp: any) =>
        Object.entries(grp?.properties || {}).map(([k, v]) => ({ g: grp.groupId, k, v: String(v) }))
      )
    );
    setCreateOpen(true);
  };

  // AI 生成 SQL:自然语言 → Flink SQL(Bedrock,后端按 sinkType 注入源/sink 样板与占位符约定)。
  const genAiSql = async () => {
    if (!aiPrompt.trim()) { message.warning(t("请输入需求描述,例如:每分钟各区域成交额与订单数")); return; }
    setAiLoading(true);
    try {
      const d = await aiFetchJson("/api/flink/ai-sql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: aiPrompt.trim(), sinkType }) });
      if (d.success === false) { message.error(d.error?.message || t("AI 生成失败")); return; }
      setSql(d.data.sql);
      message.success(t("已用 AI 生成 Flink SQL,请检查后创建"));
      // 模块45:cookbook 方言校验回显(规则标题是数据不翻译,框架文案走 t())。
      const dia = d.data.dialect;
      if (dia?.fixed?.length) {
        message.info(t("已按平台方言规则自动修正 {n} 处", { n: dia.fixed.length }) + ": " + dia.fixed.map((f: any) => f.title).join("；"));
      }
      if (dia?.violations?.length) {
        message.warning(t("检出 {n} 处方言问题(运行前会再次校验,error 级会拦截执行)", { n: dia.violations.length }) + ": " + dia.violations.map((v: any) => v.title).join("；"));
      }
    } catch (e: any) { message.error(t("AI 生成失败")); }
    finally { setAiLoading(false); }
  };

  const action = async (id: string, path: string, okMsg: string, confirm?: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const r = await fetch(`/api/flink/jobs/${id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirm ? { confirm } : {}),
      });
      const d = await r.json();
      // 🔴 需要用户决策(409):平台已【中止】操作,什么都没做。弹确认框把决策交还用户
      //    —— 消解方式会改变数据语义(丢弃进度→重算历史→可能重复写入),平台不代劳。
      //    用户确认后带 confirmToken 重试同一动作。
      if (d.success === false && d.error?.code === "DECISION_REQUIRED") {
        setBusyId("");
        askDecision(id, path, okMsg, d.error);
        return;
      }
      if (d.success === false) { message.error(d.error?.message || t("操作失败")); return; }
      message.success(d.data?.message || okMsg); fetchJobs();
    } finally { setBusyId(""); }
  };

  /** 决策确认对话框:讲清「发生了什么 / 为什么 / 选它的后果」,由用户自己点。
   *  刻意不提供"平台帮我选"——重大决策必须人为确认(用户红线)。 */
  const askDecision = (id: string, path: string, okMsg: string, err: any) => {
    const advice = err?.detail?.advice;
    const token = err?.detail?.confirmToken;
    const ctx = err?.detail?.context || {};
    // 推荐项即"继续执行"的语义(如丢弃进度重读);其余选项(调保留期/看日志)是旁路,不在此对话框内代做。
    const rec = (advice?.actions || []).find((a: any) => a.recommended);
    Modal.confirm({
      title: advice?.summary || t("需要你确认后才能继续"),
      width: 620,
      okText: rec?.label || t("确认并继续"),
      cancelText: t("暂不操作"),
      okButtonProps: { danger: true },
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          {advice?.cause && (
            <Collapse ghost size="small" style={{ marginLeft: -16 }}
              items={[{ key: "why", label: t("为什么会这样"), children: <div style={{ color: "#555" }}>{advice.cause}</div> }]} />
          )}
          {rec?.consequence && (
            <Alert type="warning" showIcon style={{ margin: "8px 0" }}
              message={t("确认后会发生什么")} description={rec.consequence} />
          )}
          {(advice?.actions || []).filter((a: any) => !a.recommended && a.id !== "open_logs").length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: "#888", marginBottom: 4 }}>{t("其他可考虑的处理(需你自行操作)")}:</div>
              <ul style={{ paddingLeft: 18, margin: 0, color: "#555" }}>
                {(advice.actions as any[]).filter((a) => !a.recommended && a.id !== "open_logs").map((a) => (
                  <li key={a.id}><b>{a.label}</b> — {a.consequence}</li>
                ))}
              </ul>
            </div>
          )}
          {(ctx.snapshotAt || ctx.oldestBinlogAt) && (
            <Collapse ghost size="small" style={{ marginLeft: -16, marginTop: 4 }}
              items={[{
                key: "tech", label: t("技术详情"),
                children: (
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#666" }}>
                    {ctx.snapshotAt && <div>{t("已保存进度的时间")}: {ctx.snapshotAt}</div>}
                    {ctx.oldestBinlogAt && <div>{t("源库现存最早日志时间")}: {ctx.oldestBinlogAt}</div>}
                  </div>
                ),
              }]} />
          )}
        </div>
      ),
      onOk: () => { if (token) action(id, path, okMsg, token); },
    });
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/flink/jobs/${id}`, { method: "DELETE" });
      const d = await r.json();
      if (d.success === false) { message.error(d.error?.message || t("删除失败")); return; }
      // @kf-batch 50-B28b-flink-delete-async —— 202 = 已受理、后台做完(列表显示「删除中」直到消失)
      if (d.data?.deleting) message.info(d.data?.message || t("删除已受理,停稳后会自动销毁并从列表移除"));
      else message.success(t("已删除(并清理 MSAF 应用)"));
      fetchJobs();
    } finally { setBusyId(""); }
  };

  const openDetail = async (job: any) => {
    setDetail({ job, status: null }); setDetailLoading(true);
    clearInterval(pollRef.current);
    const load = async () => {
      try {
        const [sr, lr] = await Promise.all([
          fetch(`/api/flink/jobs/${job.jobId}/status`).then((r) => r.json()).catch(() => null),
          fetch(`/api/flink/jobs/${job.jobId}/logs`).then((r) => r.json()).catch(() => null),
        ]);
        setDetail((prev: any) => prev && prev.job.jobId === job.jobId ? {
          ...prev, // 保留按需查询结果(s3tResults/s3tColumns/s3tTable),否则 10s 轮询会把它们清掉→面板反复回 0 行
          job,
          status: sr && sr.success !== false ? sr.data : prev.status,
          logs: lr && lr.success !== false ? (lr.data?.logs || []) : (prev.logs || []),
        } : prev);
      } catch {} finally { setDetailLoading(false); }
    };
    await load();
    pollRef.current = setInterval(load, 10000); // 轮询状态 + 结果
    loadDiags(job.jobId); // 诊断历史(留痕回看)
  };
  const closeDetail = () => { clearInterval(pollRef.current); clearInterval(diagPollRef.current); setDetail(null); setDiags([]); };

  // AI 诊断(DevOps Agent):加载该作业历史诊断;若有 running 记录则轮询直到完成。
  const loadDiags = async (jobId: string) => {
    try {
      const r = await fetch(`/api/flink/jobs/${jobId}/diagnose`);
      const d = await r.json();
      const items = (d.success ? d.data : Array.isArray(d) ? d : []) || [];
      setDiags(items);
      clearInterval(diagPollRef.current);
      if (items.some((x: any) => x.status === "running")) {
        diagPollRef.current = setInterval(async () => {
          const rr = await fetch(`/api/flink/jobs/${jobId}/diagnose`).then((x) => x.json()).catch(() => null);
          const its = (rr?.success ? rr.data : []) || [];
          setDiags(its);
          if (!its.some((x: any) => x.status === "running")) clearInterval(diagPollRef.current);
        }, 4000);
      }
    } catch { /* best-effort */ }
  };
  const startDiagnose = async (jobId: string) => {
    setDiagBusy(true);
    try {
      const r = await fetch(`/api/flink/jobs/${jobId}/diagnose`, { method: "POST" });
      const d = await r.json();
      if (d.success === false) { message.error(d.error?.message || t("发起诊断失败")); return; }
      message.success(t("已发起 AI 诊断(DevOps Agent 后台调查,约数十秒,完成后报告自动出现在下方历史)"));
      loadDiags(jobId);
    } catch { message.error(t("发起诊断失败")); } finally { setDiagBusy(false); }
  };

  const produce = async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/flink/jobs/${id}/produce`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 150, spanMinutes: 3 }) });
      const d = await r.json();
      if (d.success === false) { message.error(d.error?.message || t("造数失败")); return; }
      message.success(t("已注入 {n} 条示例事件到源流(约 {span} 分钟跨度);窗口关闭后约 30-60s 出聚合结果", { n: d.data?.produced || 0, span: d.data?.spanMinutes || 3 }));
    } finally { setDetailLoading(false); }
  };

  // 打开原生 Flink 控制台(MSAF 签发临时 URL,新标签页)。
  const openDashboard = async (id: string) => {
    try {
      const r = await fetch(`/api/flink/jobs/${id}/dashboard`);
      const d = await r.json();
      if (d.success === false || !d.data?.url) { message.warning(d.error?.message || t("仅 RUNNING 时可打开 Flink 控制台")); return; }
      window.open(d.data.url, "_blank");
    } catch { message.error(t("打开 Flink 控制台失败")); }
  };

  // S3 Tables sink:按需经 Athena 查询结果(不进 10s 状态轮询,避免频繁扫描)。
  const loadS3tResults = async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/flink/jobs/${id}/results`);
      const d = await r.json();
      if (d.success === false) { message.error(d.error?.message || t("查询失败")); return; }
      setDetail((prev: any) => prev && prev.job.jobId === id
        ? { ...prev, s3tResults: d.data?.results || [], s3tColumns: d.data?.columns || [], s3tTable: d.data?.table || "" } : prev);
      message.success(t("S3 Tables 查询到 {n} 行(经 Athena 联邦目录)", { n: d.data?.resultCount || 0 }));
    } catch { message.error(t("查询失败")); }
    finally { setDetailLoading(false); }
  };

  const columns = [
    { title: t("作业名称"), dataIndex: "name", render: (v: string, r: any) => <a onClick={() => openDetail(r)}><b>{v}</b></a> },
    { title: t("状态"), dataIndex: "status", render: (v: string) => <Badge status={statusBadge[v] || "default"} text={statusLabel[v] ? t(statusLabel[v]) : v} /> },
    { title: t("引擎"), render: () => <Tag color="geekblue">MSAF Flink {meta?.versionLabel || ""}</Tag> },
    // 🔴 @kf-batch 50-WP27-9cap-matrix:优先显示**读侧派生**的真实源流。落库的 `sourceStream` 是
    //   建作业时的快照(默认名 `bgp-flink-source` 那条流**根本不存在** —— 平台刻意不建固定流),
    //   显示它就是在说一条不存在的流的名字。派生值由后端经 `resolveKinesisStreamName` 给出。
    { title: t("源流"), dataIndex: "sourceStream", render: (v: string, r: any) => <Tag>{r.sourceStreamResolved || v}</Tag> },
    { title: t("更新时间"), dataIndex: "updatedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
    {
      title: t("操作"), key: "action", render: (_: any, r: any) => (
        r.status === "stopping" || r.status === "deleting" ? (
          // @kf-batch 50-B28b-flink-delete-async —— 引擎还在过渡态:启动 / 编辑 / 删除都不给点(点了只会被拒);列表自动刷新到稳定
          <Space size="small">
            <Tooltip title={r.status === "deleting" ? t("删除已受理,停稳后会自动销毁并从列表移除") : t("引擎正在停止,停稳后可再操作")}>
              <span style={{ color: "#888", cursor: "not-allowed" }}>{r.status === "deleting" ? t("删除中") : t("停止中")}</span>
            </Tooltip>
            <a onClick={() => openDetail(r)}>{t("详情")}</a>
          </Space>
        ) : (
        <Space size="small">
          {r.status === "running" || r.status === "starting"
            ? <a onClick={() => action(r.jobId, "stop", t("停止中"))}><PauseCircleOutlined /> {t("停止")}</a>
            : <a onClick={() => action(r.jobId, "start", t("启动中"))}><PlayCircleOutlined /> {t("启动")}</a>}
          {/* 编辑:仅非运行态可改(运行中须先停止);修复"发布后脚本不可编辑"。 */}
          {r.status === "running" || r.status === "starting"
            ? <Tooltip title={t("运行中不可编辑,请先停止")}><span style={{ color: "#888", cursor: "not-allowed" }}>{t("编辑")}</span></Tooltip>
            : <a onClick={() => openEdit(r)}>{t("编辑")}</a>}
          <a onClick={() => openDetail(r)}>{t("详情")}</a>
          <Popconfirm title={t("确认删除？(停止仅暂停;删除才会销毁后台 MSAF 应用)")} onConfirm={() => remove(r.jobId)}>
            <a style={{ color: "red" }}>{t("删除")}</a>
          </Popconfirm>
        </Space>
        )
      ),
    },
  ];

  const st = detail?.status;
  const isS3t = detail?.job?.sinkType === "s3table";
  const results = isS3t ? (detail?.s3tResults || []) : (st?.results || []);
  const logs = detail?.logs || [];
  // 🔴 崩溃诊断的错误文本来源(缺陷2 盲区根治):
  //  优先平台持久化的 lastError;但【运行中崩溃循环】时 start 已把 lastError 清空、reconcile 不刷新它
  //  (位点过期最常见就是这种暴露方式)——此时 lastError 为空,只认它会漏诊。故兜底从【已在轮询的 logs】
  //  里捞最近一条 ERROR 行(含 MSAF 抽出的"根因链"),零新增后端调用。两者取到的原始文本喂给 adviseFailure。
  const lastErr: string = detail?.job?.lastError || "";
  const errFromLogs: string = lastErr
    ? ""
    : (logs.filter((l: any) => l.level === "ERROR").slice(-1)[0]?.msg || "");
  const errText: string = lastErr || errFromLogs;
  // 命中已知故障模式→人话诊断(纯函数,未命中返回 null:此时保留原始文本裸展示,不臆造建议)。
  const advice = errText ? adviseFailure(errText) : null;
  // 位点过期(CDC)可一键"放弃旧位点重启":语义 == 启动预检的 discard-state,与预检决策路径闭环。
  //  仅当作业当前不在运行/启动态(可点启动)时给按钮——运行中先让用户停止(编辑区规则一致)。
  const canDiscardRestart =
    advice?.code === "CDC_BINLOG_POSITION_EXPIRED" &&
    detail?.job?.status !== "running" && detail?.job?.status !== "starting";
  // 结果表列(模式无关):优先后端真实列(s3t 走 /results,其余走状态轮询),兜底首行键。
  const backendCols: string[] = isS3t ? (detail?.s3tColumns || []) : (st?.columns || []);
  const dynCols: string[] = backendCols.length ? backendCols : (results.length ? Object.keys(results[0]) : []);
  // 标签用真实 sink 表名(历史写死 flink_region_agg,对 CDC 等其他表名不符)。
  const resultLabel = detail?.s3tTable || (detail?.job?.sinkType === "mysql" ? "MySQL" : isS3t ? "S3 Tables" : t("S3 输出"));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Space>
          <h2 style={{ margin: 0 }}><ThunderboltOutlined /> {t("实时计算")}</h2>
          <Tag color="geekblue">{t("Flink SQL 流作业")} · {meta?.engineLabel || "Amazon Managed Service for Apache Flink"}</Tag>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchJobs}>{t("刷新")}</Button>
          <Button icon={<ApiOutlined />} onClick={() => { setConnOpen(true); fetchConnectors(); }}>{t("连接器管理")}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t("新建流作业")}</Button>
        </Space>
      </div>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message={t("消费 Kinesis 流 → Flink SQL 事件时间滚动窗口聚合 → 实时落 S3,Athena/结果预览可查。")}
        description={t("需先部署门控基建 BgpFlinkStack(-c enable-flink=1)并上传 runner JAR;占位符 ${SOURCE_STREAM_ARN}/${OUTPUT_PATH}/${REGION} 启动时按账号自动注入(不硬编码)。")} />
      <Table rowKey="jobId" loading={loading} columns={columns as any} dataSource={jobs} />

      {/* 新建 / 编辑 */}
      <Modal title={editingId ? t("编辑 Flink SQL 流作业") : t("新建 Flink SQL 流作业")} open={createOpen} width={860} onCancel={() => { setCreateOpen(false); resetForm(); }} onOk={create} confirmLoading={saving} okText={editingId ? t("保存") : t("创建")}>
        <div style={{ marginBottom: 12 }}>
          <Input placeholder={t("作业名称,例如:每分钟各区域成交额")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {/* @kf-batch 50-WP18-flink-multi-region —— 🔴 新建时可**多选**执行区(用户 2026-09-15:
            「我不是让你在美东1 发布执行多个区域吗?」)。流式作业天生一区一个应用 ⇒ 这里的语义是
            **每个区各建一个作业**(名字自动带区后缀),而不是一个作业跑两区 —— 标签上把这句话说清楚,
            否则用户会以为「一个作业同时在两区跑」。🔴 只勾一个时多选长得像单选,必须有可见标签 + 计数标签。 */}
        {!editingId && (
          <Space style={{ marginBottom: 12 }} wrap>
            <span style={{ color: "#888" }}>{t("执行区域(可多选):")}</span>
            <Select
              mode="multiple"
              allowClear={false}
              style={{ minWidth: 320 }}
              data-testid="flink-create-targets"
              value={newJobTargets}
              onChange={(v: string[]) => setNewJobTargets(v)}
              placeholder={t("默认 = 当前顶栏视角那个区")}
              options={(scopeTargets ?? []).map((x) => ({
                label: `${x.targetId}${x.region ? `(${x.region})` : ""}`,
                value: x.targetId,
              }))}
            />
            <Button
              size="small"
              data-testid="flink-create-targets-all"
              disabled={(scopeTargets ?? []).length === 0}
              onClick={() => setNewJobTargets((scopeTargets ?? []).map((x) => x.targetId))}
            >
              {t("全选当前活跃区({n})", { n: (scopeTargets ?? []).length })}
            </Button>
            {newJobTargets.length > 1 ? (
              <Tag color="geekblue">{t("🌐 {n} 个区各建一个作业(流式应用一区一个)", { n: newJobTargets.length })}</Tag>
            ) : (
              <Tag>{t("📍 单区")}</Tag>
            )}
          </Space>
        )}
        <Space style={{ marginBottom: 12 }} wrap>
          <span style={{ color: "#888" }}>{t("数据源类型:")}</span>
          <Select value={sourceType} style={{ width: 220 }}
            onChange={(v) => {
              setSourceType(v);
              if (v === "mysql-cdc") { setSinkType("s3table"); setSql(MYSQL_CDC_S3T_SQL); }
              else if (v === "msk") { setSinkType("s3"); setSql(MSK_S3_SQL); }
              else { setSinkType("s3"); setSql(DEFAULT_SQL); }
            }}
            options={[
              { label: t("Kinesis 流(事件)"), value: "kinesis" },
              { label: t("MySQL CDC(直读 binlog)"), value: "mysql-cdc" },
              { label: t("MSK / Kafka(流)"), value: "msk" },
            ]} />
          {sourceType === "mysql-cdc" && (
            <>
              <span style={{ color: "#888" }}>{t("源数据源:")}</span>
              <Select value={cdcDsId} style={{ width: 240 }} placeholder={t("选择 MySQL 数据源")} onChange={setCdcDsId}
                options={datasources.filter((d: any) => (d.type || "").includes("mysql")).map((d: any) => ({ label: `${d.name}(${(d.host || "").split(".")[0]}/${d.database})`, value: d.datasourceId }))} />
            </>
          )}
          {/* 模块42 P42.7c 多源:Kinesis 源第二层——下拉自动列出已注册的 Kinesis 数据源(选即可,免手敲)。
              没有想要的?去「数据源」页新建 Kinesis 流(可新建/选已有)。选中的流启动时注入 SQL 的 ${SOURCE_STREAM_ARN}。 */}
          {sourceType === "kinesis" && (
            <>
              <span style={{ color: "#888" }}>{t("源数据源:")}</span>
              <Select value={cdcDsId} style={{ width: 260 }} allowClear
                placeholder={t("选择 Kinesis 数据源(留空用默认流)")} onChange={setCdcDsId}
                notFoundContent={t("暂无 Kinesis 数据源(去「数据源」页新建流)")}
                options={datasources.filter((d: any) => d.type === "kinesis").map((d: any) => ({ label: `${d.name}(${d.connection?.streamName || "-"})`, value: d.datasourceId }))} />
            </>
          )}
          {/* 模块42 P42.6c:MSK/Kafka 源第二层——列出已注册的 MSK 数据源(连接+认证+topic 都在数据源里,选即可)。
              没有?去「数据源」页新建 MSK 源(选托管集群/自建 + IAM/SCRAM)。启动时注入 ${KAFKA_TOPIC}/${KAFKA_AUTH_PROPS}。 */}
          {sourceType === "msk" && (
            <>
              <span style={{ color: "#888" }}>{t("源数据源:")}</span>
              <Select value={cdcDsId} style={{ width: 240 }}
                placeholder={t("选择 MSK 数据源")} onChange={setCdcDsId}
                notFoundContent={t("暂无 MSK 数据源(去「数据源」页新建)")}
                options={datasources.filter((d: any) => d.type === "msk").map((d: any) => ({ label: `${d.name}(${d.connection?.mskFlavor === "self" ? "自建" : "托管"}/${d.connection?.auth || "iam"})`, value: d.datasourceId }))} />
              <span style={{ color: "#888" }}>{t("Topic:")}</span>
              <Input value={mskTopic} style={{ width: 200 }} placeholder={t("消费的 topic 名")} onChange={(e) => setMskTopic(e.target.value)} />
            </>
          )}
        </Space>
        <Space style={{ marginBottom: 12, display: sourceType === "mysql-cdc" ? "none" : undefined }} wrap>
          <span style={{ color: "#888" }}>{t("目标类型:")}</span>
          <Select value={sinkType} style={{ width: 230 }}
            onChange={(v) => {
              setSinkType(v);
              // Bug#5:MSK 源 + S3Tables sink → 用 kafka源+iceberg 组合模板(MSK_S3T_SQL),不能塞
              // Kinesis 源的 S3TABLE_SQL(那会让 MSK 作业带上 kinesis connector → 装配路由选错包)。
              if (v === "s3table") { setSql(sourceType === "msk" ? MSK_S3T_SQL : S3TABLE_SQL); }
              else if (v === "mysql") { setSql(MYSQL_SQL); }
              else if (v === "custom") { setSql(CUSTOM_SQL); }
              else { setSql(sourceType === "msk" ? MSK_S3_SQL : DEFAULT_SQL); }
            }}
            options={[
              { label: t("S3 数据湖(默认)"), value: "s3" },
              { label: t("S3 Tables(托管 Iceberg)"), value: "s3table" },
              { label: t("MySQL(JDBC 批量)"), value: "mysql" },
              { label: t("自定义连接器(上传 JAR)"), value: "custom" },
            ]} />
          {sinkType === "mysql" && (
            <>
              <span style={{ color: "#888" }}>{t("目标 MySQL:")}</span>
              <Select value={sinkDsId} style={{ width: 260 }} placeholder={t("选择已注册 MySQL 数据源")} onChange={setSinkDsId}
                options={datasources.filter((d: any) => (d.type || "").includes("mysql")).map((d: any) => ({ label: `${d.name}(${(d.host || "").split(".")[0]}/${d.database})`, value: d.datasourceId }))} />
            </>
          )}
          {sinkType === "custom" && (
            <>
              <span style={{ color: "#888" }}>{t("连接器 JAR:")}</span>
              <Select mode="multiple" value={connectorIds} style={{ minWidth: 240 }} placeholder={t("选择已上传的连接器")} onChange={setConnectorIds}
                options={connectors.map((c: any) => ({ label: `${c.name}(${c.connectorIdentifier})`, value: c.connectorId }))} />
              <Button size="small" icon={<ApiOutlined />} onClick={() => { setConnOpen(true); fetchConnectors(); }}>{t("连接器管理")}</Button>
              <span style={{ color: "#888" }}>{t("凭证数据源:")}</span>
              <Select value={sinkDsId} style={{ width: 200 }} placeholder={t("(可选)注入 ${SINK_USER/PASSWORD}")} allowClear onChange={setSinkDsId}
                options={datasources.map((d: any) => ({ label: d.name, value: d.datasourceId }))} />
            </>
          )}
        </Space>
        {sinkType === "custom" && (
          <>
            <Alert type="warning" showIcon style={{ marginBottom: 10 }}
              message={t("自定义 Sink 接入条件(平台只提供运行环境,sink 连接定义与网络可达性由你自管)")}
              description={<div style={{ fontSize: 12, lineHeight: 1.7 }}>
                <div>① <b>{t("连接器 JAR")}</b>{t(":Flink 1.20 兼容、含 ")}<code>META-INF/services</code>{t(" SPI 工厂、单个 ≤250MB(合并后 uber-jar ≤512MB),在「连接器管理」上传。")}</div>
                <div>② <b>{t("网络")}</b>{t(":sink 目标须在")}<b>{t("私有子网")}</b>{t("且其安全组对下方 MSAF 子网放行对应端口;MSAF 子网经 NAT 出网到 Kinesis/CloudWatch。仅 web 对外,数据/计算组件不得公网暴露。")}</div>
                <div>③ <b>SQL</b>{t(":多语句、须含 ")}<code>INSERT INTO</code>{t(";窗口聚合须 ")}<code>GROUP BY window_start, window_end</code>{t("。连接参数(hosts/index 等)由你按所用连接器填写;密钥用 ")}<code>${'{'}SINK_USER{'}'}/${'{'}SINK_PASSWORD{'}'}</code>{t(" 占位符 + 选「凭证数据源」可避免写进 SQL(不入库)。")}</div>
                <div>④ {t("接入后若报错,可在作业详情用 ")}<b>{t("AI 诊断(DevOps Agent)")}</b>{t(" 定位根因,诊断记录会留痕可回看。")}</div>
              </div>} />
            <Space style={{ marginBottom: 12 }} wrap>
              <span style={{ color: "#888" }}>{t("VPC 私有子网:")}</span>
              <Input style={{ width: 280 }} placeholder={t("(可选)留空用平台私有子网:{subnets}", { subnets: (meta?.subnetIds || []).join(",") || "subnet-..." })} value={vpcSubnets} onChange={(e) => setVpcSubnets(e.target.value)} />
              <span style={{ color: "#888" }}>{t("安全组:")}</span>
              <Input style={{ width: 260 }} placeholder={t("sink 可达的 SG,如 sg-xxx(逗号分隔;填了才接 VPC)")} value={vpcSgs} onChange={(e) => setVpcSgs(e.target.value)} />
            </Space>
          </>
        )}
        {(sourceType === "mysql-cdc" || sourceType === "msk") && (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 10 }}
              message={sourceType === "msk" ? t("MSK / Kafka → S3(Flink 消费 broker,事件时间窗口聚合)") : t("MySQL CDC → S3 Table(Flink CDC 直读 binlog,小批次写入)")}
              description={sourceType === "msk" ? (<div style={{ fontSize: 12, lineHeight: 1.7 }}>
                <div>① <b>{t("源")}</b>{t(":Flink 消费所选 MSK 数据源的 topic;连接(bootstrap)+ 认证(IAM/SCRAM)+ topic 由数据源注入(密钥不入库)。")}</div>
                <div>② <b>{t("网络")}</b>{t(":Kafka broker 在")}<b>{t("私有 VPC")}</b>{t("(端口 9098/9096),请选 VPC + 子网 + 安全组(平台不自动探测可达性;选错则启动后报网络不通,可用 AI 诊断)。安全组须能到达 broker 端口。")}</div>
                <div>③ <b>{t("目标")}</b>{t(":S3 数据湖(裸文件);事件时间 1 分钟滚动窗口聚合。")}</div>
              </div>) : (<div style={{ fontSize: 12, lineHeight: 1.7 }}>
                <div>① <b>{t("源")}</b>{t(":Flink CDC 内嵌 Debezium 直接消费 MySQL binlog;源库需 ")}<code>binlog_format=ROW</code>{t("。账密从所选源数据源 Secrets 注入(不入库)。")}</div>
                <div>② <b>{t("网络")}</b>{t(":CDC 要连")}<b>{t("私有子网")}</b>{t("里的 RDS 读 binlog,请选 VPC + 子网 + 安全组(平台不自动探测可达性;选错则作业启动后报网络不通,可用 AI 诊断)。安全组须能出站到 RDS:3306。")}</div>
                <div>③ <b>{t("目标")}</b>{t(":S3 Table(托管 Iceberg);按 checkpoint 间隔(默认 30s)小批次 flush。")}</div>
              </div>)} />
            <Space style={{ marginBottom: 12 }} wrap>
              <span style={{ color: "#888" }}>VPC:</span>
              <Select value={cdcVpc} style={{ width: 240 }} placeholder={t("选择 VPC")} showSearch optionFilterProp="label"
                onChange={(v) => { setCdcVpc(v); setCdcSubnets([]); setCdcSgs([]); }}
                options={netVpcs.map((x: any) => ({ label: `${x.name || x.id}(${x.cidr})`, value: x.id }))} />
              <span style={{ color: "#888" }}>{t("子网:")}</span>
              <Select mode="multiple" value={cdcSubnets} style={{ minWidth: 280 }} placeholder={t("选私有子网(可多选)")} showSearch optionFilterProp="label"
                onChange={setCdcSubnets}
                options={netSubnets.filter((s: any) => !cdcVpc || s.vpcId === cdcVpc).map((s: any) => ({ label: `${s.name || s.id} · ${s.az}${s.isPrivate ? ` · ${t("私有")}` : ""}`, value: s.id }))} />
              <span style={{ color: "#888" }}>{t("安全组:")}</span>
              <Select mode="multiple" value={cdcSgs} style={{ minWidth: 240 }} placeholder={sourceType === "msk" ? t("选安全组(可达 broker 9098/9096)") : t("选安全组(可达RDS:3306)")} showSearch optionFilterProp="label"
                onChange={setCdcSgs}
                options={netSgs.filter((g: any) => !cdcVpc || g.vpcId === cdcVpc).map((g: any) => ({ label: `${g.name}(${g.id})`, value: g.id }))} />
            </Space>
            {/* 网络连通性智能顾问:不想手动选 VPC/子网/SG?让它探测+裁决+一键预填(CDC 要连私有 RDS 读 binlog,且 MSAF 要出网到 Kinesis/S3/CloudWatch)。 */}
            {cdcDsId ? (
              <NetworkAdvisorPanel
                targetIds={newJobTargets}
                request={{
                  computeKind: "flink",
                  targets: [
                    { kind: "datasource", datasourceId: cdcDsId },
                    { kind: "aws-service", service: "kinesis" },
                    { kind: "aws-service", service: "s3" },
                  ],
                  constraints: { preferPrivate: true, avoidNatCost: true },
                }}
                onPrefill={(p) => {
                  if (p.channel === "flink") {
                    setCdcSubnets(p.vpcConfiguration.SubnetIds);
                    setCdcSgs(p.vpcConfiguration.SecurityGroupIds);
                    // 同步 VPC 下拉(取首个子网所属 VPC,使 SG/子网过滤一致)。
                    const sub = netSubnets.find((s: any) => p.vpcConfiguration.SubnetIds.includes(s.id));
                    if (sub) setCdcVpc(sub.vpcId);
                  }
                }}
              />
            ) : (
              <Alert type="info" showIcon style={{ marginBottom: 10 }} message={t("选择上方「源数据源」后，可用网络连通性智能顾问自动推荐 VPC/子网/安全组")} />
            )}
          </>
        )}
        {/* 参数智能顾问:按源类型(kinesis shard/CDC)推荐并行度/每KPU并行度/自动扩缩,一键预填。 */}
        <ParamAdvisorPanel
          request={{
            channel: "flink",
            workload: { sourceType },
            current: { parallelism, parallelismPerKPU, autoScalingEnabled: autoScaling },
          }}
          onPrefill={(p) => {
            if (p.channel === "flink") {
              setParallelism(p.parallelism);
              setParallelismPerKPU(p.parallelismPerKPU);
              setAutoScaling(p.autoScalingEnabled);
              if (p.checkpointIntervalMs != null) setCkIntervalMs(p.checkpointIntervalMs);
              if (p.minPauseBetweenCheckpointsMs != null) setCkMinPauseMs(p.minPauseBetweenCheckpointsMs);
              if (p.logLevel) setLogLevel(p.logLevel);
              if (p.metricsLevel) setMetricsLevel(p.metricsLevel);
              if (p.snapshotsEnabled != null) setSnapshotsEnabled(p.snapshotsEnabled);
            }
          }}
          title={t("Flink 资源参数智能顾问")}
        />
        {/* 执行角色(序 72 B-139:账号内任何 kinesisanalytics.amazonaws.com 可承担的角色都能选;留空=该区平台 Flink 运行角色;落点 = 编辑中作业的章 / 新建时第一个绑定区 / 当前范围) */}
        <div style={{ marginTop: 12 }}>
          <span style={{ color: "#888", fontSize: 12 }}>{t("执行角色")}</span>
          <ExecutionRolePicker
            engine="flink"
            targetId={(() => {
              if (editingId) {
                const j = jobs.find((x) => x.jobId === editingId);
                const bound = Array.isArray(j?.targets) && j.targets.length ? String(j.targets[0]) : (typeof j?.targetId === "string" ? j.targetId : "");
                return bound || landingOfScope(scope);
              }
              return newJobTargets[0] || landingOfScope(scope);
            })()}
            multiTargetHint={!editingId && newJobTargets.length > 1}
            value={execRole}
            onChange={(arn) => setExecRole(arn)}
            isAdmin={isAdmin}
            advisorRequest={{ engine: "flink", resources: { needsS3Tables: true, needsGlueCatalog: true, needsCloudWatchLogs: true } }}
          />
        </div>
        <Space style={{ marginBottom: 12 }} wrap>
          <span style={{ color: "#888" }}>{t("资源配置:")}</span>
          <Tooltip title={t("作业总并行度(Flink 算子并发)")}>
            <span style={{ color: "#888", fontSize: 12 }}>{t("并行度")}</span>
          </Tooltip>
          <InputNumber min={1} max={64} value={parallelism} onChange={(v) => setParallelism(Number(v) || 1)} style={{ width: 80 }} />
          <Tooltip title={t("每个 KPU(1 vCPU/4GB)承载的并行度;KPU 数≈⌈并行度/每KPU并行度⌉+1 协调")}>
            <span style={{ color: "#888", fontSize: 12 }}>{t("每KPU并行度")}</span>
          </Tooltip>
          <InputNumber min={1} max={8} value={parallelismPerKPU} onChange={(v) => setParallelismPerKPU(Number(v) || 1)} style={{ width: 80 }} />
          <Tag color="geekblue">{t("预估 ≈ {n} KPU", { n: Math.ceil(parallelism / parallelismPerKPU) + 1 })}</Tag>
          <span style={{ color: "#888", fontSize: 12 }}>{t("自动扩缩")}</span>
          <Switch checked={autoScaling} onChange={setAutoScaling} size="small" />
        </Space>
        {/* 高级配置(对齐 MSAF console 配置页):checkpoint / 日志 / 指标 / 快照 / 运行时属性。 */}
        <Collapse size="small" style={{ marginBottom: 12 }} items={[{
          key: "adv", label: t("高级配置(Checkpoint / 日志级别 / 指标级别 / 快照 / 运行时属性)"),
          children: (
            <Space direction="vertical" style={{ width: "100%" }} size={8}>
              <Space wrap>
                <span style={{ color: "#888", fontSize: 12 }}>Checkpoint</span>
                <Switch checked={ckEnabled} onChange={setCkEnabled} size="small" />
                <InputNumber size="small" min={1000} max={3600000} step={1000} value={ckIntervalMs} onChange={(v) => setCkIntervalMs(Number(v) || 30000)} addonBefore={t("间隔(ms)")} style={{ width: 190 }} disabled={!ckEnabled} />
                <InputNumber size="small" min={0} max={3600000} step={1000} value={ckMinPauseMs} onChange={(v) => setCkMinPauseMs(Number(v) ?? 5000)} addonBefore={t("最小暂停(ms)")} style={{ width: 210 }} disabled={!ckEnabled} />
              </Space>
              <Space wrap>
                <Select size="small" value={logLevel} style={{ width: 160 }} onChange={setLogLevel}
                  options={["DEBUG", "INFO", "WARN", "ERROR"].map((x) => ({ label: t("日志:{x}", { x }), value: x }))} />
                <Select size="small" value={metricsLevel} style={{ width: 200 }} onChange={setMetricsLevel}
                  options={["APPLICATION", "TASK", "OPERATOR", "PARALLELISM"].map((x) => ({ label: t("指标:{x}", { x }), value: x }))} />
                <Tooltip title={t("启用后:停止作业自动打快照(savepoint),下次启动从最新快照恢复状态,不丢聚合中间态")}>
                  <span style={{ color: "#888", fontSize: 12 }}>{t("快照(savepoint)")}</span>
                </Tooltip>
                <Switch checked={snapshotsEnabled} onChange={setSnapshotsEnabled} size="small" />
              </Space>
              <div>
                <span style={{ color: "#888", fontSize: 12 }}>{t("自定义运行时属性(PropertyGroups;作业代码内读取,\"bgp\" 组为平台保留):")}</span>
                {runtimeProps.map((p, i) => (
                  <Space key={i} style={{ marginTop: 4 }} wrap>
                    <Input size="small" value={p.g} placeholder={t("属性组(如 kv.config)")} style={{ width: 170 }}
                      onChange={(e) => setRuntimeProps(runtimeProps.map((x, j) => (j === i ? { ...x, g: e.target.value } : x)))} />
                    <Input size="small" value={p.k} placeholder={t("键")} style={{ width: 200 }}
                      onChange={(e) => setRuntimeProps(runtimeProps.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                    <Input size="small" value={p.v} placeholder={t("值")} style={{ width: 220 }}
                      onChange={(e) => setRuntimeProps(runtimeProps.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setRuntimeProps(runtimeProps.filter((_, j) => j !== i))} />
                  </Space>
                ))}
                <div><Button size="small" icon={<PlusOutlined />} style={{ marginTop: 4 }} onClick={() => setRuntimeProps([...runtimeProps, { g: "", k: "", v: "" }])}>{t("添加属性")}</Button></div>
              </div>
            </Space>
          ),
        }]} />
        <div style={{ marginBottom: 10, padding: 10, background: "#0e1f2b", border: "1px solid #1d4254", borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: "#9fb3c8", marginBottom: 6 }}><ThunderboltOutlined /> {t("AI 生成 SQL — 自然语言 → Flink SQL(Amazon Bedrock,按所选目标类型生成源/sink 样板):")}</div>
          <Space.Compact style={{ width: "100%" }}>
            <Input placeholder={t("例如:每分钟统计各区域的订单数与成交额合计")} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} onPressEnter={genAiSql} />
            <Button type="primary" loading={aiLoading} icon={<ExperimentOutlined />} onClick={genAiSql}>{t("AI 生成")}</Button>
          </Space.Compact>
        </div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>{t("Flink SQL(多语句;须含 INSERT INTO;占位符启动时自动注入):")}</div>
        <div style={{ border: "1px solid #1d4254", borderRadius: 6, overflow: "hidden" }}>
          <Editor height="340px" defaultLanguage="sql" theme="vs-dark" value={sql} onChange={(v) => setSql(v || "")} options={{ minimap: { enabled: false }, fontSize: 12 }} />
        </div>
      </Modal>

      {/* 详情 */}
      <Drawer title={detail?.job?.name || t("流作业详情")} width={760} open={!!detail} onClose={closeDetail}
        extra={<Space>
          <Tooltip title={t("打开原生 Flink Web 控制台(作业拓扑/反压/checkpoint/异常,仅 RUNNING 时可用)")}><Button icon={<ApiOutlined />} onClick={() => openDashboard(detail.job.jobId)}>{t("Flink 控制台")}</Button></Tooltip>
          <Tooltip title={t("向源 Kinesis 注入示例订单事件(造数)")}><Button icon={<ExperimentOutlined />} loading={detailLoading} onClick={() => produce(detail.job.jobId)}>{t("造数")}</Button></Tooltip>
          <Button icon={<ReloadOutlined />} onClick={() => openDetail(detail.job)}>{t("刷新")}</Button>
        </Space>}>
        {detail && (
          <>
            <Card size="small" style={{ marginBottom: 12 }}>
              <Descriptions column={2} size="small">
                <Descriptions.Item label={t("DB 状态")}><Badge status={statusBadge[detail.job.status] || "default"} text={statusLabel[detail.job.status] ? t(statusLabel[detail.job.status]) : detail.job.status} /></Descriptions.Item>
                <Descriptions.Item label={t("MSAF 应用状态")}>{st ? <Tag color={appStatusColor[st.appStatus] || "default"}>{st.appStatus}</Tag> : "—"}</Descriptions.Item>
                <Descriptions.Item label={t("应用名")}>{st?.appName || detail.job.appName || "—"}</Descriptions.Item>
                <Descriptions.Item label={t("源流")}><Tag>{detail.job.sourceStreamResolved || detail.job.sourceStream}</Tag></Descriptions.Item>
                <Descriptions.Item label={t("资源")}>{t("并行度 {p} / 每KPU {pk} · ≈{kpu} KPU", { p: detail.job.parallelism || 1, pk: detail.job.parallelismPerKPU || 1, kpu: Math.ceil((detail.job.parallelism || 1) / (detail.job.parallelismPerKPU || 1)) + 1 })}{detail.job.autoScalingEnabled ? ` · ${t("自动扩缩")}` : ""}</Descriptions.Item>
                <Descriptions.Item label={t("输出位置")} span={2}><code style={{ fontSize: 11 }}>{st?.outputPath || detail.job.outputPath || t("(启动后生成)")}</code></Descriptions.Item>
              </Descriptions>
            </Card>
            {/* 崩溃诊断:命中已知故障模式→人话结论+为什么+可执行按钮(原始堆栈折叠保留,不遮蔽证据);
                未命中→保留原始文本裸展示(不臆造建议)。缺陷2 盲区根治:此前只裸展示 Java 堆栈,用户读不懂、更不知下一步。 */}
            {errText && advice && (
              <Alert type={advice.severity === "blocker" ? "error" : "warning"} showIcon style={{ marginBottom: 12 }}
                message={advice.summary}
                description={
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    <Collapse ghost size="small" style={{ marginLeft: -16 }}
                      items={[
                        { key: "why", label: t("为什么会这样"), children: <div style={{ color: "#555" }}>{advice.cause}</div> },
                        { key: "raw", label: t("原始错误(技术详情)"), children: <div style={{ fontFamily: "monospace", fontSize: 11, color: "#666", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{errText}</div> },
                      ]} />
                    {canDiscardRestart && (() => {
                      const rec = advice.actions.find((a) => a.recommended);
                      return (
                        <div style={{ marginTop: 8 }}>
                          <Button danger size="small" icon={<PlayCircleOutlined />}
                            onClick={() => Modal.confirm({
                              title: rec?.label || t("放弃旧位点,重新开始读"),
                              width: 560,
                              okText: t("确认并重启"), cancelText: t("暂不操作"), okButtonProps: { danger: true },
                              content: <div style={{ fontSize: 13, lineHeight: 1.7 }}>{rec?.consequence || advice.cause}</div>,
                              onOk: () => action(detail.job.jobId, "start", t("启动中"), "discard-state"),
                            })}>
                            {rec?.label || t("放弃旧位点,重新开始读")}
                          </Button>
                        </div>
                      );
                    })()}
                    {/* 其余可考虑的处理(如调大 binlog 保留期):只讲不代做——需用户自行操作。 */}
                    {advice.actions.filter((a) => !a.recommended && a.id !== "open_logs").length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ color: "#888", marginBottom: 4 }}>{t("其他可考虑的处理(需你自行操作)")}:</div>
                        <ul style={{ paddingLeft: 18, margin: 0, color: "#555" }}>
                          {advice.actions.filter((a) => !a.recommended && a.id !== "open_logs").map((a) => (
                            <li key={a.id}><b>{a.label}</b> — {a.consequence}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                } />
            )}
            {errText && !advice && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={errText} />}
            <Card size="small" title={<Space>{t("聚合结果(")}{resultLabel}{t(")")}<Statistic valueStyle={{ fontSize: 14 }} value={results.length} suffix={t("行")} /></Space>} style={{ marginBottom: 12 }}
              extra={isS3t ? <Button size="small" icon={<ReloadOutlined />} loading={detailLoading} onClick={() => loadS3tResults(detail.job.jobId)}>{t("查询结果(Athena)")}</Button> : undefined}>
              {results.length > 0 ? (
                <Table size="small" rowKey={(_, i) => String(i)} pagination={{ pageSize: 10 }}
                  dataSource={results}
                  // 列动态渲染:按 sink 表真实结构(模式无关,兼容窗口聚合/CDC 聚合/自定义)。
                  // 格式化只看值的运行时类型(number→千分位右对齐),不对任何列名做特殊假设。
                  columns={dynCols.map((col: string) => ({
                    title: col,
                    dataIndex: col,
                    align: (results.some((r: any) => typeof r?.[col] === "number") ? "right" : "left") as any,
                    render: (v: any) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v),
                  }))} />
              ) : <div style={{ color: "#999", padding: 16, textAlign: "center" }}>
                {isS3t
                  ? t("暂无结果。启动作业(RUNNING)→ 点「造数」→ 窗口关闭并 checkpoint 提交(约 30-60s)后,点「查询结果(Athena)」从 S3 Tables(托管 Iceberg)读取聚合结果。")
                  : t("暂无聚合结果。启动作业(RUNNING)→ 点「造数」注入事件 → 事件时间窗口关闭后约 30-60s 出结果(自动轮询刷新)。")}
              </div>}
            </Card>
            <Card size="small" title={<Space>{t("运行日志")} <span style={{ fontSize: 12, color: "#888" }}>{t("MSAF CloudWatch · {n} 条", { n: logs.length })}</span></Space>} style={{ marginBottom: 12 }}>
              <div style={{ maxHeight: 280, overflow: "auto", background: "#08131b", color: "#c9d6e5", padding: 10, borderRadius: 6, fontFamily: "monospace", fontSize: 11, lineHeight: 1.5 }}>
                {logs.length > 0 ? logs.map((l: any, i: number) => (
                  <div key={i} style={{ color: l.level === "ERROR" ? "#ff6b6b" : l.level === "WARN" ? "#ffd43b" : "#c9d6e5" }}>
                    <span style={{ color: "#5a6b7a" }}>{l.time}</span> [{l.level}] {l.msg}
                  </div>
                )) : <span style={{ color: "#888" }}>{t("暂无日志(启动后约 1-2 分钟开始输出)")}</span>}
              </div>
            </Card>
            <Card size="small" style={{ marginBottom: 12 }}
              title={<Space>{t("AI 诊断")} <span style={{ fontSize: 12, color: "#888" }}>{t("AWS DevOps Agent · {n} 条记录", { n: diags.length })}</span></Space>}
              extra={<Button size="small" type="primary" icon={<ExperimentOutlined />} loading={diagBusy} onClick={() => startDiagnose(detail.job.jobId)}>{t("AI 诊断根因")}</Button>}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{t("由 AWS 托管 DevOps Agent 关联 MSAF 应用状态/CloudWatch 日志/作业 SQL 自治分析根因,出修复与预防建议。诊断记录留痕,可回看。")}</div>
              {diags.length > 0 ? (
                <Table size="small" rowKey="diagnosticId" pagination={{ pageSize: 5 }} dataSource={diags}
                  columns={[
                    { title: t("时间"), dataIndex: "createdAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
                    { title: t("状态"), dataIndex: "status", render: (v: string) => <Tag color={v === "done" ? "green" : v === "running" ? "blue" : "red"}>{v === "done" ? t("完成") : v === "running" ? t("调查中") : t("失败")}</Tag> },
                    { title: t("发起人"), dataIndex: "createdBy" },
                    { title: t("操作"), key: "act", render: (_: any, r: any) => (
                      r.status === "running" ? <span style={{ color: "#888" }}>{t("调查中…")}</span>
                        : <a onClick={() => setDiagView(r)}>{t("查看报告")}</a>
                    ) },
                  ]} />
              ) : <div style={{ color: "#999", padding: 12, textAlign: "center" }}>{t("暂无诊断记录。作业异常/失败时点「AI 诊断根因」发起。")}</div>}
            </Card>
            <Card size="small" title="Flink SQL">
              <pre style={{ background: "#08131b", color: "#c9d6e5", padding: 12, borderRadius: 6, fontSize: 11, maxHeight: 240, overflow: "auto" }}>{detail.job.sql}</pre>
            </Card>
          </>
        )}
      </Drawer>

      {/* 诊断报告查看 */}
      <Modal title={<Space><ExperimentOutlined /> {t("AI 诊断报告(DevOps Agent)")}</Space>} width={820} open={!!diagView} onCancel={() => setDiagView(null)} footer={<Button onClick={() => setDiagView(null)}>{t("关闭")}</Button>}>
        {diagView && (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={t("诊断时间")}>{diagView.createdAt?.slice(0, 19).replace("T", " ")}</Descriptions.Item>
              <Descriptions.Item label={t("状态")}><Tag color={diagView.status === "done" ? "green" : "red"}>{diagView.status}</Tag></Descriptions.Item>
              <Descriptions.Item label={t("资源")}>{diagView.resourceName || "-"}</Descriptions.Item>
              <Descriptions.Item label={t("发起人")}>{diagView.createdBy}</Descriptions.Item>
            </Descriptions>
            {diagView.error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={diagView.error} />}
            <div style={{ whiteSpace: "pre-wrap", background: "#08131b", color: "#c9d6e5", padding: 14, borderRadius: 6, fontSize: 12, lineHeight: 1.7, maxHeight: 460, overflow: "auto" }}>
              {diagView.report || t("(无报告内容)")}
            </div>
          </>
        )}
      </Modal>

      {/* 连接器管理(自定义 sink JAR) */}
      <Drawer title={<Space><ApiOutlined /> {t("连接器管理(自定义 sink JAR)")}</Space>} width={680} open={connOpen} onClose={() => setConnOpen(false)}>
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={t("上传自定义连接器 JAR(如 OpenSearch sink),作业启动时会与基础 runner 合并为单一 uber-jar 交给 MSAF。")}
          description={t("只需上传一次;新建作业时目标类型选「自定义连接器」并勾选即可。连接器标识 = Flink SQL 中 'connector'='<标识>' 的值。")} />
        <Card size="small" title={t("上传连接器 JAR")} style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Input placeholder={t("连接器名称(如 OpenSearch 2.x Sink)")} value={upName} onChange={(e) => setUpName(e.target.value)} />
            <Input placeholder={t("连接器标识 connector=(如 opensearch-2)")} value={upIdent} onChange={(e) => setUpIdent(e.target.value)} />
            <input type="file" accept=".jar" onChange={(e) => setUpFile(e.target.files?.[0] || null)} />
            <Button type="primary" icon={<UploadOutlined />} loading={upLoading} onClick={uploadConnector}>{t("上传")}</Button>
          </Space>
        </Card>
        <Table size="small" rowKey="connectorId" loading={connLoading} dataSource={connectors} pagination={false}
          columns={[
            { title: t("名称"), dataIndex: "name" },
            { title: "connector=", dataIndex: "connectorIdentifier", render: (v: string) => <Tag color="geekblue">{v}</Tag> },
            { title: t("大小"), dataIndex: "sizeBytes", render: (v: number) => (v ? `${(v / 1024 / 1024).toFixed(1)} MB` : "-") },
            { title: t("操作"), key: "act", render: (_: any, r: any) => (
              <Popconfirm title={t("删除该连接器?(已用它的作业再启动会失败)")} onConfirm={() => removeConnector(r.connectorId)}>
                <a style={{ color: "red" }}>{t("删除")}</a>
              </Popconfirm>
            ) },
          ]} />
      </Drawer>
    </div>
  );
}
