"use client";
// @kf-batch 50-P50.3-matrix2
// **多 Region 看板 · 版本一致性矩阵**(50 INTERACTION §3.1 线框 + §3.1a 入选规则 + §3.1b 建模产物行组 + §2bis.4 格子语义)。
//
// 这是对标 DataWorks / Snowflake / Databricks 的核心差异点:
//   · DataWorks 要开 N 个工作空间人工比对;
//   · Snowflake 的 replication 是**按对象**复制,不给"任务 × region 一致性"视图;
//   · Databricks 是 workspace-per-region + Terraform 自己兜。
// 一屏看出**漏发 / 失败 / 版本不齐 / 结构漂移**,并且点格直达处置 —— 这是我们独有的。
//
// 🔴 本页最要紧的事不是"画出来",是**别误报**:§2bis.4 + §3.1b 明写
// `🔶已特化` / `—未绑定` / `⊘数据不可用` / `⊘待重新落地`(序 33 ③ 起:WP-11b 交付前的旧记录)**四类格不参与红黄判定**(原第五类「⊘被驻留门控」已随不设法务门删除,WP-10a)
// (用户原话:「不是所有区域的计算任务都绝对一致,某些区域是特定的计算任务也是正常的」)。
//
// 🔴 判定与派发**全部来自服务端同一份纯函数**:
//   · 「哪些态需要处理」← `deployments-shared.ts` 的 `needsAttention`(本页**不再**自己写一列 bool ——
//     W3-d2 之前 `CELL_UI` 里那列 `attention` 就是第二个真值源,加一个态就会漂);
//   · 「一键处置打哪个端点」← `matrix-actions.ts` 的 `matrixRepublishAction`(混排了建模产物之后,
//     原来那条硬编码会把 codeTableId 打进 `/api/etl-jobs/{id}/schedule`)。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Modal, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { ReloadOutlined, GlobalOutlined, ThunderboltOutlined, WarningOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";
import { needsAttention, type CellState } from "@/lib/exec-env/deployments-shared";
import { matrixRepublishAction, readMatrixActionResult } from "@/lib/exec-env/matrix-actions";

const { Title, Text } = Typography;

interface Cell {
  state: CellState;
  version?: number;
  publishedAt?: number;
  error?: string;
  artifact?: string;
  defHash?: string;
  observedAt?: string;
  residual?: true;
}
interface Row {
  type: string;
  group: "task" | "modeling";
  id: string;
  name: string;
  shape: string;
  targets: string[];
  /** 任务行才有(建模没有版本快照 ⇒ 不许印「v0」) */
  currentVersion?: number;
  /** 建模产物行才有 */
  currentDefHash?: string;
  physical?: string;
  cells: Record<string, Cell>;
  attention: number;
  scheduleEnabled: boolean;
  cronExpression?: string;
}
interface Col {
  targetId: string;
  region: string;
  isHome: boolean;
  active: boolean;
}
interface AttentionTask {
  type: string;
  group: "task" | "modeling";
  id: string;
  name: string;
  targetId: string;
  state: CellState;
  actionable: boolean;
  skipReason?: string;
  cronExpression?: string;
}
interface Matrix {
  columns: Col[];
  rows: Row[];
  covered: string[];
  pending: string[];
  excluded: { unpublished: number; unlanded: number; truncated: boolean; cap: number };
  scope: { project: string[]; global: string[] };
  summary: { rows: number; attentionRows: number; attentionCells: number; actionableCells: number };
  attention: AttentionTask[];
}

/**
 * 格子的呈现口径。🔴 与服务端 `CellState` **一一对应**,不在这里新造状态;
 * 「要不要处理」**不在这里写** —— 一律问 `needsAttention()`(单一真值源)。
 */
