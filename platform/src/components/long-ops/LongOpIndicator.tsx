"use client";
// 长操作的全局提示:监听 lib/long-ops/client/events.ts 的 DOM 事件,用 antd message.loading 显示
// 「正在后台执行:<label>(已 n 秒)」,终态自动消(key = taskId,多个长操作并发各一条)。
//
// 为什么是组件而不是在拦截器里直接调 antd:拦截器是非 React 模块,直接用静态 message 会脱离 ConfigProvider(皮肤 / 语言);
// 这里经 t() 翻标签、挂在壳层(登录页不挂)。容器 `data-testid="long-op-indicator"` 给页面驱动判据读文本(段 p50)。

import { useEffect } from "react";
import { message } from "antd";
import { useT } from "@/lib/i18n/useT";
import { LONG_OP_EVENT, type LongOpEventDetail } from "@/lib/long-ops/client/events";

export default function LongOpIndicator() {
  const t = useT();
  useEffect(() => {
    const onEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<LongOpEventDetail>).detail;
      if (!detail || !detail.taskId) return;
      const key = `long-op:${detail.taskId}`;
      if (detail.phase === "settled") {
        message.destroy(key);
        return;
      }
      const seconds = Math.max(0, Math.round(detail.elapsedMs / 1000));
      const label = detail.label ? t(detail.label) : t("长操作");
      message.loading({
        key,
        duration: 0,
        content: (
          <span data-testid="long-op-indicator" data-task-id={detail.taskId} data-kind={detail.kind}>
            {t("正在后台执行:{label}(已 {n} 秒)", { label, n: seconds })}
          </span>
        ),
      });
    };
    window.addEventListener(LONG_OP_EVENT, onEvent);
    return () => window.removeEventListener(LONG_OP_EVENT, onEvent);
  }, [t]);
  return null;
}
