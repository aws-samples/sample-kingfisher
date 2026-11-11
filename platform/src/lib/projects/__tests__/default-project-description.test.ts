// 默认空间描述必须与服务端行为一致:项目准入没有隐式成员(resolveRole / listVisibleProjects),
//   早期文案「任何登录用户隐式为 editor」与行为相悖(2026-11-09 用户指南取证核到)。
//   改法 = 常量改成事实 + ensureDefaultProject 把存量库里的旧文案原地改正(条件写,管理员自己改过的不动)。
// 只 mock 真外部(DynamoDB 文档客户端)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EN } from "@/lib/i18n/messages/en";

const h = vi.hoisted(() => ({ cmds: [] as Array<{ name: string; input: any }>, existing: null as any }));
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { PROJECTS: "bgp-projects", PROJECT_MEMBERS: "bgp-project-members", APPROVALS: "bgp-approvals" },
  PROJECT_MEMBERS_BY_USER_INDEX: "byUser",
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.cmds.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") return { Item: h.existing ?? undefined };
      return {};
    }),
  },
}));

import { DEFAULT_PROJECT_DESCRIPTION, LEGACY_DEFAULT_PROJECT_DESCRIPTIONS, DEFAULT_PROJECT_ID, PROJECTS_PK } from "@/lib/projects/constants";
import { ensureDefaultProject } from "@/lib/projects/project-service";

const LEGACY = "平台默认工作空间（承载历史资源；任何登录用户隐式为 editor）";
const row = (description: string) => ({ pk: PROJECTS_PK, projectId: DEFAULT_PROJECT_ID, name: "默认空间", description, system: true, createdAt: "2026-11-09T02:07:45.846Z", updatedAt: "2026-11-09T02:07:45.846Z" });

describe("默认空间描述与行为一致", () => {
  beforeEach(() => { h.cmds.length = 0; h.existing = null; });

  it("常量说的是事实:无隐式成员、成员由平台管理员添加;旧文案只在遗留清单里", () => {
    expect(DEFAULT_PROJECT_DESCRIPTION).not.toContain("隐式");
    expect(DEFAULT_PROJECT_DESCRIPTION).toContain("管理员");
    expect(LEGACY_DEFAULT_PROJECT_DESCRIPTIONS).toContain(LEGACY);
    expect(LEGACY_DEFAULT_PROJECT_DESCRIPTIONS).not.toContain(DEFAULT_PROJECT_DESCRIPTION);
    expect(EN[DEFAULT_PROJECT_DESCRIPTION]).toBeTruthy();
    expect(EN[DEFAULT_PROJECT_DESCRIPTION]).not.toMatch(/implicit/);
  });

  it("没有默认空间 ⇒ 建出来的行写现行文案", async () => {
    const p = await ensureDefaultProject();
    const put = h.cmds.find((c) => c.name === "PutCommand");
    expect(put?.input.Item.description).toBe(DEFAULT_PROJECT_DESCRIPTION);
    expect(p.description).toBe(DEFAULT_PROJECT_DESCRIPTION);
  });

  it("存量行还是旧文案 ⇒ 条件更新成现行文案(只在仍是那句旧文案时改),回值已是新文案", async () => {
    h.existing = row(LEGACY);
    const p = await ensureDefaultProject();
    const upd = h.cmds.find((c) => c.name === "UpdateCommand");
    expect(upd, "没有发出 UpdateCommand").toBeTruthy();
    expect(upd!.input.Key).toEqual({ pk: PROJECTS_PK, projectId: DEFAULT_PROJECT_ID });
    expect(upd!.input.ConditionExpression).toBe("description = :old");
    expect(upd!.input.ExpressionAttributeValues[":old"]).toBe(LEGACY);
    expect(upd!.input.ExpressionAttributeValues[":d"]).toBe(DEFAULT_PROJECT_DESCRIPTION);
    expect(p.description).toBe(DEFAULT_PROJECT_DESCRIPTION);
    expect(h.cmds.some((c) => c.name === "PutCommand")).toBe(false);
  });

  it("管理员自己改过描述 ⇒ 一字不动(不发 Update / Put)", async () => {
    h.existing = row("我们团队的公共空间");
    const p = await ensureDefaultProject();
    expect(p.description).toBe("我们团队的公共空间");
    expect(h.cmds.map((c) => c.name)).toEqual(["GetCommand"]);
  });

  it("已是现行文案 ⇒ 不再写", async () => {
    h.existing = row(DEFAULT_PROJECT_DESCRIPTION);
    await ensureDefaultProject();
    expect(h.cmds.map((c) => c.name)).toEqual(["GetCommand"]);
  });
});
