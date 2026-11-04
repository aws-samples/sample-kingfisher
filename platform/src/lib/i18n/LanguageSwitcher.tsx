"use client";

// 顶栏语言切换器 —— 放在换肤下拉旁,复用同款 Dropdown 交互(当前语种打勾)。
// 切换即时全站生效(响应式 Context,不 reload,保留多页签状态)。

import React from "react";
import { Dropdown, Tooltip } from "antd";
import { GlobalOutlined, CheckOutlined } from "@ant-design/icons";
import { useI18n } from "./I18nProvider";
import { SUPPORTED_LOCALES, LOCALE_LABELS } from "./locales";

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  const items = SUPPORTED_LOCALES.map((l) => ({
    key: l,
    label: (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 120 }}>
        <span style={{ flex: 1 }}>{LOCALE_LABELS[l]}</span>
        {l === locale && <CheckOutlined style={{ color: "#22d3ee", fontSize: 12 }} />}
      </span>
    ),
    onClick: () => setLocale(l),
  }));

  return (
    <Dropdown menu={{ items }} trigger={["click"]} placement="bottomRight">
      <Tooltip title={t("切换语言")}>
        <GlobalOutlined style={{ color: "var(--bgp-primary, #22d3ee)", fontSize: 18, cursor: "pointer" }} />
      </Tooltip>
    </Dropdown>
  );
}
