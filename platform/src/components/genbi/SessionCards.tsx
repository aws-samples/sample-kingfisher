"use client";

// 问数「会话卡片」的三个交互件(54 DESIGN v1.5 §6):保存弹框 / 我的卡片抽屉 / 打开别范围卡片时的二选一。
//
// 🔴 「打开一张属于别范围的卡片」**不是本文件自创的交互**,而是通用协议
//    `50-multi-region-execution/INTERACTION-DESIGN.md` **v2.30 §9.7(护栏 7)** 的第一个消费者。
//    七条里最容易做错的两条:① **绝不静默切顶栏**(必须用户点);⑥ **拒绝切区零副作用**
//    (选「只读查看」时压根不调 resume 接口)。
// 🔴 「标题也留区」(用户 2026-09-12 拍板)⇒ 列表里标题可能读不到:那一行**照样列出**,
//    标题位显示占位 + 〔重试〕,绝不把卡片藏起来(藏起来 = 用户以为卡片丢了)。
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Drawer, Empty, Form, Input, List, Modal, Popconfirm, Space, Spin, Switch, Table, Tag, Typography, message } from "antd";
import { ClockCircleOutlined, DeleteOutlined, HistoryOutlined, ReloadOutlined, SaveOutlined, SyncOutlined } from "@ant-design/icons";
// (问数)—— 卡片定时刷新的 cron 编辑器(与调度中心同一个组件)
import CronEditor from "@/components/common/CronEditor";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

const { Text, Paragraph } = Typography;

export interface CardRow {
  cardId: string;
  title: string | null;
  titleUnavailable: boolean;
  targetId: string;
  region: string;
  projectId: string;
  engine: string;
  turnCount: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  state: "ready" | "deleting";
  // 刷新的非数据戳(中央指针上)
  lastRefreshedAt?: string;
  lastRefreshStatus?: "succeeded" | "failed";
  refreshCount?: number;
}

export interface CardsListResp {
  items: CardRow[];
  used: number;
  limit: number;
  hiddenByScope: number;
  titleUnavailableCount: number;
}

const MAX_TITLE = 80;

/** 列表接口的唯一客户端读法(带 `?scope=`;读路由口径)。 */
export async function fetchCards(scopeParam: string | null): Promise<CardsListResp | { error: string }> {
  try {
    const qs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
    const r = await fetch(`/api/genbi/cards${qs}`);
    const d = await r.json();
    if (!d?.success) return { error: d?.error?.message || `HTTP ${r.status}` };
    return d.data as CardsListResp;
  } catch (e) {
    // 🔴 拉不到**不当成空列表** —— 空列表在这个抽屉里等于「你没有卡片」,那是撒谎
    return { error: (e as Error)?.message || "网络异常" };
  }
}

// ─────────────────────────── 保存弹框 ───────────────────────────

