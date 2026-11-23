// 判据用的 DMS 落点夹具:主控区与一个执行区各一份,字段形态与落点解析器(lib/realtime/dms-place.ts)产出的一致。
// 只给「测服务层」的判据用;「测落点解析」的判据走真解析器 + 注册表行夹具。
import { __dmsPlaceForTest, type DmsPlace } from "@/lib/realtime/dms-place";

/** 主控区落点(名字与命名单一事实源的主控区值逐字相同)。 */
export function homeDmsPlace(over: Partial<Parameters<typeof __dmsPlaceForTest>[0]> = {}): DmsPlace {
  return __dmsPlaceForTest({
    targetId: "tgt_home",
    region: "us-east-1",
    instanceId: "bgp-dms",
    subnetGroupId: "bgp-dms-subnet-group",
    securityGroupName: "bgp-dms-sg",
    roleArn: "arn:aws:iam::acct0000000a:role/bgp-dms-kinesis-role",
    stagingBucket: "bgp-datalake-acct0000000a",
    warehouse: { targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev" },
    targetSecretName: "bgp/dms/redshift-target",
    ...over,
  });
}

/** 一个执行区的落点(缺省 us-west-2;名字里的 slug = 把 targetId 的下划线换成连字符,与命名单一事实源一致)。 */
export function regionDmsPlace(over: Partial<Parameters<typeof __dmsPlaceForTest>[0]> = {}): DmsPlace {
  return __dmsPlaceForTest({
    targetId: "tgt_usw2",
    region: "us-west-2",
    instanceId: "bgp-dms-tgt-usw2",
    subnetGroupId: "bgp-dms-subnet-group-tgt-usw2",
    securityGroupName: "bgp-dms-sg-tgt-usw2",
    roleArn: "arn:aws:iam::acct0000000a:role/BgpExecEnv-tgt-usw2-dms-kinesis-role",
    stagingBucket: "bgp-datalake-acct0000000a-tgt-usw2",
    warehouse: { targetId: "tgt_usw2", region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2", database: "dev" },
    targetSecretName: "bgp/dms/redshift-target",
    ...over,
  });
}