const CELL_UI: Record<CellState, { text: string; color?: string; hint: string }> = {
  ok: { text: "✓", color: "success", hint: "已下发/已落地,与当前定义一致" },
  stale: { text: "⚠ 版本不齐", color: "warning", hint: "下发/落地过,但不是当前版本 —— 重做即可对齐" },
  failed: { text: "✗ 失败", color: "error", hint: "下发/落地失败,看错误详情(常见:组件缺失 / 权限 / 桶策略)" },
  "never-deployed": { text: "⚠ 漏发", color: "warning", hint: "绑了这个区却从没下发过 —— 这就是「漏 region」" },
  unbound: { text: "—", hint: "本就没绑这个区(区域专属 / 按需不绑)⇒ 正常,不参与判定" },
  specialized: { text: "🔶 已特化", color: "orange", hint: "脱离共享定义、不随主定义更新 ⇒ 本就该不同,不判不齐" },
  unavailable: { text: "⊘ 数据不可用", hint: "该区没有它依赖的独有数据 ⇒ 天然不能绑,不参与判定" },
  // ── 建模产物行引入的两态(§3.1b;@kf-batch 50-W5-seg1-WP10a:`residency-blocked` 已删,不设法务门)──
  drift: {
    text: "🔴 结构漂移",
    color: "error",
    hint: "该区已存在**结构不同**的同名表,平台没有覆盖它(建表是 CREATE TABLE IF NOT EXISTS)⇒ 去建模页看字段级差异",
  },
  // @kf-batch 50-WP11b-shared-writer —— 写入通道已交付;这一态只剩交付前留下的旧记录(文案随合同更新,不许留过期的话)
  "credential-gap": {
    text: "⊘ 待重新落地",
    hint: "该区尚未供给 shared-writer 身份(写入通道交付之前留下的旧记录)⇒ 到建模页对这个区重新落地一次即自动供给并写入",
  },
};

/** 建模产物行的文案改写:同一个严重度,不同说法(「漏发」对一张码表是听不懂的)。 */
const MODELING_TEXT: Partial<Record<CellState, { text: string; hint: string }>> = {
  "never-deployed": { text: "⚠ 未落地", hint: "绑了这个区却没落过这张表 —— 那个区现在没有它" },
  ok: { text: "✓", hint: "**观测到**的表结构与平台定义一致(只代表「观测于」那一刻)" },
};

const cellUi = (state: CellState, group: "task" | "modeling") => {
  const base = CELL_UI[state] || CELL_UI.unbound;
  const over = group === "modeling" ? MODELING_TEXT[state] : undefined;
  return { ...base, ...(over || {}) };
};

const SHAPE_UI: Record<string, string> = {
  shared: "🌐 多region共享",
  exclusive: "📍 区域专属",
  specialized: "🔶 已特化",
};

const TYPE_UI: Record<string, { label: string; color: string }> = {
  "etl-job": { label: "⏱ 离线任务", color: "geekblue" },
  "code-table": { label: "🧱 码表", color: "purple" },
  "model-table": { label: "🧱 维度/事实表", color: "purple" },
};

