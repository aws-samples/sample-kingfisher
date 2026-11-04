"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Button, Card, Input, Select, Space, Table, Tag, Alert, Spin, Typography,
  Collapse, Segmented, Empty, message, Modal, Form,
} from "antd";
import { RobotOutlined, SendOutlined, BulbOutlined, ReloadOutlined, FileAddOutlined, UserOutlined, PlusOutlined, SaveOutlined, FolderOpenOutlined } from "@ant-design/icons";
import MiniChart from "@/components/genbi/MiniChart";
import type { GenBiResult, GenBiHistoryItem } from "@/types/genbi";
import { useT } from "@/lib/i18n/useT";
// 🔴🔴 用户拍板「连问数都可以切区」:取数落点跟顶栏「执行范围」走。
//    AgentCore(Runtime/Gateway/Memory)只装在主控区 ⇒ 非主控区自动走进程内引擎,页面如实说一句。
import { useScope } from "@/components/scope/ScopeProvider";
// 会话卡片三件:保存弹框 / 我的卡片抽屉 / 打开别范围卡片的二选一(§9.7)
import { SaveCardModal, MyCardsDrawer, ScopeSwitchConfirm, fetchCards } from "@/components/genbi/SessionCards";
import type { CardRow } from "@/components/genbi/SessionCards";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { ranInView, ranInLabel } from "@/lib/genbi/ran-in";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
// 前端默认值也收编到命名 SSOT(与改动前**同值**,零行为变化)。
// 🔴 待办:这里应改成"取当前执行目标的 workgroup"(env 覆盖与 per-target 实名都在服务端,
//    客户端拿不到)—— 届时改这一个 import 的用法即可,不必再回来找字面量。

const { Title, Paragraph, Text } = Typography;

const EXAMPLES = [
  "数据库里都有哪些表？各有多少行数据？",
  "customers 表里一共有多少个客户？",
  "他们按地区怎么分布？",
  "orders 表最近的 10 条记录是什么？",
];
const ATHENA_EXAMPLES = [
  "S3 Tables 里都有哪些表？各有多少行？",
  "按地区统计客户数，从多到少",
  "那按商品分类呢？",
  "订单总金额是多少？",
];

type ChartView = "auto" | "table" | "bar" | "line";

