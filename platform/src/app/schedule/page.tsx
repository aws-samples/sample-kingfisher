"use client";

// 2026-07-13 调度运维收敛:调度管理并入「任务监控 → 调度配置」Tab(看运行↔改调度一页完成)。
// 本页保留作 URL 兼容跳转(旧收藏/页签不断链);菜单入口已移除。
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spin } from "antd";

export default function ScheduleRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/monitor?tab=schedule");
  }, [router]);
  return (
    <div style={{ textAlign: "center", padding: 64 }}>
      <Spin />
    </div>
  );
}