export function SaveCardModal({
  open, onCancel, onSaved, conversationId, targetId, region, engine, database, turns, defaultTitle, used, limit,
}: {
  open: boolean;
  onCancel: () => void;
  onSaved: (cardId: string, used: number) => void;
  conversationId: string;
  targetId: string;
  region: string;
  engine: string;
  /** 🔴 必填而**不是**可选:漏传就等于让重脱敏静默失效(有静默合法默认值的参数 = 一整类缺陷)。 */
  database: string;
  turns: unknown[];
  defaultTitle: string;
  used: number;
  limit: number;
}) {
  const t = useT();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setErr("");
      form.setFieldsValue({ title: (defaultTitle || "").slice(0, 40) });
    }
  }, [open, defaultTitle, form]);

  const submit = async () => {
    let v: { title: string };
    try { v = await form.validateFields(); } catch { return; }
    setSaving(true);
    setErr("");
    try {
      const r = await fetch("/api/genbi/cards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, title: v.title, targetId, engine, database, turns }),
      });
      const d = await r.json();
      if (!d?.success) {
        // 🔴 满额是 409:文案里带真实 used/limit 并引导去删,**平台绝不自动淘汰**
        setErr(d?.error?.message || `保存失败(HTTP ${r.status})`);
        return;
      }
      message.success(d.data.created ? t("已保存为卡片") : t("已更新这张卡片"));
      onSaved(d.data.cardId, d.data.used);
    } catch (e) {
      setErr((e as Error)?.message || t("网络异常"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t("保存对话为卡片")} open={open} onCancel={onCancel} onOk={submit} confirmLoading={saving}
           okText={t("保存")} data-testid="genbi-save-card-modal" width={620}>
      <Form form={form} layout="vertical">
        <Form.Item name="title" label={t("标题")}
                   rules={[{ required: true, message: t("请给这张卡片起个名字") },
                           { max: MAX_TITLE, message: t("最多 {n} 字", { n: MAX_TITLE }) }]}>
          <Input maxLength={MAX_TITLE} showCount placeholder={t("一句话概括这段对话")} data-testid="genbi-save-card-title" />
        </Form.Item>
      </Form>
      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {t("将保存:本次对话全部 {n} 轮(问题 / 结论 / SQL / 数据 / 图表 / 命中表 / 口径 / 脱敏列 / 推理过程)。",
           { n: turns.length })}
      </Paragraph>
      {/* 🔴 用户 2026-09-12 拍板「标题也留区」⇒ 这句话与 v1.0 草稿**相反**:标题也不出区 */}
      <Alert type="info" showIcon data-testid="genbi-save-card-residency"
             message={t("对话正文与标题都只保存在 {region}(执行环境 {tid}),不会离开该区域。", { region, tid: targetId })} />
      <Text type="secondary" style={{ fontSize: 12 }}>{t("已用 {u}/{l}", { u: used, l: limit })}</Text>
    </Modal>
  );
}

// ──────────────── 打开别范围的卡片:二选一(INTERACTION §9.7)────────────────

export function ScopeSwitchConfirm({
  open, card, onReadOnly, onSwitchAndResume, onCancel, serviceable, notServiceableWhy,
}: {
  open: boolean;
  card: CardRow | null;
  onReadOnly: () => void;
  onSwitchAndResume: () => void;
  onCancel: () => void;
  /** 该 target 此刻能否**承接**(能不能看 ≠ 能不能承接;§9.7 第 7 条) */
  serviceable: boolean;
  notServiceableWhy?: string | null;
}) {
  const t = useT();
  if (!card) return null;
  return (
    <Modal open={open} onCancel={onCancel} footer={null} data-testid="genbi-card-scope-switch"
           title={t("这张卡片属于 {tid}({region})", { tid: card.targetId, region: card.region })}>
      {/* 🔴 §9.7 第 3 条:必须同时复述 targetId + region + **对象标识** —— 只写 region 不够
          (同一个 region 可能有多个执行目标,教训)*/}
      <Paragraph data-testid="genbi-card-scope-restate">
        {t("「{title}」· {n} 轮 · {at}", {
          title: card.title || t("(标题在该区域,当前读不到)"), n: card.turnCount, at: card.updatedAt.slice(0, 16).replace("T", " "),
        })}
      </Paragraph>
      <Paragraph type="secondary">
        {t("继续对话会在**该区域**的数据仓库上执行;平台不会替你静默切换顶栏的执行范围。")}
      </Paragraph>
      {!serviceable && (
        // 🔴 §9.7 第 7 条:可见但不可承接 ⇒ **不提供**「切区并继续」,只给只读 + 人话原因 + 直达
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="genbi-card-not-serviceable"
               message={t("该执行环境现在不能承接新的对话:{why}", { why: notServiceableWhy || t("不可承接") })}
               action={<Button size="small" href={`/exec-envs?target=${encodeURIComponent(card.targetId)}`}>{t("去执行环境处理")}</Button>} />
      )}
      <Space>
        <Button onClick={onReadOnly} data-testid="genbi-card-readonly">{t("只读查看")}</Button>
        {serviceable && (
          <Button type="primary" onClick={onSwitchAndResume} data-testid="genbi-card-switch-resume">
            {t("切到 {region} 并继续对话", { region: card.region })}
          </Button>
        )}
      </Space>
    </Modal>
  );
}

