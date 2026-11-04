export interface PlaceWireRedshift {
    readonly workgroup: string;
    readonly database: string;
    readonly secretArn?: string;
}
export interface PlaceWireAthena {
    readonly workgroup: string;
    readonly outputLocation: string;
    readonly catalogRef: string;
}
export interface PlaceWire {
    readonly v: 1;
    readonly targetId: string;
    readonly region: string;
    readonly redshift?: PlaceWireRedshift;
    readonly athena?: PlaceWireAthena;
}
/** 与 schema 的 pattern 逐字相同(契约测试比对 schema 文件,改一边另一边就红)。 */
export declare const PLACE_WIRE_TARGET_ID_PATTERN = "^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$";
export declare const PLACE_WIRE_REGION_PATTERN = "^[a-z]{2}(-[a-z]+)+-\\d$";
export declare const PLACE_WIRE_SECRET_ARN_PATTERN = "^arn:[a-z-]+:secretsmanager:";
export declare const PLACE_WIRE_S3_LOCATION_PATTERN = "^(s3://.+)?$";
export declare class PlaceWireInvalid extends Error {
    readonly path: string;
    readonly code: "PLACE_WIRE_INVALID";
    constructor(path: string, why: string);
}
/** 读一个 PlaceWire(对象或其 JSON 文本)。返回**归一后的新对象**(键序固定、可选腿缺省即不出现)。 */
export declare function readPlaceWire(raw: unknown): PlaceWire;
/** 取某条腿;落点里没有这条腿 ⇒ 拒(不回落)。 */
export declare function placeWireLeg(w: PlaceWire, leg: "redshift"): PlaceWireRedshift;
export declare function placeWireLeg(w: PlaceWire, leg: "athena"): PlaceWireAthena;
