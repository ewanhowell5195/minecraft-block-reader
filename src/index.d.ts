export interface BlockState {
  id: string
  properties?: Record<string, string>
}

export interface Block {
  state: number
  pos: [number, number, number]
  nbt?: Record<string, unknown>
}

export interface Entity {
  pos: [number, number, number]
  nbt: Record<string, unknown>
}

export interface Structure {
  size: [number, number, number]
  palette: BlockState[]
  blocks: Block[]
  entities: Entity[]
  /** The same blocks as a flat `[state, x, y, z, state, x, y, z, …]` run. */
  readonly raw: Int32Array
  /** Block entity nbt, keyed by the block's index in `raw`. */
  readonly blockNbt: Map<number, Record<string, unknown>>
}

export interface ChunkRef {
  cx: number
  cz: number
  region: string
  index: number
}

export interface BlockBox {
  x0: number
  z0: number
  x1: number
  z1: number
  y0?: number
  y1?: number
  includeAir?: boolean
}

export interface BlockResult {
  palette: BlockState[]
  blocks: Block[]
  entities: Entity[]
  chunks: { read: number, missing: number, outdated: number }
  /** The same blocks as a flat `[state, x, y, z, state, x, y, z, …]` run. */
  readonly raw: Int32Array
  /** Block entity nbt, keyed by the block's index in `raw`. */
  readonly blockNbt: Map<number, Record<string, unknown>>
}

export interface ChunkGrid {
  palette: BlockState[]
  /** `256 * height` cells of `(y - yMin) * 256 + z * 16 + x`, 0 for air or a one-based palette index. */
  grid: Uint16Array
  beList: { x: number, y: number, z: number, nbt: Record<string, unknown> }[]
  empty: boolean
}

export type Progress = (done: number, total: number) => void

export interface World {
  name: string
  dimension: string
  dimensions: string[]
  chunks: ChunkRef[]
  structures: string[]
  blocks(box: BlockBox, onProgress?: Progress): Promise<BlockResult>
  chunk(chunk: ChunkRef): Promise<Record<string, unknown> | null>
  chunkExtent(chunk: ChunkRef): Promise<{ top: number, bottom: number } | null>
  chunkGrid(chunk: ChunkRef, options?: { yMin?: number, yMax?: number }): Promise<ChunkGrid>
  setDimension(id: string, onProgress?: Progress): Promise<World>
  structure(rel: string): Promise<Structure>
  file(path: string): Promise<Uint8Array | null>
}

export type Source = Uint8Array | ArrayBuffer | ArrayBufferView | Blob

export interface ReadOptions {
  region?: [number, number]
  dimension?: string
  onProgress?: Progress
}

export function read(src: Source, options?: ReadOptions): Promise<Structure | World>

export interface ChunkBlocksOptions {
  yMin?: number
  yMax?: number
  includeAir?: boolean
}

export function chunkBlocks(nbt: Record<string, unknown> | null | undefined, options?: ChunkBlocksOptions): {
  palette: BlockState[]
  blocks: Block[]
  entities: Entity[]
  /** The same blocks as a flat `[state, x, y, z, state, x, y, z, …]` run. */
  readonly raw: Int32Array
  /** Block entity nbt, keyed by the block's index in `raw`. */
  readonly blockNbt: Map<number, Record<string, unknown>>
}

export type Keys = string | Iterable<string>

export interface ReadNBTOptions {
  littleEndian?: boolean
  skip?: Keys
  only?: Keys
}

export function readNBT(input: Uint8Array | ArrayBuffer, options?: ReadNBTOptions): Promise<Record<string, unknown>>

export function parseState(str: string): BlockState
export function normState<T>(v: T): T | BlockState

export const AIR: RegExp
export const REAL_AIR: RegExp
