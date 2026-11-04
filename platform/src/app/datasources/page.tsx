"use client";
// 页面删除读响应的唯一作者:失败呈现服务端原话,成功才提示「已删除」
import { deleteJson } from "@/lib/http/delete-json";

import React, { useEffect, useState } from "react";
import { Table, Button, Space, Tag, Popconfirm, message, Drawer, Descriptions, Collapse, Badge, Input, Select, Card, Alert, Divider, Empty, Tooltip } from "antd";
import { PlusOutlined, ReloadOutlined, DatabaseOutlined, TableOutlined, SearchOutlined, ApiOutlined, ApartmentOutlined, CloudServerOutlined } from "@ant-design/icons";
import type { DataSource } from "@/types/datasource";
import DataSourceModal from "./DataSourceModal";
// S3 源行「建外部表(Athena 直查)」弹窗;落点 = 行上的章(唯一读法),外部表建在那个区
import S3ExternalTableModal from "./S3ExternalTableModal";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import { useT } from "@/lib/i18n/useT";
// 执行范围接入(50 SPEC §2.6;交互 INTERACTION §9)
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint, { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
// 取表清单的唯一作者(直连 / 经 Glue 连接发现 + 轮询都在它里面)
import { fetchSourceTables } from "@/lib/datasource/tables-client";

const statusColor: Record<string, string> = { active: "green", inactive: "default", error: "red" };
const typeIcon: Record<string, string> = { mysql: "🐬", postgresql: "🐘", oracle: "🔶", sqlserver: "🔷", kinesis: "🌊", msk: "📨", dynamodb: "🔑", s3: "🪣" };

export default function DatasourcesPage() {
  const t = useT();
  const [data, setData] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DataSource | undefined>();
  // via / note / loading —— 表清单是直连读的还是经 Glue 连接发现的,页面要说清楚
  const [metaDrawer, setMetaDrawer] = useState<{ open: boolean; ds?: DataSource; tables: any[]; via?: "control-plane" | "glue-discovery"; note?: string; discoveredAt?: string; loading?: boolean; waitingNote?: string }>({ open: false, tables: [] });
  const [deletingId, setDeletingId] = useState<string>("");
  // DS-05: connectivity heartbeat — per-row probe + batch probe.
  const [pingingId, setPingingId] = useState<string>("");
  const [pingingAll, setPingingAll] = useState(false);
  const [filters, setFilters] = useState({ name: "", type: "", status: "", hasGlue: "", hasSecret: "" });
  // 网络接入编辑(数据源 Glue 连接的子网/SG;不碰连接串)。网络顾问「应用建议」一键回填。
  const [netVpcs, setNetVpcs] = useState<any[]>([]);
  const [netSubnets, setNetSubnets] = useState<any[]>([]);
  const [netSgs, setNetSgs] = useState<any[]>([]);
  // 这份网络清单是哪个区的(护栏 2:落点必须一眼可见)
  const [netRegion, setNetRegion] = useState("");
  const [netVpc, setNetVpc] = useState<string | undefined>(undefined);
  const [netSubnetId, setNetSubnetId] = useState<string | undefined>(undefined);
  const [netSgIds, setNetSgIds] = useState<string[]>([]);
  const [savingNet, setSavingNet] = useState(false);
  const [netDrawer, setNetDrawer] = useState<{ open: boolean; ds?: DataSource }>({ open: false });
  // S3 源「建外部表」弹窗(targetId / region = 这条源的落点,打开时按行上的章算好)
  const [s3Ext, setS3Ext] = useState<{ open: boolean; ds?: DataSource; targetId: string; region: string }>({ open: false, targetId: "", region: "" });
  // 当前执行范围(顶栏选的那个;URL 是权威)。
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `scope=${encodeURIComponent(scopeParam)}` : "";
  // 网络清单的取数落点(单区视角 = 该区;分组 / 全局 = 主控区)
  // 落点显式(全局 / 分组 = 主控区写明,不靠后端缺省)
  const netTargetId = landingOfScope(scope);
  // 🔴🔴 上一版这里写的是「一期建源只发生在主控区…
  //    建出来的行当前视角看不见」。用户 2026-09-10 明确驳回了那个状态:「**所有的任务都要创建在
  //    当前区域,不能只是创建在主控区,没意义…不然也是白干了。**」
  // ⇒ 现在:单区视角 ⇒ **就建在那个区**(落点随视角);主控区 / 全局视角 ⇒ 建在主控区。
  //    按钮上复述落点(护栏 2:写操作必须把目标说出来)。
  const createTargetId = scope.kind === "target" ? scope.targetId : undefined;
  const createRegion = createTargetId ? scopeTargets?.find((x: { targetId: string; region?: string }) => x.targetId === createTargetId)?.region || createTargetId : "";

  // 打开「建外部表」—— 落点取行上的章(存量无章 = 主控区;章非法由唯一读法抛,这里如实报错、不默认主控区)
  const openS3External = (ds: DataSource) => {
    try {
      const targetId = datasourceOwnerTarget(ds as unknown as Record<string, unknown>);
      const region = scopeTargets?.find((x: { targetId: string; region?: string }) => x.targetId === targetId)?.region || targetId;
      setS3Ext({ open: true, ds, targetId, region });
    } catch (e) {
      message.error((e as Error).message || t("这条数据源的落点不合法"));
    }
  };

  const openMetaWithNetwork = (ds: DataSource) => {
    // 回填当前网络到编辑控件。
    const nc: any = (ds as any).networkConfig || {};
    setNetVpc(nc.vpcId); setNetSubnetId(nc.subnetId);
    setNetSgIds(nc.securityGroupIds || (nc.securityGroupId ? [nc.securityGroupId] : []));
  };

  const saveNetwork = async (ds: DataSource) => {
    if (!netSubnetId || netSgIds.length === 0) { message.warning(t("请选择子网 + 至少一个安全组")); return; }
    setSavingNet(true);
    try {
      const az = netSubnets.find((s) => s.id === netSubnetId)?.az;
      const r = await fetch(`/api/datasources/${ds.datasourceId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: { subnetId: netSubnetId, securityGroupIds: netSgIds, availabilityZone: az } }),
      }).then((x) => x.json());
      if (r?.success !== false && !r?.error) { message.success(t("网络接入已更新(仅改子网/安全组,未动连接信息)")); fetchData(); }
      else message.error(r?.error?.message || t("更新失败"));
    } finally { setSavingNet(false); }
  };

  const fetchData = async (f?: typeof filters) => {
    setLoading(true);
    try {
      const cur = f || filters;
      const params = new URLSearchParams();
      if (cur.name) params.set("name", cur.name);
      if (cur.type) params.set("type", cur.type);
      if (cur.status) params.set("status", cur.status);
      if (cur.hasGlue) params.set("hasGlue", cur.hasGlue);
      if (cur.hasSecret) params.set("hasSecret", cur.hasSecret);
      // 带上当前执行范围;`global` 时 `toScopeParam` 回 null
      // ⇒ **URL 与改动前逐字节相同**(回滚点),不会凭空多出一个 `?scope=global`。
      if (scopeQs) params.set("scope", scopeParam!);
      const qs = params.toString();
      const res = await fetch(`/api/datasources${qs ? `?${qs}` : ""}`);
      const json = await res.json();
      setData(Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : []);
    } finally { setLoading(false); }
  };
  useEffect(() => {
    fetchData();
    // 网络资源(真实 VPC/子网/SG),供数据源网络接入编辑 + 网络顾问应用建议(复用同款端点)。
    // 🔴 网络是**区域资源**:必须跟随顶栏视角取,否则在 us-west-2 视角下列出的是主控区的子网 /
    // 安全组,选中后写进数据源网络配置,连的时候才炸(与 /settings 那次硬撒谎同一类)。
    fetch(`/api/flink/network?targetId=${encodeURIComponent(netTargetId)}`).then((r) => r.json()).then((d) => {
      if (d?.success) { setNetVpcs(d.data.vpcs || []); setNetSubnets(d.data.subnets || []); setNetSgs(d.data.securityGroups || []); setNetRegion(d.data.region || ""); }
    }).catch(() => {});
    // 🔴 `scopeQs` 进 deps:切范围**不重载页面**,靠这里重拉(护栏 4)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeQs]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteJson(`/api/datasources/${id}`);
      message.success(t("已删除"));
      fetchData();
    } catch (e) {
      // 删不掉(502 连带资源撤不下来 / 409 进行中)⇒ 原话呈现、行不动
      message.error((e as Error).message || t("删除失败"));
    } finally {
      setDeletingId("");
    }
  };

  // DS-05: probe one data source's connectivity and refresh its status.
  const handleHeartbeat = async (id: string) => {
    setPingingId(id);
    try {
      const res = await fetch(`/api/datasources/${id}/heartbeat`, { method: "POST" });
      const json = await res.json();
      const d = json.success ? json.data : json;
      if (d?.reachable === true) message.success(t("可达 ({latency}ms)", { latency: d.latencyMs }));
      else if (d?.reachable === false) message.error(t("不可达: {err}", { err: d.error || t("连接失败") }));
      else if (d?.via === "glue-connection" && d?.state === "testing") {
        // 控制面直连不到 ⇒ 已改经数据源自己的 Glue 连接探测(一次性 Glue 作业在该连接的子网 / 安全组里登录源库,1–3 分钟),轮询结果;
        //   页面不再轮询时,列表 / 单条读取也会把结论推进出来(lib/datasource/glue-probe-settle.ts)
        message.info(d.message || t("已改经数据源的 Glue 连接探测(约 1–3 分钟)"), 6);
        fetchData();
        for (let i = 0; i < 48; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const rr = await fetch(`/api/datasources/${id}/heartbeat`);
          const jj = await rr.json();
          const s = jj.success ? jj.data : jj;
          if (s?.state === "settled") {
            if (s.reachable) message.success(t("经 Glue 连接可达(验证于 {at})", { at: String(s.validatedAt || "").slice(11, 19) }));
            else message.error(t("经 Glue 连接不可达: {err}", { err: s.error || t("连接失败") }));
            break;
          }
          if (s?.state === "unknown") { message.warning(s.error || t("Glue 连接验证没有给出结果")); break; }
        }
      }
      else message.info(d?.error || t("该类型暂不支持心跳检测"));
      fetchData();
    } catch {
      message.error(t("心跳检测失败"));
    } finally {
      setPingingId("");
    }
  };

  // DS-05: probe all data sources, then refresh once.
  const handleHeartbeatAll = async () => {
    setPingingAll(true);
    try {
      await Promise.all(data.map((d) => fetch(`/api/datasources/${d.datasourceId}/heartbeat`, { method: "POST" }).catch(() => {})));
      message.success(t("已检测全部数据源"));
      fetchData();
    } finally {
      setPingingAll(false);
    }
  };

  // 直连读不到且有 Glue 连接 ⇒ 后端起经 Glue 连接的发现作业(202),这里轮询到结果;抽屉上说明来源
  const browseMeta = async (ds: DataSource, refresh = false) => {
    setMetaDrawer({ open: true, ds, tables: [], loading: true });
    openMetaWithNetwork(ds);
    try {
      const r = await fetchSourceTables(ds.datasourceId, ds.database, {
        refresh,
        onWaiting: (info) => setMetaDrawer((m) => ({ ...m, open: true, ds, tables: [], loading: true, waitingNote: info.note || t("正在经数据源的 Glue 连接发现表(约 1–3 分钟)…") })),
      });
      setMetaDrawer({ open: true, ds, tables: r.tables, via: r.via, note: r.note, discoveredAt: r.discoveredAt, loading: false });
    } catch (e: any) {
      message.error(e?.message || t("获取表列表失败"));
      setMetaDrawer({ open: true, ds, tables: [], loading: false });
    }
  };

  const columns = [
    {
      title: t("数据源"), key: "name",
      render: (_: any, r: DataSource) => (
        <Space>
          <span style={{ fontSize: 18 }}>{typeIcon[r.type]}</span>
          <div>
            <div style={{ fontWeight: 500 }}>{r.name}</div>
            <div style={{ fontSize: 12, color: "#888" }}>{r.type?.toUpperCase()}</div>
          </div>
        </Space>
      ),
    },
    {
      title: t("连接信息"), key: "connection",
      render: (_: any, r: DataSource) => {
        // 非 JDBC 源(DynamoDB/S3/Kinesis/MSK)无 host/port/db,按连接袋渲染;JDBC 保持原样。
        const c = (r as any).connection || {};
        if (r.type === "dynamodb") return (
          <div style={{ fontSize: 12 }}>
            <div>{t("表名")}: <code>{c.tableName || "-"}</code></div>
            <div>{t("区域")}: {c.region || "-"}</div>
          </div>
        );
        if (r.type === "s3") return (
          <div style={{ fontSize: 12 }}>
            <div><code>s3://{c.bucket || "-"}/{c.prefix || ""}</code></div>
            <div>{t("格式")}: {c.format || "auto"} | {c.region || "-"}</div>
          </div>
        );
        if (r.type === "kinesis") return <div style={{ fontSize: 12 }}><div>{t("流")}: <code>{c.streamName || "-"}</code></div><div>{c.region || "-"}</div></div>;
        if (r.type === "msk") return <div style={{ fontSize: 12 }}><div>{c.clusterArn ? "MSK" : c.bootstrapServers || "-"}</div><div>{c.region || "-"}</div></div>;
        return (
          <div style={{ fontSize: 12 }}>
            <div>{t("主机")}: <code>{r.host}</code></div>
            <div>{t("端口")}: {r.port} | {t("库")}: {r.database}</div>
            <div>{t("用户")}: {r.username}</div>
          </div>
        );
      },
    },
    {
      title: "Glue Connection", dataIndex: "glueConnectionName", key: "glue",
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : <Tag>{t("未关联")}</Tag>,
    },
    {
      title: t("密码存储"), dataIndex: "secretArn", key: "secret",
      render: (v: string) => v ? <Tag color="green">🔒 Secrets Manager</Tag> : <Tag color="red">{t("⚠️ 未加密")}</Tag>,
    },
    { title: t("状态"), dataIndex: "status", key: "status", render: (v: string, r: DataSource) => {
      const m: Record<string, { s: "success"|"error"|"default"|"processing"|"warning"; t: string }> = {
        active: { s: "success", t: t("已连接") }, testing: { s: "processing", t: t("测试中") },
        error: { s: "error", t: t("异常") }, unreachable: { s: "warning", t: t("不可达") }, inactive: { s: "default", t: t("未激活") },
      };
      const st = m[v] || m.inactive;
      const hb = (r as any).heartbeat;
      // 结论来自哪条网要说清楚 —— 经 Glue 连接验证的给个小标;控制面直连不到不再被当成「不可达」
      const viaGlue = hb?.via === "glue-connection";
      return <div data-testid="ds-status-cell"><Badge status={st.s} text={st.t} />{/* 原来紧跟「已连接」显示 testResult.totalMs —— 那是查 Glue 连接配置的耗时,不是连上源库的延迟;只留心跳 ♥ 延迟 */}{hb?.latencyMs != null && hb?.reachable ? <span style={{ fontSize: 11, color: "#52c41a" }}> ♥{hb.latencyMs}ms</span> : null}
        {viaGlue && <Tooltip title={hb?.controlPlane?.error ? t("控制面直连不到该源({err});以 Glue 连接验证为准", { err: String(hb.controlPlane.error).slice(0, 80) }) : t("以数据源自己的 Glue 连接验证为准")}><Tag data-testid="ds-via-glue" style={{ marginLeft: 6, fontSize: 11 }} color={hb?.state === "testing" ? "processing" : hb?.reachable ? "green" : hb?.state === "unknown" ? "default" : "orange"}>{hb?.state === "testing" ? t("Glue 连接验证中") : t("经 Glue 连接")}</Tag></Tooltip>}
        {/* 外部网络对象的核对结论 —— broken = 用户自带对象 / 密钥缺失(平台不代建)或自愈失败,文案点名对象并指路;healed = 平台对象曾被平台外删除、已自动重建接回(次数在涨 = 账号里有清理工具在删平台对象) */}
        {r.networkState === "broken" && <Tooltip title={r.networkIssue?.message || t("数据源依赖的网络对象已不存在")}><Tag data-testid="ds-network-broken" color="red" style={{ marginLeft: 6, fontSize: 11 }}>{t("网络对象缺失")}</Tag></Tooltip>}
        {r.networkState === "healed" && <Tooltip title={t("平台自建的安全组 / Glue 连接曾被平台外删除,已自动重建并接回;最近一次 {at}。请排查账号里是否有清理工具在删带 bgp:managed 标签的对象", { at: String(r.lastHealedAt || "").slice(0, 19).replace("T", " ") })}><Tag data-testid="ds-network-healed" color="green" style={{ marginLeft: 6, fontSize: 11 }}>{t("已自愈 {n} 次", { n: r.healCount ?? 1 })}</Tag></Tooltip>}
      </div>;
    }},
    { title: t("更新时间"), dataIndex: "updatedAt", key: "updatedAt", render: (v: string) => v?.slice(0, 19).replace("T", " "), width: 170 },
    {
      title: t("操作"), key: "action", width: 360,
      render: (_: any, record: DataSource) => (
        <Space>
          <Button size="small" icon={<TableOutlined />} onClick={() => browseMeta(record)}>{t("浏览表")}</Button>
          {/* 只有 S3 源有「建外部表」—— 把一个数据集登记成 Athena 外部表,建在这条源所在的区 */}
          {record.type === "s3" && (
            <Tooltip title={t("把这条 S3 源下的数据集登记成 Athena 外部表,建在它所在的区;建好可在数据湖直查里查询")}>
              <Button size="small" icon={<CloudServerOutlined />} data-testid="ds-s3-external-btn" onClick={() => openS3External(record)}>{t("建外部表")}</Button>
            </Tooltip>
          )}
          <Button size="small" icon={<ApartmentOutlined />} onClick={() => { openMetaWithNetwork(record); setNetDrawer({ open: true, ds: record }); }}>{t("网络配置")}</Button>
          <Button size="small" icon={<ApiOutlined />} loading={pingingId === record.datasourceId} onClick={() => handleHeartbeat(record.datasourceId)}>{t("检测")}</Button>
          <a onClick={() => { setEditing(record); setModalOpen(true); }}>{t("编辑")}</a>
          <Popconfirm title={t("确认删除？")} onConfirm={() => handleDelete(record.datasourceId)} okButtonProps={{ loading: deletingId === record.datasourceId }}>
            <a style={{ color: "red", ...(deletingId === record.datasourceId ? { pointerEvents: "none", opacity: 0.5 } : {}) }}>{t("删除")}</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}><DatabaseOutlined /> {t("数据源管理")}</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>{t("刷新")}</Button>
          <Button icon={<ApiOutlined />} loading={pingingAll} onClick={handleHeartbeatAll}>{t("检测可达性")}</Button>
          {/* 护栏 2「写操作在按钮上复述目标」(INTERACTION §9.3-2)。
              非主控区视角下**先说清**建出来的源落在主控区、当前视角看不到。 */}
          <Tooltip title={createRegion ? t("将在 {r} 建这条数据源:密钥、安全组、Glue 连接都建在那个区;由它派生的同步任务也会在那个区跑", { r: createRegion }) : t("将在主控区建这条数据源")}>
            <Button type="primary" icon={<PlusOutlined />} data-testid="ds-create-btn" onClick={() => { setEditing(undefined); setModalOpen(true); }}>
              {createRegion ? t("新建数据源(建在 {r})", { r: createRegion }) : t("新建数据源")}
            </Button>
          </Tooltip>
        </Space>
      </div>
      {/* 造数(示范数据重建)不再有前台面板:用户 2026-10-21 拍板「造数据不需要在前台预留面板,这是测试使用的」⇒ 入口只剩
          /api/seed/* 给测试夹具与脚本用(守卫 components/datasources/__tests__/seed-panel-removed.test.ts)。 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input placeholder={t("数据源名称")} prefix={<SearchOutlined />} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} onPressEnter={() => fetchData()} allowClear style={{ width: 180 }} />
          <Select placeholder={t("类型")} value={filters.type || undefined} onChange={(v) => { const f = { ...filters, type: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 130 }}
            options={[{ label: "🐬 MySQL", value: "mysql" }, { label: "🐘 PostgreSQL", value: "postgresql" }, { label: "🔶 Oracle", value: "oracle" }, { label: "🔷 SQL Server", value: "sqlserver" }]} />
          <Select placeholder="Glue Connection" value={filters.hasGlue || undefined} onChange={(v) => { const f = { ...filters, hasGlue: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 150 }}
            options={[{ label: t("已关联"), value: "true" }, { label: t("未关联"), value: "false" }]} />
          <Select placeholder={t("密码存储")} value={filters.hasSecret || undefined} onChange={(v) => { const f = { ...filters, hasSecret: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 150 }}
            options={[{ label: t("🔒 已加密"), value: "true" }, { label: t("⚠️ 未加密"), value: "false" }]} />
          <Select placeholder={t("状态")} value={filters.status || undefined} onChange={(v) => { const f = { ...filters, status: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 110 }}
            options={[{ label: t("已连接"), value: "active" }, { label: t("异常"), value: "error" }, { label: t("未激活"), value: "inactive" }]} />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchData()}>{t("搜索")}</Button>
          <Button onClick={() => { const f = { name: "", type: "", status: "", hasGlue: "", hasSecret: "" }; setFilters(f); fetchData(f); }}>{t("重置")}</Button>
        </Space>
      </Card>
      {/* 护栏 1:target 视角常驻「其他执行范围还有 N 条」 */}
      <OtherScopesHint resources={["datasource"]} />
      {/* 无头验收要能**只**数这张表的行(抽屉里还有别的表),故包一层带 testid 的容器 */}
      <div data-testid="ds-table">
        <Table
          columns={columns}
          dataSource={data}
          rowKey="datasourceId"
          loading={loading}
          style={{ marginTop: 12 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<ScopeEmptyHint resources={["datasource"]} noun={t("数据源")} />} /> }}
        />
      </div>
      <DataSourceModal open={modalOpen} editing={editing} createTargetId={createTargetId} landingTargetId={netTargetId} onClose={() => setModalOpen(false)} onSuccess={(mode) => {
        setModalOpen(false);
        // 建完如实回报落点(它现在就在当前视角里,
        // 所以是 success 而不是 warning;上一版那句「已在主控区建好、当前范围看不到」已不成立)
        // 编辑成功只报「已更新」:原来编辑也弹「已在主控区建好这条数据源」,与弹窗自己的「已更新」叠成两条且第二条说错了事
        if (mode === "updated") message.success(t("已更新"));
        else message.success(createRegion ? t("已在 {r} 建好这条数据源", { r: createRegion }) : t("已在主控区建好这条数据源"));
        fetchData();
      }} />

      {/* S3 源行「建外部表(Athena 直查)」—— 落点 = 这条源所在区(标题与按钮都写明);成功块带「去数据湖直查」 */}
      <S3ExternalTableModal open={s3Ext.open} ds={s3Ext.ds} targetId={s3Ext.targetId} region={s3Ext.region} onClose={() => setS3Ext({ open: false, targetId: "", region: "" })} />

      <Drawer title={t("元数据浏览 - {name}", { name: metaDrawer.ds?.name || "" })} open={metaDrawer.open} onClose={() => setMetaDrawer({ open: false, tables: [] })} width={600}>
        {metaDrawer.ds && (
          <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t("类型")}>{metaDrawer.ds.type?.toUpperCase()}</Descriptions.Item>
            <Descriptions.Item label={t("主机")}>{metaDrawer.ds.host}</Descriptions.Item>
            <Descriptions.Item label={t("端口")}>{metaDrawer.ds.port}</Descriptions.Item>
            <Descriptions.Item label={t("数据库")}>{metaDrawer.ds.database}</Descriptions.Item>
            <Descriptions.Item label={t("用户")}>{metaDrawer.ds.username}</Descriptions.Item>
            <Descriptions.Item label={t("Glue连接")}>{metaDrawer.ds.glueConnectionName || t("无")}</Descriptions.Item>
          </Descriptions>
        )}
        {/* 等发现作业 / 发现结果来源说明 + 重新发现 */}
        {metaDrawer.loading && (
          <Alert type="info" showIcon data-testid="ds-tables-discovering" style={{ marginBottom: 12 }}
            message={metaDrawer.waitingNote ? t("正在经数据源的 Glue 连接发现表") : t("正在读取表结构…")} description={metaDrawer.waitingNote} />
        )}
        {!metaDrawer.loading && metaDrawer.via === "glue-discovery" && (
          <Alert type="success" showIcon data-testid="ds-tables-via-glue" style={{ marginBottom: 12 }}
            message={t("表结构经数据源的 Glue 连接发现(发现于 {at})", { at: String(metaDrawer.discoveredAt || "").slice(0, 19).replace("T", " ") })}
            description={metaDrawer.note}
            action={<Button size="small" data-testid="ds-tables-rediscover" onClick={() => metaDrawer.ds && browseMeta(metaDrawer.ds, true)}>{t("重新发现")}</Button>} />
        )}
        <h4>{t("表列表 ({n} 张表)", { n: metaDrawer.tables.length })}</h4>
        <Collapse items={metaDrawer.tables.map((tbl: any) => ({
          key: tbl.name,
          label: <Space><TableOutlined /><b>{tbl.name}</b><Tag>{t("{n} 字段", { n: tbl.columns?.length || 0 })}</Tag>{tbl.partitionKeys?.length > 0 && <Tag color="orange">{t("{n} 分区键", { n: tbl.partitionKeys.length })}</Tag>}</Space>,
          children: (
            <Table size="small" pagination={false} dataSource={tbl.columns?.map((c: any, i: number) => ({ ...c, key: i }))}
              columns={[
                { title: t("字段名"), dataIndex: "name", key: "name", render: (v: string) => <code>{v}</code> },
                { title: t("类型"), dataIndex: "type", key: "type", render: (v: string) => <Tag>{v}</Tag> },
                { title: t("备注"), dataIndex: "comment", key: "comment" },
              ]}
            />
          ),
        }))} />
      </Drawer>

      {/* 独立「网络配置」Drawer(列表行「网络配置」按钮打开)——网络接入可查可改 + 智能顾问一键应用。
          入口显眼(不再藏在「浏览表」里);只改 Glue 连接的子网/SG,绝不动 host/库/密码。 */}
      <Drawer
        title={
          <Space size={6}>
            {t("网络配置 - {name}", { name: netDrawer.ds?.name || "" })}
            {/* 护栏 2:这份 VPC / 子网 / 安全组清单是哪个区的,
                必须一眼可见。看不见区的网络下拉,是「选了一个别的区的子网」这类事故的温床。 */}
            {netRegion ? <Tag color="blue" data-testid="ds-network-region">{netRegion}</Tag> : null}
          </Space>
        }
        open={netDrawer.open} onClose={() => setNetDrawer({ open: false })} width={620}>
        {netDrawer.ds && (
          netDrawer.ds.glueConnectionName ? (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 12 }}
                message={t("修改数据源接入 VPC 的子网 / 安全组")}
                description={t("只改网络接入,绝不改 host / 库 / 密码等连接信息。网络顾问可探测环境、判定可达性、给建议并「一键应用」到下方。保存后,同步/编排的 Glue 作业即用新网络。")} />
              <Space direction="vertical" style={{ width: "100%" }} size={10}>
                <div>
                  <span style={{ color: "#888", fontSize: 12, marginRight: 8 }}>VPC:</span>
                  <Select size="small" value={netVpc} style={{ width: 300 }} placeholder={t("选择 VPC")} showSearch optionFilterProp="label" allowClear
                    onChange={(v) => { setNetVpc(v); setNetSubnetId(undefined); setNetSgIds([]); }}
                    options={netVpcs.map((x: any) => ({ label: `${x.name || x.id}(${x.cidr})`, value: x.id }))} />
                </div>
                <div>
                  <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>{t("私有子网")}</div>
                  <Select size="small" value={netSubnetId} style={{ width: "100%" }} placeholder={t("选私有子网")} showSearch optionFilterProp="label"
                    onChange={(v) => setNetSubnetId(v)}
                    options={netSubnets.filter((s: any) => !netVpc || s.vpcId === netVpc).map((s: any) => ({ label: `${s.name || s.id} · ${s.az}${s.isPrivate ? ` · ${t("私有")}` : ""}`, value: s.id }))} />
                </div>
                <div>
                  <div style={{ color: "#888", fontSize: 12, marginBottom: 4 }}>{t("安全组(可多选)")}</div>
                  <Select size="small" mode="multiple" value={netSgIds} style={{ width: "100%" }} placeholder={t("选安全组")} showSearch optionFilterProp="label"
                    onChange={(v) => setNetSgIds(v)}
                    options={netSgs.filter((g: any) => !netVpc || g.vpcId === netVpc).map((g: any) => ({ label: `${g.name}(${g.id})`, value: g.id }))} />
                </div>
                <Button type="primary" loading={savingNet} onClick={() => netDrawer.ds && saveNetwork(netDrawer.ds)}>{t("保存网络接入")}</Button>
                <Divider style={{ margin: "4px 0" }} />
                <NetworkAdvisorPanel
                  targetIds={[netTargetId]}
                  request={{ computeKind: "glue", targets: [{ kind: "datasource", datasourceId: netDrawer.ds.datasourceId }], constraints: { preferPrivate: true } }}
                  title={t("网络连通性顾问")}
                  onPrefill={(p) => {
                    const subs = p.channel === "glue" ? (p.subnetId ? [p.subnetId] : []) : p.channel === "generic" ? (p.subnetIds || []) : [];
                    const sgs = p.channel === "glue" ? (p.securityGroupIdList || []) : p.channel === "generic" ? (p.securityGroupIds || []) : [];
                    if (subs[0]) { setNetSubnetId(subs[0]); const f = netSubnets.find((s: any) => s.id === subs[0]); if (f) setNetVpc(f.vpcId); }
                    if (sgs.length) setNetSgIds(sgs);
                    if (subs[0] || sgs.length) message.success(t("已应用建议,请点「保存网络接入」生效"));
                  }}
                />
              </Space>
            </>
          ) : (
            <Alert type="warning" showIcon message={t("该数据源无 Glue 连接")}
              description={t("网络接入配置仅对经 Glue 连接访问 VPC 内数据库的数据源可用。")} />
          )
        )}
      </Drawer>
    </div>
  );
}
