"use client";

// @kf-batch 50-SEQ47a-promote-ux —— 资源在三个环境里的发布状态(当前 / 已发布 vN / 审批中 / 未发布),挂在详情页按钮栏旁。
//   数据来自 GET /api/promote/lineage?type=&id=(lib/env/promote-service.ts lineageStatus 唯一作者);
//   听 PromoteButton 广播的 `bgp:promoted` 即时刷新,不用页面传回调。

import React, { useCallback, useEffect, useState } from "react";
import { Space, Tag, Tooltip } from "antd";
import { ENV_COLOR, ENVS } from "@/lib/projects/constants";
import type { ResourceType } from "@/lib/versions/version-service";
import { PROMOTED_EVENT } from "@/components/common/PromoteButton";
import { useT } from "@/lib/i18n/useT";

export interface LineageEnvRow {
  env: string;
  id: string | null;
  current: boolean;
  status?: string;
  name?: string;
  promotedFrom?: string;
  promotedAt?: string;
  promotedBy?: string;
  sourceVersion?: number;
  updatedAt?: string;
  pendingApproval?: { approvalId: string; requestedBy: string; requestedAt: string } | null;
}

export default function EnvPromotionStatus({ type, id }: { type: ResourceType; id: string }) {
  const t = useT();
  const [rows, setRows] = useState<LineageEnvRow[] | null>(null);
  const [err, setErr] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/promote/lineage?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (!d?.success) { setErr(d?.error?.message || t("读不到发布状态")); return; }
      setRows(d.data?.envs || []);
      setErr("");
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  }, [type, id, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const h = () => { load(); };
    window.addEventListener(PROMOTED_EVENT, h);
    return () => window.removeEventListener(PROMOTED_EVENT, h);
  }, [load]);

  if (err) return <Tag data-testid="env-status-error" color="default">{t("发布状态:{e}", { e: err })}</Tag>;
  const byEnv = new Map((rows || []).map((r) => [r.env, r]));
  return (
    <Space size={4} data-testid="env-status" wrap>
      <span style={{ color: "#90a4c0", fontSize: 12 }}>{t("各环境")}</span>
      {(ENVS as readonly string[]).map((env) => {
        const r = byEnv.get(env);
        const color = ENV_COLOR[env as keyof typeof ENV_COLOR] || "default";
        if (!rows) return <Tag key={env} data-testid={`env-status-${env}`} data-state="loading">{env} …</Tag>;
        if (r?.current) {
          return <Tag key={env} data-testid={`env-status-${env}`} data-state="current" color={color}>{env} · {t("当前")}</Tag>;
        }
        if (r?.pendingApproval) {
          return (
            <Tooltip key={env} title={t("发布到 {env} 的审批待批准(发起人 {who},{at})", { env, who: r.pendingApproval.requestedBy, at: r.pendingApproval.requestedAt.slice(0, 19).replace("T", " ") })}>
              <Tag data-testid={`env-status-${env}`} data-state="pending" color="processing">{env} · {t("审批中")}</Tag>
            </Tooltip>
          );
        }
        if (r?.id) {
          const at = (r.promotedAt || r.updatedAt || "").slice(0, 19).replace("T", " ");
          return (
            <Tooltip key={env} title={t("已发布到 {env}:来自 {from} 的 v{ver},{at},{who}", { env, from: r.promotedFrom || "?", ver: r.sourceVersion ?? "?", at, who: r.promotedBy || "" })}>
              <Tag data-testid={`env-status-${env}`} data-state="published" color={color}>
                {env} ✓{r.sourceVersion != null ? ` v${r.sourceVersion}` : ""}
              </Tag>
            </Tooltip>
          );
        }
        return <Tag key={env} data-testid={`env-status-${env}`} data-state="none">{env} —</Tag>;
      })}
    </Space>
  );
}
