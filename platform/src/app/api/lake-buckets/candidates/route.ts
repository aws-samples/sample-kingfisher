export const dynamic = "force-dynamic";
// 「数据湖配置」入口表桶下拉的清单接口(**只读路径**):
//   GET ?targetId=   该执行环境所在区账号内的 S3 Tables 表桶(标出平台表桶 / 已登记路由桶)
//   任何登录用户可读(同步任务由 editor 建,系统设置登记由 bgp-admin 做 —— 写接口各自守卫;这里只是「能选什么」)。
// 2026-11-09:从 /api/admin/lake-buckets/candidates 挪出 —— 网关对 /api/admin/** 不分读写一律要求 bgp-admin,
//   数据开发账号的同步向导 Table Bucket 下拉拿不到清单(报错为空)。旧路径保留为别名(再导出这里的 GET),下一版删。
// 落点只经点名作者 requestedTargetId(缺 / 非法 ⇒ 400,不默认主控区)
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { listTableBucketCandidates } from "@/lib/lake/table-bucket-candidates";

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  let tid: string;
  try {
    tid = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列 S3 Tables 表桶候选");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(String((e as Error)?.message || e), 400, { code: "VALIDATION_FAILED" });
  }
  try {
    return apiOk(await listTableBucketCandidates(tid));
  } catch (e: unknown) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    // ListTableBuckets 被拒(SCP)/ 区不可达:如实 502,页面侧退回手填(不编一个空清单冒充「该区没有表桶」)
    return apiError(`列 S3 Tables 表桶失败:${String((e as Error)?.message || e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
