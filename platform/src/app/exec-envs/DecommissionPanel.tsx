"use client";

// @kf-batch 50-WP30-decommission
// 执行环境详情页「危险区」的路 B「下线销毁」(WORK-PACKAGES WP-30 ②原型 / INTERACTION §1.4 四道闸)。
//
//   ① 停止承接(drain,要写原因)→ ② 影响预览(绑定 / 启用调度 / 运行中 run,三个数都为 0 才能申请)
//   → 第一道弹窗(影响清单 + 将保留的数据资源)→ 第二道弹窗(**手输 region 名**才激活「确认删除」)
//   → 提交审批(不立即销毁)→ 平台管理员审批 → 销毁中(轮询 destroy-observe)→ 已删除 / 卡住(点名资源 + 真因,〔重试销毁〕)。
//
// 🔴 页面只做**提示性**分流;每一步服务端都会重判(`lib/exec-env/decommission.ts`),拒因原样显示。
// 🔴 主控区不渲染本组件(父组件按 isHome 隐藏;服务端另有 403 硬拒)。
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, List, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useT } from "@/lib/i18n/useT";
import {
  ApiError,
  IMPACT_KIND_HREF,
  drainForDelete,
  getDeletePreview,
  observeDestroy,
  requestDeleteTarget,
  retryDestroyTarget,
  type DecommissionViewDto,
  type DeleteImpactItem,
  type DeletePreviewView,
  type ExecEnvTarget,
  type RetainedResourceView,
} from "./api";

const { Text } = Typography;

function RetainedList({ items, testId }: { items: RetainedResourceView[]; testId: string }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <div data-testid={testId}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t("将保留(不删):数据类资源需人工确认后单独清理,平台不代决")}
      </Text>
      <List
        size="small"
        dataSource={items}
        renderItem={(r) => (
          <List.Item style={{ padding: "2px 0" }} data-testid="retained-item">
            <Space>
              <Tag color="blue">{r.kind}</Tag>
              <Text code style={{ fontSize: 12 }}>{r.name}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t(r.note)}</Text>
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}

