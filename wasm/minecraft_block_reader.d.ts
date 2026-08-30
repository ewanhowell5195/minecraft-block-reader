/* tslint:disable */
/* eslint-disable */

export class BoxQuery {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 0 read, 1 missing, 2 too old
     */
    addChunk(region: Region, index: number, with_entities: boolean): number;
    addEntities(region: Region, index: number): void;
    finish(): Packed;
    constructor(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, include_air: boolean);
    readonly counts: Uint32Array;
}

export class Packed {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly blocks: Int32Array;
    /**
     * nbt bytes: `bi` block indices, `bn` their nbt, `ep` entity
     * positions, `en` entity nbt
     */
    readonly extras: Uint8Array;
    readonly palette: string;
    readonly size: Int32Array;
    /**
     * 0 read, 1 missing, 2 too old to read
     */
    readonly status: number;
}

export class Region {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `[bottom, top]` of the non air blocks, or nothing when the chunk is empty.
     */
    chunkExtent(index: number): Int32Array | undefined;
    constructor(bytes: Uint8Array);
}

export function readStructure(bytes: Uint8Array): Packed | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_boxquery_free: (a: number, b: number) => void;
    readonly __wbg_packed_free: (a: number, b: number) => void;
    readonly __wbg_region_free: (a: number, b: number) => void;
    readonly boxquery_addChunk: (a: number, b: number, c: number, d: number) => number;
    readonly boxquery_addEntities: (a: number, b: number, c: number) => void;
    readonly boxquery_counts: (a: number) => [number, number];
    readonly boxquery_finish: (a: number) => number;
    readonly boxquery_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly packed_blocks: (a: number) => [number, number];
    readonly packed_extras: (a: number) => [number, number];
    readonly packed_palette: (a: number) => [number, number];
    readonly packed_size: (a: number) => [number, number];
    readonly packed_status: (a: number) => number;
    readonly readStructure: (a: number, b: number) => number;
    readonly region_chunkExtent: (a: number, b: number) => [number, number];
    readonly region_new: (a: number, b: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
