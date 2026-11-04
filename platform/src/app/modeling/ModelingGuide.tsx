"use client";

// 数据建模「怎么用」通俗引导:一张流程关系图 + 一句人话 + 游戏广告示例。
// 让不懂数仓的人一眼看懂 分层/域/维度/事实/指标/码表/标准 的关联与用法。
// 零依赖(纯 div + CSS 变量换肤);默认展开,可折叠(localStorage 记住)。
import React, { useState } from "react";
import { Card, Button } from "antd";
import { useT } from "@/lib/i18n/useT";
import { useBrowserInitialState } from "@/lib/hydration/use-browser-initial-state";

const KEY = "bgp-modeling-guide-collapsed";

// 一个流程节点卡。
function Node({ title, desc, eg, color }: { title: string; desc: string; eg: string; color: string }) {
  return (
    <div style={{
      flex: "1 1 0", minWidth: 128, background: "var(--bgp-panel, rgba(12,28,40,0.5))",
      border: `1px solid ${color}`, borderRadius: 8, padding: "10px 12px",
    }}>
      <div style={{ fontWeight: 700, color, fontSize: 13, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--bgp-text, #cfe6f0)", lineHeight: 1.5 }}>{desc}</div>
      <div style={{ fontSize: 11, color: "var(--bgp-text-dim, #8fb0c2)", marginTop: 6 }}>{eg}</div>
    </div>
  );
}

function Arrow() {
  return (
    <div style={{ display: "flex", alignItems: "center", color: "var(--bgp-primary, #22d3ee)", fontSize: 20, flexShrink: 0, padding: "0 2px" }}>→</div>
  );
}

export default function ModelingGuide() {
  const t = useT();
  // B-138:首帧按「展开」渲染(= 服务端),挂载后再读 localStorage;初值函数里读浏览器状态会让 React 19 报水合不一致
  const [collapsed, setCollapsed] = useBrowserInitialState<boolean>(false, () => localStorage.getItem(KEY) === "1");
  const toggle = () => {
    setCollapsed((c) => {
      const n = !c;
      try { localStorage.setItem(KEY, n ? "1" : "0"); } catch {}
      return n;
    });
  };

  const C = {
    layer: "var(--bgp-s1, #3d8bfd)",
    domain: "var(--bgp-s4, #8b6fe8)",
    model: "var(--bgp-s3, #12a07f)",
    metric: "var(--bgp-primary, #22d3ee)",
    std: "var(--bgp-s2, #d8479a)",
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 12, background: "var(--bgp-bg, transparent)" }}
      styles={{ body: { padding: collapsed ? "10px 14px" : 16 } }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>
          💡 {t("数据建模怎么用?一张图看懂(游戏广告分析示例)")}
        </span>
        <Button type="link" size="small" onClick={toggle}>{collapsed ? t("展开说明") : t("收起")}</Button>
      </div>

      {!collapsed && (
        <div style={{ marginTop: 12 }}>
          {/* 一句人话 */}
          <div style={{ fontSize: 12, color: "var(--bgp-text-dim, #8fb0c2)", marginBottom: 14, lineHeight: 1.6 }}>
            {t("数据建模 = 给杂乱的原始表定一套「规范的仓库结构」,让数据可复用、口径统一。下面 6 个功能是配合使用的一条链:")}
          </div>

          {/* 主流程图:分层 → 域 → 维度/事实建模 → 指标体系 */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 4, flexWrap: "wrap" }}>
            <Node color={C.layer} title={`1. ${t("数仓分层")}`}
              desc={t("给数据分楼层:原始→明细→汇总→应用(ODS/DWD/DWS/ADS)")}
              eg={t("例:广告原始事件放 ODS,清洗后的维度/事实放 DWD")} />
            <Arrow />
            <Node color={C.domain} title={`2. ${t("数据域")}`}
              desc={t("给数据分业务主题:一个域=一块业务")}
              eg={t("例:广告投放域、玩家行为域")} />
            <Arrow />
            <Node color={C.model} title={`3. ${t("维度/事实建模")}`}
              desc={t("核心:建维度表(描述「谁」)+ 事实表(记录「发生了什么」),一键生成并应用到 Redshift")}
              eg={t("例:dim_channel(渠道维)+ fact_ad_daily(广告日事实:曝光/点击/花费)")} />
            <Arrow />
            <Node color={C.metric} title={`4. ${t("指标体系")}`}
              desc={t("基于表定义业务指标:原子指标(直接聚合)+ 派生指标(加时间/过滤修饰),口径一处定义处处复用")}
              eg={t("例:总曝光量、总点击量、美国曝光量(派生)")} />
          </div>

          {/* 辅助功能:标准 + 码表 */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Node color={C.std} title={`+ ${t("数据标准")}`}
              desc={t("统一字段口径:类型/单位/取值范围,建表时对齐")}
              eg={t("例:广告花费金额统一 DECIMAL(14,2)、单位 USD")} />
            <Node color={C.std} title={`+ ${t("码表")}`}
              desc={t("枚举字典:把编码翻译成含义,可一键落地成 Redshift 维表")}
              eg={t("例:渠道类型 paid=付费渠道 / organic=自然渠道")} />
          </div>

          {/* 结果一句话 */}
          <div style={{ fontSize: 12, color: "var(--bgp-text, #cfe6f0)", marginTop: 14, padding: "8px 12px", background: "var(--bgp-primary, #22d3ee)14", borderRadius: 6, borderLeft: `3px solid ${C.metric}` }}>
            ⭐ {t("建好后:事实表 JOIN 维度表就能做分析(如「各广告渠道的点击率 CTR 排名」),指标可被 BI 报表、数据服务、问数直接复用 —— 这就是「建一次、处处用」。")}
          </div>
        </div>
      )}
    </Card>
  );
}
