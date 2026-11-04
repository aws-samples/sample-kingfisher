"use client";
// 序 73 模块 57(57 DESIGN R3 / R8 ③)—— 运行历史「触发」格的**唯一作者**(离线计算页 / EMR 面板 / 同步任务详情页三处共用)。
//
//   · `triggeredBy === "workflow"`(工作流里的离线作业 / 同步节点写的回链行)⇒ 「由工作流「<名字>」触发」,是一个 Next <Link>,
//     点过去 = 那个工作流详情页并自动打开**这次**运行的「节点详情」(`/workflow/<id>?run=<workflowRunId>`,地址作者 workflowRunHref);
//     老行没有 workflowName ⇒ 显示 workflowId(不编名字);
//   · 其余值照旧:原值 + 调度器 tag(Serverless / MWAA;@kf-batch 50-WP15 的那颗 `run-scheduler-tag`)。
// 🔴 不读任何浏览器状态 ⇒ 服务端 / 客户端首帧一致(B-138)。
import React from "react";
import Link from "next/link";
import { Space, Tag } from "antd";
import { useT } from "@/lib/i18n/useT";
import { workflowRunHref } from "@/lib/workflow/back-links";

export interface RunTriggerFacts {
  triggeredBy?: unknown;
  scheduler?: unknown;
  workflowId?: unknown;
  workflowRunId?: unknown;
  workflowName?: unknown;
}

export function RunTriggerCell({ run }: { run: RunTriggerFacts }) {
  const t = useT();
  const href = run?.triggeredBy === "workflow" ? workflowRunHref(run) : null;
  const schedulerTag = run?.scheduler ? (
    <Tag data-testid="run-scheduler-tag" color={run.scheduler === "serverless" ? "gold" : "default"} style={{ fontSize: 11 }}>
      {run.scheduler === "serverless" ? "Serverless" : "MWAA"}
    </Tag>
  ) : null;
  return (
    <Space size={4} wrap>
      {href ? (
        <Link href={href} data-testid="run-trigger-workflow">
          {t("由工作流「{name}」触发", { name: String(run.workflowName || run.workflowId) })}
        </Link>
      ) : (
        <span>{run?.triggeredBy == null ? "" : String(run.triggeredBy)}</span>
      )}
      {schedulerTag}
    </Space>
  );
}

export default RunTriggerCell;
