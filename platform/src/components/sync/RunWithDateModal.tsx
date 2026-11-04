"use client";

// @kf-batch 37-sync-backfill —— 序 37 ⑥:同步任务「指定业务日期运行」(列表页与详情页共用)。
// 发 `POST /api/sync/<id>/start`,请求体 `{ runDate: "YYYY-MM-DD" }`;不用这个入口(直接点「启动」)= 不带请求体 = 改动前的行为
// (脚本按任务的业务时区取今天)。日期变量的含义与取值规则的唯一作者是 lib/sync/run-vars.ts。
import React, { useEffect, useState } from "react";
import { Modal, DatePicker, Alert, Space, message } from "antd";
import type { Dayjs } from "dayjs";
import { useT } from "@/lib/i18n/useT";
import { syncTaskUsesRunDate } from "@/lib/sync/run-vars";

export interface RunWithDateTask {
  taskId: string;
  name?: string;
  whereClause?: unknown;
  sourceTables?: unknown;
}

export default function RunWithDateModal({
  task,
  open,
  onClose,
  onStarted,
}: {
  task: RunWithDateTask | null;
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT();
  const [date, setDate] = useState<Dayjs | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (open) setDate(null); }, [open, task?.taskId]);

  const usesDate = task ? syncTaskUsesRunDate(task) : false;

  const submit = async () => {
    if (!task || !date) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sync/${task.taskId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runDate: date.format("YYYY-MM-DD") }),
      });
      const data = await res.json();
      if (data.success === false || data.error) {
        message.error(data.error?.message || data.error || t("操作失败"));
        return;
      }
      message.success(t("已按业务日期 {d} 启动", { d: date.format("YYYY-MM-DD") }));
      onClose();
      onStarted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={t("指定业务日期运行")}
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText={t("运行")}
      okButtonProps={{ disabled: !date, loading: submitting, "data-testid": "sync-run-date-ok" } as never}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>{task?.name}</div>
        <DatePicker data-testid="sync-run-date-picker" style={{ width: "100%" }} value={date} onChange={(d) => setDate(d)} placeholder={t("选择业务日期")} />
        <Alert
          type={usesDate ? "info" : "warning"}
          showIcon
          message={
            usesDate
              ? t("过滤条件 / 源表名里的日期变量按所选业务日期取值;直接点「启动」则按任务的业务时区取今天。")
              : t("这个任务没有用到日期变量,指定哪一天跑出来的结果都相同。")
          }
        />
      </Space>
    </Modal>
  );
}
