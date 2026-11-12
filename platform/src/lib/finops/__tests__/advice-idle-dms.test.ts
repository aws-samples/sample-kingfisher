// 成本建议 R1「DMS 复制实例空转」钉用户看到的事实:
//   · 只有 available 且无 running 任务的实例才算空转(建议正文说明平台会在零任务 + 空闲宽限后自动回收,并指路删任务);
//   · 正在删除中(后台回收已发出)/ 正在创建中的实例**不**列为空转 —— 真环境回收后的几分钟里曾把 deleting 的实例误报成「仍计费」。
// 只 mock 真外部(DMS 客户端工厂、DynamoDB 文档客户端)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  instances: [] as Array<{ ReplicationInstanceIdentifier: string; ReplicationInstanceStatus: string; ReplicationInstanceClass: string }>,
  tasks: [] as Array<{ Status: string }>,
}));

vi.mock("@/lib/exec-env/target-clients", () => ({
  dmsClientFor: async () => ({
    send: async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "DescribeReplicationInstancesCommand") return { ReplicationInstances: h.instances };
      if (cmd.constructor.name === "DescribeReplicationTasksCommand") return { ReplicationTasks: h.tasks };
      throw new Error("unexpected " + cmd.constructor.name);
    },
  }),
}));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: async () => ({ Items: [] }) } };
});

import { listAdvice } from "@/lib/finops/advice";

const inst = (status: string) => ({ ReplicationInstanceIdentifier: "bgp-dms", ReplicationInstanceStatus: status, ReplicationInstanceClass: "dms.t3.small" });
const idle = async () => (await listAdvice(["us-east-1"])).filter((a) => a.ruleId === "idle-dms-instance");

beforeEach(() => { h.instances = []; h.tasks = []; });

describe("成本建议 R1:只有 available 且无 running 任务的复制实例才算空转", () => {
  it("available + 零 running 任务 ⇒ 一条建议,正文说明自动回收策略(空闲宽限分钟数)并指路删任务与后台清理任务", async () => {
    h.instances = [inst("available")]; h.tasks = [{ Status: "stopped" }];
    const rows = await idle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ region: "us-east-1", resource: "bgp-dms", severity: "high" });
    expect(rows[0].detail).toContain("10 分钟空闲宽限后自动回收");
    expect(rows[0].detail).toContain("删除不再需要的实时同步任务");
    expect(rows[0].detail).toContain("后台清理任务");
  });

  it("available + 有 running 任务 ⇒ 不是空转", async () => {
    h.instances = [inst("available")]; h.tasks = [{ Status: "running" }];
    expect(await idle()).toHaveLength(0);
  });

  it("deleting(后台回收已发出)⇒ 不列为空转;creating(马上要挂任务)⇒ 也不列", async () => {
    h.instances = [inst("deleting")];
    expect(await idle()).toHaveLength(0);
    h.instances = [inst("creating")];
    expect(await idle()).toHaveLength(0);
  });
});
