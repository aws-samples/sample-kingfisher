"use client";

// 2026-11-04(C)—— 发起补数向导里**随所选目标变化**的那几块:同步任务提示 / 含同步节点工作流提示 / 「级联下游依赖」开关。
//
// 【缺陷原形(两区测试环境页面驱动:选中工作流后 3 秒内级联开关与提示都没出现)】页面原来在**渲染期**用
//   `form.getFieldValue("targetId")` 取所选目标。antd Form 的字段值仓不在 React state 里:改选目标只重渲染那个 Form.Item,
//   页面组件自己**不会**重渲染;`onValuesChange` 只做 `setPreview(null)`,而 preview 本来就是 null ⇒ React 判「状态没变」直接跳过
//   ⇒ 由所选目标派生的 UI(开关 / 提示 / 并发框置灰)**不出现**,直到别的 state 变化(点「预览实例」)才补渲染。
// 【根治】所选目标 id 进 React state(app/backfill/page.tsx 的 `selectedTargetId`,在 onValuesChange 里写),派生块只按传入的目标渲染。
//   本组件不读 Form 值仓;`isConcurrencyForced` / `workflowHasSyncNode` 是页面与本组件共用的唯一判定(并发框置灰与提示同一口径,
//   服务端 `forcedBackfillConcurrency` 是真正的强制)。
import React from "react";
import { Alert, Form, Switch } from "antd";
import { useT } from "@/lib/i18n/useT";

/** `/api/backfill/targets` 一行(向导下拉的选项;`nodeTypes` 只有工作流带)。 */
export interface BackfillTargetOption {
  id: string;
  name: string;
  scope: "task" | "workflow";
  kind: string;
  taskType?: string;
  nodeCount?: number;
  nodeTypes?: string[];
  unavailableReason?: string;
}

/** 含数据同步节点的工作流(服务端会把并发强制成 1,见 lib/backfill/types.ts forcedBackfillConcurrency)。 */
export function workflowHasSyncNode(target: BackfillTargetOption | undefined): boolean {
  return target?.scope === "workflow" && Array.isArray(target?.nodeTypes) && target.nodeTypes.includes("sync");
}

/** 并发框要不要置灰:同步任务目标 / 含同步节点的工作流。 */
export function isConcurrencyForced(target: BackfillTargetOption | undefined): boolean {
  return target?.kind === "sync-task" || workflowHasSyncNode(target);
}

export default function WizardTargetDerived({ target }: { target: BackfillTargetOption | undefined }) {
  const t = useT();
  return (
    <>
      {target?.kind === "sync-task" && (
        <Alert style={{ marginBottom: 16 }} type="info" showIcon data-testid="backfill-hint-sync-task"
          message={t("同步任务按业务日期逐天补数:每个日期跑一次该任务(Glue 作业带上这个日期),并发固定为 1(同一个 Glue 作业不能同时跑两个日期);只支持按天 / 按周。")} />
      )}
      {workflowHasSyncNode(target) && (
        <Alert style={{ marginBottom: 16 }} type="info" showIcon data-testid="backfill-hint-wf-sync"
          message={t("该工作流含数据同步节点:每个业务日期会把节点关联的同步任务跑一次(Glue 作业带上这个日期),并发固定为 1(同一个 Glue 作业不能同时跑两个日期)。关联的同步任务须是 Glue 通道、全量且用到日期变量,否则该节点的实例会如实失败(级联时其下游跳过)。")} />
      )}
      {target?.scope === "workflow" && (
        <Form.Item name="cascade" label={t("级联下游依赖")} valuePropName="checked"
          tooltip={t("按 DAG 依赖顺序补数:同日期上游成功后下游才跑")}>
          <Switch checkedChildren={t("级联")} unCheckedChildren={t("独立")} />
        </Form.Item>
      )}
    </>
  );
}
