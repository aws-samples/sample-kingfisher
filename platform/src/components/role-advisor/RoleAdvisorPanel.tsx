"use client";
// 角色顾问 — 共享 UI 面板(仿 Param/NetworkAdvisorPanel)。凡是要填「执行角色 ARN」的作业面板都可挂:
//   <RoleAdvisorPanel request={{ engine, resources }} onFilled={(arn) => 填回执行角色字段} />
// 三种能力:A 推荐最小权限策略(展示+复制,自建后贴 ARN);B 一键创建(平台建受控角色,ARN 自动填入,仅管理员);C 贴 ARN(消费方已有输入框)。

import { useState, useCallback } from "react";
import { Button, Space, Alert, Spin, Tag, Divider, Typography, message } from "antd";
import { SafetyCertificateOutlined, CopyOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { RoleAdviceRequest, RoleAdvice } from "@/lib/role-advisor";
import { ROLE_RECOMMEND_BUTTON_LABEL, ROLE_APPLY_BUTTON_LABEL, provisionOutcome, type ProvisionOutcome } from "@/lib/role-advisor/labels";
import { useT } from "@/lib/i18n/useT";

const { Text } = Typography;

interface Props {
  request: RoleAdviceRequest;
  onFilled?: (roleArn: string) => void; // 一键创建成功后回填执行角色 ARN
  isAdmin?: boolean; // 仅管理员显示「一键创建」
  title?: string;
}

export default function RoleAdvisorPanel({ request, onFilled, isAdmin = false, title = "角色顾问" }: Props) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rec, setRec] = useState<RoleAdvice | null>(null);
  const [err, setErr] = useState("");
  // 「一键」的结果常驻显示(toast 三秒就没了;而「到底补没补」是用户要看的事实)
  const [outcome, setOutcome] = useState<ProvisionOutcome | null>(null);

  const ask = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/role-advisor/recommend", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      }).then((x) => x.json());
      if (r?.success) setRec(r.data);
      else setErr(r?.error?.message || t("推荐失败"));
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [request, t]);

  const copy = (label: string, obj: unknown) => {
    try { navigator.clipboard.writeText(JSON.stringify(obj, null, 2)); message.success(t("已复制{label}", { label })); }
    catch { message.warning(t("复制失败,请手动选择")); }
  };

  const createRole = async () => {
    setCreating(true);
    try {
      const r = await fetch("/api/role-advisor/create", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      }).then((x) => x.json());
      if (r?.success) {
        // 🔴 已存在的角色后端会**对账补齐**并回 `reconciledSids` —— 原来这里只说「已复用」,
        //   用户分不清「本来就齐」与「刚补了 N 条」。三态逐一说清(收口在 labels.ts 的唯一作者)。
        const o = provisionOutcome(r.data);
        setOutcome(o);
        message.success(outcomeText(o));
        onFilled?.(r.data.roleArn);
      } else message.error(r?.error?.message || t("创建失败"));
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : String(e)); }
    finally { setCreating(false); }
  };

  const outcomeText = (o: ProvisionOutcome): string => {
    switch (o.kind) {
      case "created": return t("已创建角色 {n}(必备权限已全部写入)", { n: o.roleName });
      case "reconciled":
        return o.sids.length
          ? t("角色 {n} 已存在:本次按必备权限清单补回 {k} 条({s})", { n: o.roleName, k: String(o.sids.length), s: o.sids.join(", ") })
          : t("角色 {n} 已存在:本次按必备权限清单重新写回了权限策略", { n: o.roleName });
      case "unchanged": return t("角色 {n} 已存在且必备权限齐全,未做改动", { n: o.roleName });
    }
  };

  return (
    <div style={{ border: "1px dashed #2a4a5c", borderRadius: 8, padding: 10, marginBottom: 8 }}>
      <Space wrap>
        <Button size="small" type="primary" ghost icon={<SafetyCertificateOutlined />} loading={loading} onClick={ask}>{t(ROLE_RECOMMEND_BUTTON_LABEL)}</Button>
        <span style={{ color: "#5a7184", fontSize: 12 }}>{t("按数据源/目标推荐最小权限策略;可复制自建后贴 ARN,或一键创建(受权限边界约束防提权)")}</span>
      </Space>
      {err && <Alert type="error" showIcon style={{ marginTop: 8 }} message={err} />}
      {loading && <div style={{ marginTop: 8 }}><Spin size="small" /> <Text type="secondary">{t("生成最小权限策略中…")}</Text></div>}
      {rec && !loading && (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: "#cfe0ee", marginBottom: 8, lineHeight: 1.7 }}>{rec.reasoning}</div>
          {rec.cautions?.length ? (
            <Alert type="warning" showIcon style={{ marginBottom: 8 }}
              message={<ul style={{ margin: 0, paddingLeft: 18 }}>{rec.cautions.map((c, i) => <li key={i} style={{ fontSize: 12 }}>{c}</li>)}</ul>} />
          ) : null}
          {/* 权限逐条理由 */}
          <div style={{ marginBottom: 8 }}>
            {rec.notes.map((n, i) => (
              <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                <Tag color={n.scoped ? "green" : "gold"}>{n.scoped ? t("已收敛") : t("较宽")}</Tag>
                <code style={{ color: "#9fd0e8" }}>{n.action}</code> <span style={{ color: "#8fb0c2" }}>— {n.why}</span>
              </div>
            ))}
          </div>
          <Space wrap style={{ marginBottom: 8 }}>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(t("权限策略"), rec.permissionPolicy)}>{t("复制权限策略")}</Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(t("信任策略"), rec.trustPolicy)}>{t("复制信任策略")}</Button>
            {rec.managedPolicyArns?.length ? <span style={{ fontSize: 12, color: "#8fb0c2" }}>{t("另附托管策略:")}{rec.managedPolicyArns.join(", ")}</span> : null}
          </Space>
          <Divider style={{ margin: "8px 0" }} />
          <Space wrap>
            {isAdmin ? (
              <Button size="small" type="primary" icon={<ThunderboltOutlined />} loading={creating} onClick={createRole}
                data-testid="role-advisor-apply">
                {t(ROLE_APPLY_BUTTON_LABEL)}({rec.proposedRoleName})
              </Button>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{t("一键创建需平台管理员;你可复制上方策略自建角色后把 ARN 贴到执行角色框")}</Text>
            )}
            <span style={{ color: "#5a7184", fontSize: 12 }}>{t("一键创建将挂权限边界(建出的角色权限不超过平台上限,禁 IAM 写/禁提权)")}</span>
          </Space>
          {outcome && (
            <Alert type={outcome.kind === "reconciled" ? "warning" : "success"} showIcon style={{ marginTop: 8 }}
              data-testid="role-advisor-result" data-outcome={outcome.kind}
              data-sids={outcome.kind === "reconciled" ? outcome.sids.join(",") : ""}
              message={outcomeText(outcome)} />
          )}
        </div>
      )}
    </div>
  );
}
