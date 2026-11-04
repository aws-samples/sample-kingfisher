// @kf-batch 42-ux-feedback —— 数据源可编辑字段闭合清单(用户 2026-10-15 反馈 ①「编辑数据源改名报错」)。
// 钉三件事:① 整条记录回显(主键 / 租户 / 服务端字段)全部被丢、只剩可编辑字段;② undefined 与空密码丢弃(「没填」≠「清空」);
// ③ 清单本身闭合:不含任何服务端字段名(datasourceId / userId / updatedAt / createdAt / status / secretArn / glueConnectionName / networkConfig / heartbeat / discovery / ownerTargetId)。
import { describe, it, expect } from "vitest";
import { DS_EDITABLE_FIELDS, pickEditableDatasourceFields } from "../editable-fields";

const RECORD_ECHO = {
  // 2026-10-15 …7698 真环境:编辑弹窗 PUT 回来的就是这一整条(字段名照抄,值是夹具)
  userId: "default", datasourceId: "01M4Z0AHBYF5Y28STSE1TKS7EG", name: "p42-rename-x-renamed", type: "mysql",
  host: "db.example.internal", port: 3306, database: "ecommerce", username: "app", password: "", jdbcParams: "useSSL=false",
  env: "dev", tags: ["a"], status: "active", createdAt: "2026-10-15T05:24:57.000Z", updatedAt: "2026-10-15T05:24:57.567Z",
  secretArn: "arn:aws:secretsmanager:us-east-1:acct0000ab42:secret:x", glueConnectionName: "bgp-ds-x", ownerTargetId: "tgt_home",
  networkConfig: { subnetId: "subnet-a", securityGroupId: "sg-a" }, heartbeat: { ok: true }, discovery: { status: "done" }, discoveredSchema: [],
  paradigm: "jdbc", credentialKind: "userpass", probeVia: "auto", createdBy: "admin", createdBySub: "sub-x", projectId: "proj-default",
  rdsSecretArn: undefined,
};

describe("① 整条记录回显 ⇒ 只剩可编辑字段", () => {
  it("主键 / 租户 / 服务端字段全部丢弃并点名;name / type / host / port / database / username / jdbcParams / env / tags / probeVia 留下", () => {
    const { picked, dropped } = pickEditableDatasourceFields(RECORD_ECHO);
    expect(Object.keys(picked).sort()).toEqual(["database", "env", "host", "jdbcParams", "name", "port", "probeVia", "tags", "type", "username"]); // 序 44:附加 JDBC 参数可编辑
    expect(picked.name).toBe("p42-rename-x-renamed");
    for (const k of ["datasourceId", "userId", "updatedAt", "createdAt", "status", "secretArn", "glueConnectionName", "ownerTargetId", "networkConfig", "heartbeat", "discovery", "discoveredSchema", "paradigm", "credentialKind", "createdBy", "createdBySub", "projectId"]) {
      expect(dropped, `${k} 必须被丢弃`).toContain(k);
      expect(picked).not.toHaveProperty(k);
    }
  });
  it("空密码 / undefined 不算写意图(password 留空 = 不改密码;rdsSecretArn: undefined 不进 DynamoDB)", () => {
    const { picked, dropped } = pickEditableDatasourceFields(RECORD_ECHO);
    expect(picked).not.toHaveProperty("password");
    expect(dropped).toContain("rdsSecretArn"); // 不在清单 ⇒ 丢
    const { picked: p2 } = pickEditableDatasourceFields({ name: "n", password: "s3cret-fixture", host: undefined });
    expect(p2).toEqual({ name: "n", password: "s3cret-fixture" });
  });
  it("非 JDBC 范式的连接袋与网络接入保留;null / 非对象输入 ⇒ 空", () => {
    const { picked } = pickEditableDatasourceFields({ connection: { bucket: "b" }, network: { subnetId: "s", securityGroupIds: ["g"] }, zzz: 1 });
    expect(picked).toEqual({ connection: { bucket: "b" }, network: { subnetId: "s", securityGroupIds: ["g"] } });
    expect(pickEditableDatasourceFields(null)).toEqual({ picked: {}, dropped: [] });
    expect(pickEditableDatasourceFields(undefined)).toEqual({ picked: {}, dropped: [] });
  });
});

describe("③ 清单闭合", () => {
  it("清单里没有任何服务端 / 主键字段;条目唯一", () => {
    const banned = ["datasourceId", "userId", "updatedAt", "createdAt", "status", "secretArn", "glueConnectionName", "networkConfig", "heartbeat", "discovery", "discoveredSchema", "ownerTargetId", "projectId", "createdBy", "createdBySub", "testResult"];
    for (const b of banned) expect(DS_EDITABLE_FIELDS as readonly string[]).not.toContain(b);
    expect(new Set(DS_EDITABLE_FIELDS).size).toBe(DS_EDITABLE_FIELDS.length);
  });
});
