// 问数(AgentCore 后端)的取数落点 —— **唯一作者**:平台在这里按「引擎 × target」解析一次,随 payload 交给容器,
// 容器在唯一漏斗里确定性地并进每次工具调用(不由模型决定)。
//
// 🔴🔴 (2026-10-01 无头实测):原来这里只有 Redshift 一种落点(`resolveDirectQueryPlace`),Athena 引擎也拿它;
//   容器只会把 `rs*` 四样并进工具入参,技能 Lambda 的 Athena 用模块级主控区客户端 + 主控区工作组 ⇒
//   在 us-west-2 视角问数据湖,10 条 Athena 查询全部打在主控区工作组。⇒ 落点按引擎分成两种形状(封闭联合),
//   Athena 那一种带齐 region / 工作组 / 结果位置 / **该区**联邦目录引用四样。
import { resolveAthenaPlace } from "@/lib/athena/client";
import { resolveS3TablesPlace, resolveS3TablesPlaceForNamespace } from "@/lib/athena/s3tables";
// 跨运行时只传 PlaceWire
import { buildPlaceWire, type PlaceWire } from "@/lib/place/wire";

export type GenBiPlace =
  | { engine: "redshift"; targetId: string; region: string; workgroup: string; database: string; secretArn?: string }
  | { engine: "athena"; targetId: string; region: string; athenaWorkgroup: string; athenaOutputLocation: string; catalogRef: string };

export async function resolveGenBiPlace(
  engine: "redshift" | "athena",
  targetId: string, // 必填(原来 undefined = 主控区)
  projectId: string | undefined,
  // Athena 引擎用户选的「库」= S3 Tables 命名空间;给了就按它找所在的表桶(平台表桶 / 已登记外部表桶),
  //   不给 ⇒ 平台表桶(与改动前相同)。
  namespace?: string
): Promise<GenBiPlace> {
  if (engine === "athena") {
    const a = await resolveAthenaPlace(targetId);
    const s = namespace ? await resolveS3TablesPlaceForNamespace(targetId, namespace) : await resolveS3TablesPlace(targetId);
    return { engine: "athena", targetId: a.targetId, region: a.region, athenaWorkgroup: a.workgroup, athenaOutputLocation: a.outputLocation, catalogRef: s.catalogRef };
  }
  const { resolveDirectQueryPlace } = await import("@/lib/redshift/direct-query");
  const p = await resolveDirectQueryPlace({ targetId, projectId: projectId ?? null }); // 主控区分支由解析器自己丢掉项目(direct-query 规矩 ②)
  return { engine: "redshift", targetId: p.targetId, region: p.region, workgroup: p.workgroup, database: p.database, ...(p.secretArn ? { secretArn: p.secretArn } : {}) };
}

/**
 * 问数落点 ⇒ PlaceWire(rs* / ath* 八个平面字段合并成一个对象)。
 * 容器只认这个(`payload.input.placeWire`),原样并进每次工具调用的 `place` 入参;技能 Lambda 用同一份读取函数读。
 */
export function placeWireOfGenBi(p: GenBiPlace): PlaceWire {
  return p.engine === "athena"
    ? buildPlaceWire({
        targetId: p.targetId,
        region: p.region,
        athena: { workgroup: p.athenaWorkgroup, outputLocation: p.athenaOutputLocation, catalogRef: p.catalogRef },
      })
    : buildPlaceWire({
        targetId: p.targetId,
        region: p.region,
        redshift: { workgroup: p.workgroup, database: p.database, secretArn: p.secretArn ?? null },
      });
}
