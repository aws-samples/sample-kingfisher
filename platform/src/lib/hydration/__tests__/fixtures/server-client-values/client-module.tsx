"use client";

// 夹具:客户端模块 —— 导出一个值与一个组件。
export const clientValue = "from-client-module";

export default function ClientComp({ label }: { label?: string }) {
  return <span>{label}</span>;
}
