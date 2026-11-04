export interface MaskResult {
    masked: string;
    hasMaskedRegions: boolean;
}
export declare function maskSqlLiterals(src: string): MaskResult;
