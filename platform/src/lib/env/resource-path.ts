// 「某类资源的页面在哪」的唯一作者(发布到环境后的「切到 X 环境查看」、审批后的跳转都用它)。
//   🔴 这张表与 lib/versions/version-service.ts 的 ResourceType 闭合清单一一对应;新增资源类型时两处同改,缺一 tsc 就红。
import type { ResourceType } from "@/lib/versions/version-service";

/** 列表型页面(作业在页内按名字选)与详情型页面(路径带 id)两种形态;都返回站内相对路径。 */
export function resourcePath(type: ResourceType, id: string): string {
  switch (type) {
    case "workflow": return `/workflow/${encodeURIComponent(id)}`;
    case "sync": return `/sync/${encodeURIComponent(id)}`;
    case "etl-job": return "/etl-jobs";
    case "engine-job": return "/etl-jobs";
    case "redshift-task": return "/redshift";
    default: {
      const never: never = type;
      return String(never);
    }
  }
}
