"use client";

import React, { useEffect, useState } from "react";
import { Card, Descriptions, Tag, Button, Space, Spin, Popconfirm, Table, message } from "antd";
import { SettingOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";

/** 平台为数据源自建的安全组一行(与 /api/admin/datasource-network-objects 的应答同形) */
type NetObjectRow = {
  sgId: string; groupName: string; region: string; targetId: string; vpcId?: string; tagged: boolean; taggedDatasourceId?: string;
  owner: { datasourceId: string; name: string; role: string } | null;
  status: "in-use" | "orphan" | "pending-cleanup" | "needs-manual";
  eniCount?: number;
  cleanupJob?: { jobId: string; phase: string; createdAt: string; lastError?: string };
};
type NetObjectsView = { generatedAt: string; objects: NetObjectRow[]; unreadableRegions: Array<{ targetId: string; region: string; error: string }> };
// 「AI 模型」卡(51 INTERACTION §2/§3;不新建页面、routes.tsx 零改)。
import AiModelCard from "@/components/settings/AiModelCard";
import BuildInfoCard from "@/components/common/BuildInfo"; // 平台版本(发版 tag / 产品提交)
import LakeRoutesCard from "@/components/lake/LakeRoutesCard"; // 数据湖表桶与路由卡(唯一作者;内含表桶下拉)
// 执行范围。🔴🔴 原来这一页声明「不受执行范围影响」,
// 却把主控区的工作组 / 桶 / VPC 当「平台配置」给所有区看 —— 那是本平台唯一一处明确否认自己与区
// 有关的撒谎。现在逐项显示**当前执行范围那个区自己的**资源,并把真正与区无关的项单独标出来。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { Alert } from "antd";

export default function SettingsPage() {
  const t = useT();
  const [config, setConfig] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [wiring, setWiring] = useState<any>(null);
  // 后台清理任务(平台自建安全组按网卡事实收口;平台管理员可见;全平台清单,不按区拆)
  const [cleanups, setCleanups] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";

  const fetchConfig = async () => {
    const res = await fetch(`/api/settings${scopeQs}`);
    const d = await res.json();
    setConfig(d.success ? d.data : d);
  };

  // 数据湖表桶与路由(该执行环境):读写都在 components/lake/LakeRoutesCard 里,这里只给它落点与身份。
  const lakeTargetId = landingOfScope(scope);
  const { getToken } = useAuth();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => { (async () => { try { setIsPlatformAdmin(groupsFromToken(await getToken()).includes("bgp-admin")); } catch { /* 忽略 */ } })(); }, [getToken]);

  const loadCleanups = async () => {
    try {
      const res = await fetch("/api/admin/pending-cleanups");
      const d = await res.json();
      setCleanups(res.ok && d.success ? (d.data?.jobs ?? []) : []);
    } catch { setCleanups([]); }
  };
  // 数据源网络对象清单(全平台;孤儿一键清理走该缺陷的持久清理作业)
  const [netObjects, setNetObjects] = useState<NetObjectsView | null>(null);
  const [netObjectsError, setNetObjectsError] = useState<string>("");
  const [netCleanupBusy, setNetCleanupBusy] = useState<string>("");
  const loadNetObjects = async () => {
    try {
      const res = await fetch("/api/admin/datasource-network-objects");
      const d = await res.json();
      if (res.ok && d.success) { setNetObjects(d.data); setNetObjectsError(""); }
      else { setNetObjects({ generatedAt: "", objects: [], unreadableRegions: [] }); setNetObjectsError(d?.error?.message || d?.error || `HTTP ${res.status}`); }
    } catch (e) { setNetObjects({ generatedAt: "", objects: [], unreadableRegions: [] }); setNetObjectsError(String((e as Error)?.message || e)); }
  };
  const requestNetCleanup = async (row: NetObjectRow) => {
    setNetCleanupBusy(row.sgId);
    try {
      const res = await fetch("/api/admin/datasource-network-objects/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sgId: row.sgId, region: row.region, targetId: row.targetId }) });
      const d = await res.json();
      if (res.ok && d.success) message.success(t("已交给后台清理任务(网卡为 0 时删除):{id}", { id: row.sgId }));
      else message.error(d?.error?.message || d?.error || `HTTP ${res.status}`);
      await Promise.all([loadNetObjects(), loadCleanups()]);
    } catch (e) { message.error(String((e as Error)?.message || e)); }
    finally { setNetCleanupBusy(""); }
  };

  const checkHealth = async () => {
    setLoading(true);
    const checks: Record<string, any> = {};

    try {
      const res = await fetch("/api/datasources");
      checks.dynamodb = { status: res.ok ? "ok" : "error", message: res.ok ? t("正常") : `HTTP ${res.status}` };
    } catch (e: any) { checks.dynamodb = { status: "error", message: e.message }; }

    try {
      // 按当前执行范围查那个区的工作组(缺省 = 主控区)
      const res = await fetch(`/api/redshift/connections?targetId=${encodeURIComponent(landingOfScope(scope))}`);
      const d = await res.json();
      const list = Array.isArray(d) ? d : d.data || [];
      checks.redshift = { status: list.length > 0 ? "ok" : "warning", message: t("{n} 个 Workgroup", { n: list.length }) };
    } catch (e: any) { checks.redshift = { status: "error", message: e.message }; }

    try {
      const res = await fetch("/api/s3/buckets");
      const d = await res.json();
      const buckets = d.success ? d.data : d;
      checks.s3 = { status: "ok", message: t("{n} 个 Bucket", { n: Array.isArray(buckets) ? buckets.length : 0 }) };
    } catch (e: any) { checks.s3 = { status: "error", message: e.message }; }

    try {
      const res = await fetch("/api/admin/users");
      const d = await res.json();
      const users = d.success ? d.data : [];
      checks.cognito = { status: users.length > 0 ? "ok" : "warning", message: users.length > 0 ? t("{n} 个用户", { n: users.length }) : t("已配置") };
    } catch { checks.cognito = { status: "warning", message: t("检查中...") }; }

    setHealth(checks);

    // AI 接线健康(防回归可观测层):OM 可达 + 三个 AI 能力是否真接到 AgentCore。
    try {
      const res = await fetch("/api/system/wiring");
      const d = await res.json();
      setWiring(d.success ? d.data : null);
    } catch { setWiring(null); }

    setLoading(false);
  };

  // 切区不重载页面,靠 deps 重拉(护栏 4)
  useEffect(() => { fetchConfig(); checkHealth(); /* eslint-disable-next-line */ }, [scopeQs]);
  useEffect(() => { if (isPlatformAdmin) { loadCleanups(); loadNetObjects(); } /* eslint-disable-next-line */ }, [isPlatformAdmin]);

  const statusIcon = (s: string) => s === "ok" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> : s === "warning" ? <WarningOutlined style={{ color: "#faad14" }} /> : <CloseCircleOutlined style={{ color: "#ff4d4f" }} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}><SettingOutlined /> {t("系统设置")}</h2>
        <Button icon={<ReloadOutlined />} onClick={checkHealth} loading={loading}>{t("刷新状态")}</Button>
      </div>

      {/* 标题与提示条都必须点名「这是哪个区的」*/}
      <Card
        title={
          config
            ? `${t("执行环境资源")} · ${config.displayName || config.targetId}${config.region ? ` (${config.region})` : ""}`
            : t("执行环境资源")
        }
        size="small"
        style={{ marginBottom: 16 }}
        data-testid="settings-target-resources"
      >
        {config ? (
          <>
            {!config.valuesAreForSingleTarget && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                data-testid="settings-global-view-notice"
                message={t("当前执行范围是「全部」,下面显示的是主控区的资源。要看某个区自己的桶 / 工作组 / VPC,请在顶栏选中那个区。")}
              />
            )}
            {config.valuesFrom === "unavailable" && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                data-testid="settings-values-unavailable"
                message={t("读不到这个执行环境的资源清单(描述符缺失或尚未初始化完成)—— 这里不会拿主控区的值顶上。")}
              />
            )}
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="AWS Region">{config.region}</Descriptions.Item>
              <Descriptions.Item label={t("已装组件")}>
                {Array.isArray(config.components) && config.components.length > 0 ? config.components.join(" · ") : t("未知")}
              </Descriptions.Item>
              <Descriptions.Item label="Redshift Workgroup">
                {config.warehouseInstalled === false ? t("该区未部署数据仓库") : config.redshiftWorkgroup}
              </Descriptions.Item>
              <Descriptions.Item label={t("Redshift 数据库")}>{config.redshiftDatabase}</Descriptions.Item>
              <Descriptions.Item label={t("Glue 脚本 Bucket")}>{config.glueScriptsBucket}</Descriptions.Item>
              <Descriptions.Item label="Glue IAM Role">{config.glueRoleArn?.split("/").pop()}</Descriptions.Item>
              <Descriptions.Item label={t("数据湖 Bucket")}>{config.datalakeBucket}</Descriptions.Item>
              <Descriptions.Item label="S3 Tables Bucket">{config.tableBucket}</Descriptions.Item>
              <Descriptions.Item label="Athena Workgroup">{config.athenaWorkgroup}</Descriptions.Item>
              <Descriptions.Item label="MWAA DAG Bucket">{config.mwaaDagBucket}</Descriptions.Item>
              <Descriptions.Item label={t("VPC")}>{config.defaultVpcId}</Descriptions.Item>
              <Descriptions.Item label={t("取值来源")}>
                <Tag color={config.valuesFrom === "descriptor" ? "green" : config.valuesFrom === "env" ? "gold" : "red"}>
                  {config.valuesFrom === "descriptor"
                    ? t("该执行环境的资源清单")
                    : config.valuesFrom === "env"
                      ? t("主控区进程环境(描述符暂时读不到)")
                      : t("读不到")}
                </Tag>
              </Descriptions.Item>
            </Descriptions>
          </>
        ) : <Spin />}
      </Card>

      {/* 数据湖表桶与路由(该执行环境):客户自有的 S3 Tables 表桶登记为**路由**(别名 / 分层 /
          命名空间归属 / 可写),作业按别名注入 Spark 目录、同步可写入、直查 / 目录 / 问数可见;卡片实现在 components/lake/LakeRoutesCard
          (id 锚点供向导里的「去登记 →」直达) */}
      <Card id="lake-ext-buckets" size="small" style={{ marginBottom: 16 }}>
        <LakeRoutesCard targetId={lakeTargetId} displayName={config?.displayName} region={config?.region} isPlatformAdmin={isPlatformAdmin} />
      </Card>

      {/* 真正与区无关的那一项单独一张卡:混在上面会让用户以为它也是「这个区的」*/}
      <Card title={t("全局身份(与执行范围无关)")} size="small" style={{ marginBottom: 16 }}>
        {config ? (
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Cognito User Pool">{config.cognitoUserPoolId}</Descriptions.Item>
          </Descriptions>
        ) : <Spin />}
      </Card>

      <Card title={t("服务状态")} size="small">
        {health ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            {[
              { key: "dynamodb", label: "DynamoDB", desc: t("元数据存储") },
              { key: "redshift", label: "Redshift Serverless", desc: t("数据仓库") },
              { key: "s3", label: "S3", desc: t("数据湖存储") },
              { key: "cognito", label: "Cognito", desc: t("用户认证") },
            ].map((svc) => (
              <div key={svc.key} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", border: "1px solid #1d4254", borderRadius: 6 }}>
                <Space>
                  {statusIcon(health[svc.key]?.status)}
                  <div>
                    <div style={{ fontWeight: 500 }}>{svc.label}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>{svc.desc}</div>
                  </div>
                </Space>
                <Tag color={health[svc.key]?.status === "ok" ? "green" : health[svc.key]?.status === "warning" ? "orange" : "red"}>
                  {health[svc.key]?.message}
                </Tag>
              </div>
            ))}
          </Space>
        ) : <Spin />}
      </Card>

      {/* 后台清理任务:平台自建安全组按网卡事实收口;failed = 30 分钟仍被占用 ⇒ 需人工 */}
      {isPlatformAdmin && (
        <Card title={t("后台清理任务")} size="small" style={{ marginTop: 16 }} data-testid="pending-cleanups-card"
          extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadCleanups}>{t("刷新")}</Button>}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{t("平台自建的安全组在网卡释放后自动删除;「failed」= 30 分钟内仍被占用,需人工确认网卡释放后删除该组")}</div>
          <Table size="small" rowKey="jobId" pagination={false} dataSource={cleanups ?? []} loading={cleanups === null}
            locale={{ emptyText: t("没有待处理的清理任务") }}
            columns={[
              { title: t("安全组"), key: "sg", render: (_: unknown, r: any) => r.evidence?.sgId || "-" },
              { title: t("区域"), key: "region", render: (_: unknown, r: any) => r.evidence?.region || "-" },
              { title: t("数据源"), key: "ds", render: (_: unknown, r: any) => r.evidence?.datasourceId || "-" },
              { title: t("阶段"), dataIndex: "phase", key: "phase", render: (p: string) => <Tag color={p === "failed" ? "red" : "blue"}>{p}</Tag> },
              { title: t("说明"), key: "note", render: (_: unknown, r: any) => r.lastError || (typeof r.evidence?.eniCount === "number" ? t("仍有 {n} 张网卡引用,等待释放", { n: r.evidence.eniCount }) : "-") },
              { title: t("入队时间"), dataIndex: "createdAt", key: "createdAt" },
            ]} />
        </Card>
      )}

      {/* 数据源网络对象:平台为数据源自建的安全组只在作业跑时才挂网卡,零网卡是常态 ⇒ 任何「无网卡即孤儿」的清理都会误删在用的组;
          这里把事实摆出来(归属源 / 在用 / 孤儿 / 待清理 / 网卡数),真孤儿一键交给该缺陷的持久清理作业(服务端重核三条件),不在页面直接删*/}
      {isPlatformAdmin && (
        <Card title={t("数据源网络对象")} size="small" style={{ marginTop: 16 }} data-testid="datasource-network-card"
          extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadNetObjects}>{t("刷新")}</Button>}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{t("平台为数据源自建的安全组(bgp-ds-* / 标签 bgp:managed)。「在用」的组零网卡是常态,请勿在账号里按「无网卡」清理;只有「孤儿」(没有任何数据源引用且网卡为 0)才可在此交给后台清理任务删除")}</div>
          {netObjectsError ? <div data-testid="datasource-network-error" style={{ color: "#ff4d4f", fontSize: 12, marginBottom: 8 }}>{netObjectsError}</div> : null}
          {netObjects && netObjects.unreadableRegions.length > 0 ? (
            <div data-testid="datasource-network-unreadable" style={{ color: "#faad14", fontSize: 12, marginBottom: 8 }}>
              {t("以下区读不到安全组事实(不等于没有):{list}", { list: netObjects.unreadableRegions.map((u) => `${u.region}(${u.error.slice(0, 80)})`).join("; ") })}
            </div>
          ) : null}
          <Table<NetObjectRow> size="small" rowKey="sgId" pagination={false} dataSource={netObjects?.objects ?? []} loading={netObjects === null} data-testid="datasource-network-table"
            locale={{ emptyText: t("没有平台自建的数据源安全组") }}
            columns={[
              { title: t("安全组"), key: "sg", render: (_: unknown, r: NetObjectRow) => <span><code data-testid="datasource-network-sg">{r.sgId}</code><div style={{ fontSize: 11, color: "#888" }}>{r.groupName}{r.tagged ? "" : ` · ${t("无标签(存量)")}`}</div></span> },
              { title: t("区域"), key: "region", render: (_: unknown, r: NetObjectRow) => <span>{r.region}<div style={{ fontSize: 11, color: "#888" }}>{r.targetId}</div></span> },
              { title: t("归属数据源"), key: "owner", render: (_: unknown, r: NetObjectRow) => r.owner ? <span data-testid="datasource-network-owner">{r.owner.name}</span> : <span style={{ color: "#888" }}>{r.taggedDatasourceId ? t("源已删(标签记 {id})", { id: r.taggedDatasourceId.slice(-8) }) : t("无")}</span> },
              { title: t("状态"), dataIndex: "status", key: "status", render: (s: NetObjectRow["status"]) => {
                const m: Record<NetObjectRow["status"], { c: string; t: string }> = { "in-use": { c: "green", t: t("在用") }, orphan: { c: "orange", t: t("孤儿") }, "pending-cleanup": { c: "blue", t: t("待清理") }, "needs-manual": { c: "red", t: t("需人工") } };
                return <Tag color={m[s].c} data-testid={`datasource-network-status-${s}`}>{m[s].t}</Tag>;
              } },
              { title: t("网卡"), key: "eni", render: (_: unknown, r: NetObjectRow) => r.status === "in-use" ? <span style={{ color: "#888" }}>—</span> : typeof r.eniCount === "number" ? r.eniCount : <span style={{ color: "#888" }}>?</span> },
              { title: t("操作"), key: "op", width: 120, render: (_: unknown, r: NetObjectRow) => r.status === "orphan" && r.eniCount === 0 ? (
                <Popconfirm title={t("确认清理?服务端会重新核对「无数据源引用 + 网卡为 0」,过了才交给后台清理任务删除")} onConfirm={() => requestNetCleanup(r)}>
                  <Button size="small" danger loading={netCleanupBusy === r.sgId} data-testid="datasource-network-cleanup">{t("清理")}</Button>
                </Popconfirm>
              ) : r.cleanupJob?.lastError ? <span style={{ fontSize: 11, color: "#ff4d4f" }}>{r.cleanupJob.lastError.slice(0, 60)}</span> : null },
            ]} />
        </Card>
      )}

      {/* 平台版本:与执行区无关;发版 tag 为准,未发版构建给产品提交。两轮冷启动演练的新手第一缺口。 */}
      <BuildInfoCard style={{ marginTop: 16 }} />

      {/* AI 模型运行时配置(admin 可改;非 admin 只读展示 /api/settings 的 aiModel)。 */}
      <AiModelCard readonlyModel={config?.aiModel ?? null} />

      <Card
        title={t("AI 接线健康")}
        size="small"
        style={{ marginTop: 16 }}
        extra={wiring && (
          <Tag color={wiring.overall === "ok" ? "green" : wiring.overall === "warn" ? "orange" : "red"}>
            {wiring.overall === "ok" ? t("全部正常") : wiring.overall === "warn" ? t("部分降级") : t("接线异常")}
          </Tag>
        )}
      >
        {wiring ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            {(wiring.items || []).map((it: any) => (
              <div key={it.key} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", border: "1px solid #1d4254", borderRadius: 6 }}>
                <Space>
                  {statusIcon(it.status === "warn" ? "warning" : it.status)}
                  <div>
                    <div style={{ fontWeight: 500 }}>{it.label}</div>
                    <div style={{ fontSize: 12, color: "#888" }}>{it.detail}</div>
                  </div>
                </Space>
                <Tag color={it.status === "ok" ? "green" : it.status === "warn" ? "orange" : "red"}>{it.status.toUpperCase()}</Tag>
              </div>
            ))}
          </Space>
        ) : <Spin />}
      </Card>
    </div>
  );
}
