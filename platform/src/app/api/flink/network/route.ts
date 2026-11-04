export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { DescribeVpcsCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { apiOk, apiError } from "@/lib/api-response";
// 🔴 原来这里是一个模块级主控区 EC2 客户端 ⇒ 在 us-west-2 视角建 CDC / EMR 作业时,网络下拉里列的是
// **主控区的 VPC / 子网 / 安全组**。这不是「少个功能」,是给了一份看着正常、其实属于另一个区的清单:
// 选中就写进 MSAF VpcConfigurations / EMR 网络配置,提交时才炸,而报错指向网络配置本身。
// ⇒ 客户端按 `?targetId=` 解出的 region 建,并把 region 回给前端(护栏 2:落点必须一眼可见)。
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
// 落点只认点名(缺 ⇒ 400,不默认主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { ec2ClientFor } from "@/lib/exec-env/target-clients";

// GET /api/flink/network[?vpcId=...] — 列举账号内真实的 VPC / 子网 / 安全组,供建 MySQL CDC 作业时
// 下拉选择网络(平台不自动猜网络可达性;用户选哪个就透传给 MSAF VpcConfigurations,红线:网络私有自管)。
// 传 vpcId 则只返回该 VPC 下的子网/SG。
export async function GET(req: NextRequest) {
  try {
    const vpcId = req.nextUrl.searchParams.get("vpcId") || "";
    // 🔴 解析不到就**抛**(下面 catch 成 500 并带上原因),不回落主控区 —— 回落的后果见文件头注释。
    let targetId: string;
    try {
      targetId = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "列举网络资源");
    } catch (e) {
      const r = placeErrorResponse(e);
      if (r) return r;
      throw e;
    }
    const region = (await resolveGlueBinding({ targetId })).region;
    const ec2 = await ec2ClientFor(region);

    const { Vpcs = [] } = await ec2.send(new DescribeVpcsCommand({}));
    const vpcs = Vpcs.map((v) => ({
      id: v.VpcId,
      cidr: v.CidrBlock,
      name: (v.Tags || []).find((t) => t.Key === "Name")?.Value || "",
      isDefault: v.IsDefault === true,
    }));

    const filters = vpcId ? [{ Name: "vpc-id", Values: [vpcId] }] : undefined;

    const { Subnets = [] } = await ec2.send(new DescribeSubnetsCommand(filters ? { Filters: filters } : {}));
    const subnets = Subnets.map((s) => ({
      id: s.SubnetId,
      vpcId: s.VpcId,
      az: s.AvailabilityZone,
      cidr: s.CidrBlock,
      name: (s.Tags || []).find((t) => t.Key === "Name")?.Value || "",
      // 私有子网提示(无 MapPublicIpOnLaunch);CDC 读私有 RDS 应选私有子网。
      isPrivate: s.MapPublicIpOnLaunch !== true,
    }));

    const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand(filters ? { Filters: filters } : {}));
    const securityGroups = SecurityGroups.map((g) => ({
      id: g.GroupId,
      vpcId: g.VpcId,
      name: g.GroupName,
      description: g.Description,
    }));

    return apiOk({ region, targetId, vpcs, subnets, securityGroups });
  } catch (e: any) {
    return apiError(`列举网络资源失败: ${String(e?.message || e)}`, 500);
  }
}
