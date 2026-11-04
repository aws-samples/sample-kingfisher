"use client";
// **多 region 查询结果:一个 region 一个 sheet**(50 INTERACTION §4septies,用户 2026-09-04 定的交互)。
//
// 🔴 本组件的全部设计压力来自用户那两条约束:
//   ① 「各区快慢不一,**一直等待所有返回再展示可能不妥**」
//   ② 「某区执行报错(没有对应的表、权限……),**把错误展示在它对应的 sheet 里面**」
//
// ⇒ 核心不变量:**每个 sheet 是独立的生命周期,不共享一个 loading**。
//   · 每个 sheet 各自轮询自己的 statementId,到终态即停;别的 sheet 继续。
//   · tab 标题自带徽标(⏳执行中 12s / ✓ 1,204行·0.8s / ✗ 失败 / ⏱ 超时),**不点进去也知道成没成**;
//     🔴 徽标里带**已耗时**是刻意的 —— 没有它,"慢"与"挂了"在界面上完全一样。
//   · 🔴 **焦点只抢一次**:第一个出结果的 sheet 自动激活一次,之后再也不抢。
//     否则用户正在读 us-east-1 的表,us-west-2 回来会把他切走 —— 那比等所有区更让人恼火。
//   · 一个区失败**绝不影响**其它 sheet(与「发布下推」相反:下发是写、错了要停;直查是只读)。
//
// 🔴 「⚖ 对比」sheet 是第一个 tab:N 个 sheet 之间最要紧的信息是**它们的差异**,而差异分散在
//   N 个 tab 里必须靠人记数字。**列签名不一致只在全部到终态后才判** —— 中途判必然误报
//   (那时多数区还没有列签名),与 §2bis.4「误报会把看板做废」是同一条纪律。

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Space, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
import { ClockCircleOutlined, StopOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";

const { Text } = Typography;

/** 服务端 `submitToTargets` 的一行(与 `lib/redshift/multi-region-query.ts` 的 `QuerySubmission` 同形)。 */
export interface Submission {
  targetId: string;
  region: string;
  workgroup: string;
  database: string;
  home: boolean;
  credential: "per-project" | "shared-admin" | "worker-iam";
  jurisdiction: string;
  /** 跨法域 target 的区域审计 ID(服务端提交前写;sheet 头显示「审计 #…」) */
  auditId?: string;
  statementId?: string;
  handleId?: string;
  submitError?: string;
  errorKind?: string;
  errorHint?: string;
}

type SheetPhase = "submitting" | "running" | "finished" | "failed" | "timeout" | "cancelled";

interface SheetState {
  phase: SheetPhase;
  columns: string[];
  rows: any[][];
  totalRows?: number;
  resultRows?: number;
  hasResultSet?: boolean;
  maskedColumns?: string[];
  /** 原始错误(引擎原文或提交错误原文)—— 🔴 不改写、不吞 */
  error?: string;
  /** 平台归类 + 去哪修 */
  errorKind?: string;
  errorHint?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 每个 sheet 独立超时(§4septies.4)。超时**不清结果**,给〔继续等〕〔取消该区〕。 */
const SHEET_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 1500;

const initialSheet = (s: Submission): SheetState =>
  s.submitError
    ? {
        // 🔴 提交阶段就失败的 sheet **不进入轮询** —— 让它假装"正在执行"是最坏的形态:
        // 用户会一直等一个永远不会回来的结果。
        phase: "failed",
        columns: [],
        rows: [],
        error: s.submitError,
        errorKind: s.errorKind,
        errorHint: s.errorHint,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      }
    : { phase: "submitting", columns: [], rows: [], startedAt: Date.now() };

export default function MultiRegionResults({
  submissions,
  sql,
  onHistoryWritten,
}: {
  submissions: Submission[];
  sql: string;
  onHistoryWritten?: () => void;
}) {
  const t = useT();
  const [sheets, setSheets] = useState<Record<string, SheetState>>(() =>
    Object.fromEntries(submissions.map((s) => [s.targetId, initialSheet(s)]))
  );
  // 🔴 **单区时不出「对比」tab**:存量用法(只查 home)是绝大多数,给它凭空加一个只有一行的
  // 对比表 = 每次查询都多一次点击。单区直接把结果 sheet 设为激活项,视觉上与改动前一致。
  const single = submissions.length <= 1;
  const [active, setActive] = useState<string>(single ? (submissions[0]?.targetId ?? "__compare__") : "__compare__");
  /** 🔴 焦点只抢一次的开关 */
  const focusTakenRef = useRef(false);
  /** 每个 sheet 各自的截止时间(〔继续等〕会把它往后推) */
  const deadlineRef = useRef<Record<string, number>>({});
  const timersRef = useRef<Record<string, any>>({});
  /** 已写过历史的 sheet(避免重复写) */
  const historyRef = useRef<Set<string>>(new Set());
  /** 用于让 tab 徽标上的"已耗时"每秒跳一下 */
  const [, tick] = useState(0);

  const writeHistory = useCallback(
    (s: Submission, st: SheetState) => {
      if (historyRef.current.has(s.targetId)) return;
      historyRef.current.add(s.targetId);
      // 🔴 **每个区各写一条历史**:一条 SQL 打了 3 个区却只留一条历史,回头看不出哪个区没成。
      fetch("/api/redshift/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql,
          targetId: s.targetId,
          status: st.phase === "finished" ? "success" : "failed",
          duration: Math.round(((st.finishedAt ?? Date.now()) - st.startedAt) / 1000),
          rowCount: st.totalRows,
          error: st.error,
        }),
      })
        .then(() => onHistoryWritten?.())
        .catch(() => {});
    },
    [sql, onHistoryWritten]
  );

  // ── 每个 sheet 一条独立的轮询链 ─────────────────────────────────────────────
  useEffect(() => {
    const abort = { done: false };
    for (const s of submissions) {
      if (!s.statementId) continue; // 提交就失败的,不轮询
      deadlineRef.current[s.targetId] = Date.now() + SHEET_TIMEOUT_MS;
      const qs = new URLSearchParams();
      if (s.handleId) qs.set("handleId", s.handleId);
      qs.set("targetId", s.targetId);
      const poll = async () => {
        if (abort.done) return;
        if (Date.now() > (deadlineRef.current[s.targetId] ?? 0)) {
          // 🔴 **超时 ≠ 失败**:文案与状态都要区分。写成"失败"会让人以为 SQL 有问题,
          // 而真相往往是那个区慢或数据量大(后台**可能仍在跑**)。
          setSheets((prev) => ({ ...prev, [s.targetId]: { ...prev[s.targetId], phase: "timeout" } }));
          return;
        }
        try {
          const r = await fetch(`/api/redshift/result/${s.statementId}?${qs.toString()}`);
          const d = await r.json();
          if (abort.done) return;
          if (!r.ok) {
            // handle 校验类拒绝(403/410/503)—— 响应体没有 status 字段,必须先处理,
            // 否则会落到"继续轮询"分支永远卡在执行中(既有页面注释警告过的坑)。
            setSheets((prev) => ({
              ...prev,
              [s.targetId]: {
                ...prev[s.targetId],
                phase: "failed",
                error: d?.error?.message || d?.error || t("取结果被拒"),
                finishedAt: Date.now(),
              },
            }));
            return;
          }
          if (d.status === "FINISHED") {
            setSheets((prev) => {
              const next: SheetState = {
                ...prev[s.targetId],
                phase: "finished",
                columns: d.columns || [],
                rows: d.rows || [],
                totalRows: d.totalRows,
                resultRows: d.resultRows,
                hasResultSet: d.hasResultSet !== false,
                maskedColumns: d.maskedColumns,
                finishedAt: Date.now(),
              };
              writeHistory(s, next);
              return { ...prev, [s.targetId]: next };
            });
            // 🔴 焦点只抢一次
            if (!focusTakenRef.current) {
              focusTakenRef.current = true;
              setActive(s.targetId);
            }
            return;
          }
          if (d.status === "FAILED" || d.status === "ABORTED") {
            setSheets((prev) => {
              const next: SheetState = {
                ...prev[s.targetId],
                phase: "failed",
                error: d.error || t("执行失败"),
                errorKind: d.errorKind,
                errorHint: d.errorHint,
                finishedAt: Date.now(),
              };
              writeHistory(s, next);
              return { ...prev, [s.targetId]: next };
            });
            return;
          }
          setSheets((prev) =>
            prev[s.targetId]?.phase === "submitting"
              ? { ...prev, [s.targetId]: { ...prev[s.targetId], phase: "running" } }
              : prev
          );
          timersRef.current[s.targetId] = setTimeout(poll, POLL_MS);
        } catch (e: any) {
          if (abort.done) return;
          timersRef.current[s.targetId] = setTimeout(poll, POLL_MS * 2);
        }
      };
      poll();
    }
    // 每秒让"已耗时"重绘一次
    const ticker = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      abort.done = true;
      clearInterval(ticker);
      Object.values(timersRef.current).forEach((h) => clearTimeout(h));
      timersRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissions]);

  const keepWaiting = (s: Submission) => {
    deadlineRef.current[s.targetId] = Date.now() + SHEET_TIMEOUT_MS;
    setSheets((prev) => ({ ...prev, [s.targetId]: { ...prev[s.targetId], phase: "running" } }));
    const qs = new URLSearchParams();
    if (s.handleId) qs.set("handleId", s.handleId);
    qs.set("targetId", s.targetId);
    const poll = async () => {
      if (Date.now() > (deadlineRef.current[s.targetId] ?? 0)) {
        setSheets((prev) => ({ ...prev, [s.targetId]: { ...prev[s.targetId], phase: "timeout" } }));
        return;
      }
      try {
        const r = await fetch(`/api/redshift/result/${s.statementId}?${qs.toString()}`);
        const d = await r.json();
        if (r.ok && d.status === "FINISHED") {
          setSheets((prev) => ({
            ...prev,
            [s.targetId]: {
              ...prev[s.targetId], phase: "finished", columns: d.columns || [], rows: d.rows || [],
              totalRows: d.totalRows, hasResultSet: d.hasResultSet !== false, finishedAt: Date.now(),
            },
          }));
          return;
        }
        if (r.ok && (d.status === "FAILED" || d.status === "ABORTED")) {
          setSheets((prev) => ({
            ...prev,
            [s.targetId]: { ...prev[s.targetId], phase: "failed", error: d.error, finishedAt: Date.now() },
          }));
          return;
        }
        timersRef.current[s.targetId] = setTimeout(poll, POLL_MS);
      } catch {
        timersRef.current[s.targetId] = setTimeout(poll, POLL_MS * 2);
      }
    };
    poll();
  };

  const cancelOne = async (s: Submission) => {
    // 🔴 **只取消这一个区**(§4septies.4:不连坐)。region 由服务端从句柄取,客户端无从指定。
    try {
      const qs = s.handleId ? `?handleId=${encodeURIComponent(s.handleId)}` : "";
      const r = await fetch(`/api/redshift/cancel${qs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementId: s.statementId }),
      });
      const d = await r.json();
      if (d?.success) {
        clearTimeout(timersRef.current[s.targetId]);
        setSheets((prev) => ({
          ...prev,
          [s.targetId]: { ...prev[s.targetId], phase: "cancelled", finishedAt: Date.now() },
        }));
        message.success(t("已取消 {t} 的查询(其它区域不受影响)", { t: s.targetId }));
      } else message.error(d?.error?.message || t("取消失败"));
    } catch (e: any) {
      message.error(e?.message || t("取消失败"));
    }
  };

  const elapsedOf = (st: SheetState) =>
    Math.max(0, Math.round(((st.finishedAt ?? Date.now()) - st.startedAt) / 1000));

  const badgeOf = (s: Submission) => {
    const st = sheets[s.targetId];
    if (!st) return null;
    if (st.phase === "submitting") return <Tag>{t("⏳ 提交中")}</Tag>;
    if (st.phase === "running") return <Tag color="processing">{t("⏳ 执行中 {n}s", { n: elapsedOf(st) })}</Tag>;
    if (st.phase === "timeout") return <Tag color="warning">{t("⏱ 超时")}</Tag>;
    if (st.phase === "cancelled") return <Tag>{t("已取消")}</Tag>;
    if (st.phase === "failed") return <Tag color="error">{t("✗ 失败")}</Tag>;
    return (
      <Tag color="success">
        {st.hasResultSet === false
          ? t("✓ {n} 行受影响", { n: st.resultRows ?? 0 })
          : t("✓ {n} 行 · {s}s", { n: st.totalRows ?? st.rows.length, s: elapsedOf(st) })}
      </Tag>
    );
  };

  const allTerminal = submissions.every((s) => {
    const p = sheets[s.targetId]?.phase;
    return p === "finished" || p === "failed" || p === "cancelled" || p === "timeout";
  });

  /**
   * 列签名比对。🔴 **只在全部到终态后才判** —— 中途判必然误报(多数区还没有列签名)。
   * 基准 = **第一个成功返回的区**(不是 home:home 也可能失败;基准必须真有列签名)。
   */
  const signatureMismatch = useMemo(() => {
    if (!allTerminal) return new Set<string>();
    const ok = submissions.filter((s) => sheets[s.targetId]?.phase === "finished");
    if (ok.length < 2) return new Set<string>();
    const base = (sheets[ok[0].targetId].columns || []).join(",");
    const bad = new Set<string>();
    for (const s of ok.slice(1)) {
      if ((sheets[s.targetId].columns || []).join(",") !== base) bad.add(s.targetId);
    }
    return bad;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTerminal, sheets, submissions]);

  // 原 `crossJur`(跨法域时禁用合并)**已删**:不设法务门,合并对跨法域 target 可用(查询已审计)。

  const compareRows = submissions.map((s) => {
    const st = sheets[s.targetId] || ({} as SheetState);
    return {
      key: s.targetId,
      targetId: s.targetId,
      region: s.region,
      home: s.home,
      phase: st.phase,
      badge: badgeOf(s),
      rowsN: st.phase === "finished" ? (st.totalRows ?? st.rows.length) : null,
      elapsed: st.phase === "finished" ? elapsedOf(st) : null,
      signature: st.phase === "finished" ? (st.columns || []).join(", ") : "",
      mismatch: signatureMismatch.has(s.targetId),
      error: st.error,
    };
  });

  const renderSheet = (s: Submission) => {
    const st = sheets[s.targetId];
    if (!st) return null;
    const locus = (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t("落点")}: <code>{s.region}</code> · <code>{s.workgroup}</code> · <code>{s.database}</code> ·{" "}
        <Tag color={s.credential === "per-project" ? "green" : s.credential === "shared-admin" ? "orange" : "default"}>
          {s.credential}
        </Tag>
        {/* 中性法域标签 + 区域审计 ID(INTERACTION v2.17 §4bis.1;不带任何「知情 / 担责」措辞) */}
        {s.jurisdiction && s.jurisdiction !== "home" ? (
          <>
            {" "}· <Tag color="geekblue" data-testid="sheet-jurisdiction">🌍 {s.jurisdiction}</Tag>
            {s.auditId ? (
              <span data-testid="sheet-audit-id" title={t("该次查询的区域审计记录 ID(全量留在该区;中央只留摘要)")}>
                {t("审计 #{id}", { id: s.auditId })}
              </span>
            ) : null}
          </>
        ) : null}
      </Text>
    );
    if (st.phase === "failed") {
      // 🔴 错误**三段**:原文 + 归类去哪修 + 该区落点。多区域排障第一个问题永远是「我到底打到哪了」。
      return (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="error"
            showIcon
            message={t("该区域执行失败(其它区域不受影响)")}
            description={
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <div><Text code copyable style={{ whiteSpace: "pre-wrap" }}>{st.error}</Text></div>
                {st.errorHint ? <div><Text type="warning">💡 {st.errorHint}</Text></div> : null}
                <div>{locus}</div>
              </Space>
            }
          />
        </Space>
      );
    }
    if (st.phase === "timeout") {
      return (
        <Alert
          type="warning"
          showIcon
          icon={<ClockCircleOutlined />}
          message={t("⏱ 该区域超时({n}s)—— 后台可能仍在跑", { n: elapsedOf(st) })}
          description={
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              <Text type="secondary">{t("超时不等于失败:可以继续等,也可以只取消这一个区域(不影响其它 sheet)。")}</Text>
              <Space>
                <Button size="small" onClick={() => keepWaiting(s)}>{t("继续等")}</Button>
                <Button size="small" danger icon={<StopOutlined />} onClick={() => cancelOne(s)}>
                  {t("取消该区")}
                </Button>
              </Space>
              <div>{locus}</div>
            </Space>
          }
        />
      );
    }
    if (st.phase === "cancelled") {
      return <Alert type="info" showIcon message={t("已取消该区域的查询")} description={locus} />;
    }
    if (st.phase !== "finished") {
      return (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message={t("⏳ 该区域执行中(已 {n}s)—— 别的区域先回来的会先显示", { n: elapsedOf(st) })}
            description={
              <Space direction="vertical" size={6}>
                <div>{locus}</div>
                <Button size="small" danger icon={<StopOutlined />} onClick={() => cancelOne(s)}>
                  {t("取消该区")}
                </Button>
              </Space>
            }
          />
        </Space>
      );
    }
    if (st.hasResultSet === false) {
      return (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type="success" showIcon message={t("执行成功({n} 行受影响)", { n: st.resultRows ?? 0 })} description={locus} />
        </Space>
      );
    }
    return (
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          {locus}
          {signatureMismatch.has(s.targetId) ? (
            <Tag color="red">{t("列签名与基准区不一致")}</Tag>
          ) : null}
          {st.maskedColumns?.length ? <Tag color="gold">{t("已脱敏列: {c}", { c: st.maskedColumns.join(", ") })}</Tag> : null}
        </Space>
        <Table
          size="small"
          scroll={{ x: "max-content" }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          dataSource={st.rows.map((r, i) => ({ key: i, ...Object.fromEntries(st.columns.map((c, j) => [c, r[j]])) }))}
          columns={st.columns.map((c) => ({ title: c, dataIndex: c, ellipsis: true, render: (v: any) => String(v ?? "") }))}
        />
      </Space>
    );
  };

  const compareTab = {
      key: "__compare__",
      label: (
        <Space size={4}>
          <span>⚖ {t("对比")}</span>
          {allTerminal && signatureMismatch.size > 0 ? <Tag color="red">{signatureMismatch.size}</Tag> : null}
        </Space>
      ),
      children: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type={allTerminal && signatureMismatch.size ? "warning" : "info"}
            showIcon
            message={
              allTerminal
                ? signatureMismatch.size
                  ? t("有 {n} 个区域的列签名与基准区不一致 —— 通常是该区表结构不同或数据未同步", { n: signatureMismatch.size })
                  : t("各区域均已回来;行数差异见下表(列签名一致)")
                : t("各区域独立执行,回来一个填一个;列签名一致性在全部区域到终态后才判定(避免误报)")
            }
          />
          <Table
            size="small"
            pagination={false}
            dataSource={compareRows}
            rowClassName={(r: any) => (r.mismatch ? "bgp-row-mismatch" : "")}
            columns={[
              {
                title: t("区域"), dataIndex: "region", width: 160,
                render: (v: string, r: any) => (
                  <Space size={4}>
                    <Tag color={r.home ? "default" : "cyan"}>{r.targetId}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text>
                  </Space>
                ),
              },
              { title: t("状态"), dataIndex: "badge", width: 170 },
              { title: t("行数"), dataIndex: "rowsN", width: 90, render: (v: number | null) => (v === null ? "—" : v.toLocaleString()) },
              { title: t("耗时"), dataIndex: "elapsed", width: 80, render: (v: number | null) => (v === null ? "—" : `${v}s`) },
              {
                title: t("列签名"), dataIndex: "signature", ellipsis: true,
                render: (v: string, r: any) =>
                  v ? (
                    <Text type={r.mismatch ? "danger" : undefined} style={{ fontSize: 12 }}>
                      {v}{r.mismatch ? ` ⚠` : ""}
                    </Text>
                  ) : (
                    <Text type="secondary">—</Text>
                  ),
              },
              {
                title: t("错误"), dataIndex: "error", ellipsis: true,
                render: (v: string) => (v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : "—"),
              },
            ]}
          />
          <Space>
            {/* 🔴 **结果绝不自动合并**;合并是**显式动作**(INTERACTION §4septies.6 v2.17:对跨法域 target 也可用,查询已审计)。 */}
            <Tooltip title={t("把各区结果纵向拼成一张表(仅列签名一致时可用)")}>
              <Button
                size="small"
                disabled={!allTerminal || signatureMismatch.size > 0}
                onClick={() => setActive("__merged__")}
              >
                {t("合并为一张表")}
              </Button>
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t("并置展示是缺省形态:结果留在各自 sheet;合并是你的显式动作,并已审计。")}
            </Text>
          </Space>
        </Space>
      ),
  };

  // region 在本次提交里是否**不唯一**(同区多目标 ⇒ 标签必须带 targetId)
  const regionAmbiguous = (region: string) => submissions.filter((x) => x.region === region).length > 1;
  const items: any[] = [
    // 单区不放对比 tab(见上方 `single` 的说明)
    ...(single ? [] : [compareTab]),
    ...submissions.map((s) => ({
      key: s.targetId,
      label: (
        <Space size={4}>
          {/* 🔴 标签原来**只写 region**:同一 region 装了多个执行目标时
              (生产形态允许,旧环境 usw2_a/b/c 三个都在 us-west-2)几张 sheet 的标签**一模一样**,
              用户没法分辨哪张是哪个目标(排障第一个问题就是「我到底打到哪了」)。
              ⇒ region 不唯一时把 targetId 一起显示;唯一时保持原样(不给常见情形添噪音)。 */}
          <Tag color={s.home ? "default" : "cyan"} style={{ marginInlineEnd: 0 }} title={s.targetId}>
            {regionAmbiguous(s.region) ? `${s.region} · ${s.targetId}` : s.region}
          </Tag>
          {/* 跨法域 sheet 的 tab 上也带 🌍 法域(用户一眼看出这个区不在本法域) */}
          {s.jurisdiction && s.jurisdiction !== "home" ? <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>🌍 {s.jurisdiction}</Tag> : null}
          {badgeOf(s)}
        </Space>
      ),
      children: renderSheet(s),
    })),
  ];

  // 显式合并出来的那张表(只有点了按钮才出现;点了才加这个 tab,避免它平时占位)
  if (active === "__merged__") {
    const ok = submissions.filter((s) => sheets[s.targetId]?.phase === "finished");
    const cols = ok.length ? sheets[ok[0].targetId].columns : [];
    const merged = ok.flatMap((s) =>
      (sheets[s.targetId].rows || []).map((r, i) => ({
        key: `${s.targetId}-${i}`,
        __region: s.region,
        // 🔴 同一 region 可以有**多个执行目标**
        // (生产形态就是单账号 × 多 region,而一个 region 里可以装多套;旧环境 usw2_a/b/c 三个都在 us-west-2)。
        // 只写 region 时,两个目标的行在「来源」上**一模一样**,合并表就成了「不知道哪行来自哪」。
        __targetId: s.targetId,
        ...Object.fromEntries(cols.map((c, j) => [c, r[j]])),
      }))
    );
    items.push({
      key: "__merged__",
      label: <span>🧩 {t("已合并({n} 行)", { n: merged.length })}</span>,
      children: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type="info" showIcon message={t("这是你显式合并的视图;平台不会自动合并任何跨区结果。首列标出该行来自哪个区域。")} />
          <Table
            size="small"
            scroll={{ x: "max-content" }}
            pagination={{ pageSize: 20 }}
            dataSource={merged}
            columns={[
              // 来源列与「对比」表同一形态:targetId 是主标、region 作次要说明(同 region 多目标时才分得清)
              {
                title: t("来源"), dataIndex: "__targetId", width: 200,
                render: (v: string, r: any) => (
                  <Space size={4}>
                    <Tag color="cyan">{v}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>{r.__region}</Text>
                  </Space>
                ),
              },
              ...cols.map((c) => ({ title: c, dataIndex: c, ellipsis: true, render: (v: any) => String(v ?? "") })),
            ]}
          />
        </Space>
      ),
    });
  }

  return <Tabs size="small" activeKey={active} onChange={setActive} items={items} />;
}
