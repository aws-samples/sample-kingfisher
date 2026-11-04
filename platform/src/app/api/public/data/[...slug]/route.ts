// @kf-batch 50-W5-seg2-WP1
// 模块 30 「数据服务」对外端点 —— **已下线**(2026-09-05 用户拍板;50 SPEC §3.9c / WORK-PACKAGES WP-1 / ACCEPTANCE E-134)。
//
// 保留这个文件而不是删掉路由:将来有人拿旧文档来调 /api/public/data/{path}/{version},410 Gone 比 404 更能说清
// 「这个能力已下线」(实测下线时三张表 0 条 —— 没有已发布 API、没有签发过的 Key,无任何外部调用方受影响)。
//
// 🔴 铁律:**不 import 任何 @/lib、不读表、不鉴权** —— 没有数据面就没有泄露面。
//    五个方法一律 410 + 同一份 JSON 三字段(code / message / since),不看路径、不看 header、不看 body。
//    /api/public/* 在 middleware 里本就免鉴权直通,这里因此也无需(也不能)做任何身份判断。
//    门禁 lib/__tests__/data-service-retired.test.ts (b) 逐方法真调一次断 410 + 三字段,并断本文件没有 @/lib import。
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const GONE_BODY = {
  code: "GONE",
  message: "数据服务能力已于 2026-09 下线",
  since: "2026-09-05",
} as const;

function gone() {
  return NextResponse.json(GONE_BODY, { status: 410 });
}

export async function GET() {
  return gone();
}
export async function POST() {
  return gone();
}
export async function PUT() {
  return gone();
}
export async function DELETE() {
  return gone();
}
export async function PATCH() {
  return gone();
}
