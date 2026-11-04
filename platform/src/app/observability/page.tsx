"use client";

import React, { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Tag, Table, Spin, Empty, Button, Space, Typography, Alert } from "antd";
import { DashboardOutlined, ReloadOutlined, ApiOutlined, RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Donut, TrendArea, type Slice } from "@/components/dashboard/charts";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4ter-coverage
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

const { Title, Paragraph, Text } = Typography;

const statusColor = (s?: string) => {
  const v = (s || "").toUpperCase();
  if (["READY", "ACTIVE", "AVAILABLE", "CREATE_COMPLETE", "UPDATE_COMPLETE"].some((k) => v.includes(k))) return "green";
  if (["CREATING", "UPDATING", "PENDING"].some((k) => v.includes(k))) return "blue";
  if (!v) return "default";
  return "orange";
};

export default function ObservabilityPage() {
  const { getToken, user, loading: authLoading } = useAuth();
  const t = useT();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-6)
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";

  const load = async () => {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
      const res = await fetch(`/api/observability/genbi${scopeQs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
      const d = await res.json();
      setData(d?.success ? d.data : null);
    } finally { setLoading(false); }
  };

  // @kf-batch 50-WP4ter-coverage —— `scopeQs` 进 deps:切区不重载页面,靠这里重拉(护栏 4)
  useEffect(() => { if (!authLoading && user) load(); /* eslint-disable-next-line */ }, [authLoading, user, scopeQs]);

  const ac = data?.agentcore;
  const g = data?.genbi;
  const lm = data?.lambda;

  const engineSlices: Slice[] = g ? Object.entries(g.byEngine || {}).map(([k, v]: any, i) => ({
    label: k === "athena" ? t("数据湖(Athena)") : t("数据仓库(Redshift)"), value: v as number, color: ["#22d3ee", "#e0a23c", "#2dd4bf"][i % 3],
  })) : [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Title level={3} style={{ marginBottom: 0 }}><DashboardOutlined /> {t("可观测看板 · GenBI / AgentCore")}</Title>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>{t("刷新")}</Button>
      </div>
      <Paragraph type="secondary">
        {t("智能问数(GenBI)运行在 Amazon Bedrock AgentCore 之上的可观测视图：Runtime/Gateway 状态与 MCP 工具、用量分析(问数量 / token / 引擎)、技能 Lambda 的 CloudWatch 指标。")}
      </Paragraph>

      {loading && !data ? <Spin size="large" style={{ display: "block", margin: "60px auto" }} /> : !data ? (
        <Card><Empty description={t("暂无可观测数据")} /></Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {/* AgentCore 状态 */}
          <Card size="small" title={<span><RobotOutlined /> {t("AgentCore 运行时状态")}</span>}>
            <Space size="large" wrap>
              <div><div style={{ color: "#8fb0c2", fontSize: 12 }}>{t("后端模式")}</div><Tag color={ac?.backend === "agentcore" ? "cyan" : "default"}>{ac?.backend === "agentcore" ? "AgentCore" : t("进程内(inprocess)")}</Tag></div>
              <div><div style={{ color: "#8fb0c2", fontSize: 12 }}>{t("记忆后端")}</div><Tag color={ac?.memoryBackend === "agentcore" ? "geekblue" : "default"}>{ac?.memoryBackend === "agentcore" ? `${t("AgentCore 托管")}${ac?.memoryConfigured ? "" : t("(未配置ID)")}` : t("自管(DynamoDB+S3)")}</Tag></div>
              <div><div style={{ color: "#8fb0c2", fontSize: 12 }}>Runtime</div>
                {ac?.runtime ? <Tag color={statusColor(ac.runtime.status)}>{ac.runtime.name} · {ac.runtime.status}{ac.runtime.version ? ` · v${ac.runtime.version}` : ""}</Tag> : <Tag color="default">{ac?.runtimeError ? t("查询失败") : t("未发现")}</Tag>}
              </div>
              <div><div style={{ color: "#8fb0c2", fontSize: 12 }}>Gateway(MCP)</div>
                {ac?.gateway ? <Tag color={statusColor(ac.gateway.status)}>{ac.gateway.name} · {ac.gateway.status} · {ac.gateway.authorizer}</Tag> : <Tag color="default">{ac?.gatewayError ? t("查询失败") : t("未发现")}</Tag>}
              </div>
            </Space>
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t("MCP 技能工具：")}</Text>
              <Space wrap style={{ marginLeft: 8 }}>
                {(ac?.tools || []).map((tool: string) => <Tag key={tool} color="purple"><ApiOutlined /> {tool}</Tag>)}
              </Space>
              {ac?.targets?.length > 0 && <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{t("目标：")}{ac.targets.map((x: any) => `${x.name}(${x.status})`).join(t("、"))}</Text>}
            </div>
          </Card>

          {/* GenBI 用量 KPI */}
          <Row gutter={16}>
            <Col span={6}><Card size="small"><Statistic title={t("累计问数")} value={g?.total ?? 0} suffix={t("次")} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title={t("今日问数")} value={g?.today ?? 0} suffix={t("次")} valueStyle={{ color: "#22d3ee" }} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title={t("累计 Tokens (已记录 in/out)")} value={`${g?.inputTokens ?? 0}/${g?.outputTokens ?? 0}`} /><div style={{ color: "#8fb0c2", fontSize: 12 }}>{t("已记录 {tracked}/{total} 条（v1.25.0 起记录 token）", { tracked: g?.tokenTracked ?? 0, total: g?.total ?? 0 })}</div></Card></Col>
            <Col span={6}><Card size="small"><Statistic title={t("平均返回行数")} value={g?.avgRows ?? 0} suffix={t("行")} /></Card></Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Card size="small" title={t("引擎分布")}><Donut data={engineSlices} /></Card>
            </Col>
            <Col span={8}>
              <Card size="small" title={t("近 7 日问数趋势")}>
                {g?.trend?.length ? <TrendArea points={g.trend.map((pt: any) => ({ label: pt.date.slice(5), value: pt.count }))} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无趋势")} />}
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small" title={<span><ThunderboltOutlined /> {t("技能 Lambda 指标 (24h)")}</span>}>
                <Space size="large" wrap>
                  <Statistic title={t("调用次数")} value={lm?.invocations ?? 0} />
                  <Statistic title={t("错误数")} value={lm?.errors ?? 0} valueStyle={{ color: (lm?.errors ?? 0) > 0 ? "#f5577a" : undefined }} />
                  <Statistic title={t("平均耗时")} value={lm?.avgDurationMs ?? 0} suffix="ms" />
                </Space>
                <div style={{ marginTop: 8, color: "#8fb0c2", fontSize: 12 }}>{t("来源 CloudWatch · AWS/Lambda · bgp-genbi-skills")}</div>
              </Card>
            </Col>
          </Row>

          {/* 技能调用计数 (24h) — AgentCore Lambda EMF + 进程内后端历史 合并 */}
          <Card size="small" title={<span><ApiOutlined /> {t("技能调用计数 (24h · AgentCore EMF + 进程内)")}</span>}>
            <Row gutter={16}>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("内置 MCP 工具")}</Text>
                <Table size="small" rowKey="tool" pagination={false} style={{ marginTop: 6 }}
                  dataSource={data?.toolCalls?.perTool || []}
                  locale={{ emptyText: t("暂无调用") }}
                  columns={[
                    { title: t("工具"), dataIndex: "tool", render: (v: string) => <Tag color="purple"><ApiOutlined /> {v}</Tag> },
                    { title: t("调用"), dataIndex: "calls", width: 130, render: (v: number, r: any) => (
                      <span><b>{v ?? 0}</b>{(r?.inprocessCalls > 0 || r?.emfCalls > 0) && <Text type="secondary" style={{ fontSize: 11 }}>{`  (EMF ${r?.emfCalls ?? 0} · ${t("进程内")} ${r?.inprocessCalls ?? 0})`}</Text>}</span>
                    ) },
                    { title: t("错误"), dataIndex: "errors", width: 70, render: (v: number) => v > 0 ? <Text type="danger">{v}</Text> : (v ?? 0) },
                  ]} />
              </Col>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t("注册技能(run_registered_skill 细分)")}</Text>
                <Table size="small" rowKey="skill" pagination={false} style={{ marginTop: 6 }}
                  dataSource={data?.toolCalls?.perSkill || []}
                  locale={{ emptyText: t("暂无注册技能调用") }}
                  columns={[
                    { title: t("技能"), dataIndex: "skill", render: (v: string) => <Tag color="cyan"><ThunderboltOutlined /> {v}</Tag> },
                    { title: t("调用"), dataIndex: "calls", width: 80, render: (v: number) => <b>{v ?? 0}</b> },
                    { title: t("错误"), dataIndex: "errors", width: 80, render: (v: number) => v > 0 ? <Text type="danger">{v}</Text> : (v ?? 0) },
                  ]} />
              </Col>
            </Row>
            <div style={{ marginTop: 8, color: "#8fb0c2", fontSize: 12 }}>{t("来源合并:AgentCore 路径经 Lambda EMF(CloudWatch·BGP/GenBI)+ 进程内后端经问数历史 toolCalls。两条执行路径的工具调用都计入,消除进程内盲区。")}</div>
          </Card>

          {/* 最近调用 */}
          <Card size="small" title={t("最近问数调用")}>
            <Table size="small" rowKey={(_, i) => String(i)} pagination={{ pageSize: 10 }} dataSource={g?.recent || []}
              locale={{ emptyText: t("暂无调用记录") }}
              columns={[
                { title: t("问题"), dataIndex: "question", ellipsis: true },
                { title: t("引擎"), dataIndex: "engine", width: 110, render: (v: string) => <Tag color={v === "athena" ? "gold" : "cyan"}>{v === "athena" ? t("数据湖") : t("数据仓库")}</Tag> },
                { title: t("后端"), dataIndex: "backend", width: 110, render: (v: string) => <Tag color={v === "agentcore" ? "purple" : "default"}>{v}</Tag> },
                { title: t("行数"), dataIndex: "rowCount", width: 70 },
                { title: "Tokens(in/out)", key: "tok", width: 130, render: (_: any, r: any) => `${r.inputTokens ?? "—"}/${r.outputTokens ?? "—"}` },
                { title: t("时间"), dataIndex: "createdAt", width: 170, render: (v: string) => v ? v.slice(0, 19).replace("T", " ") : "-" },
              ]} />
          </Card>

          <Text type="secondary" style={{ fontSize: 12 }}>{t("生成于")} {data.generatedAt?.slice(0, 19).replace("T", " ")}</Text>
        </Space>
      )}
    </div>
  );
}
