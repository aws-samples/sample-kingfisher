"use strict";
// @genbi/core — GenBI 结果集的图表建议启发式（引擎无关纯函数,无运行时依赖）。
// Pure function so it runs on the server and is trivially testable.
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestChart = suggestChart;
const MAX_CHART_ROWS = 50;
const DATE_LIKE = /date|time|month|year|day|week|周|月|年|季|日期|时间/i;
function suggestChart(columns, rows) {
    if (!columns.length || !rows.length)
        return { type: "table" };
    // single scalar -> a big "metric" number
    if (rows.length === 1 && columns.length === 1) {
        return { type: "metric", yField: columns[0] };
    }
    const isNumericCol = (idx) => {
        let sawNumber = false;
        for (const r of rows) {
            const v = r[idx];
            if (v == null || v === "")
                continue;
            if (Number.isNaN(Number(v)))
                return false;
            sawNumber = true;
        }
        return sawNumber;
    };
    // pick the last numeric column as the measure, the first non-numeric as the category
    let yIdx = -1;
    for (let i = columns.length - 1; i >= 0; i--) {
        if (isNumericCol(i)) {
            yIdx = i;
            break;
        }
    }
    let xIdx = -1;
    for (let i = 0; i < columns.length; i++) {
        if (i !== yIdx && !isNumericCol(i)) {
            xIdx = i;
            break;
        }
    }
    if (yIdx === -1 || xIdx === -1)
        return { type: "table" };
    if (rows.length > MAX_CHART_ROWS) {
        return { type: "table", reason: "结果行数较多，建议用表格查看" };
    }
    const dateLike = DATE_LIKE.test(columns[xIdx]);
    return {
        type: dateLike ? "line" : "bar",
        xField: columns[xIdx],
        yField: columns[yIdx],
        reason: dateLike ? "按时间维度展示趋势" : "按分类维度对比",
    };
}
