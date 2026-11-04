"use client";
// 护栏 1「永远不让用户丢东西」的两个呈现件(交互 INTERACTION §9.3-1;判据)。
//
// AWS 式切区最大的痛点是:切错区之后「东西不见了」而界面**一个字都不说**。
// 所以 target 视角下:
//   · 列表页顶部**常驻**一条淡提示「其他执行范围还有 N 条 → 查看全部」;
//   · 空态直接说「这个区没有,其他区有 N 条」并给一键切「全部」。
//
// 🔴 N 必须与 DDB 对得上(是逐行核对的)⇒ 数字来自 `GET /api/scope/counts`,**不加缓存**;
// 🔴 拉不到就**不显示**提示条(而不是显示 0):显示 0 等于告诉用户「别处没有东西」,那是撒谎。

import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Space } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import type { CountableKind } from "@/lib/scope/resource-index";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { useScope } from "./ScopeProvider";

interface Counts {
  byTarget: Record<string, number>;
  loading: boolean;
  error: string | null;
}

/** 拉一组资源的按 target 计数并合并(多个 kind 的条数直接相加 —— 页面上它们就是混在一个列表里的)。 */
export function useScopeCounts(resources: CountableKind[]): Counts {
  const key = resources.join(",");
  const [state, setState] = useState<Counts>({ byTarget: {}, loading: true, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const merged: Record<string, number> = {};
        for (const r of key.split(",").filter(Boolean)) {
          const res = await fetch(`/api/scope/counts?resource=${encodeURIComponent(r)}`, { cache: "no-store" });
          const d = await res.json();
          if (!res.ok || !d?.success) throw new Error(d?.error?.message || `HTTP ${res.status}`);
          for (const [tid, n] of Object.entries((d.data?.counts ?? {}) as Record<string, number>)) {
            merged[tid] = (merged[tid] ?? 0) + Number(n || 0);
          }
        }
        if (alive) setState({ byTarget: merged, loading: false, error: null });
      } catch (e) {
        if (alive) setState({ byTarget: {}, loading: false, error: (e as Error)?.message || "读取失败" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  return state;
}

/**
 * 「别处还有多少条」。
 *
 * 🔴 **只算当前**可见(= 已安装好且本项目有授权)**的其它 target**,不是 counts 里所有 key。
 * 2026-09-09 真环境实测:仍有 6 条作业绑在**已删除**的 `tgt_usw2_b` / `tgt_usw2_c` 上
 * (那两个区按用户拍板删掉了,绑定却留在作业行里)。若把它们算进 N,提示条就会说
 * 「其他执行范围还有 9 条」而用户在下拉里**根本找不到**那 6 条 —— 那是另一种「说了谎」:
 * 给出一个到不了的数字比不给更让人怀疑界面。那 6 条属于**解绑清理**的事,不是范围的事。
 */
function otherThan(
  byTarget: Record<string, number>,
  targetId: string,
  visible: string[] | null
): number {
  return Object.entries(byTarget)
    .filter(([tid]) => tid !== targetId)
    .filter(([tid]) => visible === null || visible.includes(tid))
    .reduce((a, [, n]) => a + n, 0);
}

/** target 视角下常驻的「别处还有 N 条」提示条。global / compare 视角不渲染。 */
export default function OtherScopesHint({ resources }: { resources: CountableKind[] }) {
  const t = useT();
  const { scope, setScope, targets } = useScope();
  const { byTarget, loading, error } = useScopeCounts(resources);
  const visible = useMemo(() => (targets === null ? null : targets.map((x) => x.targetId)), [targets]);

  const other = useMemo(
    () => (scope.kind === "target" ? otherThan(byTarget, scope.targetId, visible) : 0),
    [byTarget, scope, visible]
  );

  if (scope.kind !== "target") return null;
  if (loading || error) return null; // 🔴 拉不到就不说话,绝不显示 0
  if (other <= 0) return null;

  return (
    <Alert
      data-testid="scope-other-hint"
      type="info"
      showIcon
      style={{ marginTop: 12 }}
      message={
        <Space size={8}>
          <span>
            {t("其他执行范围还有")} <b data-testid="scope-other-count">{other}</b> {t("条")}
          </span>
          <Button size="small" type="link" icon={<GlobalOutlined />} data-testid="scope-view-all" onClick={() => setScope({ kind: "global" })}>
            {t("查看全部")}
          </Button>
        </Space>
      }
    />
  );
}

/**
 * 空态文案:「这个区没有,主控区有 N 条」+ 一键切「全部」。
 *
 * @param note —— 可选的**一句实话**:某些资源在这个区不是「恰好没有」,
 * 而是**还建不了**(如同步任务:执行下推未上线)。空态只说「没有」会让用户反复去建、反复失败;
 * 说清「为什么还不能」才是护栏 1 的本意(不让用户丢东西,也不让用户白试)。
 */
export function ScopeEmptyHint({
  resources,
  noun,
  note,
}: {
  resources: CountableKind[];
  noun: string;
  note?: React.ReactNode;
}) {
  const t = useT();
  const { scope, setScope, targets } = useScope();
  const { byTarget, loading, error } = useScopeCounts(resources);

  if (scope.kind !== "target") return <span>{t("暂无")}{noun}</span>;
  const label = targets?.find((x) => x.targetId === scope.targetId)?.region || scope.targetId;
  const visible = targets === null ? null : targets.map((x) => x.targetId);
  const other = otherThan(byTarget, scope.targetId, visible);
  const home = byTarget[HOME_TARGET_ID] ?? 0;

  return (
    <Space direction="vertical" size={4} data-testid="scope-empty-hint">
      <span>
        {label} {t("没有")}{noun}
      </span>
      {note ? (
        <span data-testid="scope-empty-note" style={{ color: "#90a4c0", fontSize: 12 }}>
          {note}
        </span>
      ) : null}
      {!loading && !error && other > 0 && (
        <>
          <span style={{ color: "#90a4c0", fontSize: 12 }}>
            {t("其他执行范围有")} <b data-testid="scope-empty-other">{other}</b> {t("条")}
            {home > 0 ? `(${t("主控区")} ${home} ${t("条")})` : ""}
          </span>
          <Button size="small" icon={<GlobalOutlined />} data-testid="scope-empty-view-all" onClick={() => setScope({ kind: "global" })}>
            {t("查看全部")}
          </Button>
        </>
      )}
    </Space>
  );
}

/**
 * 护栏 1 的**外部计数**版本:计数由调用方给(不自己去 `/api/scope/counts` 拉)。
 *
 * 🔴 为什么要这个变体:run 列表是**带时间窗 + 带筛选**的,而 counts 端点是不带窗口的全表计数 ——
 * 两者口径必然对不上,提示条的数字会与列表打架(判据会因此假红)。所以 monitor 这类页
 * 让**列表响应自己**顺手回一个 `countsByTarget`(同一查询、同一窗口),这里只负责呈现。
 * 合同:SPEC v3.35 §2.6.6。
 */
export function ScopeCountsHint({
  counts,
  noun,
}: {
  counts: Record<string, number>;
  noun: string;
}) {
  const t = useT();
  const { scope, setScope, targets } = useScope();
  if (scope.kind !== "target") return null;
  const visible = targets === null ? null : targets.map((x) => x.targetId);
  const other = otherThan(counts, scope.targetId, visible);
  if (other <= 0) return null;
  return (
    <Alert
      data-testid="scope-other-hint"
      type="info"
      showIcon
      style={{ marginTop: 12 }}
      message={
        <Space size={8}>
          <span>
            {t("其他执行范围还有")} <b data-testid="scope-other-count">{other}</b> {t("条")}{noun}
          </span>
          <Button size="small" type="link" icon={<GlobalOutlined />} data-testid="scope-view-all" onClick={() => setScope({ kind: "global" })}>
            {t("查看全部")}
          </Button>
        </Space>
      }
    />
  );
}
