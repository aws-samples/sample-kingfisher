// 图表系列归一化(纯函数,零依赖,可单测,服务端/客户端皆可跑)。
//
// 高度抽象的落点:把"多系列从哪来"这个问题从渲染器里彻底剥离。任意结果集 + viz 配置,
// 一律归一成规范形状 { categories, series[] };渲染层(BiChart)只认这个形状,永远不知道
// 系列是"分组维度透视"还是"多度量"还是"单列"来的。一条渲染路径同时支撑:
//   - pivot(长转宽):设了 seriesField(分组/颜色维度)→ 该列不同取值各成一条系列;
//   - multi-measure(多度量):yFields 多列 → 每个度量一条系列;
//   - single(单系列):都没有 → 一条系列,与 v1/v2 BiChart 行为像素级一致(向后兼容铁证)。
//
// 全球用户红线:不猜类型(统一 num 解析,非法/空→0);系列数封顶防高基数列炸浏览器;纯函数无
// I/O、无 locale 依赖(数字本地化交给渲染层)。

export interface ChartSeries {
  name: string;
  data: (number | null)[];
}
export interface SeriesData {
  categories: string[];
  series: ChartSeries[];
  /** pivot 时若系列被封顶截断,置真(渲染层可提示"仅展示前 N 项")。 */
  truncated?: boolean;
}

// pivot 系列数上限:某高基数列(如 customer_id)若做分组会炸出上千系列拖垮浏览器,截断保护。
export const MAX_SERIES = 30;

// 数值解析:与 v1/v2 BiChart 口径一致(非法/空 → 0)。
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 列名 → 下标;找不到返回 -1。
function colIndex(columns: string[], field: string | undefined): number {
  if (!field) return -1;
  return columns.indexOf(field);
}

// 去重保序(保持首次出现顺序)。
function distinctInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export interface SeriesSpec {
  xField?: string;
  yFields?: string[]; // 多度量列名(编译后的度量别名);为空/单元素退化
  seriesField?: string; // 分组/颜色维度列名;设了即 pivot
}

/**
 * 把结果集归一成 { categories, series[] }。判定优先级:seriesField > yFields 多列 > 单列。
 */
export function toSeries(
  columns: string[],
  rows: (string | number | null)[][],
  spec: SeriesSpec
): SeriesData {
  if (!columns.length || !rows.length) return { categories: [], series: [] };

  // X 轴列:显式 xField 优先,否则首列。
  const xi = Math.max(0, colIndex(columns, spec.xField) >= 0 ? colIndex(columns, spec.xField) : 0);
  const catOf = (r: (string | number | null)[]) => String(r[xi] ?? "");

  const yFields = (spec.yFields || []).filter((f) => columns.includes(f));
  const si = colIndex(columns, spec.seriesField);

  // ── 模式 1:pivot(长转宽)—— 设了分组/颜色维度 ─────────────────────────────
  if (spec.seriesField && si >= 0) {
    // 度量列:第一个 yField(命中的),否则退回"末列或非 x/非 series 的数值列"。
    let mi = yFields.length ? columns.indexOf(yFields[0]) : -1;
    if (mi < 0) {
      // 取最后一个既非 x 也非 series 的列作度量(与单系列的"末列"直觉一致)。
      for (let i = columns.length - 1; i >= 0; i--) {
        if (i !== xi && i !== si) { mi = i; break; }
      }
      if (mi < 0) mi = columns.length - 1;
    }

    const categories = distinctInOrder(rows.map(catOf));
    let seriesNames = distinctInOrder(rows.map((r) => String(r[si] ?? "")));
    let truncated = false;
    if (seriesNames.length > MAX_SERIES) {
      seriesNames = seriesNames.slice(0, MAX_SERIES);
      truncated = true;
    }

    // 交叉格 map[category][seriesName] = 度量值(缺失格 = null,让 ECharts 跳过而非画 0)。
    const catPos = new Map(categories.map((c, i) => [c, i]));
    const snSet = new Set(seriesNames);
    const grid = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const c = catOf(r);
      const sn = String(r[si] ?? "");
      if (!catPos.has(c) || !snSet.has(sn)) continue;
      let row = grid.get(sn);
      if (!row) { row = new Map(); grid.set(sn, row); }
      // 同一交叉格若多行(理论上 GROUP BY 已聚合成唯一),累加以求稳。
      row.set(c, (row.get(c) ?? 0) + num(r[mi]));
    }

    const series: ChartSeries[] = seriesNames.map((sn) => {
      const row = grid.get(sn);
      return {
        name: sn,
        data: categories.map((c) => (row && row.has(c) ? (row.get(c) as number) : null)),
      };
    });
    return { categories, series, ...(truncated ? { truncated: true } : {}) };
  }

  // ── 模式 2:multi-measure(多度量)—— 多个 yField,无分组维度 ─────────────────
  if (yFields.length > 1) {
    const categories = rows.map(catOf);
    const series: ChartSeries[] = yFields.map((yf) => {
      const yi = columns.indexOf(yf);
      return { name: yf, data: rows.map((r) => num(r[yi])) };
    });
    return { categories, series };
  }

  // ── 模式 3:single(单系列)—— 与 v1/v2 BiChart 行为一致 ─────────────────────
  const yName = yFields[0];
  const yi = Math.max(
    0,
    yName && columns.indexOf(yName) >= 0 ? columns.indexOf(yName) : columns.length - 1
  );
  const categories = rows.map(catOf);
  const series: ChartSeries[] = [{ name: columns[yi] ?? "", data: rows.map((r) => num(r[yi])) }];
  return { categories, series };
}
