import type { ContextEntry } from "./types";
/** 指标行里本文件读的字段(与指标表落库行同形;只声明用到的,其余字段原样忽略)。 */
export interface MetricRowLike {
    modelMetricId?: string;
    name?: string;
    metricType?: string;
    caliber?: string;
    description?: string;
    unit?: string;
    fqn?: string;
    agg?: string;
    measureColumn?: string;
    timeColumn?: string;
    atomicId?: string;
    timeWindow?: string;
    modifiers?: Array<{
        column?: string;
        op?: string;
        value?: string | string[];
    }>;
    createdAt?: string;
    updatedAt?: string;
}
/** 解析后的指标查询规格:原子用自身;派生 = 引用的原子 + 自己的过滤条件与时间范围。 */
export interface ResolvedMetricSpec<M extends MetricRowLike = MetricRowLike> {
    fqn: string;
    agg: NonNullable<M["agg"]>;
    measureColumn: M["measureColumn"];
    timeColumn: M["timeColumn"];
    timeWindow: M["timeWindow"];
    modifiers: NonNullable<M["modifiers"]>;
}
export type MetricSpecResolution<M extends MetricRowLike = MetricRowLike> = {
    ok: true;
    spec: ResolvedMetricSpec<M>;
} | {
    ok: false;
    reason: string;
};
/**
 * 「派生指标怎么落到原子指标上」的唯一作者(纯函数)。
 * 计算指标值的一侧先把引用的原子行读出来再调它;问数这一侧在同一批行里找原子再调它 ——
 * 两边用同一条规则,不会出现「算的是一个口径、告诉模型的是另一个口径」。
 */
export declare function resolveMetricSpec<M extends MetricRowLike>(m: M, atomic: M | null | undefined): MetricSpecResolution<M>;
/** 聚合 → 表达式文本。与指标 SQL 构造器的聚合表达式逐项相同(标识符不带引号;标准 SQL,数仓与数据湖都认)。 */
export declare const METRIC_AGG_TEXT: Record<string, (column: string) => string>;
/** 过滤运算符 → 文本。 */
export declare const METRIC_OP_TEXT: Record<string, string>;
/** 时间周期 → 中文说明(与指标 SQL 构造器的谓词同义;「all」= 不限时间,不出说明)。 */
export declare const METRIC_TIME_WINDOW_TEXT: Record<string, string>;
/** 表全名取最后两段(schema.table)—— 与指标 SQL 构造器取表的规则相同。 */
export declare function metricTableOf(fqn: string): string | null;
/** 聚合表达式文本;聚合不在清单里 / 需要度量列却没有 ⇒ null(不编一个出来)。 */
export declare function metricAggText(agg: string, measureColumn?: string): string | null;
/**
 * 解析后的规格 → 一行结构化定义。任何一段落不到闭合清单上 ⇒ 整条回 null
 * (宁可这条指标不进提示,也不把半截 / 走样的定义交给模型)。
 */
export declare function metricDefinitionText(spec: ResolvedMetricSpec, extra?: {
    caliber?: string;
    unit?: string;
    basedOn?: string;
}): string | null;
/** 指标条目在上下文里的 entryId 前缀(与用户在业务口径页建的条目区分开)。 */
export declare const METRIC_ENTRY_PREFIX = "metric:";
/**
 * 指标行 → 上下文条目(kind = metric)。派生指标在**同一批行**里找它引用的原子。
 * 不是合法指标的行(缺名字 / 类型不认识 / 定义不完整 / 派生找不到原子)一律跳过。
 */
export declare function metricsToContextEntries(rows: MetricRowLike[]): ContextEntry[];
/**
 * 一次问数 / 生成要参考的全部语义条目 = 业务口径行 ∪ 指标行,再走同一套过滤 / 相关性排序 / 截断。
 * 排序在这里定(最近更新在前,同刻按 entryId),所以两个运行时给同一批行必得同一个结果 ——
 * 页面上「本次参考了哪些」与智能体真正读到的是同一份清单。
 */
export declare function groundingEntries(contextRows: ContextEntry[], metricRows: MetricRowLike[], keywords?: string, limit?: number): ContextEntry[];
