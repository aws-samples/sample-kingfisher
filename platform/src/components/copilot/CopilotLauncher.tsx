"use client";

// 统一 Copilot 全局入口。自包含组件:一个 Header 图标 + 右侧抽屉。
// 挂在 Header,任意页可唤起,不打断当前页。仅只读问答;安全边界提示常驻底部。
// 全局 fetch 拦截器已自动附带 Cognito token + 项目/环境头(AuthProvider),此处直接 fetch 即可。

import React, { useRef, useState } from "react";
import { Drawer, Input, Button, Tooltip, Spin, Tag, Empty, Segmented } from "antd";
import { RobotOutlined, SendOutlined, ClearOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";
import ExecutionPlanCard, { type Plan, type PlanStep } from "./ExecutionPlanCard";

interface Msg {
  role: "user" | "assistant";
  text: string;
  backend?: string;
  steps?: { tool: string; kind: string; ok: boolean }[];
  // 规划模式:该助手气泡承载一份执行计划表(内嵌 ExecutionPlanCard compact)。
  plan?: Plan;
  planSteps?: PlanStep[];
}

// 会话 id:组件生命周期内稳定(多轮记忆按它归并)。避免用 Date/Math.random 在 SSR 出水合问题——
// 仅客户端组件,首次点击时惰性生成。
function newConversationId() {
  return "cp-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function CopilotLauncher() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // 模式:ask(问答,默认)| plan(规划:一句话诉求→执行计划表)。
  const [mode, setMode] = useState<"ask" | "plan">("ask");
  const convRef = useRef<string>("");
  const listRef = useRef<HTMLDivElement>(null);

  const scrollToEnd = () => setTimeout(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, 50);

  // 问答模式:调 /api/copilot/ask。
  const sendAsk = async (prompt: string) => {
    const d = await aiFetchJson("/api/copilot/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, conversationId: convRef.current }),
    });
    if (d?.success) {
      setMsgs((m) => [...m, { role: "assistant", text: d.data.answer || "(无回复)", backend: d.data.backend, steps: d.data.steps }]);
    } else {
      setMsgs((m) => [...m, { role: "assistant", text: `⚠️ ${d?.error?.message || d?.error || t("请求失败")}` }]);
    }
  };

  // 规划模式:异步提交 + 轮询(planner 重推理 >60s 墙,不能同步等)。提交拿 taskId → 轮询到终态 → 内嵌计划卡。
  const sendPlan = async (prompt: string) => {
    const res = await fetch("/api/copilot/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const d = await res.json();
    if (!d?.success || !d.data?.taskId) {
      setMsgs((m) => [...m, { role: "assistant", text: `⚠️ ${d?.error?.message || d?.error || t("规划提交失败")}` }]);
      return;
    }
    const taskId = d.data.taskId;
    // 轮询(最多 ~4min:80 次 * 3s),直到 succeeded/failed/timeout。
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pr = await fetch(`/api/copilot/plan/task/${taskId}`).then((r) => r.json()).catch(() => null);
      const st = pr?.data?.status;
      if (st === "succeeded") {
        const text = pr.data.plan?.summary || t("已生成执行计划");
        setMsgs((m) => [...m, { role: "assistant", text, plan: pr.data.plan, planSteps: pr.data.steps || [] }]);
        return;
      }
      if (st === "failed" || st === "timeout") {
        setMsgs((m) => [...m, { role: "assistant", text: `⚠️ ${pr?.data?.error || t("规划失败或超时")}` }]);
        return;
      }
      // pending/running → 继续轮询
    }
    setMsgs((m) => [...m, { role: "assistant", text: `⚠️ ${t("规划耗时过长,请稍后在「Copilot 计划中心」查看")}` }]);
  };

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || loading) return;
    if (!convRef.current) convRef.current = newConversationId();
    setMsgs((m) => [...m, { role: "user", text: prompt }]);
    setInput("");
    setLoading(true);
    scrollToEnd();
    try {
      if (mode === "plan") await sendPlan(prompt);
      else await sendAsk(prompt);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", text: `⚠️ ${String(e?.message || e)}` }]);
    } finally {
      setLoading(false);
      scrollToEnd();
    }
  };

  // 刷新某条计划气泡(确认某步后重拉最新步骤态)。
  const refreshPlanMsg = async (idx: number, planId: string) => {
    try {
      const d = await fetch(`/api/copilot/plan/${planId}`).then((r) => r.json());
      if (d?.success) {
        setMsgs((m) => m.map((msg, i) => i === idx ? { ...msg, plan: d.data.plan, planSteps: d.data.steps } : msg));
      }
    } catch { /* 忽略 */ }
  };

  const clear = () => { setMsgs([]); convRef.current = ""; };

  return (
    <>
      <Tooltip title={t("智能助手 Copilot")}>
        <RobotOutlined
          data-testid="copilot-launcher"
          onClick={() => setOpen(true)}
          style={{ color: "var(--bgp-primary, #22d3ee)", fontSize: 18, cursor: "pointer" }}
        />
      </Tooltip>
      <Drawer
        title={<span><RobotOutlined style={{ marginRight: 8 }} />{t("智能助手 Copilot")}</span>}
        placement="right"
        width={460}
        open={open}
        onClose={() => setOpen(false)}
        extra={<Button size="small" icon={<ClearOutlined />} onClick={clear}>{t("清空")}</Button>}
        styles={{ body: { display: "flex", flexDirection: "column", padding: 0 } }}
      >
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {msgs.length === 0 ? (
            <Empty
              description={
                <span style={{ fontSize: 13, color: "#8fb0c2" }}>
                  {mode === "plan"
                    ? t("用一句话描述诉求,例如:帮我把广告 ROI 算出来。我会先查现状再产出可逐步确认的执行计划。")
                    : t("问我平台上的事,例如:我有哪些数据源?最近哪些任务失败了?")}
                </span>
              }
              style={{ marginTop: 40 }}
            />
          ) : (
            msgs.map((m, i) => (
              <div key={i} style={{ marginBottom: 14, textAlign: m.role === "user" ? "right" : "left" }}>
                {/* 规划模式:助手气泡承载执行计划表(内嵌 ExecutionPlanCard compact,可展开跳独立页) */}
                {m.role === "assistant" && m.plan ? (
                  <div style={{ width: "100%" }}>
                    <ExecutionPlanCard
                      plan={m.plan}
                      steps={m.planSteps || []}
                      compact
                      onExpand={() => { window.location.href = `/copilot/plans`; }}
                      onChanged={() => refreshPlanMsg(i, m.plan!.planId)}
                    />
                  </div>
                ) : (
                  <div style={{
                    display: "inline-block", maxWidth: "88%", padding: "8px 12px", borderRadius: 10,
                    textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word",
                    background: m.role === "user" ? "var(--bgp-primary, #22d3ee)" : "var(--bgp-panel, rgba(12,28,40,0.66))",
                    color: m.role === "user" ? "#04121a" : "var(--bgp-text, #cfe6f0)",
                    border: m.role === "assistant" ? "1px solid var(--bgp-panel-border, rgba(86,224,242,0.22))" : "none",
                  }}>
                    {m.text}
                    {m.role === "assistant" && m.steps && m.steps.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#8fb0c2" }}>
                        {m.steps.map((s, j) => (
                          <Tag key={j} color={s.ok ? "cyan" : "red"} style={{ fontSize: 10, marginBottom: 2 }}>{s.tool}</Tag>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
          {loading && <div style={{ textAlign: "left", color: "#8fb0c2" }}><Spin size="small" /> {t("思考中…")}</div>}
        </div>
        <div style={{ borderTop: "1px solid var(--bgp-panel-border, rgba(86,224,242,0.22))", padding: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => setMode(v as "ask" | "plan")}
              options={[
                { label: t("问答"), value: "ask" },
                { label: t("规划执行"), value: "plan" },
              ]}
              data-testid="copilot-mode"
            />
          </div>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={mode === "plan"
              ? t("一句话描述诉求…（Enter 生成计划）")
              : t("输入你的问题…（Enter 发送，Shift+Enter 换行）")}
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={loading}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
            <span style={{ fontSize: 11, color: "#5a7184" }}>
              {t("Copilot 可帮你查询与创建配置,但不会运行/发布/删除任务——这些请在对应页面确认执行。")}
            </span>
            <Button type="primary" size="small" icon={<SendOutlined />} loading={loading} onClick={send}>{t("发送")}</Button>
          </div>
        </div>
      </Drawer>
    </>
  );
}
