"use client";

// 通用「功能说明」——可收起/展开的操作指引卡(默认收起,点标题展开)。
// 用途:在功能页顶部放一段"这个功能有什么用 + 怎么用"的说明,风格统一、零业务耦合。
// 用法:<FeatureGuide titleKey="补数中心" what={...} steps={[...]} tips={[...]} />
import React from "react";
import { Collapse, Typography } from "antd";
import { BulbOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";

const { Paragraph, Text } = Typography;

export interface FeatureGuideProps {
  title: string; // 标题(中文源串,内部 t() 翻译)
  what: string; // 一句话:这个功能是做什么的
  steps: string[]; // 使用步骤(有序)
  tips?: string[]; // 注意事项/要点(无序,选填)
  storageKey?: string; // 预留:记忆展开态(本期不持久化,默认收起)
}

export default function FeatureGuide({ title, what, steps, tips }: FeatureGuideProps) {
  const t = useT();
  return (
    <Collapse
      size="small"
      ghost
      style={{ marginBottom: 12, background: "var(--bgp-panel, #f5f8fa)", borderRadius: 8 }}
      items={[
        {
          key: "guide",
          label: (
            <span style={{ fontWeight: 500 }}>
              <BulbOutlined style={{ color: "#e0a23c", marginRight: 6 }} />
              {t("功能说明")}：{t(title)}
            </span>
          ),
          children: (
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              <Paragraph style={{ marginBottom: 8 }}>
                <Text strong>{t("作用")}：</Text>
                {t(what)}
              </Paragraph>
              <Text strong>{t("使用步骤")}：</Text>
              <ol style={{ margin: "4px 0 8px 0", paddingLeft: 20 }}>
                {steps.map((s, i) => (
                  <li key={i}>{t(s)}</li>
                ))}
              </ol>
              {tips && tips.length > 0 && (
                <>
                  <Text strong>{t("要点")}：</Text>
                  <ul style={{ margin: "4px 0 0 0", paddingLeft: 20 }}>
                    {tips.map((s, i) => (
                      <li key={i} style={{ color: "var(--bgp-text-dim, #8fb0c2)" }}>{t(s)}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