// 单轮助手回答的渲染（结论 + 命中表 + 图表/表格 + SQL/推理）。各自维护图表切换。
// 🔴 `onSaveCard` 与 `onPromote` **同级**(用户原话:「这个功能是在提为需求的同级别需求」);
//   但两者语义不同:提为需求 = 拿**这一轮**去开需求单;保存对话 = 把**整段对话**收进「我的卡片」⇒ 文案必须写清「对话」。
// `expectRegion` = 这次提问应当落在的区(视角所在区;未知传 null)
function TurnResult({ result, onPromote, onSaveCard, expectRegion }: { result: GenBiResult; onPromote: () => void; onSaveCard: () => void; expectRegion: string | null }) {
  const t = useT();
  // 🔴 答案区必须说出**执行层回报**的真落点;与视角不一致当场红字(横幅只是请求侧声称)
  const ran = ranInView(result._meta?.ranIn, expectRegion);
  const [chartView, setChartView] = useState<ChartView>("auto");
  const tableColumns = (result.columns || []).map((c, idx) => ({ title: c, dataIndex: String(idx), key: String(idx), ellipsis: true }));
  const tableData = (result.rows || []).map((row, i) => {
    const obj: Record<string, any> = { _key: i };
    row.forEach((cell, j) => { obj[String(j)] = cell; });
    return obj;
  });
  const isMetric = result.chart?.type === "metric" && result.rows.length === 1 && result.columns.length === 1;
  const chartData = (() => {
    const spec = result.chart;
    if (!spec) return null;
    const eff: ChartView = chartView === "auto" ? (spec.type === "bar" || spec.type === "line" ? spec.type : "table") : chartView;
    if (eff === "table") return null;
    const xField = spec.xField || result.columns[0];
    const yField = spec.yField || result.columns[result.columns.length - 1];
    const xi = result.columns.indexOf(xField), yi = result.columns.indexOf(yField);
    if (xi < 0 || yi < 0) return null;
    return {
      type: eff as "bar" | "line",
      labels: result.rows.map((r) => String(r[xi] ?? "")),
      values: result.rows.map((r) => Number(r[yi] ?? 0)).map((v) => (Number.isFinite(v) ? v : 0)),
      xField, yField,
    };
  })();

  return (
    <Card
      size="small"
      style={{ marginTop: 8 }}
      title={<span><RobotOutlined style={{ color: "#22d3ee" }} /> {t("助手")}</span>}
      extra={
        <Space>
          <Button size="small" icon={<SaveOutlined />} onClick={onSaveCard} data-testid="genbi-save-card-btn">{t("保存对话")}</Button>
          <Button size="small" type="primary" ghost icon={<FileAddOutlined />} onClick={onPromote}>{t("提为需求")}</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>tokens in {result.usage?.inputTokens ?? 0}/out {result.usage?.outputTokens ?? 0}</Text>
        </Space>
      }
    >
      <Paragraph style={{ whiteSpace: "pre-wrap", fontSize: 15 }} data-testid="genbi-answer">{result.answer}</Paragraph>

      {/* 🔴 本次回答**实际用的模型 / 后端**(执行层回报的 _meta,不是「打算用」):多厂商模型通道之后
          管理员换了全局默认,用户在这里就能看见这次答案是谁答的;页面驱动的验收也只认这里(判据需要的真值,产品有义务暴露)。 */}
      {result._meta?.modelId ? (
        <div data-testid="genbi-model-used" data-model={result._meta.modelId} data-backend={result._meta.backend || ""} data-degraded={result._meta.degraded ? "true" : "false"} style={{ marginBottom: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("本次模型:{m}", { m: result._meta.modelId })}
            {result._meta.backend ? ` · ${t("后端")} ${result._meta.backend}` : ""}
            {result._meta.degraded ? ` · ${t("已降级回落")}` : ""}
          </Text>
        </div>
      ) : null}

      <div data-testid="genbi-ran-in" data-kind={ran.kind} data-regions={ran.kind === "unreported" ? "" : ran.regions.join(",")} style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {ran.kind === "unreported"
            ? t("本次 SQL 实际执行位置:未回报(这次没有执行 SQL,或执行层未回报)")
            : t("本次 SQL 实际执行于:{where}", { where: ran.items.map((r) => ranInLabel(r, t)).join(";") })}
        </Text>
      </div>
      {ran.kind === "mismatch" && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="genbi-ran-in-mismatch"
          message={t("本次 SQL 实际在 {actual} 执行,与当前视角 {expected} 不一致 —— 这份答案不是该区域的数据", { actual: ran.regions.join("、"), expected: ran.expected })} />
      )}

      {result.maskedColumns && result.maskedColumns.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={t("部分敏感字段已按数据分级脱敏：{cols}（如需明文请在数据治理「申请访问」）", { cols: result.maskedColumns.join("、") })} />
      )}

      {result.matchedTables && result.matchedTables.length > 0 && (
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(34,211,238,0.06)", border: "1px solid #1d4254", borderRadius: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t("本次命中数据表：")}</Text>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            {result.matchedTables.map((m, i) => (
              <div key={i} style={{ fontSize: 13 }}>
                <Tag color={m.preferred ? "purple" : "cyan"}>{m.schema}.{m.table}</Tag>
                {m.preferred && <Tag color="gold">{t("已固化")}</Tag>}
                <Text type="secondary" style={{ fontSize: 12 }}>{m.reason}</Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.usedContext && result.usedContext.length > 0 && (
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(250,173,20,0.06)", border: "1px solid #4a3a1d", borderRadius: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t("本次参考了 {n} 条业务口径（结论已按此口径生成）：", { n: result.usedContext.length })}</Text>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {result.usedContext.map((c, i) => (
              <Tag key={i} color="gold" style={{ fontSize: 12 }}>
                {c.kindLabel} · {c.title}{c.scope ? `（${c.scope}）` : ""}
              </Tag>
            ))}
          </div>
        </div>
      )}

      {isMetric && (
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <div style={{ fontSize: 36, fontWeight: 600, color: "#1677ff" }}>{result.rows[0][0]}</div>
          <Text type="secondary">{result.columns[0]}</Text>
        </div>
      )}

      {result.columns.length > 0 && result.rows.length > 0 && !isMetric && (
        <>
          <Space style={{ marginBottom: 12 }}>
            <Text type="secondary">{t("展示方式：")}</Text>
            <Segmented value={chartView} onChange={(v) => setChartView(v as ChartView)}
              options={[{ label: t("自动"), value: "auto" }, { label: t("表格"), value: "table" }, { label: t("柱状图"), value: "bar" }, { label: t("折线图"), value: "line" }]} />
          </Space>
          {chartData ? (
            <Card size="small" style={{ marginBottom: 12 }}>
              <MiniChart type={chartData.type} labels={chartData.labels} values={chartData.values} />
              <div style={{ textAlign: "center" }}><Text type="secondary" style={{ fontSize: 12 }}>{chartData.xField} × {chartData.yField}</Text></div>
            </Card>
          ) : (
            <Table size="small" columns={tableColumns} dataSource={tableData} rowKey="_key" scroll={{ x: true }}
              pagination={{ pageSize: 10, showTotal: (total) => t("共 {n} 行", { n: total }) }} style={{ marginBottom: 12 }} />
          )}
        </>
      )}

      <Collapse ghost items={[
        ...(result.sql ? [{
          key: "sql", label: t("查看生成的 SQL"),
          children: (<pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 12, borderRadius: 6, overflow: "auto" }}><code>{result.sql}</code></pre>),
        }] : []),
        {
          key: "steps", label: t("执行链路（{n} 步）", { n: result.steps?.length || 0 }),
          children: (result.steps?.length || 0) === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("无执行步骤")} /> : (
            <Space direction="vertical" style={{ width: "100%" }} size={10}>
              {result.steps.map((s, i) => (
                <div key={i} style={{ borderLeft: `2px solid ${s.ok ? "#22d3ee" : "#ff4d4f"}`, paddingLeft: 12 }}>
                  <Space wrap>
                    <Text strong style={{ color: "#8fb0c2" }}>#{i + 1}</Text>
                    <Tag color="geekblue">{s.tool || "run_sql"}</Tag>
                    {s.phase && <Tag color={s.phase === "prepare" ? "default" : "cyan"}>{s.phase === "prepare" ? t("准备") : t("推理")}</Tag>}
                    <Tag color={s.ok ? "green" : "red"}>{s.ok ? t("成功") : t("失败")}</Tag>
                    {typeof s.durationMs === "number" && <Text type="secondary" style={{ fontSize: 12 }}>{(s.durationMs / 1000).toFixed(1)}s</Text>}
                  </Space>
                  {s.inputSummary ? (
                    <div style={{ marginTop: 4 }}><Text type="secondary" style={{ fontSize: 12 }}>{t("入参：")}</Text><Text style={{ fontSize: 12 }} code>{s.inputSummary}</Text></div>
                  ) : null}
                  {s.sql ? (
                    <pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 8, borderRadius: 6, overflow: "auto", marginTop: 4, marginBottom: 0 }}><code style={{ fontSize: 12 }}>{s.sql}</code></pre>
                  ) : null}
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t("结果：")}</Text>
                    {s.ok
                      ? <Text style={{ fontSize: 12 }}>{s.outputSummary || (typeof s.rowCount === "number" ? t("{n} 行", { n: s.rowCount }) : t("完成"))}</Text>
                      : <Text type="danger" style={{ fontSize: 12 }}>{s.error || s.outputSummary || t("失败")}</Text>}
                  </div>
                </div>
              ))}
            </Space>
          ),
        },
      ]} />
    </Card>
  );
}

