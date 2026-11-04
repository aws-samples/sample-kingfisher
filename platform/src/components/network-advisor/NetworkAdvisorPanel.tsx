"use client";
// 网络连通性顾问 — 共享 UI 面板。任何消费方（DMS/Flink/Glue… 的 modal）只需：
//   <NetworkAdvisorPanel request={{ computeKind, targets }} targetIds={对象绑定的执行环境} onPrefill={(p) => 据 p.channel 填回自己的表单} />
//
// 多轮对话：用户可追加约束（"最小权限"/"免 NAT"），面板带 conversationId 复用上下文。
// 一键预填：拿到建议后点"应用建议"，把通道原生的网络配置回传给消费方。
//
// 🔴 顾问分析的是**某一个执行环境所在区**的网络(VPC / 子网 / 安全组都是区域资源):
//   消费方把对象绑定的执行环境传进来(`targetIds`);恰好一个就用它,多个让用户在面板里选,一个都没有就不许分析 ——
//   **不默认主控区**(原来服务端永远探主控区:数据源在别的区时,建议按错的 VPC 给)。

import { useState, useCallback, useRef, useEffect } from "react";
import { Button, Input, Space, Alert, Spin, Descriptions, Tag, Divider, Select, message } from "antd";
import { ThunderboltOutlined, SendOutlined, CheckOutlined, EnvironmentOutlined } from "@ant-design/icons";
import VerdictBadge from "./VerdictBadge";
import RemediationCard from "./RemediationCard";
import type { ConnectivityRequest, ConnectivityRecommendation, Constraints, EnvironmentFacts, Prefill } from "@/lib/network-advisor";
import { useT } from "@/lib/i18n/useT";
// 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";
// 只为把 targetId 显示成「名字 · region」(护栏 2:这份网络事实属于哪个区必须一眼可见);拿不到就显示 targetId 原文
import { fetchExecTargets, type ExecTargetOption } from "@/lib/exec-env/exec-targets-client";

interface Props {
  request: Omit<ConnectivityRequest, "conversationId" | "userMessage" | "targetId">;
  /** 候选落点 = 消费方对象绑定的执行环境。恰好一个 ⇒ 直接用;多个 ⇒ 面板里选;空 ⇒ 不许分析(不默认主控区)。 */
  targetIds: string[];
  onPrefill?: (prefill: Prefill) => void;
  // 可选：默认折叠，按需展开（嵌在大表单里时省空间）。
  title?: string;
}

