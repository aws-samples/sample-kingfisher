"use client";

import React, { useState, useEffect } from "react";
import { pickEditableDatasourceFields } from "@/lib/datasources/editable-fields";
import { parseJdbcParams } from "@/lib/datasource-spi/jdbc/jdbc-params";
import { Modal, Form, Input, InputNumber, Select, Button, Steps, Space, Tag, Alert, Spin, Radio, message, Result } from "antd";
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, CloudServerOutlined } from "@ant-design/icons";
import { DS_TYPE_OPTIONS, type DataSource } from "@/types/datasource";
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import { useT } from "@/lib/i18n/useT";
import { targetOfStamp } from "@/lib/exec-env/target-id";

interface Props {
  open: boolean;
  editing?: DataSource;
  onClose: () => void;
  /** 成功后的提示由页面统一给("created" 报落点 / "updated" 报「已更新」),弹窗自己不弹 */
  onSuccess: (mode: "created" | "updated") => void;
  /** 新建时的落点(顶栏单区视角 = 那个区;缺省 = 主控区) */
  createTargetId?: string;
  /** 新建时取区域资源(网络下拉)的落点,页面按视角算好(landingOfScope),必填 */
  landingTargetId: string;
}

export default function DataSourceModal({ open, editing, onClose, onSuccess, createTargetId, landingTargetId }: Props) {
  const t = useT();
  const [form] = Form.useForm();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [rdsInstances, setRdsInstances] = useState<any[]>([]);
  const [loadingRds, setLoadingRds] = useState(false);
  const [connectMode, setConnectMode] = useState<"manual" | "rds">("manual");
  const [provisionResult, setProvisionResult] = useState<any>(null);
  // 创建时网络接入(可选):留空=后端 detectNetwork 自动探测;填了=用用户选的子网/SG 建 Glue 连接。
  const [netVpcs, setNetVpcs] = useState<any[]>([]);
  const [netSubnets, setNetSubnets] = useState<any[]>([]);
  const [netSgs, setNetSgs] = useState<any[]>([]);
  const [netVpc, setNetVpc] = useState<string | undefined>(undefined);
  const [netSubnetId, setNetSubnetId] = useState<string | undefined>(undefined);
  const [netSgIds, setNetSgIds] = useState<string[]>([]);
  // 监听 host 字段:网络顾问需要 host 才渲染。直接读 form.getFieldValue 不订阅变更(输入框改值不触发父组件重渲),须用 useWatch。
  const watchHost = Form.useWatch("host", form);
  // 监听类型 → stream 范式走精简表单,不走 JDBC 的 host/port/db+网络。
  //  stream 范式细分:kinesis(流名+新建) / msk(集群或 bootstrap + 认证)。两者表单不同,provider 能力标驱动。
  const watchType = Form.useWatch("type", form);
  const paradigm = (DS_TYPE_OPTIONS.find((o) => o.value === watchType) as any)?.paradigm;
  const isStream = paradigm === "stream";
  const isDynamo = watchType === "dynamodb"; // NoSQL 范式
  const isS3 = watchType === "s3"; // 对象存储范式
  // 🔴 JDBC 专属表单(host/port/db + 网络 + RDS 选择)的守卫。此前用 !isStream,加 DDB/S3 后
  //   必须显式为 jdbc 范式,否则 DDB/S3(非 stream)会误落进 JDBC 表单要求填 host/port/database。
  const isJdbc = paradigm === "jdbc" || (!!watchType && !paradigm); // 未知类型按 JDBC 保底(与后端分流一致)
  const isKinesis = watchType === "kinesis";
  const isMsk = watchType === "msk";
  const [kinesisMode, setKinesisMode] = useState<"existing" | "new">("existing"); // 选已有流 / 新建流
  const [existingStreams, setExistingStreams] = useState<string[]>([]); // 账号已存在的 Kinesis 流名(ListStreams)
  const [loadingStreams, setLoadingStreams] = useState(false);
  // MSK:flavor(托管/自建)+ 认证 + 集群列表(托管选集群下拉)。
  const [mskFlavor, setMskFlavor] = useState<"msk" | "self">("msk");
  const [mskAuth, setMskAuth] = useState<"iam" | "scram">("iam");
  const [mskClusters, setMskClusters] = useState<Array<{ arn: string; name: string; state?: string; auth: string[] }>>([]);
  const [loadingClusters, setLoadingClusters] = useState(false);
  const isEdit = !!editing;

  // 打开且类型=MSK 托管时,拉账号已有集群列表(供"选择集群"下拉)。
  const loadMskClusters = async () => {
    setLoadingClusters(true);
    try {
      const r = await fetch("/api/datasources/msk-clusters");
      const d = await r.json();
      setMskClusters(d?.success ? (d.data?.clusters || []) : []);
    } catch { setMskClusters([]); } finally { setLoadingClusters(false); }
  };

  // 打开且类型=Kinesis 时,拉账号已有流列表(供"使用已有流"下拉自动展示,免手敲)。
  const loadKinesisStreams = async () => {
    setLoadingStreams(true);
    try {
      const r = await fetch("/api/datasources/kinesis-streams");
      const d = await r.json();
      setExistingStreams(d?.success ? (d.data?.streams || []) : []);
    } catch { setExistingStreams([]); } finally { setLoadingStreams(false); }
  };

  // 🔴 网络是区域资源:原来**不带落点** ⇒ 在 us-west-2 视角新建数据源,
  //   网络下拉列的是**主控区**的 VPC / 子网 / SG(选中写进数据源网络配置,连的时候才炸)。
  //   落点 = 编辑时该源的归属章;新建时 = 页面按视角算好的建源落点(landingOfScope)。
  // 网络顾问也用**同一个**落点(它的预填要能在下面这份清单里选中)。
  const netTarget = editing ? targetOfStamp((editing as { ownerTargetId?: unknown }).ownerTargetId) : landingTargetId;
  useEffect(() => {
    if (!open) return;
    fetch(`/api/flink/network?targetId=${encodeURIComponent(String(netTarget))}`).then((r) => r.json()).then((d) => {
      if (d?.success) { setNetVpcs(d.data.vpcs || []); setNetSubnets(d.data.subnets || []); setNetSgs(d.data.securityGroups || []); }
      else { setNetVpcs([]); setNetSubnets([]); setNetSgs([]); }
    }).catch(() => {});
  }, [open, editing, landingTargetId]);

  // 进入 Kinesis 连接配置步骤且默认"使用已有流"时,自动拉一次已有流列表(用户无需先切模式)。
  useEffect(() => {
    if (isKinesis && step === 1 && kinesisMode === "existing") loadKinesisStreams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKinesis, step]);

  // 进入 MSK 连接配置步骤且 flavor=托管时,自动拉一次集群列表(供"选择集群"下拉)。
  useEffect(() => {
    if (isMsk && step === 1 && mskFlavor === "msk") loadMskClusters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMsk, step, mskFlavor]);

  const loadRdsInstances = async () => {
    setLoadingRds(true);
    try {
      // 从 RDS 发现实例也按建源落点点名(列的是**那个区**账号里的实例;缺落点服务端 400,不默认主控区)
      const res = await fetch(`/api/datasources/discover?targetId=${encodeURIComponent(landingTargetId)}`);
      const data = await res.json();
      setRdsInstances(data.success ? data.data : []);
    } catch {} finally { setLoadingRds(false); }
  };

  const handleTest = async () => {
    try {
      const values = form.getFieldsValue(true); // Get ALL fields including hidden steps
      setTesting(true);
      setTestResult(null);
      // 非 JDBC 源(DDB/S3)测连要把连接信息组装进 connection 袋(后端 test 端点非 JDBC 分流读 body.connection),
      //   否则扁平 tableName/bucket 落不到 provider.validateConfig 里(报"缺少表名/桶")。JDBC 仍发扁平 values(零回归)。
      let testBody: any = values;
      if (isDynamo) {
        testBody = { type: values.type, connection: { tableName: (values.tableName || "").toString().trim(), region: values.region || undefined } };
      } else if (isS3) {
        testBody = { type: values.type, connection: { bucket: (values.bucket || "").toString().trim(), prefix: (values.prefix || "").toString().trim() || undefined, region: values.region || undefined, format: values.format || "auto" } };
      }
      const res = await fetch("/api/datasources/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testBody),
      });
      const data = await res.json();
      setTestResult(data.success ? data.data : data.data || { success: false, steps: [{ name: "error", status: "fail", message: data.error?.message }] });
    } catch (e: any) {
      setTestResult({ success: false, steps: [{ name: "error", status: "fail", message: e.message }] });
    } finally { setTesting(false); }
  };

  const handleSubmit = async () => {
    try {
      await form.validateFields(); // cross-step validation (forms stay mounted via preserve)
    } catch {
      message.warning(t("请检查表单必填项"));
      return;
    }
    const values = form.getFieldsValue(true); // Get ALL fields including hidden steps
    // stream 范式提交连接袋,不带 JDBC 的 host/port/db/network。
    let payload: any = values;
    if (isKinesis) {
      const streamName = (values.streamName || "").toString().trim();
      payload = {
        name: values.name, type: values.type, env: values.env, tags: values.tags,
        connection: { streamName, region: values.region || undefined },
        provision: kinesisMode === "new", // 新建流 → 后端 provider.provision 建流;选已有 → 直接注册
      };
    } else if (isMsk) {
      // MSK:托管=选集群(clusterArn);自建=手填 bootstrapServers。认证 iam/scram;scram 带账密(建 secret,不入库)。
      payload = {
        name: values.name, type: values.type, env: values.env, tags: values.tags,
        connection: {
          mskFlavor,
          auth: mskAuth,
          region: values.region || undefined,
          ...(mskFlavor === "msk" ? { clusterArn: values.clusterArn } : { bootstrapServers: (values.bootstrapServers || "").toString().trim() }),
          ...(mskAuth === "scram" ? { username: values.mskUsername, password: values.mskPassword } : {}),
        },
        // MSK 不支持 provision(不代劳建集群)。
      };
    } else if (isDynamo) {
      // DynamoDB(NoSQL 范式):连接袋 {tableName, region};iam-role 无密钥,走非 JDBC 路径。
      payload = {
        name: values.name, type: values.type, env: values.env, tags: values.tags,
        connection: { tableName: (values.tableName || "").toString().trim(), region: values.region || undefined },
      };
    } else if (isS3) {
      // S3(对象存储范式):连接袋 {bucket, prefix, region, format, hasHeader};iam-role 无密钥。
      payload = {
        name: values.name, type: values.type, env: values.env, tags: values.tags,
        connection: {
          bucket: (values.bucket || "").toString().trim(),
          prefix: (values.prefix || "").toString().trim() || undefined,
          region: values.region || undefined,
          format: values.format || "auto",
          hasHeader: values.hasHeader === undefined ? true : !!values.hasHeader,
        },
      };
    } else if (!isEdit && netSubnetId && netSgIds.length) {
      // JDBC 创建时若用户选了网络,带上 network(后端优先用它建 Glue 连接;留空则 detectNetwork 自动探测)。
      const az = netSubnets.find((s) => s.id === netSubnetId)?.az;
      values.network = { subnetId: netSubnetId, securityGroupIds: netSgIds, ...(az ? { availabilityZone: az } : {}) };
    }
    // 🔴 新建时把**落点**交给服务端(编辑不动既有源的章)。
    // 服务端会当场解析那个区的网络与 Glue 角色:缺项 ⇒ 400 可修,而不是先把密钥建在一个区、
    // 安全组建在另一个区留下半截状态。
    // 恒带落点(全部视角 = 主控区,由页面 landingOfScope 显式给;后端缺 ⇒ 400)
    if (!isEdit) payload = { ...payload, targetId: landingTargetId };
    // 🔴 编辑只提交**可编辑字段**(闭合清单 lib/datasources/editable-fields.ts):
    //   表单是用整条记录预填的,原样 PUT 回去会把 datasourceId / updatedAt / status / secretArn … 一起送到服务端 ⇒ 500(用户 2026-10-15 反馈「改名报错」)。
    //   密码框留空 = 不改密码(清单函数会丢掉空串)。
    if (isEdit) payload = pickEditableDatasourceFields(payload).picked;
    setSaving(true);
    try {
      const url = isEdit ? `/api/datasources/${editing.datasourceId}` : "/api/datasources";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (data.success !== false && res.ok) {
        setProvisionResult(data.data || data);
        if (isEdit) onSuccess("updated");
        else setStep(2);
      } else {
        message.error(data.error?.message || t("创建失败，请检查配置"));
      }
    } catch (e: any) {
      message.error(e.message);
    } finally { setSaving(false); }
  };

  const handleRdsSelect = (instance: any) => {
    const engineMap: Record<string, string> = { mysql: "mysql", postgres: "postgresql", oracle: "oracle" };
    form.setFieldsValue({
      host: instance.endpoint,
      port: instance.port,
      type: engineMap[instance.engine] || instance.engine,
      database: instance.database || "",
      rdsSecretArn: instance.masterUserSecretArn || "",
      username: "",
      password: "",
    });
  };

  return (
    <Modal title={isEdit ? t("编辑数据源") : t("新建数据源")} open={open} width={680} onCancel={onClose}
      afterOpenChange={(o) => { if (o) { form.setFieldsValue(editing || {}); setStep(0); setTestResult(null); setProvisionResult(null); } else form.resetFields(); }}
      footer={step === 2 ? [<Button key="done" type="primary" onClick={() => onSuccess("created")}>{t("完成")}</Button>] : [
        step > 0 && step < 2 && <Button key="back" onClick={() => setStep(step - 1)}>{t("上一步")}</Button>,
        step === 0 && <Button key="next" type="primary" onClick={async () => { try { await form.validateFields(["name", "type"]); setStep(1); } catch { /* fields show inline errors */ } }}>{t("下一步")}</Button>,
        step === 1 && (isJdbc || isDynamo || isS3) && <Button key="test" onClick={handleTest} loading={testing}>{t("测试连接")}</Button>,
        step === 1 && <Button key="save" type="primary" onClick={handleSubmit} loading={saving}>{isEdit ? t("保存") : isKinesis && kinesisMode === "new" ? t("创建流并注册") : t("创建数据源")}</Button>,
      ].filter(Boolean)}>

      <Steps current={step} size="small" style={{ marginBottom: 24 }}
        items={[{ title: t("基本信息") }, { title: t("连接配置") }, { title: isEdit ? t("完成") : t("资源创建") }]} />

      <Form form={form} layout="vertical" style={{ minHeight: 300 }} preserve>
        <div style={{ display: step === 0 ? undefined : "none" }}>
          <Form.Item name="name" label={t("数据源名称")} rules={[{ required: true, message: t("请输入名称") }]}>
            <Input placeholder={t("例如：电商业务库")} />
          </Form.Item>
          <Form.Item name="type" label={t("数据库类型")} rules={[{ required: true }]}>
            <Select onChange={(v) => {
              const opt = DS_TYPE_OPTIONS.find((o) => o.value === v);
              if (opt) form.setFieldValue("port", opt.defaultPort);
            }}>
              {DS_TYPE_OPTIONS.map((o) => (
                <Select.Option key={o.value} value={o.value}>
                  <Space>{o.icon} {o.label}</Space>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="env" label={t("环境")}>
            <Radio.Group>
              <Radio.Button value="dev">{t("开发")}</Radio.Button>
              <Radio.Button value="staging">{t("预发")}</Radio.Button>
              <Radio.Button value="prod">{t("生产")}</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </div>

        <div style={{ display: step === 1 ? undefined : "none" }}>
          {/* Kinesis(stream 范式)专属连接区——选已有流 / 新建流。不走 JDBC 的 host/port/db+网络。 */}
          {isKinesis && (
            <div>
              <div style={{ marginBottom: 16 }}>
                <Radio.Group value={kinesisMode} onChange={(e) => {
                  setKinesisMode(e.target.value);
                  form.setFieldValue("streamName", undefined); // 切模式清空,避免误带
                  if (e.target.value === "existing") loadKinesisStreams(); // 进"已有"即拉列表
                }}>
                  <Radio.Button value="existing">{t("使用已有流")}</Radio.Button>
                  <Radio.Button value="new">➕ {t("新建 Kinesis 流")}</Radio.Button>
                </Radio.Group>
              </div>
              <Form.Item name="streamName" label={t("流名称")}
                rules={kinesisMode === "new"
                  ? [{ required: true, message: t("请输入流名称") }, { pattern: /^[a-zA-Z0-9_.-]{1,128}$/, message: t("仅允许 字母/数字/_.-,≤128 字符") }]
                  : [{ required: true, message: t("请选择一个已有的 Kinesis 流") }]}>
                {kinesisMode === "new" ? (
                  <Input placeholder={t("将新建此流,例如:orders-stream")} />
                ) : (
                  // 「使用已有流」:下拉自动列出账号已有流,选即可(免手敲)。可搜索;带刷新。
                  <Select showSearch loading={loadingStreams} placeholder={t("从账号已有的 Kinesis 流中选择")}
                    notFoundContent={loadingStreams ? t("加载中…") : t("账号内暂无 Kinesis 流(可切「新建」创建)")}
                    options={existingStreams.map((s) => ({ label: s, value: s }))}
                    optionFilterProp="label" />
                )}
              </Form.Item>
              <Form.Item name="region" label={t("区域(留空用平台默认)")}>
                <Input placeholder="us-east-1" />
              </Form.Item>
              {kinesisMode === "new" ? (
                <>
                  <Form.Item name="shardCount" label={t("分片数(Shard,默认 1)")} initialValue={1}>
                    <InputNumber min={1} max={10} style={{ width: 120 }} />
                  </Form.Item>
                  <Alert type="warning" showIcon style={{ marginTop: 4 }}
                    message={t("将创建一个新的 Kinesis 流(常驻计费)")}
                    description={t("点「创建数据源」后,平台会真实创建此 Kinesis 流并等待其就绪(约数十秒),然后自动注册为数据源。Kinesis 流按分片小时计费(常驻),请确认需要后再创建。")} />
                </>
              ) : (
                <Alert type="info" showIcon style={{ marginTop: 4 }}
                  message={t("注册一个已存在的 Kinesis 流为数据源")}
                  description={t("填写已存在流的名称;平台会用执行角色探测其可达性(DescribeStreamSummary)。若流不存在或无权限,状态将标记为错误。")} />
              )}
              {testResult && (
                <Alert type={testResult.success ? "success" : "error"} style={{ marginTop: 16 }}
                  message={testResult.success ? t("连接测试通过") : t("连接测试失败")}
                  description={<div style={{ fontSize: 12 }}>{testResult.steps?.map((s: any, i: number) => (
                    <div key={i}>{s.status === "pass" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> : <CloseCircleOutlined style={{ color: "#ff4d4f" }} />} {s.name}: {s.message}</div>
                  ))}</div>} />
              )}
            </div>
          )}
          {/* MSK / Kafka(stream 范式)专属连接区——托管(选集群)/自建(手填 bootstrap)+ 认证(IAM/SCRAM)。 */}
          {isMsk && (
            <div>
              <div style={{ marginBottom: 16 }}>
                <span style={{ color: "#888", marginRight: 8 }}>{t("连接方式")}:</span>
                <Radio.Group value={mskFlavor} onChange={(e) => {
                  const f = e.target.value; setMskFlavor(f);
                  if (f === "self" && mskAuth === "iam") setMskAuth("scram"); // 自建不支持 IAM
                  if (f === "msk") loadMskClusters();
                }}>
                  <Radio.Button value="msk">{t("MSK 托管集群")}</Radio.Button>
                  <Radio.Button value="self">{t("自建 Kafka")}</Radio.Button>
                </Radio.Group>
              </div>
              {mskFlavor === "msk" ? (
                <Form.Item name="clusterArn" label={t("MSK 集群")}
                  rules={[{ required: true, message: t("请选择一个 MSK 集群") }]}>
                  <Select showSearch loading={loadingClusters} placeholder={t("从账号已有的 MSK 集群中选择")}
                    notFoundContent={loadingClusters ? t("加载中…") : t("账号内暂无 MSK 集群")}
                    optionFilterProp="label"
                    onChange={(arn) => {
                      // 选中集群 → 若该集群只开了一种认证,自动选上(智能约束)。
                      const c = mskClusters.find((x) => x.arn === arn);
                      if (c && c.auth.length === 1) setMskAuth(c.auth[0] as any);
                    }}
                    options={mskClusters.map((c) => ({
                      label: `${c.name}${c.state ? `(${c.state})` : ""}${c.auth.length ? ` · ${c.auth.join("/")}` : ""}`,
                      value: c.arn,
                    }))} />
                </Form.Item>
              ) : (
                <Form.Item name="bootstrapServers" label={t("bootstrap.servers(逗号分隔的 host:port)")}
                  rules={[{ required: true, message: t("请输入 bootstrap.servers") }]}>
                  <Input placeholder="b-1.xxx:9096,b-2.xxx:9096" />
                </Form.Item>
              )}
              <Form.Item label={t("认证方式")} style={{ marginBottom: 12 }}>
                <Radio.Group value={mskAuth} onChange={(e) => setMskAuth(e.target.value)}>
                  {mskFlavor === "msk" && <Radio.Button value="iam">{t("IAM 角色(无需密钥)")}</Radio.Button>}
                  <Radio.Button value="scram">SASL/SCRAM</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {mskAuth === "scram" && (
                <Space size={12}>
                  <Form.Item name="mskUsername" label={t("用户名")} rules={[{ required: true }]} style={{ marginBottom: 8, width: 240 }}>
                    <Input placeholder={t("SCRAM 用户名")} />
                  </Form.Item>
                  <Form.Item name="mskPassword" label={t("密码")} rules={[{ required: true }]} style={{ marginBottom: 8, width: 240 }}>
                    <Input.Password placeholder={t("SCRAM 密码(存 Secrets Manager,不入库)")} />
                  </Form.Item>
                </Space>
              )}
              <Form.Item name="region" label={t("区域(留空用平台默认)")} style={{ marginBottom: 8 }}>
                <Input placeholder="us-east-1" />
              </Form.Item>
              <Alert type="info" showIcon style={{ marginTop: 4 }}
                message={mskFlavor === "msk" ? t("注册一个 MSK 托管集群为数据源") : t("注册一个自建 Kafka 为数据源")}
                description={mskAuth === "iam"
                  ? t("IAM 认证无需密钥,用执行角色访问。broker 在私有 VPC,作业消费时需选 VPC 子网+安全组。topic 在建作业时指定。")
                  : t("SASL/SCRAM 账密将存入 Secrets Manager(不入库)。broker 在私有 VPC,作业消费时需选 VPC 子网+安全组。topic 在建作业时指定。")} />
            </div>
          )}
          {/* DynamoDB(NoSQL 范式)专属连接区——表名 + 区域。iam-role 无密钥,不走 host/port/db+网络。 */}
          {isDynamo && (
            <div>
              <Form.Item name="tableName" label={t("表名")}
                rules={[{ required: true, message: t("请输入 DynamoDB 表名") }, { pattern: /^[a-zA-Z0-9_.-]{3,255}$/, message: t("仅允许 字母/数字/_.-,长度 3~255") }]}>
                <Input placeholder={t("例如:GameScores")} />
              </Form.Item>
              <Form.Item name="region" label={t("区域(留空用平台默认)")}>
                <Input placeholder="us-east-1" />
              </Form.Item>
              <Alert type="info" showIcon style={{ marginTop: 4 }}
                message={t("注册一个 DynamoDB 表为数据源")}
                description={t("IAM 认证无需密钥,用执行角色访问(DescribeTable/Scan)。DynamoDB 无固定 schema,浏览表时通过采样一批 item 推断属性列。可经 Glue 批读入湖仓(Redshift / S3Tables)。")} />
              {testResult && (
                <Alert type={testResult.success ? "success" : "error"} style={{ marginTop: 16 }}
                  message={testResult.success ? t("连接测试通过") : t("连接测试失败")}
                  description={<div style={{ fontSize: 12 }}>{testResult.steps?.map((s: any, i: number) => (
                    <div key={i}>{s.status === "pass" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> : <CloseCircleOutlined style={{ color: "#ff4d4f" }} />} {s.name}: {s.message}</div>
                  ))}</div>} />
              )}
            </div>
          )}
          {/* S3(对象存储范式)专属连接区——桶 + 前缀 + 格式。iam-role 无密钥。 */}
          {isS3 && (
            <div>
              <Form.Item name="bucket" label={t("桶名(Bucket)")}
                rules={[{ required: true, message: t("请输入 S3 桶名") }, { pattern: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, message: t("桶名不合法(小写字母/数字/.-,长度 3~63)") }]}>
                <Input placeholder={t("例如:my-data-lake")} />
              </Form.Item>
              <Form.Item name="prefix" label={t("前缀(Prefix,留空=桶根)")}>
                <Input placeholder="raw/events/" />
              </Form.Item>
              <Space size={12}>
                <Form.Item name="format" label={t("文件格式")} initialValue="auto" style={{ width: 200 }}>
                  <Select options={[
                    { label: t("自动识别"), value: "auto" },
                    { label: "CSV", value: "csv" },
                    { label: "Parquet", value: "parquet" },
                    { label: "JSON", value: "json" },
                  ]} />
                </Form.Item>
                <Form.Item name="region" label={t("区域(留空用平台默认)")} style={{ width: 200 }}>
                  <Input placeholder="us-east-1" />
                </Form.Item>
              </Space>
              <Form.Item name="hasHeader" label={t("CSV 首行为表头")} initialValue={true} valuePropName="checked">
                <Radio.Group>
                  <Radio.Button value={true}>{t("是")}</Radio.Button>
                  <Radio.Button value={false}>{t("否")}</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Alert type="info" showIcon style={{ marginTop: 4 }}
                message={t("注册一个 S3 路径为数据源")}
                description={t("IAM 认证无需密钥,用执行角色访问(HeadBucket/ListObjects)。浏览时按一级子前缀分组为逻辑数据集,CSV 采样文件头推断列。可经 Athena 建外部表直查,或 Glue 读入湖仓。")} />
              {testResult && (
                <Alert type={testResult.success ? "success" : "error"} style={{ marginTop: 16 }}
                  message={testResult.success ? t("连接测试通过") : t("连接测试失败")}
                  description={<div style={{ fontSize: 12 }}>{testResult.steps?.map((s: any, i: number) => (
                    <div key={i}>{s.status === "pass" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> : <CloseCircleOutlined style={{ color: "#ff4d4f" }} />} {s.name}: {s.message}</div>
                  ))}</div>} />
              )}
            </div>
          )}
          {isJdbc && (<>
          <div style={{ marginBottom: 16 }}>
            <Radio.Group value={connectMode} onChange={(e) => { setConnectMode(e.target.value); if (e.target.value === "rds") loadRdsInstances(); }}>
              <Radio.Button value="manual">{t("手动输入")}</Radio.Button>
              <Radio.Button value="rds"><CloudServerOutlined /> {t("从 RDS 选择")}</Radio.Button>
            </Radio.Group>
          </div>

          {connectMode === "rds" && (
            <div style={{ marginBottom: 16, maxHeight: 160, overflow: "auto", border: "1px solid #1d4254", borderRadius: 8, padding: 8 }}>
              {loadingRds ? <Spin /> : rdsInstances.length > 0 ? rdsInstances.map((inst) => (
                <div key={inst.identifier} onClick={() => handleRdsSelect(inst)}
                  style={{ padding: "8px 12px", cursor: "pointer", borderRadius: 6, marginBottom: 4, border: "1px solid #1d4254", background: form.getFieldValue("host") === inst.endpoint ? "rgba(34, 211, 238, 0.14)" : "transparent" }}>
                  <Space>
                    <b>{inst.identifier}</b>
                    <Tag>{inst.engine} {inst.engineVersion}</Tag>
                    <Tag color={inst.isPublic ? "red" : "green"}>{inst.isPublic ? t("公网") : t("私有")}</Tag>
                  </Space>
                  <div style={{ fontSize: 12, color: "#888" }}>{inst.endpoint}:{inst.port}</div>
                </div>
              )) : <div style={{ color: "#999", textAlign: "center", padding: 20 }}>{t("未发现 RDS 实例")}</div>}
            </div>
          )}

          <Space size={12} style={{ width: "100%" }} direction="vertical">
            <Space size={12}>
              <Form.Item name="host" label={t("主机地址")} rules={[{ required: true, message: t("请输入主机地址") }, { pattern: /^[^\s]+$/, message: t("主机地址不能包含空格") }]} style={{ marginBottom: 0, width: 360 }}>
                <Input placeholder="xxx.rds.amazonaws.com" />
              </Form.Item>
              <Form.Item name="port" label={t("端口")} rules={[{ required: true, message: t("请输入端口") }, { type: "number", min: 1, max: 65535, message: t("端口范围 1-65535") }]} style={{ marginBottom: 0, width: 100 }}>
                <InputNumber style={{ width: "100%" }} min={1} max={65535} />
              </Form.Item>
            </Space>
            <Form.Item name="database" label={t("数据库名")} rules={[{ required: true }]}>
              <Input placeholder="ecommerce" />
            </Form.Item>
            {/* (用户 2026-10-15 反馈 ③「数据源缺少 JDBC 连接参数化配置」)—— 形态校验与服务端同一函数 parseJdbcParams */}
            <Form.Item name="jdbcParams" label={t("附加 JDBC 连接参数(可选)")} data-testid="ds-jdbc-params-item"
              tooltip={t("驱动级连接参数,形如 useSSL=false&serverTimezone=Asia/Shanghai&connectTimeout=10000。只作用于经 Glue 连接 / Glue 作业的 JDBC 连接(同步、表发现);控制面直连探测不读它。MySQL 默认已带 zeroDateTimeBehavior=CONVERT_TO_NULL(零值日期 / 时间戳按 NULL 读入,不让整个同步作业失败),填同名参数可覆盖。")}
              rules={[{ validator: (_, v) => { const r = parseJdbcParams(v); return r.ok ? Promise.resolve() : Promise.reject(new Error(r.error)); } }]}>
              <Input placeholder="useSSL=false&serverTimezone=Asia/Shanghai" allowClear data-testid="ds-jdbc-params" />
            </Form.Item>
            {/* 源在自己的 VPC 时控制面直连不到(客户生产环境),探测与浏览表改走数据源自己的 Glue 连接 */}
            <Form.Item name="probeVia" label={t("探测与浏览表方式")} initialValue="auto"
              tooltip={t("「自动」先用平台控制面直连,连不上且有 Glue 连接时自动改经 Glue 连接(起一次性 Glue 作业在该连接的子网 / 安全组里登录源库并读表结构,约 1–3 分钟)。源在自有网络、与平台不在同一 VPC 时建议直接选「仅经 Glue 连接」。")}>
              <Radio.Group data-testid="ds-probe-via" options={[
                { label: t("自动(先直连,不通再经 Glue 连接)"), value: "auto" },
                { label: t("仅经 Glue 连接(源在自有网络)"), value: "glue-connection" },
              ]} />
            </Form.Item>
            {connectMode === "rds" && form.getFieldValue("rdsSecretArn") ? (
              <Alert type="info" message={t("凭证将自动从 RDS Secrets Manager 读取，无需手动输入")} showIcon />
            ) : (
              <Space size={12}>
                <Form.Item name="username" label={t("用户名")} rules={[{ required: connectMode === "manual" }]} style={{ marginBottom: 0, width: 240 }}>
                  <Input />
                </Form.Item>
                <Form.Item name="password" label={t("密码")} rules={[{ required: connectMode === "manual" && !isEdit }]} style={{ marginBottom: 0, width: 240 }}>
                  <Input.Password placeholder={isEdit ? t("不修改请留空") : ""} />
                </Form.Item>
              </Space>
            )}
          </Space>
          <Form.Item name="rdsSecretArn" hidden><Input /></Form.Item>

          {testResult && (
            <Alert type={testResult.success ? "success" : "error"} style={{ marginTop: 16 }}
              message={testResult.success ? t("连接测试通过") : t("连接测试失败")}
              description={
                <div style={{ fontSize: 12 }}>
                  {testResult.steps?.map((s: any, i: number) => (
                    <div key={i}>
                      {s.status === "pass" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> : <CloseCircleOutlined style={{ color: "#ff4d4f" }} />}
                      {" "}{s.name}: {s.message} {s.latencyMs ? `(${s.latencyMs}ms)` : ""}
                    </div>
                  ))}
                  {testResult.totalMs > 0 && <div style={{ marginTop: 4 }}>{t("总耗时: {ms}ms", { ms: testResult.totalMs })}</div>}
                </div>
              }
            />
          )}

          {/* 网络接入(可选)——数据库在 VPC 内(如 RDS)时,Glue 连接需接入其网络。
              留空=平台自动探测(RDS 从子网组自动识别);也可手动选或用网络顾问建议。不改数据库连接信息。 */}
          {!isEdit && (
            <div style={{ marginTop: 16, border: "1px dashed #2a4a5c", borderRadius: 8, padding: 12 }}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>{t("网络接入(可选)")}</div>
              <div style={{ color: "#888", fontSize: 12, marginBottom: 10 }}>
                {t("数据库在 VPC 内时,Glue 连接需接入其网络。留空=平台自动探测(RDS 场景自动识别子网);也可手动指定或用下方网络顾问获取建议。创建后也可在「网络配置」调整。")}
              </div>
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Space wrap>
                  <span style={{ color: "#888", fontSize: 12 }}>VPC:</span>
                  <Select size="small" value={netVpc} style={{ width: 240 }} placeholder={t("自动探测(可手动选)")} showSearch optionFilterProp="label" allowClear
                    onChange={(v) => { setNetVpc(v); setNetSubnetId(undefined); setNetSgIds([]); }}
                    options={netVpcs.map((x: any) => ({ label: `${x.name || x.id}(${x.cidr})`, value: x.id }))} />
                </Space>
                <Select size="small" value={netSubnetId} style={{ width: "100%" }} placeholder={t("私有子网(留空自动探测)")} showSearch optionFilterProp="label" allowClear
                  onChange={(v) => setNetSubnetId(v)}
                  options={netSubnets.filter((s: any) => !netVpc || s.vpcId === netVpc).map((s: any) => ({ label: `${s.name || s.id} · ${s.az}${s.isPrivate ? ` · ${t("私有")}` : ""}`, value: s.id }))} />
                <Select size="small" mode="multiple" value={netSgIds} style={{ width: "100%" }} placeholder={t("安全组(留空自动探测)")} showSearch optionFilterProp="label"
                  onChange={(v) => setNetSgIds(v)}
                  options={netSgs.filter((g: any) => !netVpc || g.vpcId === netVpc).map((g: any) => ({ label: `${g.name}(${g.id})`, value: g.id }))} />
                {watchHost ? (
                  <NetworkAdvisorPanel
                    targetIds={[String(netTarget)]}
                    request={{ computeKind: "glue", targets: [{ kind: "aws-service", service: "s3" }], constraints: { preferPrivate: true } }}
                    title={t("网络连通性顾问")}
                    onPrefill={(p) => {
                      const subs = p.channel === "glue" ? (p.subnetId ? [p.subnetId] : []) : p.channel === "generic" ? (p.subnetIds || []) : [];
                      const sgs = p.channel === "glue" ? (p.securityGroupIdList || []) : p.channel === "generic" ? (p.securityGroupIds || []) : [];
                      if (subs[0]) { setNetSubnetId(subs[0]); const f = netSubnets.find((s: any) => s.id === subs[0]); if (f) setNetVpc(f.vpcId); }
                      if (sgs.length) setNetSgIds(sgs);
                      if (subs[0] || sgs.length) message.success(t("已应用建议到上方网络选择"));
                    }}
                  />
                ) : null}
              </Space>
            </div>
          )}
          </>)}
        </div>

        {step === 2 && isKinesis && (
          <Result status="success" title={t("Kinesis 数据源创建成功")}
            subTitle={provisionResult?.provisionNote || t("已注册为数据源,可在实时计算作业中作为源选用")}
            extra={
              <div style={{ textAlign: "left", background: "rgba(45, 212, 191, 0.1)", border: "1px solid rgba(45, 212, 191, 0.35)", padding: 16, borderRadius: 8 }}>
                <div>✅ {t("流名称")}: <Tag color="blue">{provisionResult?.connection?.streamName || form.getFieldValue("streamName")}</Tag></div>
                <div>✅ {t("凭证方式")}: <Tag>{t("IAM 角色(无需密钥)")}</Tag></div>
                <div>✅ {t("连接测试")}: <Tag color="processing"><LoadingOutlined /> {t("后台测试中...")}</Tag></div>
              </div>
            } />
        )}
        {step === 2 && isMsk && (
          <Result status="success" title={t("MSK / Kafka 数据源创建成功")}
            subTitle={t("已注册为数据源,可在实时计算作业中作为源选用")}
            extra={
              <div style={{ textAlign: "left", background: "rgba(45, 212, 191, 0.1)", border: "1px solid rgba(45, 212, 191, 0.35)", padding: 16, borderRadius: 8 }}>
                <div>✅ {t("连接方式")}: <Tag color="blue">{mskFlavor === "msk" ? t("MSK 托管集群") : t("自建 Kafka")}</Tag></div>
                <div>✅ {t("认证方式")}: <Tag>{mskAuth === "iam" ? t("IAM 角色(无需密钥)") : "SASL/SCRAM"}</Tag>{mskAuth === "scram" && <Tag color="blue">Secrets Manager</Tag>}</div>
                <div>✅ {t("连接测试")}: <Tag color="processing"><LoadingOutlined /> {t("后台测试中...")}</Tag></div>
              </div>
            } />
        )}
        {step === 2 && isDynamo && (
          <Result status="success" title={t("DynamoDB 数据源创建成功")}
            subTitle={t("已注册为数据源,可浏览采样属性并经 Glue 批读入湖仓")}
            extra={
              <div style={{ textAlign: "left", background: "rgba(45, 212, 191, 0.1)", border: "1px solid rgba(45, 212, 191, 0.35)", padding: 16, borderRadius: 8 }}>
                <div>✅ {t("表名")}: <Tag color="blue">{provisionResult?.connection?.tableName || form.getFieldValue("tableName")}</Tag></div>
                <div>✅ {t("凭证方式")}: <Tag>{t("IAM 角色(无需密钥)")}</Tag></div>
                <div>✅ {t("连接测试")}: <Tag color="processing"><LoadingOutlined /> {t("后台测试中...")}</Tag></div>
              </div>
            } />
        )}
        {step === 2 && isS3 && (
          <Result status="success" title={t("S3 数据源创建成功")}
            subTitle={t("已注册为数据源,可经 Athena 外部表直查或 Glue 读入湖仓")}
            extra={
              <div style={{ textAlign: "left", background: "rgba(45, 212, 191, 0.1)", border: "1px solid rgba(45, 212, 191, 0.35)", padding: 16, borderRadius: 8 }}>
                <div>✅ {t("路径")}: <Tag color="blue">s3://{provisionResult?.connection?.bucket || form.getFieldValue("bucket")}/{provisionResult?.connection?.prefix || form.getFieldValue("prefix") || ""}</Tag></div>
                <div>✅ {t("凭证方式")}: <Tag>{t("IAM 角色(无需密钥)")}</Tag></div>
                <div>✅ {t("连接测试")}: <Tag color="processing"><LoadingOutlined /> {t("后台测试中...")}</Tag></div>
              </div>
            } />
        )}
        {step === 2 && isJdbc && (
          <Result status="success" title={t("数据源创建成功")} subTitle={t("以下 AWS 资源已自动创建")}
            extra={provisionResult?.provisionedResources && (
              <div style={{ textAlign: "left", background: "rgba(45, 212, 191, 0.1)", border: "1px solid rgba(45, 212, 191, 0.35)", padding: 16, borderRadius: 8 }}>
                <div>✅ {t("密码存储")}: <Tag color="blue">Secrets Manager</Tag></div>
                <div>✅ {t("网络配置")}: <Tag>VPC {provisionResult.provisionedResources.vpcId?.slice(-8)}</Tag> <Tag>SG {provisionResult.provisionedResources.securityGroupId?.slice(-8)}</Tag></div>
                <div>✅ {t("Glue 连接")}: <Tag color="green">{provisionResult.provisionedResources.glueConnectionName}</Tag></div>
                <div>✅ {t("连接测试")}: <Tag color="processing"><LoadingOutlined /> {t("后台测试中...")}</Tag></div>
              </div>
            )}
          />
        )}
      </Form>
    </Modal>
  );
}
