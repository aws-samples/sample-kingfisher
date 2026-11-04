// 模块 35 — 数仓建模:类型定义。
// 分层(D1)/ 数据域·主题域(D2)/ 数据标准(D2)/ 码表(D2)/ 建模资产归属。

// ─── D1 数据分层 ───────────────────────────────────────────────────────────────
// 标准数仓分层 ODS/DWD/DWS/ADS,每层映射一个 Redshift schema,表可归属层。
export interface DataLayer {
  layerId: string;
  code: string; // ODS / DWD / DWS / ADS / 自定义(大写标识)
  name: string; // 中文名,如 "操作数据层"
  schema: string; // 映射的 Redshift schema 名
  seq: number; // 排序(ODS=1 … ADS=4)
  description?: string;
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-37)—— 这条治理约定**适用于哪些执行区**。
   * 🔴 **不写 / 空 = 全平台通用**(读侧用 `filterRowsByApplicableScope`,它把「未声明」当成
   * 「对所有区可见」;而 B 类 `filterRowsByScope` 的「无章 ⇒ 主控区」在这里是**错的语义** ——
   * 会让存量定义在非主控区视角整体消失)。
   * 用户 2026-09-10 驳回了「平台级定义本身不分区(设计如此)」的说法:「都可以切出来的」。
   */
  targets?: string[];

  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── D2 数据域 / 主题域(两级树)──────────────────────────────────────────────
// level 1 = 数据域(parentId 为空);level 2 = 主题域(parentId 指向数据域)。
export interface DataDomain {
  domainId: string;
  name: string; // 如 "交易域" / "订单主题"
  code: string; // 业务编码,如 trade / order
  parentId?: string; // 空=数据域顶级;非空=主题域(挂在某数据域下)
  level: 1 | 2;
  owner?: string; // 域负责人
  description?: string;
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-37)—— 这条治理约定**适用于哪些执行区**。
   * 🔴 **不写 / 空 = 全平台通用**(读侧用 `filterRowsByApplicableScope`,它把「未声明」当成
   * 「对所有区可见」;而 B 类 `filterRowsByScope` 的「无章 ⇒ 主控区」在这里是**错的语义** ——
   * 会让存量定义在非主控区视角整体消失)。
   * 用户 2026-09-10 驳回了「平台级定义本身不分区(设计如此)」的说法:「都可以切出来的」。
   */
  targets?: string[];

  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── D2 数据标准(标准字段字典)──────────────────────────────────────────────
export interface DataStandard {
  standardId: string;
  name: string; // 标准名,如 "金额"
  code: string; // 标准编码,如 amount
  dataType: string; // 标准数据类型,如 DECIMAL(18,2) / VARCHAR(64)
  length?: number;
  unit?: string; // 单位,如 元 / 个
  refCodeTableId?: string; // 关联码表(若该标准为枚举型)
  namingRule?: string; // 命名规范,如 "下划线小写"
  constraint?: string; // 约束描述,如 "非空、>=0"
  description?: string;
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-37)—— 这条治理约定**适用于哪些执行区**。
   * 🔴 **不写 / 空 = 全平台通用**(读侧用 `filterRowsByApplicableScope`,它把「未声明」当成
   * 「对所有区可见」;而 B 类 `filterRowsByScope` 的「无章 ⇒ 主控区」在这里是**错的语义** ——
   * 会让存量定义在非主控区视角整体消失)。
   * 用户 2026-09-10 驳回了「平台级定义本身不分区(设计如此)」的说法:「都可以切出来的」。
   */
  targets?: string[];

  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── D2 码表(枚举字典)─────────────────────────────────────────────────────────
