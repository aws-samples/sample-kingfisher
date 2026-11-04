export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { NextRequest, NextResponse } from "next/server";
import { KinesisClient, ListStreamsCommand } from "@aws-sdk/client-kinesis";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";

const REGION = homeRegion();

// GET /api/datasources/kinesis-streams — 列出本账号本区已存在的 Kinesis 流(供建源"使用已有流"下拉)。
//  让用户从下拉选已有流,而非手敲流名(更符合用户行为)。分页续拉直到 HasMoreStreams=false。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const client = sdkClient("data-plane", KinesisClient, { region: REGION });
  try {
    const names: string[] = [];
    let exclusiveStartStreamName: string | undefined;
    // 最多翻 10 页(每页默认 100)防极端账号打爆;正常账号一页足够。
    for (let i = 0; i < 10; i++) {
      const r = await client.send(new ListStreamsCommand(
        exclusiveStartStreamName ? { ExclusiveStartStreamName: exclusiveStartStreamName } : {}
      ));
      for (const n of r.StreamNames || []) names.push(n);
      if (!r.HasMoreStreams || !(r.StreamNames || []).length) break;
      exclusiveStartStreamName = (r.StreamNames || []).slice(-1)[0];
    }
    return apiOk({ streams: names.sort(), region: REGION });
  } catch (e: any) {
    return apiError(String(e?.message || e).slice(0, 200), 500);
  } finally {
    client.destroy();
  }
}
