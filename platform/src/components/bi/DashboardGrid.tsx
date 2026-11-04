"use client";

// 仪表盘拖拽网格(治"死板")。封装 react-grid-layout v2,对页面暴露极简 API。
// 隔离红线:react-grid-layout 的 import 只在此文件(+ 页面用我导出的组件)。布局用 {i,x,y,w,h}=RGL 原生格式
//(v1 设计时留的后路),存储/API/校验零改动。
//
// editable=true:编辑器里可拖拽移动 + 拖右下角缩放,变更回调 onLayoutChange 回写 layout[]。
// editable=false:查看器里静态渲染(锁定拖拽/缩放)。

import React from "react";
import { GridLayout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { DashboardLayoutItem } from "@/lib/bi/types";

const COLS = 24; // 与平台 antd 24 栅格制一致(w=6/8/12/24 → 1/4、1/3、半、整宽)
const ROW_H = 60; // 每行像素高;h=5 约等于一张卡片高度

interface DashboardGridProps {
  layout: DashboardLayoutItem[];
  editable: boolean;
  onLayoutChange?: (layout: DashboardLayoutItem[]) => void;
  renderItem: (item: DashboardLayoutItem) => React.ReactNode;
}

export default function DashboardGrid({ layout, editable, onLayoutChange, renderItem }: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();

  // RGL layout item:补默认 minW/minH,保证可用。i=reportId。
  const rglLayout = layout.map((it) => ({
    i: it.i,
    x: Number.isFinite(it.x) ? it.x : 0,
    y: Number.isFinite(it.y) ? it.y : 0,
    w: it.w || 8,
    h: it.h && it.h > 1 ? it.h : 6, // v1 存的 h 是档位(1/2);v2 用行数,给个合理默认
    minW: 4,
    minH: 3,
  }));

  const handleChange = (next: readonly { i: string; x: number; y: number; w: number; h: number }[]) => {
    if (!onLayoutChange) return;
    onLayoutChange(next.map((n) => ({ i: n.i, x: n.x, y: n.y, w: n.w, h: n.h })));
  };

  return (
    <div ref={containerRef} style={{ width: "100%" }}>
      {mounted && (
        <GridLayout
          width={width}
          layout={rglLayout}
          gridConfig={{ cols: COLS, rowHeight: ROW_H, margin: [16, 16] }}
          dragConfig={{ enabled: editable, handle: ".bi-card-drag" }}
          resizeConfig={{ enabled: editable, handles: ["se"] }}
          onLayoutChange={handleChange as any}
        >
          {layout.map((it) => (
            <div key={it.i} style={{ overflow: "hidden" }}>
              {renderItem(it)}
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