export interface CodeValue {
  value: string; // 码值,如 "0"
  label: string; // 含义,如 "待付款"
  seq?: number; // 排序
}
export interface CodeTable {
  codeTableId: string;
  name: string; // 如 "订单状态"
  code: string; // 如 order_status(落地表名取自此)
  description?: string;
  values: CodeValue[]; // 枚举项(内嵌,远小于 400KB)
  // @kf-batch 50-P50.3-modeling —— 轴A(50 SPEC §1.3):`landed:bool` → **`landedByTarget` 观测态**。
  // 🔴 两个旧字段**保留只为读兼容**(存量行与列表页在用);新代码一律走 `landedByTarget`。
  landed?: boolean; // 是否已落地 Redshift(= home 那一格的投影,读兼容)
  landedTable?: string; // 落地后的表名(schema.table)
  landedAt?: string;
  /** 🔴 绑定的执行目标(缺省 `["tgt_home"]`,与任务侧同一条归一口径) */
  targets?: string[];
  /**
   * 🔴 **逐 target 的落地观测态**(合同点名:「观测态,非"我以为推了啥",防看板假绿」)。
   * 值形态见 `lib/modeling/landing.ts` 的 `LandedRecord`。
   */
  landedByTarget?: Record<string, import("./landing-shared").LandedRecord>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── 建模资产归属(表/指标 → 分层/域)──────────────────────────────────────────
export interface ModelAssetBinding {
  fqn: string; // 表或指标的 FQN
  kind: "table" | "metric";
  layerId?: string;
  domainId?: string;
  boundBy?: string;
  boundAt: string;
}

// ─── D3 维度/事实建模(P1)─────────────────────────────────────────────────────
// 列定义:类型经 DDL 类型白名单规范化(见 redshift.ts);可关联数据标准。
export interface ModelColumn {
  name: string; // 列名(标识符白名单)
  dataType: string; // 基础类型(VARCHAR/INTEGER/DECIMAL/...,经白名单规范化)
  length?: number; // VARCHAR/CHAR 长度
  precision?: number; // DECIMAL 精度
  scale?: number; // DECIMAL 标度
  nullable?: boolean; // 默认 true(可空);主键列建议 false
  isPrimaryKey?: boolean; // 是否主键(Redshift 声明性,不强制)
  comment?: string; // 列注释(→ COMMENT ON COLUMN)
  standardId?: string; // 关联数据标准(bgp-data-standards)
}

// 维度表 / 事实表登记。tableType 区分;可一键生成并应用 Redshift DDL。
export interface ModelTable {
  modelTableId: string;
  name: string; // 逻辑名,如 "用户维度"
  tableType: "dimension" | "fact";
  layerId?: string; // 归属分层
  domainId?: string; // 归属数据域/主题域
  schema: string; // 目标 Redshift schema
  physicalTable: string; // 物理表名(标识符白名单)
  columns: ModelColumn[];
  // 维度特有
  scdType?: "SCD1" | "SCD2"; // 渐变维处理方式
  businessKey?: string; // 业务主键列名
  // 事实特有
  grain?: string; // 粒度描述,如 "一行=一笔订单"
  dimensionRefs?: string[]; // 关联维度表 modelTableId(元数据关联,不强制外键)
  measures?: string[]; // 度量列名
  // 应用状态
  // @kf-batch 50-P50.3-modeling —— 同码表:`applied:bool` 降为 home 那一格的投影(读兼容)。
  applied?: boolean; // 是否已建到 Redshift
  appliedTable?: string; // 落地后的限定表名(schema.table)
  appliedAt?: string;
  /** 🔴 绑定的执行目标(缺省 `["tgt_home"]`) */
  targets?: string[];
  /** 🔴 逐 target 的落地观测态(见 `lib/modeling/landing.ts`) */
  landedByTarget?: Record<string, import("./landing-shared").LandedRecord>;
  description?: string;
  // @kf-batch 50-SEQ47c-catalog-ddl —— 这条定义从哪来:建模页建的(缺省)/ 数据目录「新建表」建的 / 数据目录「修改表结构」认领的已有表
  origin?: "modeling" | "catalog" | "catalog-adopted";
  // @kf-batch 50-SEQ47c-catalog-ddl —— 非主控区图形化改表的**待执行计划**:admin 执行器模板 `alter-model-table` 只认台账上的这份(不收调用方的语句);执行完即清
  pendingAlter?: import("./alter").AlterPlan;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── D4 指标体系(P1)──────────────────────────────────────────────────────────
// 模块20 之上的治理建模层(不动 bgp-metrics):原子指标(绑定表+聚合)→派生指标(原子+修饰词+时间周期)。
export type MetricAgg = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
export type MetricFormat = "number" | "currency" | "percent";
// 时间周期枚举(映射为安全 WHERE 谓词,不接受自由表达式)。
export type TimeWindow = "all" | "today" | "7d" | "30d" | "90d" | "mtd" | "ytd";
// 修饰词比较运算符白名单。
export type ModifierOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in";
export interface MetricModifier {
  column: string; // 过滤列(safeIdent 白名单)
  op: ModifierOp; // 运算符(白名单)
  value: string | string[]; // 值(sqlString 转义;in → 数组)
}

export interface ModelMetric {
  modelMetricId: string;
  name: string; // 指标名,如 "GMV" / "近7日支付订单数"
  metricType: "atomic" | "derived";
  domainId?: string; // 归属数据域/主题域
  caliber?: string; // 业务口径/定义
  unit?: string;
  format?: MetricFormat;
  // 原子指标
  fqn?: string; // 数据表 FQN(schema.table)
  agg?: MetricAgg;
  measureColumn?: string; // 度量列(count 不需要)
  timeColumn?: string; // 时间列(供派生指标做时间窗过滤)
  // 派生指标
  atomicId?: string; // 引用的原子指标 modelMetricId
  timeWindow?: TimeWindow; // 时间周期
  modifiers?: MetricModifier[]; // 修饰词(过滤条件)
  // 计算结果缓存
  /**
   * 🔴 **最近一次计算的值,不分区** —— 只为兼容旧读法留着。用户 2026-09-10 指出这块必须能按区:
   * 「指标」有**计算值**,而那个值就是从某个区的数仓算出来的;把一个区的数字当成全平台的,
   * 在多区下就是个错数字。region-sensitive 的呈现一律读 `valueByTarget`。
   */
  lastValue?: number;
  lastComputedAt?: string;
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-37)—— **每个执行区一份计算结果**。
   * 键 = targetId;`lastTargetId` = 最近一次算的是哪个区(供「不分区」的旧读法说清它是谁)。
   */
  valueByTarget?: Record<string, { value: number; computedAt: string }>;
  lastTargetId?: string;
  description?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}
