"use client";

// 2026-07-13 调度运维收敛:SLA 基线预警并入「告警中心 → SLA 基线预警」Tab
// (检测类配置收拢到告警中心)。本页保留作 URL 兼容跳转;菜单入口已移除。
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Spin } from "antd";

export default function SlaRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/alerting?tab=sla");
  }, [router]);
  return (
    <div style={{ textAlign: "center", padding: 64 }}>
      <Spin />
    </div>
  );
}