// ─────────────────────────── 我的卡片抽屉 ───────────────────────────

export function MyCardsDrawer({
  open, onClose, onOpenCard, refreshKey,
}: {
  open: boolean;
  onClose: () => void;
  /** `resume=false` ⇒ 只读查看(**不调** resume 接口,§9.7 第 6 条零副作用) */
  onOpenCard: (card: CardRow, resume: boolean) => void;
  refreshKey?: number;
}) {
  const t = useT();
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const [data, setData] = useState<CardsListResp | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [kw, setKw] = useState("");
  /**
   * 🔴🔴 **本抽屉的「阅读镜头」**(2026-09-13 根治):卡片是**每人全局 100 张**的个人资产
   * (上限口径由用户 2026-09-12 拍板),而列表原来被执行范围**截肢** ⇒
   *   ① 计数器说「已用 97/100」而列表只有 3 张 —— **数字与列表互相矛盾**;
   *   ② 唯一出口文案是「切换顶栏范围查看」—— 那正是**护栏 7(§9.7)存在的目的**
   *      (由页面提议切换),却要用户一个区一个区手动去找;
   *   ③ 于是除了「全部」视角,§9.7 那套二选一**任何真实用户都触发不到** = 死代码。
   * ⇒ 范围仍是**默认镜头**(全平台口径不变、棘轮不放宽),但用户能一键**放宽这个镜头**;
   *   放宽只改「读哪些行」,**绝不调 `setScope`** —— 那会静默移动执行范围(§9.7 第 1 条)。
   */
  const [widened, setWidened] = useState(false);
  useEffect(() => { if (!open) setWidened(false); }, [open]);
  // 放宽 = 不带 `?scope=`(与「全部」视角同一个口径:`toScopeParam(global) === null`)。
  const lens = widened ? null : scopeParam;

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchCards(lens);
    if ("error" in r) { setErr(r.error); setData(null); } else { setErr(""); setData(r); }
    setLoading(false);
  }, [lens]);

  useEffect(() => { if (open) void load(); }, [open, load, refreshKey]);

  const del = async (cardId: string) => {
    const r = await fetch(`/api/genbi/cards/${cardId}`, { method: "DELETE" });
    const d = await r.json();
    if (!d?.success) { message.error(d?.error?.message || t("删除失败")); return; }
    if (d.data.bodyOrphaned) {
      // 🔴 **终态**:执行环境已不在注册表 ⇒ 平台永远够不到那个区的正文,说「稍后重试」是骗人
      //    (重试一万次也不会成)。已记审计交给运维,用户这边不再留一行永远删不掉的卡。
      message.warning(t("卡片已删除、额度已释放。该卡片所属的执行环境({tid})已不存在,该区域的正文无法再清理 —— 已记录,由运维处置。",
                        { tid: d.data.bodyOrphaned.targetId }));
    } else if (d.data.bodyCleaned === false) {
      // 🔴 残留可见:不假装删干净了(这一支是**可重试**的:执行环境还在,只是这次没删成)
      message.warning(t("卡片已从列表移除、额度已释放,但该区域的正文清理未完成 —— 稍后可重试"));
    } else {
      message.success(t("已删除"));
    }
    void load();
  };

  const rows = (data?.items || []).filter((x) => !kw || (x.title || "").toLowerCase().includes(kw.toLowerCase()));

  // (问数)—— 刷新 / 定时刷新 / 历史
  // 🔴 刷新的是**同一张**卡(不占额度);定时载体发到**卡片自己那个区**的 MWAA Serverless。
  const [scheds, setScheds] = useState<Record<string, any>>({});
  const [refreshing, setRefreshing] = useState("");
  const [schedModal, setSchedModal] = useState<{ card: CardRow; cron: string; enabled: boolean } | null>(null);
  const [schedSaving, setSchedSaving] = useState(false);
  const [history, setHistory] = useState<{ card: CardRow; runs: any[]; loading: boolean; err: string } | null>(null);
  const loadScheds = useCallback(async () => {
    try {
      const qs = lens ? `?scope=${encodeURIComponent(lens)}` : "";
      const r = await fetch(`/api/genbi/cards/schedules${qs}`);
      const d = await r.json();
      if (!d?.success || !Array.isArray(d.data)) return;
      setScheds(Object.fromEntries(d.data.map((x: any) => [x.cardId, x])));
    } catch {
      /* 定时状态是增强信息,读不到不影响卡片列表(列表本身照常显示) */
    }
  }, [lens]);
  useEffect(() => { if (open) void loadScheds(); }, [open, loadScheds, refreshKey]);
  const armedOf = (x: any) => Boolean(x?.scheduleEnabled && x?.cronExpression && Object.values(x?.deployments || {}).some((d: any) => d?.workflowArn));

  const refreshNow = async (c: CardRow) => {
    setRefreshing(c.cardId);
    try {
      const r = await fetch(`/api/genbi/cards/${c.cardId}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!d?.success) message.error(d?.error?.message || t("刷新失败"), 8);
      else message.success(t("已刷新:{n} 行(同一张卡片,已留一份运行快照)", { n: d.data.rowCount }));
    } finally {
      setRefreshing("");
      void load();
    }
  };
  const saveSchedule = async () => {
    if (!schedModal) return;
    setSchedSaving(true);
    try {
      const r = await fetch(`/api/genbi/cards/${schedModal.card.cardId}/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpression: schedModal.cron, enabled: schedModal.enabled }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d?.success) { message.error(d?.error?.message || t("保存失败"), 8); return; }
      message.success(d.data?.notice || t("已保存"));
      setSchedModal(null);
      void loadScheds();
    } finally {
      setSchedSaving(false);
    }
  };
  const openHistory = async (c: CardRow) => {
    setHistory({ card: c, runs: [], loading: true, err: "" });
    try {
      const r = await fetch(`/api/genbi/cards/${c.cardId}/runs`);
      const d = await r.json();
      if (!d?.success) setHistory({ card: c, runs: [], loading: false, err: d?.error?.message || `HTTP ${r.status}` });
      else setHistory({ card: c, runs: d.data.runs || [], loading: false, err: "" });
    } catch (e) {
      setHistory({ card: c, runs: [], loading: false, err: (e as Error)?.message || t("网络异常") });
    }
  };

  return (
    <Drawer title={t("我的卡片")} open={open} onClose={onClose} width={560} data-testid="genbi-cards-drawer"
            extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>{t("刷新")}</Button>}>
      {err && <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="genbi-cards-error"
                     message={t("读取卡片列表失败:{e}", { e: err })} />}
      {data && (
        <Space direction="vertical" style={{ width: "100%", marginBottom: 12 }}>
          <Text data-testid="genbi-cards-quota">{t("已用 {u}/{l}", { u: data.used, l: data.limit })}</Text>
          {/* 🔴 护栏 1:当前范围外还有几张**必须说出来**,不许静默少列 */}
          {/* 🔴 护栏 1:范围外还有几张必须说出来 —— 并且**必须给得到的入口**。
              旧文案写「切换顶栏范围查看」= 让用户手动做 §9.7 该替他做的事,已删。 */}
          {!widened && data.hiddenByScope > 0 && (
            <Space size={8} wrap data-testid="genbi-cards-hidden-wrap">
              <Text type="secondary" data-testid="genbi-cards-hidden">
                {t("当前执行范围内 {n} 张;你还有 {m} 张在其他范围", { n: data.items.length, m: data.hiddenByScope })}
              </Text>
              {/* 🔴 只放宽**这个列表的阅读镜头**,不动顶栏的执行范围(点开那张卡时才按 §9.7 征求同意) */}
              <Button size="small" type="link" data-testid="genbi-cards-show-all"
                      onClick={() => setWidened(true)}>
                {t("显示全部范围({m})", { m: data.used })}
              </Button>
            </Space>
          )}
          {widened && (
            <Space size={8} wrap>
              <Text type="secondary" data-testid="genbi-cards-widened">
                {t("正在显示你的全部 {n} 张卡片(跨全部执行范围);顶栏的执行范围**没有**改变", { n: data.items.length })}
              </Text>
              <Button size="small" type="link" data-testid="genbi-cards-show-scoped"
                      onClick={() => setWidened(false)}>{t("只看当前范围")}</Button>
            </Space>
          )}
          {data.titleUnavailableCount > 0 && (
            <Text type="warning" data-testid="genbi-cards-title-unavailable">
              {t("有 {n} 张卡片的标题此刻读不到(标题与正文都存在各自的区域)—— 卡片本身仍在,可重试或直接打开", { n: data.titleUnavailableCount })}
            </Text>
          )}
          <Input.Search placeholder={t("搜索标题")} allowClear onChange={(e) => setKw(e.target.value)} data-testid="genbi-cards-search" />
        </Space>
      )}
      {loading && !data ? <Spin /> : rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
               description={data && data.used > 0 && data.hiddenByScope > 0
                 ? t("当前执行范围内没有卡片;你还有 {m} 张在其他范围 —— 点上面的〔显示全部范围〕", { m: data.hiddenByScope })
                 : t("还没有保存的卡片 —— 在一段对话上点〔保存对话〕就会出现在这里")} />
      ) : (
        <List dataSource={rows} rowKey="cardId" data-testid="genbi-cards-list"
              renderItem={(c) => (
                <List.Item data-testid={`genbi-card-row-${c.cardId}`} actions={[
                  <a key="open" onClick={() => onOpenCard(c, true)} data-testid={`genbi-card-open-${c.cardId}`}>{t("打开续聊")}</a>,
                  // 立即刷新 / 定时刷新 / 历史
                  <a key="refresh" onClick={() => { if (refreshing !== c.cardId) void refreshNow(c); }} data-testid={`genbi-card-refresh-${c.cardId}`}>
                    <SyncOutlined spin={refreshing === c.cardId} /> {t("立即刷新")}
                  </a>,
                  <a key="sched" data-testid={`genbi-card-schedule-${c.cardId}`}
                     onClick={() => setSchedModal({ card: c, cron: scheds[c.cardId]?.cronExpression || "0 8 * * *", enabled: Boolean(scheds[c.cardId]?.scheduleEnabled) || !scheds[c.cardId] })}>
                    <ClockCircleOutlined /> {t("定时刷新")}
                  </a>,
                  <a key="hist" onClick={() => void openHistory(c)} data-testid={`genbi-card-history-${c.cardId}`}><HistoryOutlined /> {t("历史")}</a>,
                  <Popconfirm key="del" title={t("删除这张卡片?")}
                              description={t("正文会从 {region} 一并清理;额度立刻释放。", { region: c.region })}
                              okText={t("删除")} cancelText={t("取消")} onConfirm={() => void del(c.cardId)}>
                    <a style={{ color: "#ff7875" }} data-testid={`genbi-card-del-${c.cardId}`}><DeleteOutlined /> {t("删除")}</a>
                  </Popconfirm>,
                ]}>
                  <List.Item.Meta
                    title={c.titleUnavailable
                      // 🔴 标题读不到 ⇒ 占位 + 说清在哪个区,**卡片不消失**
                      ? <Text type="secondary" data-testid={`genbi-card-title-na-${c.cardId}`}>
                          {t("(标题在 {region},此刻读不到)", { region: c.region })}
                        </Text>
                      : <span>{c.title}</span>}
                    description={
                      <Space size={6} wrap>
                        <Text type="secondary" style={{ fontSize: 12 }}>{t("{n} 轮", { n: c.turnCount })}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{c.updatedAt.slice(0, 16).replace("T", " ")}</Text>
                        <Tag color="cyan">🌍 {c.region}</Tag>
                        {c.state === "deleting" && <Tag color="orange" data-testid={`genbi-card-cleanup-${c.cardId}`}>{t("清理未完成")}</Tag>}
                        {/* 绿标只给真有载体的(看产物,不看 enabled) */}
                        {armedOf(scheds[c.cardId]) && (
                          <Tag color="green" data-testid={`genbi-card-schedule-armed-${c.cardId}`}>{t("定时 {cron}", { cron: scheds[c.cardId].cronExpression })}</Tag>
                        )}
                        {scheds[c.cardId]?.scheduleEnabled && !armedOf(scheds[c.cardId]) && (
                          <Tag color="orange" data-testid={`genbi-card-schedule-not-armed-${c.cardId}`}>{t("待发布载体")}</Tag>
                        )}
                        <Text type="secondary" style={{ fontSize: 12 }} data-testid={`genbi-card-last-refresh-${c.cardId}`}>
                          {c.lastRefreshedAt ? t("最近一次刷新 {time}", { time: c.lastRefreshedAt.slice(0, 16).replace("T", " ") }) : t("从未刷新")}
                        </Text>
                        {c.lastRefreshStatus === "failed" && <Tag color="red" data-testid={`genbi-card-refresh-failed-${c.cardId}`}>{t("上次刷新失败")}</Tag>}
                      </Space>
                    }
                  />
                </List.Item>
              )} />
      )}

      {/* 定时刷新弹框 */}
      <Modal open={Boolean(schedModal)} title={t("定时刷新这张卡片")} onCancel={() => setSchedModal(null)} onOk={() => void saveSchedule()}
             confirmLoading={schedSaving} okText={t("保存")} okButtonProps={{ "data-testid": "genbi-card-schedule-save" } as never}
             data-testid="genbi-card-schedule-modal" width={560}>
        {schedModal && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Alert type="info" showIcon data-testid="genbi-card-schedule-restate"
                   message={t("到点在 {region} 重跑这张卡片里存下的 SQL(不调大模型),刷新的是同一张卡片、不占额度,每次留一份运行快照;结果按最严口径脱敏。", { region: schedModal.card.region })} />
            <div data-testid="genbi-card-schedule-cron"><CronEditor value={schedModal.cron} onChange={(c) => setSchedModal((m) => (m ? { ...m, cron: c } : m))} /></div>
            <Space>
              <Switch checked={schedModal.enabled} onChange={(v) => setSchedModal((m) => (m ? { ...m, enabled: v } : m))} data-testid="genbi-card-schedule-enabled" />
              <span>{schedModal.enabled ? t("启用定时刷新") : t("停用定时刷新")}</span>
            </Space>
          </Space>
        )}
      </Modal>

      {/* 刷新历史(手动 + 定时;同一条 taskId) */}
      <Modal open={Boolean(history)} title={t("刷新历史")} onCancel={() => setHistory(null)} footer={null} width={720} data-testid="genbi-card-history-modal">
        {history?.err && <Alert type="error" showIcon message={history.err} data-testid="genbi-card-history-error" />}
        <Table size="small" rowKey="runId" loading={history?.loading} dataSource={history?.runs || []} pagination={{ pageSize: 10 }}
               locale={{ emptyText: t("还没有刷新过") }}
               onRow={() => ({ "data-testid": "genbi-card-history-row" }) as React.HTMLAttributes<HTMLElement>}
               columns={[
                 { title: t("开始时间"), dataIndex: "startedAt", render: (v: string) => (v || "").slice(0, 19).replace("T", " ") },
                 { title: t("触发方式"), dataIndex: "triggeredBy", render: (v: string) => v === "schedule" ? <Tag color="green">{t("自动")}</Tag> : <Tag>{t("手动")}</Tag> },
                 { title: t("状态"), dataIndex: "status", render: (v: string) => <Tag color={v === "succeeded" ? "green" : v === "failed" ? "red" : "blue"}>{v}</Tag> },
                 { title: t("行数"), dataIndex: "rowCount", render: (v: number) => (typeof v === "number" ? v : "-") },
                 { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v: string) => v ? <span style={{ color: "#ff4d4f" }}>{v}</span> : "-" },
               ]} />
      </Modal>
    </Drawer>
  );
}
