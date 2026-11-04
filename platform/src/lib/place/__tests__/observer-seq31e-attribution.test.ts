// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤ —— 观测器归因三件(纯函数,零 mock):
//   ① Query 协议操作名(EC2 / RDS 的表单体 `Action=…`)不再记成 `POST /`;
//   ② `ec2.DescribeRegions`(账号级清点)在主控区 = 控制面;别的 EC2 操作 / 别的区照常判;
//   ③ 读执行环境部署的 CodeBuild 日志组 = 控制面(决策指目标区、客户端在主控区 ⇒ 之前被记成 cross-region);别的日志组照常判。
// 判据钉**事实**(判定类别 / 抽出来的操作名),不钉形态。
import { describe, it, expect } from "vitest";
import {
  judgeCall,
  buildTargetIndex,
  requestFacts,
  queryProtocolAction,
  extractResourceIds,
  CONTROL_PLANE_OPERATIONS,
  CONTROL_PLANE_LOG_GROUPS,
  type CallFacts,
} from "@/lib/place/observer";
import { EXEC_ENV_CODEBUILD_LOG_GROUP, EXEC_ENV_PROJECT_NAME } from "@/lib/exec-env/exec-env-project-name";
import { EXEC_ENV_PROJECT_NAME as FROM_DEPLOY_CONTROL } from "@/lib/exec-env/deploy-control";

const IDX = buildTargetIndex(
  [
    { targetId: "tgt_home", region: "us-east-1", resources: {} },
    { targetId: "tgt_usw2_a", region: "us-west-2", resources: {} },
  ],
  "tgt_home"
);

function facts(p: Partial<CallFacts> & Pick<CallFacts, "service" | "operation" | "clientRegion">): CallFacts {
  return { decisions: [], view: null, resourceIds: [], ...p };
}

function fakeReq(host: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { host, ...extra };
  return { method: "POST", path: "/", host, getHeader: (n: string) => headers[n.toLowerCase()] };
}

describe("序 31 二刀 ⑤ ① Query 协议的操作名", () => {
  it("表单体 `Action=DescribeRegions&Version=…` ⇒ 操作名 DescribeRegions(此前记成 `POST /`)", () => {
    expect(queryProtocolAction("Action=DescribeRegions&Version=2016-11-15")).toBe("DescribeRegions");
    expect(queryProtocolAction("Version=2014-10-31&Action=DescribeDBInstances&MaxRecords=100")).toBe("DescribeDBInstances");
    const f = requestFacts(fakeReq("ec2.us-east-1.amazonaws.com"), "Action=DescribeRegions&Version=2016-11-15&AllRegions=false");
    expect(f).toMatchObject({ service: "ec2", operation: "DescribeRegions", clientRegion: "us-east-1" });
  });
  it("JSON / XML / 空体 ⇒ 不是 Query 协议,操作名取法不变(x-amz-target 优先)", () => {
    expect(queryProtocolAction('{"Action":"x"}')).toBeNull();
    expect(queryProtocolAction("<xml/>")).toBeNull();
    expect(queryProtocolAction(undefined)).toBeNull();
    const f = requestFacts(fakeReq("secretsmanager.us-east-1.amazonaws.com", { "x-amz-target": "secretsmanager.GetSecretValue" }), '{"SecretId":"a"}');
    expect(f?.operation).toBe("GetSecretValue");
    const g = requestFacts(fakeReq("ec2.us-east-1.amazonaws.com"), undefined);
    expect(g?.operation).toBe("POST /");
  });
});

describe("序 31 二刀 ⑤ ② ec2.DescribeRegions 是账号级清点", () => {
  it("清单里有它;主控区客户端 ⇒ control(不再 unattributed)", () => {
    expect(CONTROL_PLANE_OPERATIONS.has("ec2.DescribeRegions")).toBe(true);
    expect(judgeCall(facts({ service: "ec2", operation: "DescribeRegions", clientRegion: "us-east-1" }), IDX).kinds).toEqual(["control"]);
  });
  it("判别力:同一服务别的操作(DescribeSubnets)仍 unattributed;别的区的客户端做 DescribeRegions 也不豁免", () => {
    expect(judgeCall(facts({ service: "ec2", operation: "DescribeSubnets", clientRegion: "us-east-1" }), IDX).kinds).toEqual(["unattributed"]);
    expect(judgeCall(facts({ service: "ec2", operation: "DescribeRegions", clientRegion: "us-west-2" }), IDX).kinds).toEqual(["unattributed"]);
  });
});

describe("序 31 二刀 ⑤ ③ 读执行环境部署日志 = 控制面", () => {
  const codebuildGroup = EXEC_ENV_CODEBUILD_LOG_GROUP;
  const usw2Decision = { decisions: [{ targetId: "tgt_usw2_a", via: "readBuildStatus" }] };

  it("日志组名是单一作者:叶子常量 = `/aws/codebuild/<项目名>`;deploy-control 的 re-export 与叶子同一字面", () => {
    expect(codebuildGroup).toBe(`/aws/codebuild/${EXEC_ENV_PROJECT_NAME}`);
    expect(FROM_DEPLOY_CONTROL).toBe(EXEC_ENV_PROJECT_NAME);
    expect(CONTROL_PLANE_LOG_GROUPS.has(codebuildGroup)).toBe(true);
  });
  it("入参键 logGroupName 被抽成资源名(流名不收)", () => {
    expect(extractResourceIds({ logGroupName: codebuildGroup, logStreamName: "abc/def", limit: 20 })).toEqual([codebuildGroup]);
  });
  it("缺陷原形:build-status 决策指 usw2、主控区 logs 客户端读 CodeBuild 日志组 ⇒ 现在 control(此前 cross-region)", () => {
    const v = judgeCall(
      facts({ service: "logs", operation: "GetLogEvents", clientRegion: "us-east-1", resourceIds: [codebuildGroup], ...usw2Decision }),
      IDX
    );
    expect(v.kinds).toEqual(["control"]);
  });
  it("判别力:别的日志组(作业日志)同一形态仍是 cross-region;客户端不在主控区也不豁免;没抽到日志组名不豁免", () => {
    const other = judgeCall(
      facts({ service: "logs", operation: "GetLogEvents", clientRegion: "us-east-1", resourceIds: ["/aws-glue/jobs/output"], ...usw2Decision }),
      IDX
    );
    expect(other.kinds).toEqual(["cross-region"]);
    const notHome = judgeCall(
      facts({ service: "logs", operation: "GetLogEvents", clientRegion: "us-west-2", resourceIds: [codebuildGroup], decisions: [{ targetId: "tgt_home", via: "x" }] }),
      IDX
    );
    expect(notHome.kinds).toEqual(["cross-region"]);
    const noName = judgeCall(facts({ service: "logs", operation: "GetLogEvents", clientRegion: "us-east-1", ...usw2Decision }), IDX);
    expect(noName.kinds).toEqual(["cross-region"]);
  });
});
