// 接线判据(「写了」≠「接上了」):发布到环境的可发现性改造必须真的挂到每个入口页上。
//   读源文件钉调用点,不钉样式。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("PromoteButton(发布到环境)", () => {
  const s = read("components/common/PromoteButton.tsx");
  it("按钮与菜单项有 testid;成功后给「切到目标环境查看」;待审批给「去项目空间审批」;广播 bgp:promoted", () => {
    expect(s).toContain('data-testid="promote-btn"');
    expect(s).toContain("data-testid={`promote-to-${e}`}");
    expect(s).toContain('data-testid="promote-goto-env"');
    expect(s).toContain('"data-testid": "promote-goto-approvals"');
    expect(s).toContain("export function gotoEnvResource");
    expect(s).toContain('export const PROMOTED_EVENT = "bgp:promoted"');
    expect(s).toMatch(/notification\.success\(/);
    expect(s).not.toMatch(/t\("晋升"\)/);
  });
});

describe("四类资源详情都挂了环境标签与各环境发布状态;同步任务新增发布入口", () => {
  const mounts: Array<[string, string]> = [
    ["app/etl-jobs/page.tsx", 'type="etl-job"'],
    ["app/workflow/[id]/page.tsx", 'type="workflow"'],
    ["components/engines/EmrJobPanel.tsx", 'type="engine-job"'],
    ["app/sync/[id]/page.tsx", 'type="sync"'],
  ];
  for (const [file, typeAttr] of mounts) {
    it(file, () => {
      const s = read(file);
      expect(s).toContain("<EnvTag env=");
      expect(s).toContain(`<EnvPromotionStatus ${typeAttr}`);
      expect(s).toContain(`<PromoteButton ${typeAttr}`);
    });
  }
  it("编排页的「发布」改叫「发布到调度」,与「发布到环境」区分", () => {
    const s = read("app/workflow/[id]/page.tsx");
    expect(s).toContain('t("发布到调度")');
    expect(s).not.toMatch(/>\{t\("发布"\)\}</);
  });
});

describe("审批后反馈与顶栏", () => {
  it("项目空间页两条批准路径都经 notifyPromoted(给「切到 {toEnv} 环境查看」)", () => {
    const s = read("app/projects/page.tsx");
    expect(s).toContain('data-testid="approval-goto-env"');
    expect((s.match(/notifyPromoted\(d\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(s).toContain("gotoEnvResource(");
  });
  it("顶栏环境切换器有 testid,颜色来自单一作者 ENV_COLOR(不再本地写死)", () => {
    const s = read("components/layout/Header.tsx");
    expect(s).toContain('data-testid="env-switcher"');
    expect(s).toContain('data-testid="header-env-tag"');
    expect(s).toContain("ENV_COLOR");
    expect(s).not.toMatch(/\{\s*dev:\s*"green"/);
  });
  it("lineage 路由存在且以 viewer 守卫", () => {
    const s = read("app/api/promote/lineage/route.ts");
    expect(s).toContain('guardResourceAccess(req, source, "viewer")');
    expect(s).toContain("lineageStatus(");
  });
});
