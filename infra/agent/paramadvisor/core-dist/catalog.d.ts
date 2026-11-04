import type { ParamChannel, ParamDef } from "./types";
export declare const CORE_GLUE_WORKER_VALUES: string[];
export declare const CORE_GLUE_MAX_WORKERS = 1000;
export declare const CORE_GLUE_VERSIONS: string[];
export declare const CORE_GLUE_VERSION_DEFAULT = "6.0";
export declare const CORE_EMR_RELEASE_LABELS: string[];
export declare const CORE_EMR_ARCHITECTURES: string[];
export declare const CORE_EMR_CPU_OPTIONS: string[];
export declare const CORE_EMR_MEMORY_OPTIONS: string[];
export declare const CORE_EMR_MAX_EXECUTORS = 100;
export declare const CORE_EMR_SPEC_DEFAULT: {
    releaseLabel: string;
    architecture: string;
    driver: {
        cpu: string;
        memory: string;
        disk: string;
    };
    executor: {
        cpu: string;
        memory: string;
        disk: string;
    };
    executorCount: number;
};
export declare function catalogFor(channel: ParamChannel): ParamDef[];
export declare function renderCatalogForPrompt(channel: ParamChannel): string;
