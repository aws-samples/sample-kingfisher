"use client";

import React, { useEffect, useState } from "react";
import { Card, Button, Space, Spin, Alert, Descriptions, Tag, Row, Col } from "antd";
import { LinkOutlined, CheckCircleOutlined, DatabaseOutlined, ApartmentOutlined, SearchOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-9)。🔴🔴 用户 2026-09-10 拍板「治理目录必须走
// 同一个 OpenMetadata」⇒ 「哪个区」= OM 的 **service 维度**(`bgp-*-<targetSlug>`,主控区不加后缀)。
// 所以这一页按区要做的不是换实例,而是把**该区对应的那几个 service** 直接指出来并可点进去。
import { useScope } from "@/components/scope/ScopeProvider";
import { omServiceFor } from "@/lib/openmetadata/om-service";

export default function OpenMetadataPage() {
  const t = useT();
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // @kf-batch 50-WP4ter-coverage —— 当前范围决定「列哪几个区的 service」
  const { scope, targets } = useScope();
  const scopedTargets =
    scope.kind === "target"
      ? [scope.targetId]
      : scope.kind === "compare"
        ? scope.targetIds
        : (targets ?? []).map((x) => x.targetId);
  const regionOf = (tid: string) => targets?.find((x) => x.targetId === tid)?.region || tid;

  useEffect(() => {
    fetch("/api/openmetadata/url").then((r) => r.json()).then(setStatus).finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  const isUp = !!status?.version;
  // Access OM via its own CloudFront domain
  const omBase = status?.url || "";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>{t("数据治理中心")}</h2>
        {isUp && (
          <Button type="primary" size="large" icon={<LinkOutlined />} onClick={() => window.open(omBase, "_blank")}>
            {t("打开 OpenMetadata 控制台")}
          </Button>
        )}
      </div>

      {!isUp ? (
        <Alert type="warning" message={t("OpenMetadata 服务未就绪")} description={typeof status?.error === "string" ? status.error : (status?.error?.message || t("请检查部署状态"))} showIcon />
      ) : (
        <>
          <Card style={{ marginBottom: 24 }}>
            <Descriptions column={3}>
              <Descriptions.Item label={t("状态")}><Tag icon={<CheckCircleOutlined />} color="success">{t("运行中")}</Tag></Descriptions.Item>
              <Descriptions.Item label={t("版本")}>{status.version}</Descriptions.Item>
              <Descriptions.Item label={t("访问地址")}><a href={omBase} target="_blank">{window.location.origin}/om</a></Descriptions.Item>
            </Descriptions>
          </Card>

          <Row gutter={16}>
            <Col span={8}>
              <Card hoverable onClick={() => window.open(`${omBase}/explore/tables`, "_blank")}>
                <Card.Meta avatar={<DatabaseOutlined style={{ fontSize: 32, color: "#1677ff" }} />}
                  title={t("数据目录")} description={t("浏览所有数据资产、表、主题、仪表板")} />
              </Card>
            </Col>
            <Col span={8}>
              <Card hoverable onClick={() => window.open(`${omBase}/lineage`, "_blank")}>
                <Card.Meta avatar={<ApartmentOutlined style={{ fontSize: 32, color: "#52c41a" }} />}
                  title={t("数据血缘")} description={t("查看表级和列级血缘关系")} />
              </Card>
            </Col>
            <Col span={8}>
              <Card hoverable onClick={() => window.open(`${omBase}/data-quality`, "_blank")}>
                <Card.Meta avatar={<SearchOutlined style={{ fontSize: 32, color: "#faad14" }} />}
                  title={t("数据质量")} description={t("配置和查看数据质量规则与测试结果")} />
              </Card>
            </Col>
          </Row>

          {/* @kf-batch 50-WP4ter-coverage —— 按区的入口:OM 是同一个实例,区的差别在 service 名上。
              🔴 不显示表数:那要查 OM 才知道,而这一页只负责导航;目录页(/governance)才是看表的地方
              (那边已经带新鲜度,且刻意不用 facet 的 tables —— 实测它只统计定时来源,会显示 0)。 */}
          <Card title={t("按执行范围的 OpenMetadata 服务")} style={{ marginTop: 24 }} data-testid="om-services-by-scope">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={t("同一个 OpenMetadata 实例服务所有区域;「哪个区」体现在服务名后缀上(主控区沿用不带后缀的原名,存量资产零迁移)。")}
            />
            <Space direction="vertical" style={{ width: "100%" }}>
              {scopedTargets.length === 0 ? (
                <span style={{ color: "#90a4c0" }}>{t("没有可显示的执行环境")}</span>
              ) : (
                scopedTargets.map((tid) => (
                  <Space key={tid} wrap>
                    <Tag color="blue">{regionOf(tid)}</Tag>
                    {(["redshift", "glue"] as const).map((kind) => {
                      const svc = omServiceFor(kind, tid);
                      return (
                        <Button
                          key={kind}
                          size="small"
                          data-testid={`om-service-link-${svc}`}
                          onClick={() => window.open(`${omBase}/service/databaseServices/${encodeURIComponent(svc)}`, "_blank")}
                        >
                          {svc}
                        </Button>
                      );
                    })}
                  </Space>
                ))
              )}
            </Space>
          </Card>

          <Card title={t("快速入口")} style={{ marginTop: 24 }}>
            <Space wrap>
              <Button onClick={() => window.open(`${omBase}/settings/services/databases`, "_blank")}>{t("配置数据库服务")}</Button>
              <Button onClick={() => window.open(`${omBase}/settings/services/pipelines`, "_blank")}>{t("配置管道服务")}</Button>
              <Button onClick={() => window.open(`${omBase}/glossary`, "_blank")}>{t("术语表")}</Button>
              <Button onClick={() => window.open(`${omBase}/tags`, "_blank")}>{t("标签管理")}</Button>
              <Button onClick={() => window.open(`${omBase}/settings`, "_blank")}>{t("系统设置")}</Button>
            </Space>
          </Card>
        </>
      )}
    </div>
  );
}