// 生成一个稳定的 conversationId（组件生命周期内复用，支撑多轮）。
function useConversationId() {
  const ref = useRef<string>("");
  if (!ref.current) ref.current = `na-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return ref.current;
}

/** 候选落点唯一 ⇒ 就是它;多个 ⇒ 用户选过且仍在候选里才算;否则空(= 还没定)。 */
function pickTarget(targetIds: string[], prev: string): string {
  if (targetIds.length === 1) return targetIds[0];
  return targetIds.includes(prev) ? prev : "";
}

export default function NetworkAdvisorPanel({ request, targetIds, onPrefill, title }: Props) {
  const t = useT();
  const panelTitle = title ?? t("网络连通性智能顾问");
  const conversationId = useConversationId();
  const [loading, setLoading] = useState(false);
  const [rec, setRec] = useState<ConnectivityRecommendation | null>(null);
  const [probed, setProbed] = useState<EnvironmentFacts | null>(null); // 分阶段:L1 探测先回
  const [followup, setFollowup] = useState("");
  const [err, setErr] = useState<string>("");
  const seqRef = useRef(0); // 竞态守卫:只采纳最新一轮请求的结果
  const [targetId, setTargetId] = useState<string>(() => pickTarget(targetIds, ""));
  const [execTargets, setExecTargets] = useState<ExecTargetOption[]>([]);
  const lastReqRef = useRef<ConnectivityRequest | null>(null); // 一键修复要带同一份已落点的请求

  const targetsKey = targetIds.join("|");
  useEffect(() => {
    setTargetId((prev) => pickTarget(targetIds, prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey]);
  // 换了落点 = 换了区:上一轮的事实 / 建议全部作废,不许留在界面上冒充这个区的结论。
  useEffect(() => {
    setRec(null); setProbed(null); setErr(""); lastReqRef.current = null;
  }, [targetId]);
  useEffect(() => {
    if (!targetIds.length) return;
    fetchExecTargets("any").then(setExecTargets).catch(() => setExecTargets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey]);

  const labelOf = (id: string) => {
    const hit = execTargets.find((x) => x.targetId === id);
    return hit ? `${hit.displayName || hit.targetId} · ${hit.region}` : id;
  };

  const ask = useCallback(
    async (userMessage?: string, constraints?: Constraints) => {
      if (!targetId) return; // 没定落点就不分析(按钮也是禁用的;这里是双保险)
      const seq = ++seqRef.current;
      setLoading(true);
      setErr("");
      const body: ConnectivityRequest = {
        ...request,
        targetId,
        conversationId,
        userMessage,
        constraints: { ...(request.constraints || {}), ...(constraints || {}) },
      };
      lastReqRef.current = body;

      // 分阶段 loading(标准 §7③):首问先走廉价 L1 探测(纯确定性,秒回),等待裁决/大模型时
      // 展示"发现了什么环境";完整建议由 advise 后补。advise API 签名不变。
      if (!rec) {
        fetch("/api/network-advisor/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then((json) => {
            if (json?.success && seq === seqRef.current) setProbed(json.data as EnvironmentFacts);
          })
          .catch(() => { /* 快路径失败不影响主流程 */ });
      }

      try {
        const json = await aiFetchJson("/api/network-advisor/advise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!json.success) throw new Error(json.error?.message || t("顾问请求失败"));
        if (seq === seqRef.current) setRec(json.data as ConnectivityRecommendation);
      } catch (e: any) {
        if (seq === seqRef.current) setErr(String(e?.message || e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [request, targetId, conversationId, rec, t]
  );

  const applyPrefill = () => {
    if (rec?.prefill && onPrefill) {
      onPrefill(rec.prefill);
      message.success(t("已按建议预填网络配置"));
    }
  };

  const placement = rec?.recommendedPlacement;

  return (
    <div style={{ padding: 12, background: "#0e1f2b", border: "1px solid #1d4254", borderRadius: 8, marginBottom: 12 }}>
      <Space style={{ marginBottom: 8 }} wrap>
        <span style={{ color: "#9fb3c8", fontSize: 13 }}>
          <ThunderboltOutlined /> {panelTitle}
        </span>
        {targetIds.length > 1 ? (
          <Select
            size="small"
            data-testid="netadvisor-target"
            style={{ minWidth: 220 }}
            placeholder={t("选择要分析的执行环境")}
            value={targetId || undefined}
            onChange={(v) => setTargetId(String(v))}
            options={targetIds.map((id) => ({ value: id, label: labelOf(id) }))}
          />
        ) : targetId ? (
          <Tag icon={<EnvironmentOutlined />} color="geekblue" data-testid="netadvisor-target">{labelOf(targetId)}</Tag>
        ) : null}
        <Button size="small" type="primary" loading={loading} disabled={!targetId} icon={<ThunderboltOutlined />} onClick={() => ask()}>
          {t("智能分析网络")}
        </Button>
        <span style={{ color: "#5a7184", fontSize: 12 }}>{t("自动探测 VPC/子网/SG/路由/endpoint，给出可达性裁决与修复建议")}</span>
      </Space>

      {!targetId ? (
        <Alert type="info" showIcon style={{ marginBottom: 8 }} data-testid="netadvisor-need-target"
          message={targetIds.length > 1 ? t("这个对象绑定了多个执行环境:先选一个,顾问按它所在的区探测网络") : t("请先选择执行环境:顾问按该环境所在的区探测 VPC / 子网 / 安全组,不会默认主控区")} />
      ) : null}

      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} /> : null}

      {loading && !rec ? (
        <div style={{ padding: 16 }}>
          {probed ? (
            // 分阶段:L1 已回,展示环境概览,等待裁决+大模型建议。
            <div style={{ fontSize: 12, color: "#9fb3c8" }}>
              <div style={{ marginBottom: 6 }}><Spin size="small" /> {t("环境已探测,正在裁决连通性 + 生成建议…")}</div>
              <Space wrap>
                <Tag color="geekblue">{probed.region}</Tag>
                <Tag color="cyan">{t("{n} 个 VPC", { n: probed.vpcs.length })}</Tag>
                <Tag color="cyan">{t("{n} 个子网", { n: probed.vpcs.reduce((s, v) => s + v.subnets.length, 0) })}</Tag>
                <Tag color="cyan">{t("{n} 个目标已解析", { n: probed.targets.length })}</Tag>
                {probed.degraded ? <Tag color="orange">{t("部分信息受限")}</Tag> : null}
              </Space>
            </div>
          ) : (
            <div style={{ textAlign: "center" }}><Spin tip={t("探测环境 + 裁决连通性 + 生成建议…")} /></div>
          )}
        </div>
      ) : null}

      {rec ? (
        <div style={{ fontSize: 13 }}>
          <Space style={{ marginBottom: 8 }} wrap>
            <VerdictBadge verdict={rec.verdict} confidence={rec.confidence} />
            <Tag color="geekblue" data-testid="netadvisor-facts-region">{rec.facts.region}</Tag>
            {rec.facts.degraded ? <Tag color="orange">{t("部分信息受限（已降级）")}</Tag> : null}
            {rec.llmAvailable === false ? <Tag color="default">{t("大模型降级·确定性结果")}</Tag> : null}
          </Space>

          {/* 大模型/确定性 reasoning */}
          <div style={{ whiteSpace: "pre-wrap", color: "#cfe0ee", marginBottom: 10, lineHeight: 1.7 }}>{rec.reasoning}</div>

          {/* 推荐放置 + 一键预填 */}
          {placement ? (
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 10, background: "#0a1722" }}
              labelStyle={{ color: "#9fb3c8", width: 110 }} contentStyle={{ color: "#e6f0fa" }}>
              <Descriptions.Item label="VPC">{placement.vpcId}</Descriptions.Item>
              <Descriptions.Item label={t("子网")}>{placement.subnetIds.join(", ") || "—"}</Descriptions.Item>
              <Descriptions.Item label={t("安全组")}>{placement.securityGroupIds.join(", ") || "（建议新建）"}</Descriptions.Item>
              <Descriptions.Item label={t("可用区")}>{placement.availabilityZones.join(", ") || "—"}</Descriptions.Item>
              <Descriptions.Item label={t("理由")}>{placement.rationale}</Descriptions.Item>
            </Descriptions>
          ) : null}

          {rec.prefill && onPrefill ? (
            <Button size="small" type="primary" ghost icon={<CheckOutlined />} onClick={applyPrefill} style={{ marginBottom: 10 }}>
              {t("应用建议（一键预填）")}
            </Button>
          ) : null}

          {/* 待办问题 */}
          {rec.questions?.length ? (
            <Alert type="info" showIcon style={{ marginBottom: 10 }}
              message={t("需要你补充")} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{rec.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>} />
          ) : null}

          {/* 补救清单 */}
          {rec.remediations.length ? (
            <>
              <Divider style={{ margin: "8px 0", borderColor: "#1d4254" }} orientation="horizontal" orientationMargin={0}>
                <span style={{ color: "#9fb3c8", fontSize: 12 }}>{t("打通还需做（{n}）", { n: rec.remediations.length })}</span>
              </Divider>
              {rec.remediations.map((r) => (
                <RemediationCard key={r.id} rem={r} req={lastReqRef.current ?? undefined} onApplied={() => ask()} />
              ))}
            </>
          ) : null}

          {/* 多轮追加约束 */}
          <Divider style={{ margin: "10px 0", borderColor: "#1d4254" }} />
          <Space wrap style={{ marginBottom: 8 }}>
            <span style={{ color: "#5a7184", fontSize: 12 }}>{t("快捷约束：")}</span>
            <Button size="small" onClick={() => ask("请按最小权限优化", { leastPrivilege: true })} loading={loading}>{t("最小权限")}</Button>
            <Button size="small" onClick={() => ask("请避免 NAT 成本", { avoidNatCost: true })} loading={loading}>{t("免 NAT 成本")}</Button>
            <Button size="small" onClick={() => ask("请保证高可用", { requireHA: true })} loading={loading}>{t("高可用")}</Button>
          </Space>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              placeholder={t("追问 / 追加需求，例如：源库在另一个 VPC、要走私有不出网…")}
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              onPressEnter={() => { if (followup.trim()) { ask(followup.trim()); setFollowup(""); } }}
            />
            <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={() => { if (followup.trim()) { ask(followup.trim()); setFollowup(""); } }}>
              {t("发送")}
            </Button>
          </Space.Compact>
        </div>
      ) : null}
    </div>
  );
}
