// The rust reader, compiled to wasm. Every entry point answers null when the
// module cannot load, and the js reader takes over.

import init, { readStructure as rsReadStructure, Region as RsRegion, BoxQuery as RsBoxQuery } from "../wasm/minecraft_block_reader.js"
import { readNBT } from "./nbt.js"
import { withBlocks } from "./blocks.js"

let ready
let broken = false

// built rather than written out, so a browser bundler does not resolve it
const NODE_FS = "node:fs/promises"

async function loaded() {
  if (broken) return false
  try {
    // node's fetch refuses file: urls, so there the bytes are handed over
    ready ??= globalThis.process?.versions?.node
      ? import(NODE_FS)
          .then(({ readFile }) => readFile(new URL("../wasm/minecraft_block_reader_bg.wasm", import.meta.url)))
          .then(bytes => init({ module_or_path: bytes }))
      : init()
    await ready
    return true
  } catch {
    broken = true
    return false
  }
}

const entitiesOf = extras => extras.en.map((nbt, i) => ({
  pos: [extras.ep[i * 3], extras.ep[i * 3 + 1], extras.ep[i * 3 + 2]],
  nbt
}))

// Null when the bytes are not a structure file the rust side handles.
export async function readStructureFast(bytes) {
  if (!await loaded()) return null

  let packed
  try {
    packed = rsReadStructure(bytes)
  } catch {
    return null
  }
  if (!packed) return null

  // copied out and freed at once, so no wasm memory waits on a property that
  // may never be read
  let size, palette, raw, extrasBytes
  try {
    size = Array.from(packed.size)
    palette = JSON.parse(packed.palette)
    raw = packed.blocks
    extrasBytes = packed.extras
  } finally {
    packed.free()
  }
  const extras = await readNBT(extrasBytes, { littleEndian: false })
  const out = { size, palette, blocks: null, entities: entitiesOf(extras) }
  return withBlocks(out, raw, extras.bi, extras.bn)
}

const regionCache = new WeakMap()

export async function regionHandle(bytes) {
  if (!await loaded()) return null
  let handle = regionCache.get(bytes)
  if (!handle) {
    handle = new RsRegion(bytes)
    regionCache.set(bytes, handle)
  }
  return handle
}

export async function chunkGridFast(handle, index, yMin, yMax) {
  const packed = handle.chunkGrid(index, yMin, yMax)
  if (!packed) return null
  let palette, grid, extrasBytes, empty
  try {
    palette = JSON.parse(packed.palette)
    grid = packed.grid
    extrasBytes = packed.extras
    empty = packed.empty
  } finally {
    packed.free()
  }
  const extras = await readNBT(extrasBytes, { littleEndian: false })
  const blockEntities = extras.bn.map((nbt, i) => ({
    x: extras.bp[i * 3], y: extras.bp[i * 3 + 1], z: extras.bp[i * 3 + 2], nbt
  }))
  return { palette, grid, blockEntities, empty }
}

export function chunkExtentFast(handle, index, yMin, yMax) {
  const e = handle.chunkExtent(index, yMin, yMax)
  return e ? { top: e[1], bottom: e[0] } : null
}

export async function chunkBlocksFast(handle, index, yMin, yMax, includeAir) {
  const packed = handle.chunkBlocks(index, yMin, yMax, includeAir)
  if (!packed) return null
  let palette, raw, extrasBytes
  try {
    palette = JSON.parse(packed.palette)
    raw = packed.blocks
    extrasBytes = packed.extras
  } finally {
    packed.free()
  }
  const extras = await readNBT(extrasBytes, { littleEndian: false })
  const out = { palette, entities: entitiesOf(extras) }
  return withBlocks(out, raw, extras.bi, extras.bn)
}

export async function boxQuery({ x0, y0, z0, x1, y1, z1, includeAir }) {
  if (!await loaded()) return null
  return new RsBoxQuery(x0, y0, z0, x1, y1, z1, includeAir)
}

export async function finishQuery(query) {
  const packed = query.finish()
  let palette, raw, extrasBytes
  try {
    palette = JSON.parse(packed.palette)
    raw = packed.blocks
    extrasBytes = packed.extras
  } finally {
    packed.free()
    query.free()
  }
  const extras = await readNBT(extrasBytes, { littleEndian: false })
  return { palette, raw, blockNbt: extras, entities: entitiesOf(extras) }
}
