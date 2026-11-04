"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Card, Table, Tag, Space, Button, Input, Select, Typography, message } from "antd";
import { ReloadOutlined, SearchOutlined, FileSearchOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// 执行范围。审计条目现在带 `targetId`
// (`lib/audit.ts`:exec-env 类由 resourceId 派生,数据面动作由调用方显式传)。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import { Alert } from "antd";

const { Text } = Typography;

// Color-code the action by its resource family (prefix before the dot).
const actionColor = (action: string): string => {
  const family = (action || "").split(".")[0];
  return (
    {
      datasource: "blue",
      sync: "green",
      workflow: "purple",
    } as Record<string, string>
  )[family] || "default";
};

interface AuditRow {
  ts: string;
  timestamp?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  /** 这次动作作用在哪个执行环境(存量条目没有,视图上按主控区算) */
  targetId?: string;
  detail?: any;
  method?: string;
  path?: string;
}

export default function AuditPage() {
  const t = useT();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");

  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeAmp = scopeParam ? `&scope=${encodeURIComponent(scopeParam)}` : "";
  const regionOf = (tid?: string) => (tid ? scopeTargets?.find((x) => x.targetId === tid)?.region || tid : "");

  const fetchData = () => {
    setLoading(true);
    fetch(`/api/audit?limit=500${scopeAmp}`)
      .then((r) => r.json())
      .then((res) => setRows(Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []))
      .catch(() => message.error(t("加载审计日志失败")))
      .finally(() => setLoading(false));
  };

  // 切区不重载页面,靠 deps 重拉(护栏 4)
  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeAmp]);

  // Distinct action values for the filter dropdown.
  const actionOptions = useMemo(() => {
    const set = Array.from(new Set(rows.map((r) => r.action).filter(Boolean))) as string[];
    return set.sort().map((a) => ({ label: a, value: a }));
  }, [rows]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionFilter && r.action !== actionFilter) return false;
      if (!kw) return true;
      return [r.actor, r.action, r.resourceType, r.resourceId, r.path]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(kw));
    });
  }, [rows, keyword, actionFilter]);

  return (
    <div>
      {/* 如实说明存量条目的口径:落章之前的动作没有区维,
          按「控制面在主控区」归主控区。不说清 = 用户会以为主控区的条目莫名其妙变多了。 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        data-testid="audit-stamp-notice"
        message={t("审计条目自 2026-09-10 起带执行环境标记(执行环境类动作按其 targetId,数据面动作按真实落点)。此前的存量条目没有该标记,按「控制面在主控区」归主控区显示。")}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <FileSearchOutlined style={{ fontSize: 20 }} />
          <h2 style={{ margin: 0 }}>{t("操作审计日志")}</h2>
          <Text type="secondary">{t("记录谁在什么时间创建/修改/删除/运行了资源")}</Text>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
          {t("刷新")}
        </Button>
      </div>

      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Input
            allowClear
            data-testid="audit-search"
            prefix={<SearchOutlined />}
            placeholder={t("搜索 操作者 / 操作 / 资源 / 路径")}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 320 }}
          />
          <Select
            allowClear
            placeholder={t("按操作类型过滤")}
            style={{ width: 220 }}
            value={actionFilter || undefined}
            onChange={(v) => setActionFilter(v || "")}
            options={actionOptions}
          />
          <Text type="secondary">{t("共 {n} 条", { n: filtered.length })}</Text>
        </Space>

        <Table
          size="small"
          loading={loading}
          dataSource={filtered}
          rowKey="ts"
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t("共 {n} 条", { n: total }) }}
          locale={{ emptyText: t("暂无审计记录") }}
          columns={[
            // 「在哪个区做的」必须在列表里看得见,
            // 否则按区过滤了却看不出依据,用户无法判断过滤对不对
            {
              title: t("执行环境"),
              dataIndex: "targetId",
              width: 130,
              render: (v?: string) =>
                v ? <Tag color="blue">{regionOf(v)}</Tag> : <Tag>{t("主控区(未盖章)")}</Tag>,
            },
            {
              title: t("时间"),
              dataIndex: "timestamp",
              width: 180,
              defaultSortOrder: "descend",
              sorter: (a, b) => (a.timestamp || a.ts).localeCompare(b.timestamp || b.ts),
              render: (v: string, r) => (v || r.ts || "").slice(0, 19).replace("T", " "),
            },
            {
              title: t("操作者"),
              dataIndex: "actor",
              width: 200,
              ellipsis: true,
              render: (v: string) => v || "-",
            },
            {
              title: t("操作"),
              dataIndex: "action",
              width: 170,
              render: (v: string) => (v ? <Tag color={actionColor(v)}>{v}</Tag> : "-"),
            },
            {
              title: t("资源"),
              dataIndex: "resourceType",
              width: 220,
              render: (v: string, r) => (
                <span>
                  {v ? <Tag>{v}</Tag> : null}
                  {r.resourceId ? <code style={{ fontSize: 11 }}>{r.resourceId.slice(-14)}</code> : null}
                </span>
              ),
            },
            {
              title: t("请求"),
              dataIndex: "path",
              ellipsis: true,
              render: (v: string, r) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {r.method} {v}
                </Text>
              ),
            },
            {
              title: t("详情"),
              dataIndex: "detail",
              width: 260,
              ellipsis: true,
              render: (v: any) =>
                v === undefined || v === null ? (
                  "-"
                ) : (
                  <Text style={{ fontSize: 12 }} title={typeof v === "string" ? v : JSON.stringify(v)}>
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </Text>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
