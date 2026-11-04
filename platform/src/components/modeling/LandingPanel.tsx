"use client";
// **建模落地面板**(50 INTERACTION §4ter 场景五:建模逐 target 下推与 drift 呈现)。
//
// 复用既有三件范式、**不新造**:target 多选(§2.1)· 下发前看清(§2.2)· 观测态四色(§4ter)。
// 新增的只是"落到哪个 schema / 观测态四色"的表达(原「被驻留门控」态已随不设法务门删除)。
//
// 🔴 本面板最要紧的两条:
//  ① **`drift` 绝不显示为 ✓**(原「⊘被驻留门控」态已删)。判态用**服务端同一份纯函数** `landedStateOf`
//     (`landing-shared.ts`)—— 前端自己再判一遍就会有两个说法,而不一致的表现恰好是
//     "面板说已落、库里其实是另一张表"。
//  ② **不许把陈旧观测画成实时绿灯**:每格都显示「观测于 <时间>」,并给〔重新检测〕。
//     "已落"只代表**那一刻**观测到的结构一致;库里被人改了平台是不知道的。

import React, { useMemo, useState } from "react";
import { Alert, Button, Descriptions, Input, Modal, Popconfirm, Radio, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { DisconnectOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { landedStateOf, diffSignatures, type LandedRecord, type LandedState } from "@/lib/modeling/landing-shared";
// 免责告知弹窗(409 驱动,同意后重试)
import { useResidencyAck } from "@/components/residency/useResidencyAck";
import { fetchWithResidencyAck } from "@/lib/residency/client";

const { Text } = Typography;
const HOME_TARGET = "tgt_home";

/** 四态 + 两个"还没记录/定义变了"的呈现口径。🔴 与服务端 `LandedState` 一一对应,不新造。 */
const STATE_UI: Record<LandedState, { text: string; color?: string; hint: string }> = {
  ok: { text: "✓ 已落", color: "success", hint: "观测到的表结构与平台定义一致" },
  stale: { text: "⚠ 版本不齐", color: "warning", hint: "定义已经改过,但这个区落的还是旧结构 —— 重新落地即可对齐" },
  drift: {
    text: "🔴 drift",
    color: "error",
    hint: "该区已存在**结构不同**的同名表,平台**没有覆盖**它 —— 看差异后决定是否以平台定义强制重建",
  },
  // 🔴 写入通道已交付(SPEC §3.9d):非 home 落地不再产生这一态,
  //   界面上只剩**交付之前留下的旧记录**(它们从没执行过任何语句,那个区没有这张表)。文案随合同更新
  //   (INTERACTION §4ter.a-1:不许让用户读到一句过期的「至今未交付」),并给出路:勾上重新落地即可。
  "credential-gap": {
    text: "⊘ 待重新落地",
    hint: "该区尚未供给 shared-writer 身份(写入通道交付之前留下的旧记录,那个区还没有这张表)⇒ 勾选后点〔落地〕即自动供给并写入",
  },
  failed: { text: "✗ 落地失败", color: "error", hint: "看错误详情(常见:组件缺失 / 权限 / schema 不存在)" },
  "never-landed": { text: "⚠ 未落地", color: "warning", hint: "绑了这个区却还没落过 —— 那个区现在没有这张表" },
};

export interface LandingPanelProps {
  open: boolean;
  onClose: () => void;
  /** 建模对象类型(决定调哪个端点) */
  kind: "code-table" | "model-table";
  id: string;
  name: string;
  /** 物理落点(schema.table);🔴 显示**真实值**,不许美化 */
  table: string;
  /** 当前定义哈希(服务端算,面板只比对) */
  defHash: string;
  landedByTarget?: Record<string, LandedRecord>;
  /** 该定义当前绑定的 target(缺省 home) */
  targets?: string[];
  /** 可选的执行目标清单(来自 `/api/exec-targets`,已过准入+组件+法域) */
  execTargets: Array<{ targetId: string; region: string; isHome: boolean }>;
  onDone: () => void;
}

export default function LandingPanel(p: LandingPanelProps) {
  const t = useT();
  // 免责告知弹窗(409 驱动,同意后重试)
  const { residencyModal, resolveAckRequired } = useResidencyAck();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [diffOpen, setDiffOpen] = useState<string>("");
  const [forceOpen, setForceOpen] = useState<string>("");
  const [confirmText, setConfirmText] = useState("");
  // 解绑弹窗(只解绑 / 解绑并清理;清理要逐字输入物理表名)
  const [unbindOpen, setUnbindOpen] = useState<string>("");
  const [unbindMode, setUnbindMode] = useState<"keep" | "cleanup">("keep");
  const [unbindConfirm, setUnbindConfirm] = useState("");
  const [unbindPreview, setUnbindPreview] = useState<
    { table: string; status: string | null; lastLandedAt: string | null; rowCountEstimate: number | null; bound: boolean } | null
  >(null);

  const endpoint =
    p.kind === "code-table" ? `/api/modeling/codetables/${p.id}/land` : `/api/modeling/dimensions/${p.id}/apply`;
  const unbindBase = p.kind === "code-table" ? `/api/modeling/codetables/${p.id}` : `/api/modeling/dimensions/${p.id}`;

  const bound = useMemo(() => (p.targets?.length ? p.targets : [HOME_TARGET]), [p.targets]);
  /** 列出**绑定 ∪ 已有记录 ∪ 可选清单**:只列绑定会把"落过但后来解绑"的区藏掉(与矩阵同一条纪律)。 */
  const rows = useMemo(() => {
    const ids = new Set<string>([...bound, ...Object.keys(p.landedByTarget || {})]);
    for (const x of p.execTargets) ids.add(x.targetId);
    return Array.from(ids).map((targetId) => {
      const rec = (p.landedByTarget || {})[targetId];
      const meta = p.execTargets.find((x) => x.targetId === targetId);
      return {
        key: targetId,
        targetId,
        region: meta?.region || "",
        isHome: targetId === HOME_TARGET,
        bound: bound.includes(targetId),
        rec,
        state: landedStateOf(rec, p.defHash) as LandedState,
      };
    }).sort((a, b) => (a.isHome ? -1 : b.isHome ? 1 : a.targetId.localeCompare(b.targetId)));
  }, [bound, p.landedByTarget, p.defHash, p.execTargets]);

  const call = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      // 跨法域 target 首次落地 ⇒ 服务端 409 ⇒ 弹免责告知 ⇒ 同意留存 ⇒ 自动重试同一请求
      const { res: r, body: d, cancelled } = await fetchWithResidencyAck(
        endpoint,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        resolveAckRequired
      );
      if (cancelled) return false;
      if (!r.ok || !d?.success) {
        message.error(d?.error?.message || t("操作失败"));
        return false;
      }
      message.success(okMsg);
      p.onDone();
      return true;
    } catch (e: any) {
      message.error(e?.message || t("操作失败"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const doLand = (targets: string[]) =>
    call({ targets }, t("已落地到 {n} 个区(状态取自落地后的**真实观测**;其它区的绑定未改动)", { n: targets.length }));
  const doProbe = (targets: string[]) =>
    call({ targets, probeOnly: true }, t("已重新检测 {n} 个区", { n: targets.length }));

  const doForce = async (targetId: string) => {
    if (confirmText !== "FORCE-REBUILD") {
      message.warning(t("请逐字输入 FORCE-REBUILD 以确认"));
      return;
    }
    const ok = await call(
      { targets: [targetId], force: true, confirm: "FORCE-REBUILD" },
      t("已以平台定义强制重建 {t}", { t: targetId })
    );
    if (ok) {
      setForceOpen("");
      setConfirmText("");
    }
  };

  // 解绑(50 SPEC v3.20 §3.8 / INTERACTION v2.16 §4ter)
  const openUnbind = async (targetId: string) => {
    setUnbindOpen(targetId);
    setUnbindMode("keep");
    setUnbindConfirm("");
    setUnbindPreview(null);
    try {
      const r = await fetch(`${unbindBase}/unbind-preview?targetId=${encodeURIComponent(targetId)}`);
      const d = await r.json();
      if (r.ok && d?.success) setUnbindPreview(d.data);
    } catch {
      /* 预览拿不到不阻断:弹窗仍能只解绑;清理仍要输入表名 */
    }
  };
  const boundCount = rows.filter((r) => r.bound).length;
  const unbindRow = rows.find((r) => r.targetId === unbindOpen);
  const unbindIsLast = Boolean(unbindRow?.bound) && boundCount === 1;
  const unbindNeedsConfirm = unbindMode === "cleanup";
  const unbindConfirmOk = !unbindNeedsConfirm || unbindConfirm === p.table;
  const doUnbind = async () => {
    if (!unbindOpen) return;
    if (unbindNeedsConfirm && unbindConfirm !== p.table) {
      message.warning(t("请逐字输入物理表名 {t} 以确认清理", { t: p.table }));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${unbindBase}/unbind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetId: unbindOpen,
          cleanup: unbindMode === "cleanup",
          ...(unbindMode === "cleanup" ? { confirm: unbindConfirm } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok || !d?.success) {
        // 🔴 失败文案照实转述服务端(它会说清「记录与绑定保留」),不许在这里美化成「已解绑」
        message.error(d?.error?.message || t("解绑失败"));
        return;
      }
      message.success(
        d.data?.dropped
          ? t("已解绑并清理 {t}:该区的表已 DROP,落地记录已去项", { t: unbindOpen })
          : unbindMode === "cleanup"
            ? t("已解绑 {t}:该区本就没有这张表,落地记录已去项", { t: unbindOpen })
            : t("已解绑 {t}:落地记录保留 ⇒ 矩阵将显示「残留」", { t: unbindOpen })
      );
      setUnbindOpen("");
      p.onDone();
    } catch (e: any) {
      message.error(e?.message || t("解绑失败"));
    } finally {
      setBusy(false);
    }
  };

  const diffRow = rows.find((r) => r.targetId === diffOpen);
  const diff = diffRow?.rec
    ? diffSignatures(diffRow.rec.expectedColumns || "", diffRow.rec.observedColumns || "")
    : null;

  return (
    <>
      {residencyModal}
      <Modal
        title={<Space>{t("落地面板")}<Text type="secondary" style={{ fontSize: 13 }}>{p.name}</Text></Space>}
        open={p.open}
        onCancel={p.onClose}
        width={980}
        footer={[
          <Button key="probe" icon={<ReloadOutlined />} loading={busy}
            onClick={() => doProbe(rows.filter((r) => r.bound).map((r) => r.targetId))}>
            {t("重新检测(全部已绑区)")}
          </Button>,
          // 🔴 文案说清「只落这些区」——**不动其它区的绑定**(绑定只增不减、没有隐式解绑;
          //    修 bug 前勾选事实上变成了「解绑其余区」,而界面上一个字都没说)
          <Tooltip key="land-tip" title={t("只把这些区落一遍;**不会改动其它区的绑定**(平台没有隐式解绑)")}>
            <Button key="land" type="primary" loading={busy} disabled={picked.length === 0}
              onClick={() => doLand(picked)}>
              {t("落地到选中的 {n} 个区", { n: picked.length })}
            </Button>
          </Tooltip>,
          <Button key="close" onClick={p.onClose}>{t("关闭")}</Button>,
        ]}
      >
        <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
          <Descriptions.Item label={t("物理落点")}><code>{p.table}</code></Descriptions.Item>
          <Descriptions.Item label={t("定义哈希")}><code>{p.defHash}</code></Descriptions.Item>
        </Descriptions>
        {/* 🔴 schema 口径**照实说**:现在落 `public`,收进项目 schema ,不许在界面上美化成 shared/proj_* */}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("状态是**观测态**:每格显示「观测于」的时间,代表那一刻库里的真实结构 —— 之后被人改过平台并不知道,要看现在请点「重新检测」。")}
          description={t("物理落点当前是 {s};把建模产物收进项目 schema(shared / proj_*)属后续批次,这里如实显示真实 schema。", {
            s: p.table.split(".")[0] || "public",
          })}
        />
        <Table
          size="small"
          pagination={false}
          dataSource={rows}
          rowSelection={{
            selectedRowKeys: picked,
            onChange: (k) => setPicked(k as string[]),
            // 原「缺写入通道的区不给勾」已放开(INTERACTION §4ter.a-1 勾选框一行):
            //   写入通道已交付,旧的 credential-gap 记录重新落地一次就会变成真实的四态之一。
            getCheckboxProps: () => ({ disabled: false }),
          }}
          columns={[
            {
              title: t("执行区域"),
              dataIndex: "targetId",
              width: 210,
              render: (v: string, r: any) => (
                <Space size={4}>
                  <Tag color={r.isHome ? "default" : "cyan"}>{v}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{r.region}</Text>
                  {r.bound ? null : <Tag>{t("未绑定")}</Tag>}
                </Space>
              ),
            },
            {
              title: t("观测态"),
              dataIndex: "state",
              width: 170,
              render: (s: LandedState) => (
                <Tooltip title={t(STATE_UI[s].hint)}>
                  {STATE_UI[s].color ? <Tag color={STATE_UI[s].color}>{t(STATE_UI[s].text)}</Tag> : <Tag>{t(STATE_UI[s].text)}</Tag>}
                </Tooltip>
              ),
            },
            {
              title: t("观测于"),
              dataIndex: "rec",
              width: 170,
              render: (rec: LandedRecord | undefined) =>
                rec?.observedAt ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>{rec.observedAt.slice(0, 19).replace("T", " ")}</Text>
                ) : (
                  <Text type="secondary">—</Text>
                ),
            },
            {
              title: t("处置"),
              key: "act",
              render: (_: any, r: any) => (
                <Space wrap>
                  {r.state === "drift" ? (
                    <>
                      <Button size="small" onClick={() => setDiffOpen(r.targetId)}>{t("查看差异")}</Button>
                      <Button size="small" danger icon={<WarningOutlined />}
                        onClick={() => { setForceOpen(r.targetId); setConfirmText(""); }}>
                        {t("以平台定义强制重建")}
                      </Button>
                    </>
                  ) : null}
                  {r.state === "stale" || r.state === "never-landed" || r.state === "failed" ? (
                    <Button size="small" type="link" style={{ padding: 0 }} loading={busy}
                      onClick={() => doLand([r.targetId])}>
                      {t("落地到此区")}
                    </Button>
                  ) : null}
                  {r.rec?.error ? (
                    <Tooltip title={r.rec.error}><Text type="danger" style={{ fontSize: 12 }}>{t("错误详情")}</Text></Tooltip>
                  ) : null}
                  {/* 解绑是**显式动作**(此前绑定只能由落地增长,残留在真环境构造不出来) */}
                  {r.bound || r.rec ? (
                    <Button size="small" icon={<DisconnectOutlined />} loading={busy} onClick={() => openUnbind(r.targetId)}>
                      {t("解绑…")}
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      {/* 解绑弹窗:只解绑(残留可见)/ 解绑并清理(DROP,机制 A 输入表名) */}
      <Modal
        title={<Space><DisconnectOutlined />{t("从 {t} 解绑 · {n}", { t: unbindOpen, n: p.name })}</Space>}
        open={Boolean(unbindOpen)}
        onCancel={() => setUnbindOpen("")}
        okText={unbindMode === "cleanup" ? t("解绑并清理") : t("只解绑")}
        okButtonProps={{ danger: unbindMode === "cleanup", disabled: !unbindConfirmOk }}
        confirmLoading={busy}
        onOk={doUnbind}
        width={640}
      >
        <Radio.Group value={unbindMode} onChange={(e) => setUnbindMode(e.target.value)} style={{ width: "100%" }}>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Radio value="keep">
              {t("只解绑,保留该区已落地的表")}
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t("矩阵与本面板将把这一格显示为「残留」—— 那个区的表还在,平台绝不把它藏起来")}
              </Text>
            </Radio>
            <Radio value="cleanup" disabled={unbindPreview ? unbindPreview.status === "credential-gap" && false : false}>
              {t("解绑并清理:DROP {t}", { t: p.table })}
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {unbindPreview?.status === "credential-gap" || (unbindPreview && unbindPreview.status === null)
                  ? t("该区从未落过这张表 ⇒ 只去掉记录,不连库")
                  : unbindPreview?.rowCountEstimate != null
                    ? t("约 {n} 行,最后落地 {at}", {
                        n: unbindPreview.rowCountEstimate,
                        at: (unbindPreview.lastLandedAt || "—").slice(0, 19).replace("T", " "),
                      })
                    : t("先 DROP、观测为空、再去记录;DROP 失败则记录与绑定一字不动")}
              </Text>
            </Radio>
          </Space>
        </Radio.Group>
        {unbindIsLast ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={t("这是最后一个绑定:解绑后该定义回到缺省 home(下次落地默认只落 home)。")}
          />
        ) : null}
        {unbindMode === "cleanup" ? (
          <div style={{ marginTop: 12 }}>
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 8 }}
              message={t("DROP 是有损动作:表里的数据会一起消失,请先备份。平台不会替你判断那张表能不能删。")}
            />
            <Text>{t("逐字输入物理表名以确认:")}</Text>
            <Input value={unbindConfirm} onChange={(e) => setUnbindConfirm(e.target.value)} placeholder={p.table} style={{ marginTop: 8 }} />
          </div>
        ) : null}
      </Modal>

      {/* 字段级 diff(§4ter 的〔查看差异〕) */}
      <Modal title={t("字段级差异 · {t}", { t: diffOpen })} open={Boolean(diffOpen)} onCancel={() => setDiffOpen("")} footer={null} width={760}>
        {diff ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Alert type="warning" showIcon
              message={t("该区已存在一张**结构不同**的同名表 —— 平台没有覆盖它(建表语句是 CREATE TABLE IF NOT EXISTS)。")} />
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t("平台定义只有的列")}>
                {diff.onlyInDefinition.length ? diff.onlyInDefinition.join(", ") : "—"}
              </Descriptions.Item>
              <Descriptions.Item label={t("该区表只有的列")}>
                {diff.onlyInTarget.length ? diff.onlyInTarget.join(", ") : "—"}
              </Descriptions.Item>
              <Descriptions.Item label={t("类型不一致")}>
                {diff.typeMismatch.length
                  ? diff.typeMismatch.map((m) => `${m.column}: ${t("定义")} ${m.expected} ≠ ${t("实际")} ${m.observed}`).join("; ")
                  : "—"}
              </Descriptions.Item>
            </Descriptions>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t("定义签名")}: <code>{diffRow?.rec?.expectedColumns || "—"}</code>
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t("观测签名")}: <code>{diffRow?.rec?.observedColumns || "—"}</code>
            </Text>
          </Space>
        ) : null}
      </Modal>

      {/* 🔴 强制重建 = 有损:DROP 该区现有表 ⇒ 机制A 二次确认(逐字确认串) */}
      <Modal
        title={<Space><WarningOutlined style={{ color: "#ff4d4f" }} />{t("以平台定义强制重建 · {t}", { t: forceOpen })}</Space>}
        open={Boolean(forceOpen)}
        onCancel={() => setForceOpen("")}
        okText={t("确认强制重建")}
        okButtonProps={{ danger: true, disabled: confirmText !== "FORCE-REBUILD" }}
        confirmLoading={busy}
        onOk={() => doForce(forceOpen)}
      >
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
          message={t("这会 **DROP 该执行目标上的现有表**,表里的数据会一起消失。请先备份。")}
          description={t("平台不会替你判断那张表能不能删 —— 它可能是别人建的、正被别的作业写入。")} />
        <Text>{t("逐字输入 FORCE-REBUILD 以确认:")}</Text>
        <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="FORCE-REBUILD" style={{ marginTop: 8 }} />
      </Modal>
    </>
  );
}
