"use client";

// 模块 14 — 通用「版本历史」抽屉：列出某资源的版本，支持查看快照与一键回滚。
// 用法：<VersionHistoryDrawer type="workflow" id={id} open={open} onClose={...} onRolledBack={refetch} />

import React, { useCallback, useEffect, useState } from "react";
import { Drawer, Table, Button, Tag, message, Popconfirm, Modal, Empty } from "antd";
import { HistoryOutlined, RollbackOutlined, EyeOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";

interface VersionRow {
  version: number;
  versionedAt: string;
  versionedBy: string;
  note: string;
  name: string;
}

export default function VersionHistoryDrawer({
  type,
  id,
  open,
  onClose,
  onRolledBack,
}: {
  type: "workflow" | "etl-job" | "sync" | "redshift-task" | "engine-job";
  id: string;
  open: boolean;
  onClose: () => void;
  onRolledBack?: () => void;
}) {
  const t = useT();
  const [rows, setRows] = useState<VersionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<{ version: number; config: any } | null>(null);

  const fetchVersions = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/versions?type=${type}&id=${id}`);
      const d = await res.json();
      setRows(d?.success ? d.data : []);
    } finally {
      setLoading(false);
    }
  }, [type, id]);

  useEffect(() => {
    if (open) fetchVersions();
  }, [open, fetchVersions]);

  const handleView = async (version: number) => {
    const res = await fetch(`/api/versions?type=${type}&id=${id}&version=${version}`);
    const d = await res.json();
    if (d?.success) setViewing({ version, config: d.data.config });
    else message.error(d?.error?.message || t("加载失败"));
  };

  const handleRollback = async (version: number) => {
    const res = await fetch(`/api/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id, version }),
    });
    const d = await res.json();
    if (d?.success) {
      message.success(t("已回滚到 v{version}", { version }));
      fetchVersions();
      onRolledBack?.();
    } else {
      message.error(d?.error?.message || t("回滚失败"));
    }
  };

  const columns = [
    { title: t("版本"), dataIndex: "version", width: 70, render: (v: number) => <Tag color="blue">v{v}</Tag> },
    { title: t("时间"), dataIndex: "versionedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
    { title: t("操作人"), dataIndex: "versionedBy", width: 110 },
    { title: t("说明"), dataIndex: "note", ellipsis: true },
    {
      title: t("操作"),
      key: "act",
      width: 150,
      render: (_: any, r: VersionRow) => (
        <>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(r.version)}>
            {t("查看")}
          </Button>
          <Popconfirm
            title={t("回滚到 v{version}？", { version: r.version })}
            description={t("当前内容会先自动存为新版本，可再回滚撤销。")}
            onConfirm={() => handleRollback(r.version)}
          >
            <Button type="link" size="small" danger icon={<RollbackOutlined />}>
              {t("回滚")}
            </Button>
          </Popconfirm>
        </>
      ),
    },
  ];

  return (
    <Drawer
      title={
        <span>
          <HistoryOutlined /> {t("版本历史")}
        </span>
      }
      width={620}
      open={open}
      onClose={onClose}
    >
      {rows.length === 0 && !loading ? (
        <Empty description={t("暂无版本（保存或创建后生成）")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Table size="small" rowKey="version" loading={loading} columns={columns} dataSource={rows} pagination={{ pageSize: 10 }} />
      )}

      <Modal
        title={viewing ? t("版本 v{version} 配置快照", { version: viewing.version }) : ""}
        open={!!viewing}
        onCancel={() => setViewing(null)}
        footer={null}
        width={720}
      >
        <pre style={{ maxHeight: 480, overflow: "auto", background: "#0d1117", color: "#c9d1d9", padding: 12, borderRadius: 6, fontSize: 12 }}>
          {viewing ? JSON.stringify(viewing.config, null, 2) : ""}
        </pre>
      </Modal>
    </Drawer>
  );
}
