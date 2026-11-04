"use client";
// **跨地域一屏只读元数据总览**(50 INTERACTION §4quater 线框 / SPEC §3.13)。
//
// 对标产品(含 DataWorks)只能**切在单地域**看资产/血缘/质量;这里给的是中央跨 target 的
// 只读元数据全景(按 target 只读镜像,**零数据 egress**)。这是超越点,但 §4quater 同时立了
// 一条硬规矩:**必须把「元数据全景 ≠ 跨区结果聚合」讲清**,否则用户会以为能跨区查数。
//
// 🔴 本组件三条不许破的:
//  ① **不用旧镜像假装实时**:每个分面常驻 `镜像 · 最近同步 <相对时间>`;
//     过期/从未/失败一律打标 + 给〔立即同步〕。判定来自服务端纯函数 `mirrorFacetState`,
//     本组件**不自己算新鲜度**(第二个真值源必漂 —— W3-d2 已经吃过一次)。
//  ② **穷举映射**:`STATE_UI` 是 `Record<MirrorState, …>`,新增一个态**编译期**就会红;
//     不许写 `?? fresh` 兜底(那会让新态静默变绿)。
//  ③ **采不到的指标照实说「未采集」+ 原因**,绝不填 0 —— 0 在界面上看起来像「这个区很干净」。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { ReloadOutlined, GlobalOutlined, CloudSyncOutlined, DatabaseOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";
import {
  describeAge,
  mirrorNeedsSync,
  toEpochMs,
  type MirrorFacet,
  type MirrorOverview,
  type MirrorState,
} from "@/lib/exec-env/metadata-mirror-shared";

const { Title, Text } = Typography;

/** 🔴 与服务端 `MirrorState` **一一对应**,新增态编译期必须给去处。 */
const STATE_UI: Record<MirrorState, { text: string; color?: string; hint: string }> = {
  fresh: { text: "✓", color: "success", hint: "镜像新鲜(仍是最终一致的镜像,不是实时查询)" },
  stale: {
    text: "⚠ 镜像过期",
    color: "warning",
    hint: "超过阈值没同步成功 ⇒ 这些数字可能已经不对了。点〔立即同步〕重新采集",
  },
  expired: {
    text: "⚠ 镜像已失效",
    color: "error",
    hint: "已超过 7 天保留期(条目随 TTL 清理)⇒ 数字不可用,必须重新采集",
  },
  never: { text: "— 从未同步", hint: "这个区从没采集过元数据 ⇒ **不代表它是空的**,只代表我们还没看过" },
  failed: {
    text: "⚠ 上次同步失败",
    color: "warning",
    hint: "数据还在阈值内,但最近一次采集失败了(原因见提示)⇒ 再不处理就会一路烂到过期",
  },
};

interface Entry {
  kind: string;
  fqn: string;
  payload: { name?: string; db?: string; source?: string; tableType?: string; columnCount?: number; columnsTruncated?: boolean };
  mirroredAt?: string;
}

