"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button, Modal, Spin, Tag, Typography, Alert, message } from "antd";
import { ExperimentOutlined, BulbOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";

const { Text } = Typography;

interface Props {
  taskId: string;
  runId: string;
  size?: "small" | "middle" | "large";
  label?: string;
}

// 命中的历史修复摘要(来自 /api/incidents/lookup)。
interface IncidentHit {
  signature: string;
  occurrenceCount?: number;
  hasVerifiedFix: boolean;
  resolution?: { verifiedBy?: string; verifiedAt?: string; markdown?: string } | null;
}

// 用 AWS DevOps Agent 对一次失败运行发起故障诊断，并轮询展示生成的报告。
// 诊断落 done 时若命中知识库【人工已验证】的历史修复(usedIncidentHistory=true),
// 报告顶部展示"同类故障历史"Alert,引用上次的已验证修复并跳转 /incidents 查详情(复利闭环可见化)。
export default function DiagnosisButton({ taskId, runId, size = "small", label }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [report, setReport] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [incident, setIncident] = useState<IncidentHit | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  // 命中历史修复时,拉取该签名的复发次数/已验证修复摘要供顶部 Alert 展示。best-effort。
  const loadIncident = async (signature: string) => {
    try {
      const r = await fetch("/api/incidents/lookup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const d = await r.json();
      if (d?.success && d.data?.found) setIncident(d.data as IncidentHit);
    } catch { /* 拉取失败不影响报告展示 */ }
  };

  const poll = (id: string, attempt = 0) => {
    pollRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/diagnostics/${id}`);
        const d = await r.json();
        if (d?.success) {
          const rec = d.data;
          setStatus(rec.status);
          if (rec.status === "done") {
            setReport(rec.report || "");
            setLoading(false);
            // 命中知识库已验证历史修复 → 顶部展示引用。
            if (rec.usedIncidentHistory && rec.incidentSignature) loadIncident(rec.incidentSignature);
            return;
          }
          if (rec.status === "failed") { setErr(rec.error || t("诊断失败")); setLoading(false); return; }
        }
      } catch { /* keep polling */ }
      // DevOps Agent 深度调查(关联 CloudWatch 日志)实测可达 3 分钟(196s 有实例),
      // 轮询窗口设 100 次 × 3s = 5 分钟,覆盖其真实耗时,避免报告已生成却前端先报超时。
      if (attempt < 100) poll(id, attempt + 1);
      else { setErr(t("诊断超时，请稍后在诊断记录中查看")); setLoading(false); }
    }, 3000);
  };

  const start = async () => {
    setOpen(true); setLoading(true); setReport(""); setErr(""); setStatus("running"); setIncident(null);
    try {
      const res = await fetch("/api/diagnostics", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, runId }),
      });
      const d = await res.json();
      if (!d?.success) { setErr(d?.error?.message || t("发起诊断失败")); setLoading(false); return; }
      poll(d.data.diagnosticId);
    } catch (e: any) { setErr(e?.message || t("网络异常")); setLoading(false); }
  };

  return (
    <>
      <Button size={size} icon={<ExperimentOutlined />} onClick={start} style={{ color: "#a371f7", borderColor: "#a371f7" }}>
        {label ?? t("AI 诊断")}
      </Button>
      <Modal
        title={<span><ExperimentOutlined style={{ color: "#a371f7" }} /> {t("故障诊断报告（AWS DevOps Agent）")}</span>}
        open={open} onCancel={() => setOpen(false)} width={920}
        footer={[<Button key="c" onClick={() => setOpen(false)}>{t("关闭")}</Button>]}
      >
        {loading && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <Spin tip={t("AWS DevOps Agent 正在调查（关联 CloudWatch 日志、定位根因），通常 1-3 分钟…")} />
          </div>
        )}
        {err && <Text type="danger">{err}</Text>}
        {/* 同类故障历史引用(命中知识库已验证修复时)。 */}
        {!loading && incident && incident.hasVerifiedFix && (
          <Alert
            type="success"
            showIcon
            icon={<BulbOutlined />}
            style={{ marginBottom: 12 }}
            message={
              <span>
                {t("同类故障历史：此故障与知识库中已沉淀的同类故障同签名")}
                {typeof incident.occurrenceCount === "number" ? `（${t("累计")} ${incident.occurrenceCount} ${t("次")}）` : ""}
                {"。"}
                {incident.resolution?.verifiedAt
                  ? `${t("最近于")} ${String(incident.resolution.verifiedAt).slice(0, 10)} ${t("修复并已人工验证。")}`
                  : t("已有人工验证的修复手册。")}
              </span>
            }
            description={
              <span>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t("本次诊断已把该历史已验证修复注入证据，供 DevOps Agent 对照根因。")}
                </Text>
                <a href="/incidents" target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                  {t("查看修复详情")}
                </a>
              </span>
            }
          />
        )}
        {!loading && report && (
          <div style={{ maxHeight: 560, overflow: "auto", background: "#0c1c28", border: "1px solid #1d4254", borderRadius: 8, padding: 16, whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6, color: "#c9d6e5" }}>
            {report}
          </div>
        )}
        {!loading && (report || err) && (
          <div style={{ marginTop: 8 }}>
            <Tag color={status === "done" ? "green" : "red"}>{status}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>{t("由 AWS DevOps Agent 自主调查生成，建议人工复核后再执行修复。")}</Text>
          </div>
        )}
      </Modal>
    </>
  );
}
