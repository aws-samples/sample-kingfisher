// 序 73 模块 57(57 DESIGN §3.8)—— 离线作业节点的画布渲染:复用 RichNodes 的 Shell(同一外壳),
// 显示作业名 · 引擎 Tag · 「未关联 / 作业不存在」。作业名 / 引擎是面板选中时随手存进 data 的展示副本
// (`jobName` / `jobEngine`),权威引用只有 `data.jobRef`(kind + jobId);发布期 / 运行期只读 jobRef 与 jobSpec。
import { memo } from "react";
import type { NodeProps } from "reactflow";
import { CodeOutlined } from "@ant-design/icons";
import { Tag } from "antd";
import { Shell } from "./RichNodes";
import { NODE_SUBTEXT } from "./nodeStatus";
import { useT } from "@/lib/i18n/useT";

/** 引擎展示名(闭合;作业行的 type / engine 字面 ⇒ 人话)。 */
export function jobEngineLabel(engine: unknown): string {
  switch (String(engine ?? "")) {
    case "glue": return "Glue";
    case "redshift": return "Redshift";
    case "emr":
    case "emr-serverless": return "EMR Serverless";
    default: return String(engine ?? "");
  }
}

export const JobNode = memo(function JobNode({ data }: NodeProps) {
  const t = useT();
  const ref = (data?.jobRef ?? null) as { kind?: string; jobId?: string } | null;
  const linked = Boolean(ref?.jobId);
  const missing = Boolean(data?.jobMissing);
  const name = typeof data?.jobName === "string" && data.jobName ? data.jobName : ref?.jobId || "";
  const engine = jobEngineLabel(data?.jobEngine);
  return (
    <Shell
      testId="dag-node-job"
      data={data}
      icon={<CodeOutlined style={{ color: "#2dd4bf" }} />}
      title={t("离线作业")}
      sub={
        linked && !missing ? (
          <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2, display: "flex", alignItems: "center", gap: 4, maxWidth: 220 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="dag-node-job-name">{name}</span>
            {engine ? <Tag style={{ fontSize: 10, lineHeight: "14px", margin: 0 }} data-testid="dag-node-job-engine">{engine}</Tag> : null}
          </div>
        ) : (
          <div style={{ fontSize: 10, color: "#e8a23d", marginTop: 2 }} data-testid="dag-node-job-warning">
            {linked ? t("作业不存在或不再绑定本工作流的执行区") : t("未关联离线作业")}
          </div>
        )
      }
    />
  );
});