interface Turn { id: string; question: string; result: GenBiResult | null; error: string; loading: boolean; elapsedMs?: number; }
const newConvId = () => `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// 异步轮询参数。前端上限略高于服务端 300s 天花板(兜底,正常情况下服务端会先返回
// timeout/succeeded)。轮询间隔 2s(复用 workflow runs 心智)。
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 320_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function GenBiPage() {
  const t = useT();
  const { scope, targets: scopeTargets, setScope } = useScope();
  // 缺省(全部视角)= 主控区,与改动前逐字节等价
  const askTargetId = scope.kind === "target" ? scope.targetId : undefined;
  // 取数请求的落点(恒有:全部 / 对比视角 = 主控区,显式);askTargetId 只管界面语义
  const askLanding = landingOfScope(scope);
  const askRegion = askTargetId ? scopeTargets?.find((x) => x.targetId === askTargetId)?.region || askTargetId : "";
  // 这次提问**应当**落在的区:选了区 = 该区;没选 = 主控区(问数缺省 target)。查不到就 null(不臆测)
  const expectRegion = scopeTargets?.find((x) => x.targetId === (askTargetId || HOME_TARGET_ID))?.region ?? null;
  // 读路由一律 `?scope=`(执行/写路由才用 body.targetId,SPEC §2.6.3)
  const scopeParam = toScopeParam(scope);
  const historyScopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState<string>(newConvId);
  // 工作组清单请求的序号:只认最新那次的响应(见 fetchWorkgroups 里的理由)
  const wgReqSeq = useRef(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sending, setSending] = useState(false);
  const [engine, setEngine] = useState<"redshift" | "athena">("redshift");

  const [workgroups, setWorkgroups] = useState<any[]>([]);
  // 🔴 不再以 home 的 workgroup 常量打底:在 us-west-2 视角下那是
  // **别的区**的名字,清单到达前它会在下拉里当选中项显示(与向导同族)。空 = 清单到达后选第一个;
  // 空着提交时服务端按执行目标解析(唯一作者 resolveRedshiftBinding)。
  const [selectedWg, setSelectedWg] = useState("");
  const [databases, setDatabases] = useState<string[]>(["dev"]);
  const [selectedDb, setSelectedDb] = useState("dev");
  // 数据湖(S3 Tables · Athena)命名空间:动态列真实 namespace(此前前端写死 ecommerce → 游戏环境 404)。
  const [s3Namespaces, setS3Namespaces] = useState<string[]>([]);
  const [selectedNs, setSelectedNs] = useState<string>("");
  // 当前执行目标的联邦目录引用(含**该区**表桶名),由 /api/athena/tables 按 targetId 解析后回传;不在前端写死。
  const [s3Catalog, setS3Catalog] = useState<string>("");
  const [history, setHistory] = useState<GenBiHistoryItem[]>([]);

  // 会话卡片
  const [saveOpen, setSaveOpen] = useState(false);
  const [cardsOpen, setCardsOpen] = useState(false);
  const [cardsRefresh, setCardsRefresh] = useState(0);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [pendingCard, setPendingCard] = useState<CardRow | null>(null);
  const [readOnlyCard, setReadOnlyCard] = useState<CardRow | null>(null);

  // 提为需求（按某一轮的问答）
  const [reqOpen, setReqOpen] = useState(false);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqCtx, setReqCtx] = useState<{ question: string; result: GenBiResult } | null>(null);
  const [reqForm] = Form.useForm();

  // 🔴 工作组下拉必须跟随**问数自己的执行目标**:
  // 否则在 us-west-2 问数时下拉里列的是主控区的工作组,选中一个就等于让用户挑一个不存在于该区的落点。
  const fetchWorkgroups = () => {
    // 🔴🔴 先清空再取 + **丢弃陈旧响应**:一次进站可能并发发出「上一个区」与「当前区」两个清单请求
    // (视角 effect 比首屏渲染晚一拍),谁先回来不确定;晚到的那份会赢 ⇒ us-west-2 视角显示主控区的
    // 工作组与 us-east-1 的 Endpoint(真环境截图坐实,与 `/settings` 那次硬撒谎同类)。
    // 只「先清空」治不了:清空在请求**发出时**,管不住晚到的响应 ⇒ 加序号,回来时不是最新那次就整份丢掉。
    setWorkgroups([]);
    setSelectedWg("");
    const seq = ++wgReqSeq.current;
    return fetch(`/api/redshift/connections?targetId=${encodeURIComponent(askLanding)}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq !== wgReqSeq.current) return; // 更晚的请求已发出 ⇒ 这份是别的区的答案,丢掉
        if (!Array.isArray(d)) return;
        setWorkgroups(d);
        // 选中项只能是**这份清单里**的名字:换区后上一个区的选中项作废,取该区第一个;清单为空就留空。
        const names: string[] = d.map((w: any) => w.workgroupName).filter(Boolean);
        setSelectedWg((cur) => (cur && names.includes(cur) ? cur : names[0] || ""));
      })
      .catch(() => {});
  };
  // 🔴 库列表也必须跟随问数的执行目标。
  // 上一刀只修了工作组下拉,库列表仍打主控区 ⇒ 在 us-west-2 问数时,工作组是对的、库名是主控区的,
  // 选出来的组合根本不存在。**半截跟随比不跟随更坏**:错得像对的。
  const fetchDatabases = (wg: string) =>
    fetch(`/api/redshift/databases?workgroup=${encodeURIComponent(wg)}&targetId=${encodeURIComponent(askLanding)}`)
      .then((r) => r.json())
      .then((d: any[]) => Array.isArray(d) && d.length && setDatabases(d.map((x) => x.name)))
      .catch(() => {});
  // 问数历史按区过滤(行上已有 `targetId` 章)。
  const fetchHistory = () =>
    fetch(`/api/genbi/history${historyScopeQs}`).then((r) => r.json()).then((d) => setHistory(d?.success ? d.data : [])).catch(() => {});
  // 拉真实 S3 Tables 命名空间(控制面 ListNamespaces,复用 athena 查询页同款端点);默认选第一个存在的 namespace。
  // S3 Tables 命名空间也按执行目标取(每个区一个表桶)。
  const fetchNamespaces = () => fetch(`/api/athena/tables?targetId=${encodeURIComponent(askLanding)}`).then((r) => r.json()).then((d) => {
    const ns: string[] = Array.isArray(d?.namespaces) ? d.namespaces.map((n: any) => n.namespace).filter(Boolean) : [];
    setS3Namespaces(ns);
    setS3Catalog(typeof d?.catalog === "string" ? d.catalog : "");
    setSelectedNs((cur) => cur || ns[0] || "");
  }).catch(() => {});

  // 执行目标一换,工作组下拉必须跟着重拉(否则列的是上一个区的)
  // 🔴 deps 必须同时含 `scopeParam`:`askTargetId` 只在**单区**视角有值,
  // 只写它 ⇒ 在两个多区分组之间切换时 effect 不触发,历史列表停在上一个分组的数据上(护栏 4 的漏洞)。
  useEffect(() => { fetchWorkgroups(); fetchDatabases(selectedWg); fetchHistory(); fetchNamespaces(); /* eslint-disable-next-line */ }, [askTargetId, scopeParam]);

  const openRequirement = (q: string, result: GenBiResult) => {
    setReqCtx({ question: q, result });
    reqForm.setFieldsValue({
      title: q.slice(0, 80), priority: "P2", businessValue: "",
      acceptanceCriteria: result.answer?.slice(0, 200) || "", description: `源自智能问数。\n问题：${q}`,
    });
    setReqOpen(true);
  };
  const submitRequirement = async () => {
    if (!reqCtx) return;
    let values: any;
    try { values = await reqForm.validateFields(); } catch { return; }
    setReqSubmitting(true);
    try {
      const res = await fetch("/api/requirements", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, source: { kind: "genbi", question: reqCtx.question, sql: reqCtx.result.sql, columns: reqCtx.result.columns, sampleRows: (reqCtx.result.rows || []).slice(0, 10), chartType: reqCtx.result.chart?.type } }),
      });
      const data = await res.json();
      if (!data?.success) message.error(data?.error?.message || t("提交失败"));
      else { message.success(t("已提交为需求，研发经理将受理")); setReqOpen(false); }
    } catch (e: any) { message.error(e?.message || t("网络异常")); }
    finally { setReqSubmitting(false); }
  };

  // 异步任务轮询:每 2s 拉 GET /api/genbi/tasks/[taskId],直到终态或上限。running 时更新已耗时
  // 活性(消除长问答干瞪眼)。响应恒为 JSON → 永不 JSON.parse 天书;上限后显 timeout → 永不无限转圈。
  const pollTask = async (id: string, taskId: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_MAX_MS) {
      await sleep(POLL_INTERVAL_MS);
      let data: any;
      try {
        const res = await fetch(`/api/genbi/tasks/${taskId}`);
        data = await res.json();
      } catch { continue; } // 网络抖动:跳过本次,下轮重试
      if (!data?.success) {
        setTurns((prev) => prev.map((turn) => turn.id === id ? { ...turn, error: data?.error?.message || t("请求失败"), loading: false } : turn));
        return;
      }
      const { status, result, error, elapsedMs } = data.data || {};
      if (status === "succeeded") {
        setTurns((prev) => prev.map((turn) => turn.id === id ? { ...turn, result: result as GenBiResult, loading: false } : turn));
        fetchHistory();
        return;
      }
      if (status === "failed" || status === "timeout") {
        const msg = status === "timeout" ? t("查询超过 5 分钟已自动终止，请缩小范围或拆分问题后重试。") : (error || t("执行失败"));
        setTurns((prev) => prev.map((turn) => turn.id === id ? { ...turn, error: msg, loading: false } : turn));
        return;
      }
      // pending / running:更新已耗时活性,继续轮询。
      setTurns((prev) => prev.map((turn) => turn.id === id ? { ...turn, elapsedMs: typeof elapsedMs === "number" ? elapsedMs : turn.elapsedMs } : turn));
    }
    // 前端兜底上限(正常服务端会先返回 timeout)。
    setTurns((prev) => prev.map((turn) => turn.id === id ? { ...turn, error: t("查询超过 5 分钟已自动终止，请缩小范围或拆分问题后重试。"), loading: false } : turn));
  };

  const ask = async (q?: string) => {
    const query = (q ?? question).trim();
    if (!query) { message.warning(t("请输入问题")); return; }
    if (sending) return;
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTurns((prev) => [...prev, { id, question: query, result: null, error: "", loading: true }]);
    setQuestion("");
    setSending(true);
    try {
      const res = await fetch("/api/genbi/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // `targetId` 走 body(写/执行路由不读 `?scope=`)
        // 🔴 选了 target 就**不带** workgroup:页面这个选择器列的是主控区的工作组,带过去会撞落点冲突
        body: JSON.stringify({ question: query, workgroupName: askTargetId ? undefined : selectedWg, database: engine === "athena" ? selectedNs : selectedDb, engine, conversationId, targetId: askLanding }),
      });
      const data = await res.json();
      // 自适应:同步(200 含 result)直接渲染=零回归路径;异步(202 含 taskId)起轮询。前端无需感知 flag。
      if (data?.success && data.data?.async && data.data?.taskId) {
        setSending(false); // 异步:释放发送锁,执行在后台轮询,不阻塞继续提问
        await pollTask(id, data.data.taskId);
        return;
      }
      setTurns((prev) => prev.map((turn) => turn.id === id ? (data?.success ? { ...turn, result: data.data as GenBiResult, loading: false } : { ...turn, error: data?.error?.message || t("请求失败"), loading: false }) : turn));
      if (data?.success) fetchHistory();
    } catch (e: any) {
      setTurns((prev) => prev.map((turn) => turn.id === id ? { ...turn, error: e?.message || t("网络异常"), loading: false } : turn));
    } finally { setSending(false); }
  };

  // 拉一次配额给按钮显示 n/100(读路由带 ?scope=,与列表同一口径)
  const refreshQuota = () => {
    void fetchCards(scopeParam).then((r) => { if (!("error" in r)) setQuota({ used: r.used, limit: r.limit }); });
  };
  useEffect(() => { refreshQuota(); /* eslint-disable-next-line */ }, [scopeParam, cardsRefresh]);

  /** 把卡片正文渲染成对话线程(只读或续聊都先做这一步)。 */
  const renderCardBody = (body: { turns: Array<{ question: string; result: GenBiResult | null; error?: string | null }> }) => {
    setTurns((body.turns || []).map((tn, i) => ({
      id: `card-${i}`, question: tn.question, result: tn.result, error: String(tn.error || ""), loading: false,
    })));
  };

  /**
   * 打开一张卡片。🔴 走 50 INTERACTION v2.30 §9.7(护栏 7)的协议:
   *  · 同范围 ⇒ 直接打开并续聊;
   *  · 不同范围 ⇒ **弹二选一**,绝不静默切顶栏;选「只读查看」时**压根不调 resume**(第 6 条零副作用)。
   */
  const openCard = async (card: CardRow, resume: boolean) => {
    const res = await fetch(`/api/genbi/cards/${card.cardId}`);
    const d = await res.json();
    if (!d?.success) { message.error(d?.error?.message || t("打开卡片失败")); return; }
    renderCardBody(d.data.body);
    if (d.data.bodyMissing) {
      message.warning(t("这张卡片的正文已不在 {region} —— 可以删掉它释放额度", { region: card.region }));
      setCardsOpen(false);
      return;
    }
    if (Array.isArray(d.data.maskedNow) && d.data.maskedNow.length) {
      message.info(t("按当前数据分级,这几列已隐去:{cols}", { cols: d.data.maskedNow.join("、") }));
    }
    setCardsOpen(false);
    if (!resume) { setReadOnlyCard(card); return; }
    if (card.targetId === askTargetId) { await doResume(card); return; }
    setPendingCard(card); // 跨范围 ⇒ 交给 §9.7 的二选一
  };

  const doResume = async (card: CardRow) => {
    const r = await fetch(`/api/genbi/cards/${card.cardId}/resume`, { method: "POST" });
    const d = await r.json();
    if (!d?.success) { message.error(d?.error?.message || t("恢复对话失败")); return; }
    // 🔴 沿用卡片原来的 conversationId:换一个新 id 会让「再次保存」找不到原卡、多吃一个额度
    setConversationId(d.data.conversationId);
    setReadOnlyCard(null);
    message.success(t("已恢复这段对话的上下文({n} 轮),可以接着问了", { n: d.data.rehydratedTurns }));
  };

  const startNewConversation = () => {
    setConversationId(newConvId());
    setTurns([]);
    setQuestion("");
    message.success(t("已开始新对话"));
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Title level={3} style={{ marginBottom: 0 }}><RobotOutlined /> {t("智能问数 GenBI")}</Title>
        <Space>
          {/* 个人卡片集合入口。🔴 用抽屉而**不新增菜单叶**:
              新增一个叶子会触发 31 叶全覆盖那一整套棘轮机制(54 DESIGN §9 反模式 ⑤)。*/}
          <Button icon={<FolderOpenOutlined />} onClick={() => setCardsOpen(true)} data-testid="genbi-my-cards-btn">
            {quota ? t("我的卡片 {u}/{l}", { u: quota.used, l: quota.limit }) : t("我的卡片")}
          </Button>
          <Button icon={<PlusOutlined />} onClick={startNewConversation}>{t("新对话")}</Button>
        </Space>
      </div>
      <Paragraph type="secondary">
        {t("多轮对话式问数：用自然语言连续提问、可承上启下地追问（“他们按地区怎么分布？”“那按分类呢？”）。平台基于 Amazon Bedrock AgentCore 生成只读 SQL、执行并给出结论、数据与图表，所有数字均来自真实查询。")}
      </Paragraph>

      {/* 🔴 用户 2026-09-10 拍板「都走同一个 AgentCore」。
          于是提示条只说**一件**事:SQL 在这个区域的数仓上执行。**不再**提「进程内引擎」——
          那是上一版按区分流的说法,已被推翻(同一个 Runtime / Gateway / 技能 / 记忆服务所有区)。 */}
      {askTargetId && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="genbi-scope-note"
          message={t("当前在 {region} 提问:SQL 在该区域的数据仓库上执行(问数走同一个 AgentCore,对话记忆与技能全区共用)。答案与数据都来自该区域的真实查询。", { region: askRegion })}
        />
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Text strong>{t("数据源：")}</Text>
          <Segmented value={engine} onChange={(v) => setEngine(v as "redshift" | "athena")}
            options={[{ label: t("数据仓库 (Redshift)"), value: "redshift" }, { label: t("数据湖 (S3 Tables · Athena)"), value: "athena" }]} />
          {engine === "redshift" ? (
            <>
              <Select value={selectedWg || undefined} style={{ width: 200 }} onChange={(v) => { setSelectedWg(v); fetchDatabases(v); }}
                placeholder={t("按执行目标自动解析")}
                options={workgroups.map((w) => ({ label: `${w.workgroupName} (${w.status})`, value: w.workgroupName }))} />
              <Select value={selectedDb} style={{ width: 140 }} onChange={setSelectedDb} options={databases.map((d) => ({ label: d, value: d }))} />
              <Button icon={<ReloadOutlined />} onClick={() => fetchWorkgroups()}>{t("刷新")}</Button>
            </>
          ) : (
            <>
              {/* 表桶名随执行目标(原来写死主控区的 bgp-table-bucket,在别的区视角下是谎话) */}
              <Tag color="cyan">{s3Catalog ? t("联邦目录 {c}（Iceberg）", { c: s3Catalog }) : t("联邦目录（Iceberg）· 按执行目标解析")}</Tag>
              <Text type="secondary">{t("命名空间：")}</Text>
              <Select value={selectedNs || undefined} style={{ width: 180 }} placeholder={t("选择命名空间")} onChange={setSelectedNs} showSearch
                options={s3Namespaces.map((n) => ({ label: n, value: n }))}
                notFoundContent={s3Namespaces.length ? undefined : t("无命名空间")} />
              <Button icon={<ReloadOutlined />} onClick={() => fetchNamespaces()}>{t("刷新")}</Button>
            </>
          )}
        </Space>
      </Card>

      {/* 对话线程 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { minHeight: 120 } }}>
        {turns.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("开始一段对话吧：先问一个问题，再用“他们/那/继续按…拆分”等追问，平台会记住上下文。")} />
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size={16}>
            {turns.map((turn) => (
              <div key={turn.id}>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <Tag color="blue" style={{ marginTop: 2 }}><UserOutlined /> {t("我")}</Tag>
                  <Text strong style={{ fontSize: 15 }}>{turn.question}</Text>
                </div>
                {turn.loading && (
                  <div style={{ padding: "12px 0 0 8px" }}>
                    <Spin /> <Text type="secondary" style={{ marginLeft: 8 }}>{t("正在思考、生成并执行 SQL……")}</Text>
                    {typeof turn.elapsedMs === "number" && turn.elapsedMs >= 3000 && (
                      <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{t("已耗时 {s}s", { s: Math.floor(turn.elapsedMs / 1000) })}</Text>
                    )}
                  </div>
                )}
                {turn.error && <Alert type="error" message={turn.error} showIcon style={{ marginTop: 8 }} />}
                {turn.result && <TurnResult result={turn.result} expectRegion={expectRegion} onPromote={() => openRequirement(turn.question, turn.result!)}
                                onSaveCard={() => { if (!askTargetId) { message.warning(t("请先在顶栏选定一个执行范围(卡片要记住这段对话在哪个区取的数)")); return; } setSaveOpen(true); }} />}
              </div>
            ))}
          </Space>
        )}
      </Card>

      {/* 输入区 */}
      <Card style={{ marginBottom: 16 }}>
        {/* 🔴 50 INTERACTION v2.30 §9.7 第 4 条
            只读态**必须 disable 且说明为什么**(上面那条 `genbi-card-readonly-note` 就是那句原因 +
            保留的切区入口)。只给横幅不 disable ⇒ 用户照样能问,而问的是**错的区** —— 那比不能问坏得多;
            只 disable 不解释 ⇒ 用户以为页面坏了。两半都要有。 */}
        <Input.TextArea value={question} onChange={(e) => setQuestion(e.target.value)}
          disabled={!!readOnlyCard} data-testid="genbi-ask-input"
          placeholder={readOnlyCard
            ? t("只读查看中 —— 这张卡片属于 {region},切到那里才能继续对话", { region: readOnlyCard.region })
            : t("输入问题或追问，例如：按地区统计客户数；接着问“那按分类呢？”（Enter 发送 / Shift+Enter 换行）")}
          autoSize={{ minRows: 2, maxRows: 5 }}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); if (!readOnlyCard) ask(); } }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <Space wrap>
            <BulbOutlined style={{ color: "#faad14" }} />
            {(engine === "athena" ? ATHENA_EXAMPLES : EXAMPLES).map((ex) => (
              <Tag key={ex} style={{ cursor: "pointer" }} onClick={() => ask(ex)}>{ex}</Tag>
            ))}
          </Space>
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!!readOnlyCard}
                  data-testid="genbi-send-btn" onClick={() => ask()}>{t("发送")}</Button>
        </div>
      </Card>

      <Card title={t("最近提问")} size="small">
        {history.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无历史")} />
        ) : (
          <Space direction="vertical" style={{ width: "100%" }}>
            {history.map((h) => (
              <div key={h.historyId} style={{ borderBottom: "1px solid #1d4254", paddingBottom: 8 }}>
                <a onClick={() => ask(h.question)}>{h.question}</a>
                <div><Text type="secondary" style={{ fontSize: 12 }}>{h.createdAt?.slice(0, 19).replace("T", " ")} · {t("{n} 行", { n: h.rowCount })}</Text></div>
              </div>
            ))}
          </Space>
        )}
      </Card>

      {/* 三件:保存弹框 / 我的卡片抽屉 / 打开别范围卡片的二选一(§9.7)*/}
      <SaveCardModal
        open={saveOpen} onCancel={() => setSaveOpen(false)}
        onSaved={(_id, used) => { setSaveOpen(false); setQuota((q) => ({ used, limit: q?.limit ?? 100 })); setCardsRefresh((n) => n + 1); }}
        conversationId={conversationId}
        // 🔴 与提问时用的是同一个表达式(engine 决定看 selectedNs 还是 selectedDb):
        //    卡片的重脱敏要按**当次执行的库**去查分级,这里给错等于重脱敏失效。
        database={engine === "athena" ? selectedNs : selectedDb}
        targetId={askTargetId || ""}
        region={askRegion || askTargetId || ""}
        engine={engine}
        turns={turns.filter((x) => x.result).map((x, i) => ({ i, question: x.question, askedAt: new Date().toISOString(), elapsedMs: x.elapsedMs, result: x.result, error: x.error || null }))}
        defaultTitle={turns[0]?.question || ""}
        used={quota?.used ?? 0} limit={quota?.limit ?? 100}
      />
      <MyCardsDrawer open={cardsOpen} onClose={() => setCardsOpen(false)} onOpenCard={(c, r) => void openCard(c, r)} refreshKey={cardsRefresh} />
      <ScopeSwitchConfirm
        open={!!pendingCard} card={pendingCard}
        serviceable={!!scopeTargets?.find((x) => x.targetId === pendingCard?.targetId)?.serviceable}
        notServiceableWhy={scopeTargets?.find((x) => x.targetId === pendingCard?.targetId)?.unusableReason ?? null}
        onCancel={() => setPendingCard(null)}
        onReadOnly={() => { setReadOnlyCard(pendingCard); setPendingCard(null); }}
        onSwitchAndResume={async () => {
          const c = pendingCard!;
          setPendingCard(null);
          // 🔴 §9.7 第 1/5 条:切范围由**用户点下去**触发,且走 `setScope`(改 URL + 记住选择、不重载)
          setScope({ kind: "target", targetId: c.targetId });
          await doResume(c);
        }}
      />
      {readOnlyCard && (
        // 🔴 §9.7 第 4 条:只读态必须**说明为什么不能操作**,并保留切区入口(只 disable 不解释 = 用户以为坏了)
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="genbi-card-readonly-note"
               message={t("只读查看:这张卡片属于 {tid}({region}),继续对话需要先把执行范围切到那里。", { tid: readOnlyCard.targetId, region: readOnlyCard.region })}
               action={<Button size="small" onClick={() => setPendingCard(readOnlyCard)}>{t("切区并继续")}</Button>} />
      )}
      <Modal title={t("提为需求")} open={reqOpen} onCancel={() => setReqOpen(false)} onOk={submitRequirement} confirmLoading={reqSubmitting} okText={t("提交需求")} width={640}>
        <Alert type="info" message={t("提交后将进入当前项目空间的需求池，由数据产品/研发经理受理并指派研发。技术实现由研发部门完成。")} style={{ marginBottom: 16 }} />
        <Form form={reqForm} layout="vertical">
          <Form.Item name="title" label={t("需求标题")} rules={[{ required: true, message: t("请填写需求标题") }]}><Input maxLength={80} placeholder={t("一句话概括这个分析诉求")} /></Form.Item>
          <Form.Item name="priority" label={t("优先级")} initialValue="P2">
            <Select options={[{ value: "P0", label: t("P0 紧急") }, { value: "P1", label: t("P1 高") }, { value: "P2", label: t("P2 中") }, { value: "P3", label: t("P3 低") }]} />
          </Form.Item>
          <Form.Item name="description" label={t("需求描述")}><Input.TextArea rows={3} placeholder={t("期望产出什么、口径、频率等")} /></Form.Item>
          <Form.Item name="businessValue" label={t("业务价值")}><Input.TextArea rows={2} placeholder={t("这个需求带来的业务价值 / 使用场景")} /></Form.Item>
          <Form.Item name="acceptanceCriteria" label={t("验收标准")}><Input.TextArea rows={2} placeholder={t("什么情况下算交付完成")} /></Form.Item>
          {reqCtx && (
            <div style={{ background: "rgba(34,211,238,0.06)", border: "1px solid #1d4254", borderRadius: 8, padding: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t("将随需求一并提交的洞察来源（只读快照）：")}</Text>
              <div style={{ marginTop: 6, fontSize: 12, color: "#8fb0c2" }}>{t("问题：")}{reqCtx.question}</div>
              {reqCtx.result?.sql && (
                <pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 8, borderRadius: 6, overflow: "auto", marginTop: 6, maxHeight: 120 }}><code style={{ fontSize: 12 }}>{reqCtx.result.sql}</code></pre>
              )}
            </div>
          )}
        </Form>
      </Modal>
    </div>
  );
}
