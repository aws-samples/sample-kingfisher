"use client";

// 「运行日志」弹窗的唯一作者:原来内联在任务监控页里;补数中心的实例抽屉也要看同一条 run 的日志,
// 抄一份 = 两处各自漂移(取哪个接口 / 怎么渲染 / 取不到怎么说)。两页都用这一个。
//   日志来源 = `GET /api/monitor/tasks/<taskId>/logs?runId=<runId>`(按 run 行的章去**该区**取;接口自己说清取不到的原因)。
//   `extra`:调用方可塞一行补充入口(例如补数实例抽屉给「本区 Glue 作业运行」直达链接)。
import React, { useEffect, useState } from "react";
import { Modal, Spin } from "antd";
import { useT } from "@/lib/i18n/useT";

export interface RunLogModalProps {
  open: boolean;
  taskId: string;
  runId: string;
  onClose: () => void;
  extra?: React.ReactNode;
  title?: React.ReactNode;
}

type LogLine = string | { timestamp?: string | number; message?: string };

export default function RunLogModal({ open, taskId, runId, onClose, extra, title }: RunLogModalProps) {
  const t = useT();
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !taskId) return;
    let alive = true;
    setLoading(true); setLogs([]); setError("");
    fetch(`/api/monitor/tasks/${encodeURIComponent(taskId)}/logs?runId=${encodeURIComponent(runId)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        setLogs(Array.isArray(d?.logs) ? d.logs : []);
        // 接口对「取不到日志」会给 409 + error(刻意不回落主控区);照原话呈现,不吞成「暂无日志」
        if (!r.ok || d?.error) setError(String(d?.error?.message || d?.error || `HTTP ${r.status}`));
      })
      .catch((e) => { if (alive) setError(String((e as Error)?.message || e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, taskId, runId]);

  return (
    <Modal title={title ?? t("运行日志")} open={open} onCancel={onClose} footer={null} width={900} data-testid="run-log-modal">
      {extra ? <div data-testid="run-log-extra" style={{ marginBottom: 8 }}>{extra}</div> : null}
      {error ? <div data-testid="run-log-error" style={{ color: "#ff4d4f", marginBottom: 8, whiteSpace: "pre-wrap" }}>{error}</div> : null}
      <Spin spinning={loading}>
        <div data-testid="run-log-body" style={{ maxHeight: 500, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {logs.length > 0 ? logs.map((log, i) => (
            <div key={i}>
              {typeof log !== "string" && log.timestamp ? <span style={{ color: "#6a9955" }}>{new Date(log.timestamp).toISOString().slice(0, 19)} </span> : null}
              {typeof log === "string" ? log : log.message}
            </div>
          )) : <span style={{ color: "#808080" }}>{loading ? t("加载中…") : t("暂无日志")}</span>}
        </div>
      </Spin>
    </Modal>
  );
}
