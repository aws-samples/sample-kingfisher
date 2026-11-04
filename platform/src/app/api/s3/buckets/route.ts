export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { apiOk, apiError } from "@/lib/api-response";

// IAM 侧(2026-10-21):ListBuckets 是**账号级清点**(全球命名空间,结果不分区、不含数据),唯一消费点是
//   「系统设置 → 服务状态」数一数账号里有几个桶 —— 这是控制面体检,不是碰某个区的数据 ⇒ 走控制面轴(与内部端点共享密钥读点同一条路,三刀 ①)。
//   此前挂在数据面轴上:…9435 observe 第四十四轮里主控区数据面角色被拒 `s3:ListAllMyBuckets` 20 次(enforce 下服务状态卡会红);
//   数据面角色刻意不给 ListAllMyBuckets(per-target 角色只认本区、本 target 实名桶,SPEC L5)。
const s3 = sdkClient("control-plane", S3Client, { region: homeRegion() });

export async function GET() {
  try {
    const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
    return apiOk(Buckets.map((b) => ({ name: b.Name, createdAt: b.CreationDate?.toISOString() })));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
