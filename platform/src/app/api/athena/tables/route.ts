export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { requireProject } from "@/lib/projects/guard";
import { listNamespaceTreeAll, ATHENA_CATALOG_REF, resolveS3TablesPlaces } from "@/lib/athena/s3tables";

// S3 Tables 命名空间 + 表树（供前端左侧浏览/点表生成 SELECT）。RBAC: viewer。
// 树 = 该区平台表桶 + 平台管理员登记的外部表桶(每个命名空间带 bucket / catalog / external;
//   `catalog` 仍是平台表桶的目录引用,存量消费者不变;新增 `catalogs` 列出全部)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    // 表树按**编辑器自己的执行目标**取
    // (与 `/redshift` 左侧树同款:一棵树只能显示一个区的结构)。
    const places = await resolveS3TablesPlaces(requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列数据湖表"));
    const primary = places[0];
    const namespaces = await listNamespaceTreeAll(places);
    return NextResponse.json({
      catalog: primary.home ? ATHENA_CATALOG_REF : primary.catalogRef,
      catalogs: places.map((p) => ({ catalog: p.home && !p.external ? ATHENA_CATALOG_REF : p.catalogRef, bucket: p.bucket, external: p.external, ...(p.label ? { label: p.label } : {}) })),
      namespaces,
      targetId: primary.targetId,
      region: primary.region,
    });
  } catch (err: any) {
    // 本路由沿用自己的信封;落点拒因带上 code(PLACE_UNDECIDABLE)让前端 / 判据分得清
    return NextResponse.json({ error: err.message || String(err), ...(err?.code ? { code: err.code } : {}) }, { status: 400 });
  }
}
