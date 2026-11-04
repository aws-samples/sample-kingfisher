"use client";
// @kf-batch 50-W5-seg2-WP8
// 模块 51 — /settings「AI 模型」卡(51 INTERACTION §2 场景一 / 二 / 四 + §3 各态 + §5 F 系列)。
//
//   · 常驻:当前生效模型 + 来源层标签(运行时配置 / 部署 env / 出厂默认 / 配置面陈旧)+ 最近探测态徽标(统一色板)
//   · 场景一:「更换全局默认」Modal —— 两系列目录下拉(默认停在当前生效模型,A2/F3)→「测试该模型」(POST /probe,必须通过)
//             → 保存前弹**中档 danger 确认 + 影响预览**(9 能力 / 全租户 / ≤5s 生效)→ PUT(带 expectVersion 乐观锁)
//   · 场景二:探测失败按四类给「为什么 + 怎么办」文案(F8),探测通过前保存禁用(D5)
//   · 场景四:当前模型最近探测失败 ⇒ 红色告警 banner +「立即恢复出厂默认」(DELETE 全部覆盖;**不要求探测通过**,只轻确认)
//   · §3:catalog 加载中 / 拉取失败可重试(不影响当前生效)/ 探测中 processing / 非 admin 只读 / 首次未自定义引导
//   · 一期不做能力级覆盖(§1bis);GPT 系列条目可见但按传输门控禁用(F8 说明原因)
//
// 状态源全部是真实端点:GET /api/admin/model-config(effective + overrides)/ catalog / probe / PUT / DELETE;
// 非 admin(/api/admin/** 403)退化为只读,读 /api/settings 的 aiModel。
// 无头验收定位钩子:data-testid="ai-model-*"(见 verify_p51_model.py)。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope } from "@/lib/scope/scope";
import { Alert, Badge, Button, Card, Descriptions, Modal, Popconfirm, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import { ExperimentOutlined, ReloadOutlined, RobotOutlined, UndoOutlined } from "@ant-design/icons";
import FeatureGuide from "@/components/common/FeatureGuide";
import { useT } from "@/lib/i18n/useT";

const { Text } = Typography;

type SourceLayer = "runtime" | "runtime-stale" | "env" | "ssot";
// @kf-batch 51-v3-probe-budget:ProbeError 的唯一作者是 lib/ai/capabilities.ts(零依赖叶子,import type 不拖任何运行时);
//   原来这里手抄一份,服务端加一类(Timeout)页面就漂(tsc 当场抓到)—— 单一作者。
import type { ProbeError } from "@/lib/ai/capabilities";

interface Effective {
  scope: string;
  modelId: string;
  source: SourceLayer;
  stale?: boolean;
  probedAt?: number;
  probeOk?: boolean;
  version?: number;
}
interface CatalogModel {
  modelId: string;
  /** 系列键(anthropic / openai / zai / moonshotai …);分组与标题以目录响应的 `families[]` 为准,前端不硬编码 */
  family: string;
  kind: "model" | "profile";
  displayName: string;
  available: boolean;
  lastProbe?: { ok: boolean; error?: ProbeError; probedAt?: number; toolUseOk?: boolean };
  inferenceTypesSupported?: string[];
}
interface ProbeResult {
  ok: boolean;
  error?: ProbeError;
  errorDetail?: string;
  toolUseOk?: boolean;
  probedAt?: number;
}
/**
 * @kf-batch 51-v2-multi-vendor —— 目录响应的 `families[]`(51 SPEC §7.5;唯一作者 lib/ai/core/vendors.ts):
 * 下拉分组标题 / 该系列保存前要不要 tool-use 二探 / 是否恒带推理块。前端不再硬编码「两系列」。
 */
interface FamilySummary {
  family: string;
  label: string;
  toolUse: "assumed" | "probe";
  reasoningBlocks: boolean;
}

/** 受全局默认影响的 9 个能力(与 lib/ai/capabilities.ts 白名单一一对应;影响预览用)。 */
const CAPABILITY_LABELS: [string, string][] = [
  ["genbi", "智能问数"],
  ["genbi-retrieval", "GenBI 检索重排"],
  ["genbi-memory", "GenBI 记忆摘要"],
  ["copilot", "Copilot 问答"],
  ["copilot-planner", "Copilot 规划"],
  ["net-advisor", "网络顾问"],
  ["param-advisor", "参数顾问"],
  ["flink-sql", "Flink SQL 生成"],
  ["codegen", "需求 codegen"],
];

/** 场景二:五类探测失败的「为什么 + 怎么办」(F8;v2.0 加 NotAvailableForAccount,51 INTERACTION §7)。 */
const PROBE_ERROR_TEXT: Record<ProbeError, string> = {
  AccessDenied: "本账号无权调用此模型。请在 Bedrock 控制台为该模型申请访问,或换一个已开通的模型。",
  NotFound: "此模型在当前 region 不可用。请换 region 已上线的模型(下拉已按本 region 过滤,若仍失败可能是刚下线)。",
  MarketplaceSCP: "此模型需在 AWS Marketplace 订阅,但你的账号策略(SCP)禁止订阅第三方模型。请改用 Anthropic 一方模型,或联系账号管理员放开订阅。",
  Throttle: "探测被限流,请稍候重试。",
  NotAvailableForAccount: "此模型对本账号未开放(Bedrock 返回「not available for this account」,是账号级限制,与 region / 权限 / Marketplace 无关)。请联系 AWS 账号团队开通,或改选同系列其它版本 / 其它厂商。",
  // @kf-batch 51-v3-probe-budget(序 46 / B-106):超时不再冒充限流 —— 推理模型(Kimi K3)首字延迟可达数十秒,处方是再试一次 / 换推理配置
  Timeout: "探测超时:模型在本系列的预算时间内没有响应(推理模型首字延迟可达数十秒,与限流无关)。请稍候再测一次;反复超时可换 global. 推理配置,或联系 AWS 账号团队。",
};

const SOURCE_LABEL: Record<SourceLayer, string> = {
  runtime: "运行时配置",
  "runtime-stale": "配置面陈旧(沿用 last-good)",
  env: "部署 env(BEDROCK_MODEL_ID)",
  ssot: "出厂默认(ai-model.json)",
};
const SOURCE_COLOR: Record<SourceLayer, string> = { runtime: "green", "runtime-stale": "red", env: "blue", ssot: "default" };

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export interface AiModelCardProps {
  /** 非 admin 只读时的兜底数据(来自 GET /api/settings 的 aiModel) */
  readonlyModel?: { modelId: string; source: SourceLayer; stale?: boolean } | null;
}

export default function AiModelCard({ readonlyModel }: AiModelCardProps) {
  // @kf-batch 50-WP4quater-reads(工单 SC-25 读侧)—— 当前视角那个区(用于目录与可用性显示)。
  // 🔴 per-region 的**默认模型覆盖**属 51 WP-8 / P51.3,这一刀不替它拍板 —— 只把「这个区能用哪些模型」读对。
  const { scope, targets: modelScopeTargets } = useScope();
  const modelTargetId = scope.kind === "target" ? scope.targetId : undefined;
  const modelRegion = modelTargetId ? modelScopeTargets?.find((x) => x.targetId === modelTargetId)?.region || modelTargetId : "";
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [overrides, setOverrides] = useState<number>(0);
  const [gptReady, setGptReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null);
  const [families, setFamilies] = useState<FamilySummary[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ modelId: string; result: ProbeResult; ms: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/model-config");
      if (res.status === 401 || res.status === 403) {
        setReadOnly(true);
        return;
      }
      const d = await readJson(res);
      if (!res.ok || !d?.success) throw new Error(d?.message || d?.error?.message || `HTTP ${res.status}`);
      setReadOnly(false);
      setEffective((d.data.effective || [])[0] || null);
      setOverrides((d.data.overrides || []).length);
      setGptReady(!!d.data.gptTransportReady);
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      // @kf-batch 50-WP4quater-reads(工单 SC-25 读侧)—— 🔴 目录按当前视角那个区取:
      // `us.` 前缀的跨区推理配置在非美国区调不通,拿主控区的清单给别的区看,
      // 用户选一个保存后一调就炸,而报错指向模型而不是区。
      // @kf-batch 50-WP31-place-first-class —— 恒带落点(全部 / 对比 = 主控区,显式;后端缺 ⇒ 400)
      const res = await fetch(`/api/admin/model-config/catalog?targetId=${encodeURIComponent(landingOfScope(scope))}`);
      const d = await readJson(res);
      if (!res.ok || !d?.success) throw new Error(d?.message || d?.error?.message || `HTTP ${res.status}`);
      setCatalog(d.data.models || []);
      setFamilies(Array.isArray(d.data.families) ? d.data.families : []);
    } catch (e: any) {
      setCatalog(null);
      setCatalogError(String(e?.message || e));
    } finally {
      setCatalogLoading(false);
    }
    // 🔴 `modelTargetId` 进 deps:切区要重取目录(护栏 4);不进 deps 就会留着上一个区的清单
  }, [modelTargetId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!readOnly && !loading && !loadError) loadCatalog();
  }, [readOnly, loading, loadError, loadCatalog]);

  const current = effective;
  const isCustomized = current?.source === "runtime" || current?.source === "runtime-stale";
  const currentBroken = !!current && current.probeOk === false; // 场景四:最近探测失败
  const selectedEntry = useMemo(() => catalog?.find((m) => m.modelId === selected), [catalog, selected]);
  // 分组按服务端 families[](系列顺序 = 档案顺序);旧服务端没给时退化为按目录里出现的系列键分组(标题 = 键名,不编造)
  const familyGroups = useMemo<FamilySummary[]>(() => {
    if (families.length) return families;
    const seen = Array.from(new Set((catalog || []).map((m) => m.family)));
    return seen.map((f) => ({ family: f, label: f, toolUse: "probe" as const, reasoningBlocks: false }));
  }, [families, catalog]);
  const selectedFamily = useMemo(() => familyGroups.find((f) => f.family === selectedEntry?.family), [familyGroups, selectedEntry]);
  // 序 49 ⑧ UX ④:友好名只来自目录(displayName);目录没加载 / 找不到就不显示,绝不编造
  const friendlyName = (modelId?: string | null): React.ReactNode => {
    const entry = modelId ? catalog?.find((m) => m.modelId === modelId) : undefined;
    return entry?.displayName && entry.displayName !== modelId
      ? <Text strong data-testid="ai-model-friendly" style={{ marginRight: 6 }}>{entry.displayName}</Text>
      : null;
  };
  const probeOkForSelected = !!probe && probe.modelId === selected && probe.result.ok === true;
  const canSave = !!selected && selected !== current?.modelId && probeOkForSelected && !saving;

  const openModal = () => {
    setSelected(current?.modelId);
    setProbe(null);
    setOpen(true);
    if (!catalog && !catalogLoading) loadCatalog();
  };

  const runProbe = async () => {
    if (!selected) return;
    setProbing(true);
    const t0 = Date.now();
    try {
      const res = await fetch("/api/admin/model-config/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: selected }) });
      const d = await readJson(res);
      if (res.status === 429) {
        message.warning(t("探测过于频繁(每分钟最多 {n} 次),请 {s}s 后再试", { n: String(d.limit ?? 6), s: String(d.retryAfterSec ?? 60) }));
        return;
      }
      if (!res.ok || !d?.success) throw new Error(d?.message || d?.error?.message || `HTTP ${res.status}`);
      setProbe({ modelId: selected, result: d.data as ProbeResult, ms: Date.now() - t0 });
      loadCatalog(); // 徽标随缓存刷新
    } catch (e: any) {
      message.error(t("探测请求失败:{m}", { m: String(e?.message || e) }));
    } finally {
      setProbing(false);
    }
  };

  const doSave = async () => {
    if (!selected || !current) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/model-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settingScope: "global", modelId: selected, ...(current.version !== undefined ? { expectVersion: current.version } : {}) }),
      });
      const d = await readJson(res);
      if (res.status === 409) {
        message.error(t("配置刚被其他管理员修改,已刷新,请重新选择"));
        await load();
        return;
      }
      if (!res.ok || !d?.success) {
        const code = d?.error as string | undefined;
        const reason = d?.reason as ProbeError | undefined;
        const human =
          code === "ProbeFailed" && reason ? t(PROBE_ERROR_TEXT[reason]) :
          code === "NotAllowedFamily" ? t("GPT 系列一期未开放(待传输门控放行)") :
          code === "NotInCatalog" ? t("该模型不在可选系列目录内") :
          code === "ToolUseUnavailable" ? t("该模型在 Converse 下不能调用工具(tool-use 探测未通过),问数 / Copilot / 顾问会哑火,不能设为全局默认") :
          String(d?.message || d?.detail || code || `HTTP ${res.status}`);
        message.error(human);
        return;
      }
      message.success(t("已切换全局默认模型为 {m},≤5s 内全平台生效", { m: selected }));
      setOpen(false);
      await load();
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  // 场景一:中档 danger 确认 + 影响预览。
  const confirmSave = () => {
    if (!selected || !current) return;
    Modal.confirm({
      title: t("确认更换全局默认模型?"),
      okText: t("确认更换"),
      okButtonProps: { danger: true, "data-testid": "ai-model-confirm-ok" } as any,
      cancelText: t("取消"),
      width: 560,
      content: (
        <div data-testid="ai-model-impact-preview" style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div>{t("当前生效")}:{friendlyName(current.modelId)}<Text code>{current.modelId}</Text>(<Text type="secondary">{t(SOURCE_LABEL[current.source])}</Text>)</div>
          <div>{t("更换为")}:{friendlyName(selected)}<Text code strong>{selected}</Text></div>
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 10 }}
            message={t("影响预览(此改动将立即对全平台生效)")}
            description={
              <div>
                <div>{t("受影响能力(9)")}:{CAPABILITY_LABELS.map(([, label]) => t(label)).join(" / ")}</div>
                <div>{t("生效范围")}:{t("所有租户、所有项目")}</div>
                <div>{t("生效时机")}:{t("保存后 ≤5s(主动失效缓存,无需重启)")}</div>
                <div>{t("可回退")}:{t("随时「恢复出厂默认」或换回原模型")}</div>
              </div>
            }
          />
        </div>
      ),
      onOk: doSave,
    });
  };

  // 场景四 / M7:恢复出厂默认 = 删全部覆盖;不要求探测通过(坏态下按钮必须能点)。
  const restoreDefault = async () => {
    setRestoring(true);
    try {
      const res = await fetch("/api/admin/model-config?settingScope=global", { method: "DELETE" });
      const d = await readJson(res);
      if (!res.ok || !d?.success) throw new Error(d?.message || d?.error?.message || `HTTP ${res.status}`);
      message.success(t("已恢复出厂默认,当前回落到:{s}", { s: t(SOURCE_LABEL[(d.data.fellBackTo as SourceLayer) || "ssot"]) }));
      await load();
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally {
      setRestoring(false);
    }
  };

  const probeBadge = (ok: boolean | undefined, probing?: boolean) => {
    if (probing) return <Badge status="processing" text={t("探测中")} />;
    if (ok === true) return <Badge status="success" text={t("可用")} />;
    if (ok === false) return <Badge status="error" text={t("不可用")} />;
    return <Badge status="default" text={t("未探测")} />;
  };

  const guide = (
    <FeatureGuide
      title={t("AI 模型")}
      what="这里配置平台所有 AI 功能(智能问数 / Copilot / 顾问 / 代码生成等 9 项能力)用的大模型;改动对所有人立即生效(≤5s),不需要重新部署。"
      steps={[
        "点「更换全局默认」,在厂商系列目录(Claude Opus / GPT-5.6 / GLM 5 / Kimi K3)里选一个模型",
        "点「测试该模型」做一次真实探测 —— 探测通过前不能保存(列表里的 ACTIVE 不可信)",
        "保存前会弹出影响预览与确认;保存后卡片刷新为「运行时配置」来源",
        "模型失效(账号配额 / SCP 变化 / 下线)时卡片顶部会告警,点「恢复出厂默认」即回落 env / 出厂值",
      ]}
      tips={[
        "只允许 Bedrock 上的模型(含 us. / global. 推理配置),不接任何第三方端点",
        "GPT 系列一期由传输门控管着,探测未过时不可选",
        "GLM 5 / Kimi K3 保存前须通过 tool-use 探测;Kimi K3 恒带推理块,输出 token 约为 Claude 的 2 倍(平台已按系数放大 maxTokens)",
        "只改「全局默认」;按能力 / 按区域覆盖属二期",
      ]}
    />
  );

  // ── 非 admin:只读(§3) ──
  if (readOnly) {
    const ro = readonlyModel;
    return (
      <Card title={<span><RobotOutlined /> {t("AI 模型")}</span>} size="small" style={{ marginTop: 16 }} data-testid="ai-model-card">
        {guide}
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t("当前生效模型")}><span data-testid="ai-model-effective">{ro?.modelId || "—"}</span></Descriptions.Item>
          <Descriptions.Item label={t("来源")}>{ro ? <Tag color={SOURCE_COLOR[ro.source]} data-testid="ai-model-source">{t(SOURCE_LABEL[ro.source])}</Tag> : "—"}</Descriptions.Item>
        </Descriptions>
        <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>{t("仅平台管理员(bgp-admin)可更换模型;你当前为只读。")}</Text>
      </Card>
    );
  }

  return (
    <Card
      title={<span><RobotOutlined /> {t("AI 模型")}</span>}
      size="small"
      style={{ marginTop: 16 }}
      data-testid="ai-model-card"
      loading={loading}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => { load(); loadCatalog(); }}>{t("刷新")}</Button>
          <Button size="small" type="primary" onClick={openModal} data-testid="ai-model-change-btn" disabled={!current}>
            {isCustomized ? t("更换全局默认") : t("设为自定义")}
          </Button>
        </Space>
      }
    >
      {guide}
      {loadError && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message={t("模型配置读取失败")} description={loadError}
          action={<Button size="small" onClick={load}>{t("重试")}</Button>} />
      )}
      {current?.stale && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="ai-model-stale-banner"
          message={t("配置面(bgp-settings)读取失败,平台正沿用最近一次成功解析的模型")}
          description={t("AI 功能仍可用;配置面恢复后自动回到运行时配置。")} />
      )}
      {currentBroken && current && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="ai-model-banner"
          message={t("AI 模型异常:当前模型 {m} 最近一次探测失败", { m: current.modelId })}
          description={
            <Space direction="vertical" size={6}>
              <Text>{t("平台所有 AI 功能可能不可用。恢复出厂默认会删除全部运行时覆盖,回落到部署 env / 出厂值(不要求探测通过)。")}</Text>
              <Space>
                <Popconfirm title={t("确认恢复出厂默认?")} okText={t("恢复")} cancelText={t("取消")} onConfirm={restoreDefault}>
                  <Button danger size="small" icon={<UndoOutlined />} loading={restoring} data-testid="ai-model-restore-btn">{t("立即恢复出厂默认")}</Button>
                </Popconfirm>
                <Button size="small" onClick={openModal}>{t("更换其他模型")}</Button>
              </Space>
            </Space>
          }
        />
      )}
      {current && (
        <Descriptions column={2} size="small" bordered>
          <Descriptions.Item label={t("当前生效模型")} span={2}>
            <Space>
              {friendlyName(current.modelId)}
              <Text code data-testid="ai-model-effective">{current.modelId}</Text>
              <Tag color={SOURCE_COLOR[current.source]} data-testid="ai-model-source">{t(SOURCE_LABEL[current.source])}</Tag>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t("最近探测")}>
            <span data-testid="ai-model-probe-state">{probeBadge(current.probeOk)}</span>
            {current.probedAt ? <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{new Date(current.probedAt).toLocaleString()}</Text> : null}
          </Descriptions.Item>
          <Descriptions.Item label={t("运行时覆盖")}>
            {isCustomized ? (
              <Space>
                <Text data-testid="ai-model-overrides">{t("{n} 项", { n: String(overrides) })}{current.version !== undefined ? ` · v${current.version}` : ""}</Text>
                <Popconfirm title={t("确认恢复出厂默认?")} okText={t("恢复")} cancelText={t("取消")} onConfirm={restoreDefault}>
                  <Button size="small" icon={<UndoOutlined />} loading={restoring} data-testid="ai-model-restore-btn">{t("恢复出厂默认")}</Button>
                </Popconfirm>
              </Space>
            ) : (
              <Text type="secondary" data-testid="ai-model-overrides">{t("尚未自定义:当前用{s}", { s: t(current.source === "env" ? "部署 env" : "出厂默认(SSOT)") })}</Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label={t("GPT 系列")} span={2}>
            <Text type="secondary" style={{ fontSize: 12 }}>{gptReady ? t("传输门控已放行") : t("一期未开放(传输门控未放行,探测通过后由管理员置位)")}</Text>
          </Descriptions.Item>
        </Descriptions>
      )}

      <Modal
        open={open}
        title={t("更换全局默认模型")}
        onCancel={() => setOpen(false)}
        width={640}
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>{t("取消")}</Button>,
          <Button key="save" type="primary" danger disabled={!canSave} loading={saving} onClick={confirmSave} data-testid="ai-model-save-btn">{t("保存")}</Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={10}>
          <div>
            <Text type="secondary">{t("当前生效")}:</Text> {friendlyName(current?.modelId)}<Text code>{current?.modelId}</Text>
            {current ? <Tag style={{ marginLeft: 8 }} color={SOURCE_COLOR[current.source]}>{t(SOURCE_LABEL[current.source])}</Tag> : null}
          </div>
          {catalogError && (
            <Alert type="warning" showIcon message={t("模型列表拉取失败(Bedrock ListFoundationModels 异常)")} description={catalogError}
              action={<Button size="small" onClick={loadCatalog}>{t("重试")}</Button>} />
          )}
          {catalogError && <Text type="secondary" style={{ fontSize: 12 }}>{t("当前生效模型不受影响,仍在运行。")}</Text>}
          {/* @kf-batch 50-WP4quater-reads(工单 SC-25 读侧)—— 护栏 2:这份清单是**哪个区**能用的。
              模型可用性真按区(`us.` 跨区推理配置在非美国区调不通)⇒ 不标区的下拉是个陷阱。
              🔴 「默认模型能不能按区各设一份」属 51 WP-8 / P51.3,这里不越权替它拍板,
              但**这个区能用哪些**必须读对,并说清当前保存的是**全平台默认**。 */}
          <Space size={6} style={{ marginBottom: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t("可用模型清单来自")}</Text>
            <Tag color={modelRegion ? "blue" : "default"} data-testid="ai-model-catalog-region">
              {modelRegion || t("主控区")}
            </Tag>
            {modelRegion && (
              <Text type="warning" style={{ fontSize: 12 }} data-testid="ai-model-global-default-note">
                {t("保存后是**全平台默认**(按区分别设默认模型见工单 SC-25 / 51 WP-8)")}
              </Text>
            )}
          </Space>
          <Select
            data-testid="ai-model-select"
            style={{ width: "100%" }}
            showSearch
            loading={catalogLoading}
            placeholder={t("选择模型(按厂商系列分组:{s})", { s: familyGroups.map((f) => t(f.label)).join(" / ") })}
            value={selected}
            onChange={(v) => { setSelected(v); setProbe(null); }}
            // 序 49 ⑧ UX ④:选项 label 是节点(友好名 + 次要 id),搜索按 searchText(友好名 + 完整 id,小写)匹配
            filterOption={(input, opt) => String((opt as { searchText?: string } | undefined)?.searchText || "").includes(input.trim().toLowerCase())}
            optionLabelProp="label"
            // @kf-batch 51-v2-multi-vendor —— 分组由服务端 families[] 驱动(51 SPEC §7.5);GPT 系仍按传输门控禁用(D9 门恒关)
            // 序 49 ⑧ UX ④(用户 10-20 拍板「显示系列 + 友好名」):系列 = 分组标题;每一项友好名在前(目录 displayName =
            //   Bedrock modelName / inferenceProfileName),完整 id 退成次要小字仍可见、仍可搜(判据与老用户都按 id 找)。
            options={familyGroups.map((f) => {
              const gated = f.family === "openai" && !gptReady;
              return {
                label: t(f.label),
                options: (catalog || []).filter((m) => m.family === f.family).map((m) => ({
                  value: m.modelId,
                  searchText: `${m.displayName} ${m.modelId}`.toLowerCase(),
                  label: (
                    <span data-testid="ai-model-option" data-model-id={m.modelId}>
                      <span style={{ fontWeight: 500 }}>{m.displayName || m.modelId}</span>
                      {m.kind === "profile" ? <Tag style={{ marginLeft: 6 }}>{t("推理配置")}</Tag> : null}
                      {gated ? <Tag style={{ marginLeft: 6 }}>{t("一期未开放")}</Tag> : null}
                      <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{m.modelId}</Text>
                    </span>
                  ),
                  disabled: gated,
                })),
              };
            })}
          />
          {selectedEntry && (
            <div style={{ fontSize: 12 }}>
              <Space wrap>
                <Text type="secondary">{t("目录探测态")}:</Text>
                {probeBadge(selectedEntry.lastProbe ? selectedEntry.lastProbe.ok : undefined)}
                {selectedEntry.lastProbe?.error ? <Text type="secondary">({selectedEntry.lastProbe.error})</Text> : null}
                {selectedFamily?.toolUse === "probe" ? (
                  <Tooltip title={t("该系列保存前必须通过 tool-use 探测(问数 / Copilot / 顾问全靠工具调用)")}><Tag color="geekblue" data-testid="ai-model-family-tooluse">{t("需 tool-use 探测")}</Tag></Tooltip>
                ) : null}
                {selectedFamily?.reasoningBlocks ? (
                  <Tooltip title={t("该系列每次回复都先出推理块,输出 token 约为 Claude 的 2 倍;平台已按系数放大 maxTokens,推理块对页面透明")}><Tag color="purple" data-testid="ai-model-family-reasoning">{t("恒带推理块")}</Tag></Tooltip>
                ) : null}
                {selectedEntry.inferenceTypesSupported && !selectedEntry.inferenceTypesSupported.includes("ON_DEMAND") && selectedEntry.kind === "model" ? (
                  <Tooltip title={t("该基础模型只支持推理配置调用,请改选 us. / global. 前缀条目")}><Tag color="orange">{t("仅推理配置")}</Tag></Tooltip>
                ) : null}
              </Space>
            </div>
          )}
          <Space>
            <Button icon={<ExperimentOutlined />} onClick={runProbe} loading={probing} disabled={!selected} data-testid="ai-model-probe-btn">{t("测试该模型")}</Button>
            {probing ? probeBadge(undefined, true) : null}
            {probe && probe.modelId === selected && (
              probe.result.ok ? (
                <Text type="success" data-testid="ai-model-probe-result">{t("探测通过({ms}s)", { ms: (probe.ms / 1000).toFixed(1) })}{probe.result.toolUseOk === false
                  // @kf-batch 51-v3-probe-budget:二探超时 ≠ 模型不支持工具 —— 文案分开,用户知道该再测一次而不是换模型
                  ? ` · ${(probe.result as { toolUseError?: string }).toolUseError === "Timeout" ? t("tool-use 探测超时,请再测一次") : t("tool-use 不可用")}` : ""}</Text>
              ) : (
                <Text type="danger" data-testid="ai-model-probe-result">{t("探测失败")}:{probe.result.error}</Text>
              )
            )}
          </Space>
          {probe && probe.modelId === selected && !probe.result.ok && probe.result.error && (
            <Alert type="error" showIcon data-testid="ai-model-probe-help" message={t(PROBE_ERROR_TEXT[probe.result.error])}
              description={probe.result.errorDetail ? <Text type="secondary" style={{ fontSize: 12 }}>{probe.result.errorDetail}</Text> : null} />
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {selected === current?.modelId
              ? t("与当前生效模型相同,无需保存。")
              : probeOkForSelected
                ? t("探测已通过,可以保存;保存前会再弹出影响预览确认。")
                : t("必须先「测试该模型」且探测通过,才能保存(保存前服务端还会再探一次)。")}
          </Text>
        </Space>
      </Modal>
    </Card>
  );
}
