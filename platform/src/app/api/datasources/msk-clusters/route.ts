export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { NextRequest, NextResponse } from "next/server";
import { KafkaClient, ListClustersV2Command } from "@aws-sdk/client-kafka";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";

const REGION = homeRegion();

// GET /api/datasources/msk-clusters — 列出本账号本区已存在的 MSK 集群(供建源"选择集群"下拉)。
//  模块42 P42.6:MSK 托管 flavor 让用户从下拉选已有集群(免手敲 ARN)。分页续拉直到无 NextToken。
//  返回每个集群支持的认证方式(iam/scram),供前端约束 auth 选项(集群没开的认证不给选)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const client = sdkClient("data-plane", KafkaClient, { region: REGION });
  try {
    const clusters: Array<{ arn: string; name: string; state?: string; auth: string[] }> = [];
    let nextToken: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r: any = await client.send(new ListClustersV2Command(nextToken ? { NextToken: nextToken } : {}));
      for (const c of r.ClusterInfoList || []) {
        // 认证方式:从集群配置读(Provisioned/Serverless 结构不同,做并集,best-effort)。
        const sasl = c?.Provisioned?.ClientAuthentication?.Sasl || c?.Serverless?.ClientAuthentication?.Sasl;
        const auth: string[] = [];
        if (sasl?.Iam?.Enabled) auth.push("iam");
        if (sasl?.Scram?.Enabled) auth.push("scram");
        clusters.push({
          arn: c.ClusterArn,
          name: c.ClusterName || (c.ClusterArn || "").split("/")[1] || c.ClusterArn,
          state: c.State,
          auth, // 空数组=未探测到(前端仍放开选项,由建源真连测试兜底)
        });
      }
      nextToken = r.NextToken;
      if (!nextToken) break;
    }
    clusters.sort((a, b) => a.name.localeCompare(b.name));
    return apiOk({ clusters, region: REGION });
  } catch (e: any) {
    return apiError(String(e?.message || e).slice(0, 200), 500);
  } finally {
    client.destroy();
  }
}