export default function DecommissionPanel({ target, onChanged }: { target: ExecEnvTarget; onChanged: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<DeletePreviewView | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [view, setView] = useState<DecommissionViewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [drainOpen, setDrainOpen] = useState(false);
  const [drainReason, setDrainReason] = useState("");
  const [step, setStep] = useState<0 | 1 | 2>(0); // 0 关;1 影响预览;2 输 region 名
  const [confirmText, setConfirmText] = useState("");
  const [retryOpen, setRetryOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const p = await getDeletePreview(target.targetId);
      setPreview(p);
      setPreviewErr(null);
      if (p.stage === "destroying" || p.stage === "stuck" || p.stage === "deleted") {
        setView(await observeDestroy(target.targetId));
      } else {
        setView(null);
      }
    } catch (e) {
      setPreviewErr((e as Error).message);
    }
  }, [target.targetId]);

  useEffect(() => {
    void refresh();
  }, [refresh, target.updatedAt, target.status]);

  // 销毁中:每 15s 观测一次(观测本身会在 build 结束时收口 ⇒ 状态变化后通知父组件刷新)
  useEffect(() => {
    if (preview?.stage !== "destroying") return;
    const timer = setInterval(async () => {
      try {
        const v = await observeDestroy(target.targetId);
        setView(v);
        if (v.state === "settled-gone" || v.state === "settled-stuck") {
          onChanged();
          void refresh();
        }
      } catch {
        /* 下一轮再看 */
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [preview?.stage, target.targetId, onChanged, refresh]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      message.success(ok);
      onChanged();
      await refresh();
      return true;
    } catch (e) {
      const err = e as ApiError;
      message.error(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (previewErr) return <Alert type="error" showIcon message={t("影响预览读取失败")} description={previewErr} />;
  if (!preview) return <Text type="secondary">{t("正在读取删除流程状态…")}</Text>;
  const c = preview.impact.counts;
  const mark = (n: number | null) => (n === 0 ? <Text type="success">✓</Text> : <Text type="danger">✗</Text>);
  const impactRows = [
    { key: "bindings", label: t("绑定资源"), n: c.bindings },
    { key: "schedules", label: t("启用调度"), n: c.schedules },
    { key: "runs", label: t("运行中 run"), n: c.runningRuns },
  ];
  const impactTable = (
    <div data-testid="delete-impact">
      <Space wrap>
        {impactRows.map((r) => (
          <Text key={r.key} data-testid={`delete-impact-${r.key}`}>
            {r.label} {r.n === null ? "?" : r.n} {mark(r.n)}
          </Text>
        ))}
      </Space>
      {preview.impact.unresolved.length > 0 && (
        <Alert type="error" showIcon style={{ marginTop: 6 }} message={t("有来源读不到,不能确认是 0(读不到 ≠ 没有)")} description={preview.impact.unresolved.map((u) => `${u.source}:${u.error}`).join(";")} />
      )}
      {preview.impact.bindings.length > 0 && (
        <Table<DeleteImpactItem>
          size="small"
          style={{ marginTop: 6 }}
          rowKey={(r) => `${r.kind}/${r.id}`}
          pagination={false}
          data-testid="delete-impact-bindings"
          dataSource={preview.impact.bindings}
          columns={[
            { title: t("类型"), dataIndex: "label", render: (v: string) => t(v) },
            { title: t("名称"), dataIndex: "name" },
            {
              title: t("去解绑"),
              key: "go",
              render: (_: unknown, r: DeleteImpactItem) => (
                <a href={IMPACT_KIND_HREF[r.kind] ?? "#"} data-testid="delete-impact-unbind-link">{t("去解绑这些任务")}</a>
              ),
            },
          ]}
        />
      )}
    </div>
  );

  const stage = preview.stage;
  if (stage === "never-deployed") return null; // 路 A 的弃置区由父组件渲染

  return (
    <div data-testid="exec-env-decommission-zone" data-stage={stage}>
      {stage === "serving" && (
        <Alert
          type="warning"
          showIcon
          message={t("删除执行环境")}
          description={
            <Space direction="vertical" size={4}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("这个环境装出来过:删除要先停止承接,再经影响预览、输 region 名确认、审批后销毁(数据桶 / 表桶 / 最终快照保留)。")}
              </Text>
              <Button danger size="small" data-testid="exec-env-drain-btn" onClick={() => { setDrainReason(""); setDrainOpen(true); }}>
                {t("① 停止承接(drain)")}
              </Button>
            </Space>
          }
        />
      )}

      {(stage === "drained" || stage === "pending-approval") && (
        <Alert
          type="warning"
          showIcon
          message={t("该执行环境已停止承接")}
          description={
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              {impactTable}
              <RetainedList items={preview.impact.retained} testId="delete-retained-preview" />
              {stage === "pending-approval" ? (
                <Alert type="info" showIcon data-testid="delete-pending-approval" message={t("已提交删除申请(审批单 {id}),等待平台管理员审批", { id: preview.pendingApprovalId ?? "?" })} />
              ) : (
                <Space wrap>
                  <Button danger size="small" data-testid="exec-env-delete-request-btn" disabled={preview.blockers.length > 0} onClick={() => { setConfirmText(""); setStep(1); }}>
                    {t("② 申请删除")}
                  </Button>
                  {preview.blockers.map((b) => (
                    <Text key={b} type="danger" style={{ fontSize: 12 }} data-testid="delete-blocker">{b}</Text>
                  ))}
                </Space>
              )}
            </Space>
          }
        />
      )}

      {(stage === "approved" || stage === "stuck") && (
        <Alert
          type="error"
          showIcon
          data-testid="exec-env-destroy-stuck"
          message={stage === "approved" ? t("删除已批准,销毁还没开始") : t("销毁卡住了")}
          description={
            <Space direction="vertical" size={4}>
              {(view?.lastError || view?.lastDestroy?.stuck) && (
                <Text type="danger" data-testid="exec-env-destroy-last-error">{view?.lastError ?? `${view?.lastDestroy?.stuck?.resource}:${view?.lastDestroy?.stuck?.reason}`}</Text>
              )}
              {view?.lastDestroy?.remaining?.length ? (
                <Text type="secondary" style={{ fontSize: 12 }}>{t("仍在:{list}", { list: view.lastDestroy.remaining.join(", ") })}</Text>
              ) : null}
              <Button danger size="small" data-testid="exec-env-destroy-retry-btn" onClick={() => { setConfirmText(""); setRetryOpen(true); }}>
                {t("重试销毁")}
              </Button>
            </Space>
          }
        />
      )}

      {stage === "destroying" && (
        <Alert type="info" showIcon data-testid="exec-env-destroying" message={t("正在销毁")} description={t("托管服务先走,然后按反依赖序删组件栈、core、base;构建状态:{p}", { p: view?.buildPhase ?? "…" })} />
      )}

      {stage === "deleted" && (
        <Alert
          type="success"
          showIcon
          data-testid="exec-env-deleted"
          message={t("已删除")}
          description={
            <Space direction="vertical" size={4}>
              {view?.lastDestroy?.finalSnapshot && (
                <Text data-testid="exec-env-final-snapshot">
                  {t("数仓最终快照:{name}({state})", { name: view.lastDestroy.finalSnapshot.name, state: view.lastDestroy.finalSnapshot.state })}
                </Text>
              )}
              <RetainedList items={view?.lastDestroy?.retained ?? view?.plan?.retained ?? []} testId="delete-retained-final" />
            </Space>
          }
        />
      )}

      <Modal
        open={drainOpen}
        title={t("停止承接 {tid}", { tid: target.targetId })}
        okText={t("确认停止承接")}
        okButtonProps={{ danger: true, disabled: drainReason.trim().length === 0, loading: busy, "data-testid": "exec-env-drain-ok" } as never}
        onOk={async () => {
          if (await run(() => drainForDelete(target.targetId, drainReason.trim()), t("已停止承接:新绑定 / 新调度 / 新运行一律拒"))) setDrainOpen(false);
        }}
        onCancel={() => setDrainOpen(false)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>{t("停止承接后该区立即不再接受新绑定、新调度、新运行(在途作业跑完);不销毁任何资源。")}</Text>
          <Input.TextArea data-testid="exec-env-drain-reason" value={drainReason} onChange={(e) => setDrainReason(e.target.value)} placeholder={t("原因(必填,进审计)")} maxLength={500} />
        </Space>
      </Modal>

      <Modal
        open={step === 1}
        title={t("删除执行环境 {region} —— 影响预览", { region: target.region })}
        okText={t("下一步")}
        okButtonProps={{ danger: true, disabled: !preview.impact.clear, "data-testid": "exec-env-delete-preview-ok" } as never}
        onOk={() => setStep(2)}
        onCancel={() => setStep(0)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>{t("删除前检查(全部需为 0):")}</Text>
          {impactTable}
          <RetainedList items={preview.impact.retained} testId="delete-retained-modal" />
        </Space>
      </Modal>

      <Modal
        open={step === 2}
        title={t("确认删除 {region}", { region: target.region })}
        okText={t("确认删除")}
        okButtonProps={{ danger: true, disabled: confirmText !== target.region, loading: busy, "data-testid": "exec-env-delete-confirm-ok" } as never}
        onOk={async () => {
          if (await run(() => requestDeleteTarget(target.targetId, confirmText, preview.impact.previewHash), t("已提交删除申请,等待平台管理员审批"))) setStep(0);
        }}
        onCancel={() => setStep(0)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>{t("此操作将销毁该 region 全部执行资源。数据桶 / 表桶 / 最终快照将保留,需人工另行清理,不随此操作删除。")}</Text>
          <Text>{t("请输入 region 名以确认:")}</Text>
          <Input data-testid="exec-env-delete-confirm-input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={target.region} />
          <Text type="secondary" style={{ fontSize: 12 }}>{t("提交后进入审批(平台管理员审批),审批通过才会开始销毁")}</Text>
        </Space>
      </Modal>

      <Modal
        open={retryOpen}
        title={t("重试销毁 {region}", { region: target.region })}
        okText={t("重试销毁")}
        okButtonProps={{ danger: true, disabled: confirmText !== target.region, loading: busy, "data-testid": "exec-env-destroy-retry-ok" } as never}
        onOk={async () => {
          if (await run(() => retryDestroyTarget(target.targetId, confirmText), t("已重新触发销毁"))) setRetryOpen(false);
        }}
        onCancel={() => setRetryOpen(false)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text>{t("沿用同一份删除计划与同一个最终快照名(不会重复拍快照,也不会删快照)。请输入 region 名以确认:")}</Text>
          <Input data-testid="exec-env-destroy-retry-input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={target.region} />
        </Space>
      </Modal>
    </div>
  );
}
