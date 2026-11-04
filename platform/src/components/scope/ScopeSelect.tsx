"use client";
// 顶栏第三层「执行范围」选择器(交互 INTERACTION §9.2;合同 SPEC v3.36 §2.6.5a)。
//
// 🔴 三条:
// ① **不叫 Region**:选中值恒为 `targetId`(同 region 可有多账号 / 多 cell,按 region 键会串身份)。
// ② **只列已安装好的**(用户 2026-09-09 拍板):清单来自 Provider,不在这里另做过滤。
// ③ 切换**不重载、不离开当前页**:交给 `setScope`(内部 `router.push`)。

import React, { useMemo } from "react";
import { Select, Tag, Tooltip } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { SCOPE_GLOBAL, serializeScope, type TargetScope } from "@/lib/scope/scope";
import { useScope, type ScopeTargetOption } from "./ScopeProvider";

export default function ScopeSelect() {
  const t = useT();
  const { scope, targets, targetsError, setScope } = useScope();

  const options = useMemo(() => {
    const globalOpt = {
      value: SCOPE_GLOBAL,
      label: (
        <span data-testid="scope-opt-global">
          <GlobalOutlined /> {t("全部")}
          {targets ? `(${targets.length} ${t("个区")})` : ""}
        </span>
      ),
    };
    if (!targets || targets.length === 0) return [globalOpt];
    // 按 region 分组(INTERACTION §9.2:选项按 region 分组显示,选中值仍是 targetId)
    const byRegion: Record<string, ScopeTargetOption[]> = {};
    for (const tg of targets) {
      (byRegion[tg.region] ??= []).push(tg);
    }
    const groups = Object.keys(byRegion)
      .sort((a, b) => a.localeCompare(b))
      .map((region) => ({
        label: <span style={{ color: "#90a4c0", fontSize: 11 }}>{region}</span>,
        options: byRegion[region].map((tg: ScopeTargetOption) => ({
          value: tg.targetId,
          label: (
            <span data-testid={`scope-opt-${tg.targetId}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>{tg.displayName}</span>
              {tg.isHome && <Tag color="cyan" style={{ marginInlineEnd: 0 }}>{t("主控区")}</Tag>}
              {tg.jurisdiction !== "home" && (
                <Tag color="gold" style={{ marginInlineEnd: 0 }}>🌍 {tg.jurisdiction}</Tag>
              )}
              <span style={{ fontSize: 10, color: "#90a4c0" }}>
                {tg.components.length} {t("组件")}
              </span>
              {/* 🔴 健康是**徽标**不是过滤条件:装好了就得看得见(INTERACTION §9.2 每项显示健康)。
                  不可承接时照样能选 —— 看数据不需要它健康,而写操作会被服务端按同一条判据拒。 */}
              {!tg.serviceable && (
                <Tooltip title={tg.unusableReason || t("此刻不可承接新工作")}>
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t("不可承接")}</Tag>
                </Tooltip>
              )}
            </span>
          ),
        })),
      }));
    return [globalOpt, ...groups];
  }, [targets, t]);

  const title = targetsError
    ? t("读取执行范围清单失败,下拉里可能不全:") + targetsError
    : t("切换当前执行范围（只列出已安装好的执行环境；切换不会离开当前页面）");

  return (
    <Tooltip title={title}>
      <Select
        size="small"
        data-testid="scope-select"
        style={{ minWidth: 200 }}
        value={serializeScope(scope)}
        status={targetsError ? "warning" : undefined}
        onChange={(v: string) => {
          const next: TargetScope = v === SCOPE_GLOBAL ? { kind: "global" } : { kind: "target", targetId: v };
          setScope(next);
        }}
        options={options}
      />
    </Tooltip>
  );
}