export default function MultiRegionBoardPage() {
  const t = useT();
  const [m, setM] = useState<Matrix | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [groupFilter, setGroupFilter] = useState<"all" | "task" | "modeling">("all");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<Array<{ name: string; targetId: string; ok: boolean; note: string }>>([]);

  /**
   * 🔴 建模产物的处置是**平台管理员**才有的权限(落地端点硬拦 403)。
   * 沿用仓内既有写法(workflow / EmrJobPanel 同一来源),**不隐藏、而是禁用 + 说清原因** ——
   * 「最坏的不是不能用,是看不出为什么不能用」。真授权仍在服务端。
   */
  const { getToken } = useAuth();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        setIsPlatformAdmin(groupsFromToken(await getToken()).includes("bgp-admin"));
      } catch {
        /* 非登录态忽略;默认 false = 保守(不误开入口) */
      }
    })();
  }, [getToken]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/multi-region/matrix");
      const d = await r.json();
      // 🔴 读失败**显示错误**,不显示空矩阵 —— 空矩阵在界面上等于"一切正常"(假绿)。
      if (!r.ok || !d?.success) {
        setM(null);
        setErr(d?.error?.message || t("矩阵读取失败"));
        return;
      }
      setErr("");
      setM(d.data as Matrix);
    } catch (e: any) {
      setM(null);
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 处置一个 (定义 × region)。🔴 端点与请求体**全部来自共享派发表**,本页不写 if ——
   * 混排之后每多一种行类型,派发表有门禁保证它有落点,而页面里的 if 没有。
   */
  const doOne = async (
    row: { type: string; id: string; group: "task" | "modeling"; cronExpression?: string },
    targetId: string,
    state: CellState
  ): Promise<{ ok: boolean; note: string }> => {
    const plan = matrixRepublishAction(row, targetId, state);
    if (plan.kind === "skip") return { ok: false, note: plan.reason };
    if (row.group === "modeling" && !isPlatformAdmin) {
      return { ok: false, note: t("建模产物的落地仅平台管理员可做(服务端会拒)") };
    }
    const r = await fetch(plan.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan.body),
    });
    const d = await r.json();
    if (!r.ok || !d?.success) return { ok: false, note: d?.error?.message || t("处置失败") };
    // 🔴 HTTP 200 **不等于**那一格现在是绿的(建模落地在 drift/缺通道时也回 200)⇒ 读回真实逐 target 结果
    return readMatrixActionResult(row, targetId, d.data);
  };

  const doRepublish = async (row: Row, targetId: string, state: CellState) => {
    setBusy(true);
    try {
      const r = await doOne(row, targetId, state);
      r.ok ? message.success(`${row.name} → ${targetId}:${r.note}`) : message.error(`${row.name} → ${targetId}:${r.note}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 「一键处置全部不一致项」—— 🔴 先弹**影响预览**(机制B),确认后逐项串行。
   * 🔴 `actionable=false` 的**不做**,并把原因写进结果里(静默跳过 = 用户以为已经处理了)。
   */
  const doBatch = async () => {
    if (!m) return;
    setBusy(true);
    const out: Array<{ name: string; targetId: string; ok: boolean; note: string }> = [];
    try {
      for (const a of m.attention) {
        if (!a.actionable) {
          out.push({ name: a.name, targetId: a.targetId, ok: false, note: t("跳过:{r}", { r: a.skipReason || "不可一键处置" }) });
          continue;
        }
        const row = m.rows.find((x) => x.id === a.id && x.type === a.type);
        if (!row) continue;
        const r = await doOne(row, a.targetId, a.state);
        out.push({ name: a.name, targetId: a.targetId, ...r });
      }
      setBatchResult(out);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    if (!m) return [];
    let rows = m.rows;
    if (onlyAttention) rows = rows.filter((r) => r.attention > 0);
    if (groupFilter !== "all") rows = rows.filter((r) => r.group === groupFilter);
    return rows;
  }, [m, onlyAttention, groupFilter]);

  const columns = useMemo(() => {
    if (!m) return [];
    const base: any[] = [
      {
        title: t("定义"),
        dataIndex: "name",
        fixed: "left" as const,
        width: 330,
        render: (v: string, r: Row) => (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Tag color={TYPE_UI[r.type]?.color || "default"}>{TYPE_UI[r.type]?.label || r.type}</Tag>
              <Text strong>{v}</Text>
              <Tag>{SHAPE_UI[r.shape] || r.shape}</Tag>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.group === "modeling"
                ? // 建模没有版本快照,比对基准是**定义指纹** ⇒ 照实显示指纹与物理落点,不假装有版本号
                  t("定义指纹 {h} · 落点 {p}", { h: (r.currentDefHash || "").slice(0, 10), p: r.physical || "-" })
                : `${t("当前版本 v{v}", { v: r.currentVersion ?? "-" })} · ${
                    r.scheduleEnabled ? `⏱ ${r.cronExpression || "-"}` : t("未调度")
                  }`}
            </Text>
          </Space>
        ),
      },
    ];
    for (const c of m.columns) {
      base.push({
        title: (
          <Space size={4} direction="vertical">
            <Text strong>{c.region || c.targetId}</Text>
            <Space size={2}>
              <Tag color={c.isHome ? "default" : "cyan"} style={{ marginInlineEnd: 0 }}>{c.targetId}</Tag>
              {/* 🔴 已不活跃的 target 仍显示(台账里出现过)—— 只取活跃列会把"发到过某个后来被摘掉的区"整列藏掉 */}
              {c.active ? null : <Tag color="volcano">{t("已下线")}</Tag>}
            </Space>
          </Space>
        ),
        dataIndex: ["cells", c.targetId],
        key: c.targetId,
        width: 180,
        render: (_: any, r: Row) => {
          const cell = r.cells?.[c.targetId];
          const state = (cell?.state || "unbound") as CellState;
          const ui = cellUi(state, r.group);
          // 🔴 「要不要给处置入口」问服务端那份纯函数,不看本页的任何 bool;残留格不给(没有清理通道)
          const act = needsAttention(state) && cell?.residual !== true;
          const plan = matrixRepublishAction({ type: r.type, id: r.id, group: r.group, cronExpression: r.cronExpression }, c.targetId, state);
          return (
            <Tooltip
              title={
                `${t(ui.hint)}` +
                `${cell?.error ? ` | ${cell.error}` : ""}` +
                `${cell?.artifact ? ` | ${cell.artifact}` : ""}` +
                `${cell?.observedAt ? ` | ${t("观测于")} ${cell.observedAt.slice(0, 19).replace("T", " ")}` : ""}`
              }
            >
              <Space direction="vertical" size={0}>
                <Space size={4}>
                  {ui.color ? <Tag color={ui.color}>{t(ui.text)}</Tag> : <Text type="secondary">{t(ui.text)}</Text>}
                  {cell?.version !== undefined ? <Text style={{ fontSize: 12 }}>v{cell.version}</Text> : null}
                  {cell?.defHash ? <Text type="secondary" style={{ fontSize: 11 }}>#{cell.defHash.slice(0, 6)}</Text> : null}
                  {/* 🔴 残留**必须显示**:解绑不会删掉那个区已经建出来的表(跨法域残留不许被藏起来) */}
                  {cell?.residual ? (
                    <Tooltip title={t("这个区当前**没绑**,但那里还有产物 —— 解绑不会删掉已建出来的表,平台也还没有清理通道(已登记)。")}>
                      <Tag color="volcano">{t("残留")}</Tag>
                    </Tooltip>
                  ) : null}
                </Space>
                {/* 建模产物的「观测于」直接摆在格子里:不许把陈旧观测画成实时绿灯 */}
                {cell?.observedAt ? (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {t("观测于 {a}", { a: cell.observedAt.slice(5, 16).replace("T", " ") })}
                  </Text>
                ) : null}
                {act ? (
                  plan.kind === "post" ? (
                    <Tooltip title={r.group === "modeling" && !isPlatformAdmin ? t("仅平台管理员可落地建模产物") : ""}>
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: 0 }}
                        loading={busy}
                        disabled={r.group === "modeling" && !isPlatformAdmin}
                        onClick={() => doRepublish(r, c.targetId, state)}
                      >
                        {/* 文案用**字面量**(i18n 抽取要静态可见);端点仍来自派发表 */}
                        {r.group === "modeling" ? t("落地到此 region") : t("重发到此 region")}
                      </Button>
                    </Tooltip>
                  ) : (
                    // 🔴 不能一键的**说清为什么**,并给去处(drift 要人工逐字确认,看板不代劳)
                    <Tooltip title={plan.reason}>
                      <Text type="warning" style={{ fontSize: 12 }}>
                        {state === "drift" ? t("需人工处置 →「建模」页") : t("不可一键处置")}
                      </Text>
                    </Tooltip>
                  )
                ) : null}
              </Space>
            </Tooltip>
          );
        },
      });
    }
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, busy, t, isPlatformAdmin]);

  return (
    <div>
      <Title level={3}>
        <GlobalOutlined /> {t("多 Region 看板")}
      </Title>
      <Text type="secondary">
        {t("一屏看全 region 的**任务下发**与**建模产物落地**一致性。红=失败/结构漂移,黄=版本不齐/漏发,绿=一致;🔶已特化 / —未绑定 / ⊘数据不可用 / ⊘待重新落地 四类**不参与判定、不报警**(区域专属任务本就不该被报「缺失」)。")}
      </Text>

      {err ? (
        // 🔴 算不出来就说算不出来,绝不显示一张空矩阵冒充"一切正常"
        <Alert style={{ marginTop: 12 }} type="error" showIcon message={t("矩阵算不出来(这不等于「没问题」)")} description={err}
          action={<Button size="small" onClick={load}>{t("重试")}</Button>} />
      ) : null}

      {m ? (
        <>
          <Card size="small" style={{ marginTop: 12, marginBottom: 12 }}>
            <Space wrap>
              <Tag color={m.summary.attentionCells > 0 ? "error" : "success"}>
                {m.summary.attentionCells > 0
                  ? t("⚠ {rows} 个定义、{cells} 个格子需要处理", { rows: m.summary.attentionRows, cells: m.summary.attentionCells })
                  : t("✓ 各 region 下发/落地一致")}
              </Tag>
              <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>{t("刷新")}</Button>
              <Button size="small" onClick={() => setOnlyAttention((v) => !v)}>
                {onlyAttention ? t("显示全部定义") : t("只看需要处理的")}
              </Button>
              <Button size="small" onClick={() => setGroupFilter(groupFilter === "all" ? "task" : groupFilter === "task" ? "modeling" : "all")}>
                {groupFilter === "all" ? t("行组:全部") : groupFilter === "task" ? t("行组:仅任务") : t("行组:仅建模产物")}
              </Button>
              {/* 🔴 按钮上的数是**能真正动手**的格子数(drift 要人工确认)⇒ 不许用总数过度承诺 */}
              <Button size="small" type="primary" icon={<ThunderboltOutlined />}
                disabled={m.summary.actionableCells === 0} loading={busy}
                onClick={() => { setBatchResult([]); setBatchOpen(true); }}>
                {t("一键处置可自动对齐项({n})", { n: m.summary.actionableCells })}
              </Button>
              {m.summary.attentionCells > m.summary.actionableCells ? (
                <Tooltip title={t("结构漂移(drift)要人工决定是否 DROP 重建,看板刻意不代劳 ⇒ 去「建模」页落地面板逐字确认。")}>
                  <Tag icon={<WarningOutlined />} color="warning">
                    {t("其中 {n} 个需人工处置", { n: m.summary.attentionCells - m.summary.actionableCells })}
                  </Tag>
                </Tooltip>
              ) : null}
            </Space>
          </Card>

          {/* 🔴 覆盖面**如实登记**:不说清楚就等于让人以为"一屏看全了"(§3.1a ① / §3.1b) */}
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message={t("本看板当前覆盖:{covered}", { covered: m.covered.join("、") })}
            description={
              <Space direction="vertical" size={2}>
                <Text type="secondary">
                  {t("尚未覆盖(其下发路径还没接下发台账,列进来会每格都误报「漏发」):{pending}", { pending: m.pending.join("、") })}
                </Text>
                <Text type="secondary">
                  {/* 🔴 口径照实说:任务是本项目的,建模产物是平台全局的(建模没有项目维度) */}
                  {t("口径:{p} 只列**本项目**的;{g} 是**平台级全局**的(建模没有项目维度)。", {
                    p: m.scope.project.join("、"),
                    g: m.scope.global.join("、"),
                  })}
                </Text>
                <Text type="secondary">
                  {t("另有 {n} 个**未发布**的任务定义、{k} 个**从没落过也没绑过区**的建模定义未列入(矩阵谈的是「已下发/已落地」的一致性,草稿没有可比对象)。", {
                    n: m.excluded.unpublished,
                    k: m.excluded.unlanded,
                  })}
                  {m.excluded.truncated ? t("⚠ 行数超过 {cap},已截断。", { cap: m.excluded.cap }) : ""}
                </Text>
                <Text type="secondary">
                  {t("非 home 的建模产物落地走窄权 shared-writer 通道(首次落地自动供给);⊘ 待重新落地 = 通道交付之前留下的旧记录,重新落地一次即可。")}
                </Text>
              </Space>
            }
          />

          <Table
            size="small"
            rowKey={(r: Row) => `${r.type}#${r.id}`}
            dataSource={shown}
            columns={columns}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            scroll={{ x: "max-content" }}
          />

          <Card size="small" style={{ marginTop: 12 }} title={t("格子图例")}>
            <Space wrap>
              {(Object.keys(CELL_UI) as CellState[]).map((k) => (
                <Tooltip key={k} title={t(CELL_UI[k].hint)}>
                  {CELL_UI[k].color ? <Tag color={CELL_UI[k].color}>{t(CELL_UI[k].text)}</Tag> : <Tag>{t(CELL_UI[k].text)}</Tag>}
                </Tooltip>
              ))}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {/* 图例里"参与判定"的清单直接从服务端纯函数生成,不手写 —— 手写就会与计数漂 */}
                {t("只有 {list} 参与判定与计数", {
                  list: (Object.keys(CELL_UI) as CellState[]).filter((s) => needsAttention(s)).map((s) => CELL_UI[s].text).join(" / "),
                })}
              </Text>
            </Space>
          </Card>
        </>
      ) : null}

      {/* 🔴 批量处置先弹**影响预览**(机制B):列出将向哪些 (定义 × region) 动手,以及**哪些刻意不动** */}
      <Modal
        title={t("影响预览:{n} 项待处理,其中 {k} 项可自动对齐", {
          n: m?.attention.length ?? 0,
          k: m?.summary.actionableCells ?? 0,
        })}
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        okText={t("确认处置")}
        confirmLoading={busy}
        onOk={doBatch}
        width={900}
      >
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={t("逐项串行;每项走的是与手工发布/落地**同一个**通道(不另造路径)。已成功的保留,失败的仍留在看板上。")}
          description={t("🔴 结构漂移(drift)**不在自动处置范围**:对齐它只能 DROP 该区现有表再重建(表里的数据会一起消失)⇒ 必须去「建模」页落地面板逐字确认。")} />
        <Table
          size="small"
          pagination={false}
          rowKey={(r: any) => `${r.type}#${r.id}#${r.targetId}`}
          dataSource={m?.attention || []}
          columns={[
            { title: t("定义"), dataIndex: "name",
              render: (v: string, r: AttentionTask) => (
                <Space size={4}><Tag color={TYPE_UI[r.type]?.color}>{TYPE_UI[r.type]?.label || r.type}</Tag><Text>{v}</Text></Space>
              ) },
            { title: t("执行区域"), dataIndex: "targetId", width: 150, render: (v: string) => <Tag color="cyan">{v}</Tag> },
            { title: t("当前状态"), dataIndex: "state", width: 140,
              render: (v: CellState, r: AttentionTask) => <Tag color={cellUi(v, r.group).color}>{t(cellUi(v, r.group).text)}</Tag> },
            { title: t("本次处置"), dataIndex: "actionable", width: 260,
              render: (v: boolean, r: AttentionTask) =>
                v ? <Tag color="processing">{t("自动对齐")}</Tag>
                  : <Tooltip title={r.skipReason}><Tag color="default">{t("跳过(需人工)")}</Tag></Tooltip> },
          ]}
        />
        {batchResult.length ? (
          <>
            <Text strong style={{ display: "block", marginTop: 12 }}>{t("处置结果")}</Text>
            <Table
              size="small"
              pagination={false}
              rowKey={(r: any) => `${r.name}#${r.targetId}`}
              dataSource={batchResult}
              columns={[
                { title: t("定义"), dataIndex: "name" },
                { title: t("执行区域"), dataIndex: "targetId", width: 150 },
                { title: t("结果"), dataIndex: "ok", width: 90, render: (v: boolean) => <Tag color={v ? "success" : "error"}>{v ? "✓" : "✗"}</Tag> },
                { title: t("说明"), dataIndex: "note", ellipsis: true },
              ]}
            />
          </>
        ) : null}
      </Modal>
    </div>
  );
}