export default function CrossTargetMirrorOverview() {
  const t = useT();
  const { getToken } = useAuth();
  const [ov, setOv] = useState<MirrorOverview | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [drill, setDrill] = useState<{ targetId: string; entries: Entry[] } | null>(null);

  /**
   * 采集要花钱(打那个区的 API;数仓那一路还会唤醒 Serverless 数仓)⇒ 端点是管理面。
   * 🔴 沿用仓内既有写法:**不隐藏、而是禁用 + 说清原因**(最坏的不是不能用,是看不出为什么不能用)。
   */
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        setIsAdmin(groupsFromToken(await getToken()).includes("bgp-admin"));
      } catch {
        /* 非登录态忽略;默认 false = 保守 */
      }
    })();
  }, [getToken]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/metadata-mirror");
      const d = await r.json();
      if (!r.ok || !d?.success) {
        // 🔴 读失败**显示错误**,不显示空分面 —— 空分面看起来像"那些区没有资产"(假绿)
        setOv(null);
        setErr(d?.error?.message || t("跨地域总览读取失败"));
        return;
      }
      setErr("");
      setOv(d.data as MirrorOverview);
    } catch (e: any) {
      setOv(null);
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const sync = async (targetId: string, sources: string[]) => {
    setBusy(`${targetId}#${sources.join(",")}`);
    try {
      const r = await fetch("/api/admin/metadata-mirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, sources }),
      });
      const d = await r.json();
      if (!r.ok || !d?.success) {
        message.error(d?.error?.message || t("采集失败"));
        return;
      }
      // 🔴 HTTP 200 ≠ 全好了:逐来源看 error(部分失败必须说出来)
      const failed = (d.data?.facet?.sources || []).filter((s: any) => s.error);
      if (failed.length) {
        message.warning(
          t("部分来源失败:{list}", { list: failed.map((s: any) => `${s.source}(${s.error})`).join("；") })
        );
      } else {
        message.success(t("{tid} 采集完成", { tid: targetId }));
      }
      await load();
      if (drill?.targetId === targetId) await openDrill(targetId);
    } finally {
      setBusy("");
    }
  };

  const openDrill = async (targetId: string) => {
    try {
      const r = await fetch(`/api/metadata-mirror?targetId=${encodeURIComponent(targetId)}`);
      const d = await r.json();
      if (!r.ok || !d?.success) {
        message.error(d?.error?.message || t("下钻读取失败"));
        return;
      }
      setDrill({ targetId, entries: (d.data?.entries || []) as Entry[] });
    } catch (e: any) {
      message.error(String(e?.message || e));
    }
  };

  /** 表格按线框来:**行 = 指标,列 = target**(外加合计列)。 */
  const metricRows = useMemo(() => {
    if (!ov) return [];
    const nc = ov.notCollected;
    return [
      { key: "tables", label: t("资产(表)"), kind: "num" as const, pick: (f: MirrorFacet) => f.tables },
      { key: "databases", label: t("库 / 命名空间"), kind: "num" as const, pick: (f: MirrorFacet) => f.databases },
      { key: "columns", label: t("列(Glue 侧)"), kind: "num" as const, pick: (f: MirrorFacet) => f.columns },
      ...nc.map((n) => ({ key: n.metric, label: t(n.label), kind: "na" as const, reason: n.reason, slice: n.slice })),
      { key: "__mirror", label: t("元数据镜像"), kind: "state" as const },
      { key: "__warehouse", label: t("数仓目录(手动采集)"), kind: "warehouse" as const },
    ];
  }, [ov, t]);

  const columns = useMemo(() => {
    if (!ov) return [];
    const base: any[] = [
      { title: t("指标"), dataIndex: "label", fixed: "left" as const, width: 190,
        render: (v: string, r: any) =>
          r.kind === "na" ? (
            <Tooltip title={`${r.reason}(${r.slice})`}>
              <Text>{v} <Text type="secondary" style={{ fontSize: 11 }}>ⓘ</Text></Text>
            </Tooltip>
          ) : (
            <Text strong={r.kind === "state"}>{v}</Text>
          ) },
    ];
    for (const f of ov.facets) {
      base.push({
        title: (
          <Space direction="vertical" size={0}>
            <Text strong>{f.region || f.targetId}</Text>
            <Space size={2} wrap>
              <Tag color={f.isHome ? "default" : "cyan"} style={{ marginInlineEnd: 0 }}>{f.targetId}</Tag>
              {f.jurisdiction && f.jurisdiction !== "home" ? <Tag color="purple">🌍 {f.jurisdiction}</Tag> : null}
              {/* 已下线的 target 仍显示:只列活跃会把"那个区还留着东西"整列藏掉(与矩阵同纪律) */}
              {f.active ? null : <Tag color="volcano">{t("已下线")}</Tag>}
            </Space>
            <Button size="small" type="link" style={{ padding: 0 }} icon={<DatabaseOutlined />}
              onClick={() => openDrill(f.targetId)}>
              {t("下钻")}
            </Button>
          </Space>
        ),
        key: f.targetId,
        width: 210,
        render: (_: any, r: any) => renderCell(f, r),
      });
    }
    base.push({
      title: t("合计"),
      key: "__total",
      width: 120,
      render: (_: any, r: any) =>
        r.key === "tables" ? <Text strong>{ov.totals.tables}</Text>
        : r.key === "databases" ? <Text strong>{ov.totals.databases}</Text>
        : r.key === "columns" ? <Text strong>{ov.totals.columns}</Text>
        // 🔴 「未采集」的指标**没有合计**(把三个 — 加起来变成 0 就是编数字)
        : <Text type="secondary">—</Text>,
    });
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov, busy, isAdmin, t]);

  const renderCell = (f: MirrorFacet, r: any) => {
    if (r.kind === "num") return <Text>{r.pick(f).toLocaleString()}</Text>;
    if (r.kind === "na") {
      // 🔴 照实「未采集」,不填 0
      return <Tooltip title={`${r.reason}(${r.slice})`}><Text type="secondary">{t("未采集")}</Text></Tooltip>;
    }
    if (r.kind === "state") {
      const ui = STATE_UI[f.state];
      const age = describeAge(f.mirroredAt ? Date.now() - (toEpochMs(f.mirroredAt) ?? Date.now()) : null);
      const srcErr = (f.sources || []).find((s) => s.source === "glue" && s.error)?.error;
      return (
        <Space direction="vertical" size={0}>
          <Tooltip title={`${t(ui.hint)}${srcErr ? ` | ${srcErr}` : ""}`}>
            {ui.color ? <Tag color={ui.color}>{t(ui.text)}</Tag> : <Tag>{t(ui.text)}</Tag>}
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {f.mirroredAt ? t("最近同步 {a}", { a: age }) : t("无同步记录")}
          </Text>
          {f.truncated ? (
            <Tooltip title={t("条目数超过上限 {c},已截断 ⇒ 这个区的真实资产**多于**上面的数字", { c: f.cap })}>
              <Tag color="warning">{t("已截断")}</Tag>
            </Tooltip>
          ) : null}
          {mirrorNeedsSync(f.state) ? (
            <Tooltip title={isAdmin ? "" : t("采集会调用该区域 API ⇒ 仅平台管理员可触发(服务端会拒)")}>
              <Button size="small" type="link" style={{ padding: 0 }} disabled={!isAdmin}
                // 🔴 每个分面一个**稳定锚点**:总览里同时有多个区,`get_by_role("立即同步").first`
                //   会点到**别的区**那颗按钮,然后判据去看本区状态没变 ⇒ 假红(2026-09-15 段 w3e 实测)。
                //   锚点带 targetId 是产品对验收套件的契约(同  `nav-<key>`、`rs-load-schema`)。
                data-testid={`mirror-sync-${f.targetId}`}
                loading={busy === `${f.targetId}#glue`} icon={<CloudSyncOutlined />}
                onClick={() => sync(f.targetId, ["glue"])}>
                {t("立即同步")}
              </Button>
            </Tooltip>
          ) : null}
        </Space>
      );
    }
    // 数仓目录:**自己的时间戳、自己的态**,刻意不并进上面那个 ✓/⚠
    const w = f.warehouse;
    const wui = w ? STATE_UI[w.state] : STATE_UI.never;
    return (
      <Space direction="vertical" size={0}>
        <Tooltip title={`${t(wui.hint)}${w?.error ? ` | ${w.error}` : ""}`}>
          {wui.color ? <Tag color={wui.color}>{w ? `${t(wui.text)} · ${w.tables} ${t("表")}` : t(wui.text)}</Tag> : <Tag>{t(wui.text)}</Tag>}
        </Tooltip>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {w?.at ? t("采集于 {a}", { a: describeAge(Date.now() - (toEpochMs(w.at) ?? Date.now())) }) : t("未采集过")}
        </Text>
        <Tooltip title={isAdmin
          ? t("🔴 会唤醒该区的 Serverless 数仓(按 RPU 计费)⇒ 只在你要看时点,平台不定时采")
          : t("仅平台管理员可触发")}>
          <Button size="small" type="link" style={{ padding: 0 }} disabled={!isAdmin}
            loading={busy === `${f.targetId}#redshift`} onClick={() => sync(f.targetId, ["redshift"])}>
            {t("采集数仓目录")}
          </Button>
        </Tooltip>
      </Space>
    );
  };

  return (
    <div>
      <Space align="center" wrap style={{ marginBottom: 8 }}>
        <Title level={4} style={{ margin: 0 }}>
          <GlobalOutlined /> {t("跨地域元数据总览")}
        </Title>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>{t("刷新")}</Button>
      </Space>

      {/* 🔴 §4quater 的诚实边界:必须把「元数据全景 ≠ 跨区结果聚合」写在最显眼处 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("跨地域【元数据】全景(不含任何数据行);点某个目标下钻查它有哪些库表,数据本身留在该区。")}
        description={
          <Space direction="vertical" size={2}>
            <Text type="secondary">
              {t("镜像**只读、最终一致**:中央按 target 去它自己的 region 拉元数据(AWS 没有跨 region 的全局目录)。每列都常驻最近同步时间;过期就照实说过期,绝不拿旧镜像假装实时。")}
            </Text>
            <Text type="secondary">
              {t("🔴 跨 target 的结果聚合 / 跨区 JOIN **不在这里做**(要合并须走显式复制作业 + 审批)。")}
            </Text>
          </Space>
        }
      />

      {err ? (
        <Alert style={{ marginBottom: 12 }} type="error" showIcon
          message={t("总览算不出来(这不等于「那些区没有资产」)")} description={err}
          action={<Button size="small" onClick={load}>{t("重试")}</Button>} />
      ) : null}

      {ov ? (
        <>
          {ov.warnings.length ? (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon
              message={t("部分数据源读取失败 —— 下面的数字**不完整**")}
              description={ov.warnings.join("；")} />
          ) : null}

          <Table
            size="small"
            rowKey="key"
            dataSource={metricRows}
            columns={columns}
            pagination={false}
            scroll={{ x: "max-content" }}
          />

          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message={t("本总览的覆盖面(如实登记)")}
            description={
              <Space direction="vertical" size={2}>
                <Text type="secondary">
                  {t("采集来源:该区 **Glue 数据目录**(定时刷新,目录 API 免费)+ 该区 **Redshift 数仓目录**(🔴 只在人点时采 —— 定时采会把每个区的 Serverless 数仓永久保持唤醒,一个只读看板不该产生常态数仓账单)。")}
                </Text>
                <Text type="secondary">
                  {t("{n} 项指标本期**未采集**(照实显示「未采集」而不是 0):{list}。", {
                    n: ov.notCollected.length,
                    list: ov.notCollected.map((x) => `${t(x.label)} → ${x.slice}`).join("、"),
                  })}
                </Text>
                <Text type="secondary">
                  {t("🔴 「只读 · 来自 <target>」这种跨 target 引用分组本期**没有可挂的东西** —— 跨区复制是只建了数据模型骨架、刻意不实现(SPEC §6.4)。等它落地再挂,不先画一个空分组冒充有这个能力。")}
                </Text>
              </Space>
            }
          />

          {drill ? (
            <Card
              size="small"
              style={{ marginTop: 12 }}
              title={
                <Space wrap>
                  <Text strong>{t("下钻:{tid} 的镜像条目", { tid: drill.targetId })}</Text>
                  <Tag>{t("{n} 条", { n: drill.entries.length })}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t("只读镜像;点表看数据要去该区的数据面(治理页按 target 化在后续刀)")}
                  </Text>
                </Space>
              }
              extra={<Button size="small" onClick={() => setDrill(null)}>{t("收起")}</Button>}
            >
              <Table
                size="small"
                rowKey={(r: Entry) => `${r.kind}#${r.fqn}`}
                dataSource={drill.entries}
                pagination={{ pageSize: 20, showSizeChanger: true }}
                locale={{ emptyText: t("这个区的镜像里没有条目(可能从未同步,或那个区确实还没有目录对象)") }}
                columns={[
                  { title: t("类型"), dataIndex: "kind", width: 90,
                    render: (v: string) => <Tag color={v === "db" ? "blue" : "purple"}>{v === "db" ? t("库") : t("表")}</Tag> },
                  { title: t("来源"), key: "src", width: 110,
                    render: (_: any, r: Entry) => <Tag>{r.payload?.source || r.fqn.split(".")[0]}</Tag> },
                  { title: t("名称"), key: "name",
                    render: (_: any, r: Entry) => (
                      <Space direction="vertical" size={0}>
                        <Text>{r.payload?.name || r.fqn}</Text>
                        <Text type="secondary" style={{ fontSize: 11 }}>{r.fqn}</Text>
                      </Space>
                    ) },
                  { title: t("列数"), key: "cols", width: 110,
                    render: (_: any, r: Entry) =>
                      r.kind === "table" ? (
                        <Space size={4}>
                          <Text>{r.payload?.columnCount ?? 0}</Text>
                          {r.payload?.columnsTruncated ? (
                            <Tooltip title={t("列名只镜像了前若干个(item 体积上限)⇒ 列数是真的,列名清单不全")}>
                              <Tag color="warning">{t("列名已截断")}</Tag>
                            </Tooltip>
                          ) : null}
                        </Space>
                      ) : <Text type="secondary">—</Text> },
                  { title: t("镜像于"), dataIndex: "mirroredAt", width: 160,
                    render: (v?: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v ? v.slice(0, 19).replace("T", " ") : "—"}</Text> },
                ]}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
