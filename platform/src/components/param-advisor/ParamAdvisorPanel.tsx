"use client";
// 参数辅助顾问 — 共享 UI 面板(仿 NetworkAdvisorPanel)。任何消费方(Glue/Flink/DMS 的表单)只需:
//   <ParamAdvisorPanel request={{ channel, workload, current, jobRef }} onPrefill={(p) => 据 p.channel 填回自己的表单} />
//
// 多轮对话:用户可补充特征("大概 200GB"/"含大字段"),面板带 conversationId 复用上下文。
// 一键预填:拿到建议后点"应用建议",把通道原生的参数配置回传给消费方。

import { useState, useCallback, useRef } from "react";
import { Button, Input, Space, Alert, Spin, Table, Tag, Divider, Tooltip, message } from "antd";
import { BulbOutlined, SendOutlined, CheckOutlined, HistoryOutlined } from "@ant-design/icons";
import type { ParamAdviceRequest, ParamAdvice, ParamPrefill, ParamRecommendation } from "@/lib/param-advisor";
import { useT } from "@/lib/i18n/useT";
// 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";

interface Props {
  request: Omit<ParamAdviceRequest, "conversationId" | "userMessage">;
  onPrefill?: (prefill: ParamPrefill) => void;
  title?: string;
}

// 生成一个稳定的 conversationId(组件生命周期内复用,支撑多轮)。
function useConversationId() {
  const ref = useRef<string>("");
  if (!ref.current) ref.current = `pa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return ref.current;
}

export default function ParamAdvisorPanel({ request, onPrefill, title = "参数智能顾问" }: Props) {
  const t = useT();
  const conversationId = useConversationId();
  const [loading, setLoading] = useState(false);
  const [rec, setRec] = useState<ParamAdvice | null>(null);
  const [interim, setInterim] = useState(false); // 分阶段 loading:确定性推荐已到,大模型解释在路上
  const [followup, setFollowup] = useState("");
  const [err, setErr] = useState<string>("");
  const seqRef = useRef(0); // 竞态守卫:只采纳最新一轮请求的结果
  const finalSeqRef = useRef(0); // 已落最终结果的轮次(快路径不得覆盖完整结果)

  const ask = useCallback(
    async (userMessage?: string) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setErr("");
      const body: ParamAdviceRequest = { ...request, conversationId, userMessage };

      // 分阶段 loading(标准 §7③):首问先走确定性快路径,推荐表格秒回;完整解释由 advise 后补。
      if (!rec) {
        fetch("/api/param-advisor/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then((json) => {
            if (json?.success && seq === seqRef.current && finalSeqRef.current < seq) {
              setRec({ ...(json.data as ParamAdvice), reasoning: "" });
              setInterim(true);
            }
          })
          .catch(() => { /* 快路径失败不影响主流程 */ });
      }

      try {
        const json = await aiFetchJson("/api/param-advisor/advise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!json.success) throw new Error(json.error?.message || t("顾问请求失败"));
        finalSeqRef.current = seq;
        if (seq === seqRef.current) {
          setRec(json.data as ParamAdvice);
          setInterim(false);
        }
      } catch (e: any) {
        if (seq === seqRef.current) setErr(String(e?.message || e));
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    },
    [request, conversationId, rec, t]
  );

  const applyPrefill = () => {
    if (rec?.prefill && onPrefill) {
      onPrefill(rec.prefill);
      message.success(t("已按建议预填参数"));
    }
  };

  const g = rec?.historyFacts?.glue;
  const columns = [
    { title: t("参数"), dataIndex: "label", key: "label", width: 130, render: (v: string, r: ParamRecommendation) => (
      <Tooltip title={r.key}><span style={{ color: "#cfe0ee" }}>{v}</span></Tooltip>
    ) },
    { title: t("推荐值"), key: "value", width: 120, render: (_: unknown, r: ParamRecommendation) => (
      <Space size={4}>
        <span style={{ color: r.changed ? "#fadb14" : "#6ee7b7", fontWeight: 600 }}>{String(r.value)}{r.unit ? ` ${r.unit}` : ""}</span>
        {r.changed ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>{t("建议改")}</Tag> : null}
        {r.basedOnHistory ? <Tooltip title={t("基于运行历史实据")}><HistoryOutlined style={{ color: "#22d3ee" }} /></Tooltip> : null}
      </Space>
    ) },
    { title: t("当前值"), key: "cur", width: 90, render: (_: unknown, r: ParamRecommendation) => (
      <span style={{ color: "#5a7184" }}>{r.currentValue !== undefined ? String(r.currentValue) : "—"}</span>
    ) },
    { title: t("理由"), dataIndex: "reason", key: "reason", render: (v: string, r: ParamRecommendation) => (
      <span style={{ color: "#9fb3c8", fontSize: 12 }}>{v}<Tag style={{ marginLeft: 6 }} color={r.confidence >= 0.8 ? "green" : r.confidence >= 0.6 ? "blue" : "default"}>{Math.round(r.confidence * 100)}%</Tag></span>
    ) },
  ];

  return (
    <div style={{ padding: 12, background: "#0e1f2b", border: "1px solid #1d4254", borderRadius: 8, marginBottom: 12 }}>
      <Space style={{ marginBottom: 8 }} wrap>
        <span style={{ color: "#9fb3c8", fontSize: 13 }}>
          <BulbOutlined /> {t(title)}
        </span>
        <Button size="small" type="primary" loading={loading} icon={<BulbOutlined />} onClick={() => ask()}>
          {t("智能推荐参数")}
        </Button>
        <span style={{ color: "#5a7184", fontSize: 12 }}>{t("按工作负载与运行历史推荐 worker/并行度/超时等高级参数,附理由与置信度")}</span>
      </Space>

      {err ? <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} /> : null}

      {loading && !rec ? (
        <div style={{ padding: 16, textAlign: "center" }}>
          <Spin tip={t("探测运行历史 + 计算推荐 + 生成解释…")} />
        </div>
      ) : null}

      {rec ? (
        <div style={{ fontSize: 13 }}>
          <Space style={{ marginBottom: 8 }} wrap>
            <Tag color={rec.confidence >= 0.75 ? "green" : rec.confidence >= 0.55 ? "blue" : "orange"}>{t("整体置信度 {pct}%", { pct: Math.round(rec.confidence * 100) })}</Tag>
            {rec.llmAvailable === false ? <Tag color="default">{t("大模型降级·确定性结果")}</Tag> : null}
            {g && g.runs > 0 ? <Tag color="cyan">{t("近 {runs} 次运行:成功率 {rate}%", { runs: g.runs, rate: (g.successRate * 100).toFixed(0) })}{g.p90DurationMin != null ? t(" · P90 {min} 分钟", { min: g.p90DurationMin }) : ""}</Tag> : null}
          </Space>

          {/* 大模型/确定性 reasoning;分阶段:推荐表格已出、解释生成中 */}
          {interim ? (
            <div style={{ color: "#5a7184", marginBottom: 10 }}><Spin size="small" /> {t("推荐已就绪(确定性引擎),AI 解释生成中…")}</div>
          ) : (
            <div style={{ whiteSpace: "pre-wrap", color: "#cfe0ee", marginBottom: 10, lineHeight: 1.7 }}>{rec.reasoning}</div>
          )}

          {/* 推荐清单 */}
          {rec.recommendations.length ? (
            <Table<ParamRecommendation>
              size="small" rowKey="key" columns={columns as never} dataSource={rec.recommendations}
              pagination={false} style={{ marginBottom: 10 }}
            />
          ) : null}

          {rec.prefill && onPrefill ? (
            <Button size="small" type="primary" ghost icon={<CheckOutlined />} onClick={applyPrefill} style={{ marginBottom: 10 }}>
              {t("应用建议(一键预填)")}
            </Button>
          ) : null}

          {/* 待补充特征 */}
          {rec.questions?.length ? (
            <Alert type="info" showIcon style={{ marginBottom: 10 }}
              message={t("补充以下信息可获得更准的推荐")} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{rec.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>} />
          ) : null}

          {/* 多轮补充特征 */}
          <Divider style={{ margin: "10px 0", borderColor: "#1d4254" }} />
          <Space wrap style={{ marginBottom: 8 }}>
            <span style={{ color: "#5a7184", fontSize: 12 }}>{t("快捷补充:")}</span>
            <Button size="small" onClick={() => ask("这是生产级任务,请按生产标准推荐")} loading={loading}>{t("生产级")}</Button>
            <Button size="small" onClick={() => ask("成本优先,可接受更长运行时长")} loading={loading}>{t("成本优先")}</Button>
            <Button size="small" onClick={() => ask("速度优先,尽快跑完")} loading={loading}>{t("速度优先")}</Button>
          </Space>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              placeholder={t("补充特征 / 追问,例如:数据量大概 200GB、表里有 TEXT 大字段、按 user_id join…")}
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
