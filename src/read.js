import { readWorld } from "./world.js"
import { readStructureFast } from "./fast.js"

const headBytes = async (src, n) =>
  src instanceof Uint8Array ? src.subarray(0, n) : new Uint8Array(await src.slice(0, n).arrayBuffer())

const bytesOf = async src =>
  src instanceof Uint8Array ? src
    : src instanceof ArrayBuffer ? new Uint8Array(src)
    : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(await src.arrayBuffer())

export async function read(src, { region, dimension, onProgress } = {}) {
  if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) src = await bytesOf(src)
  const head = await headBytes(src, 2)
  if (head[0] === 0x50 && head[1] === 0x4b) return readWorld(src, { region, dimension, onProgress })
  const bytes = await bytesOf(src)
  const fast = await readStructureFast(bytes)
  if (fast) return fast
  const { readStructureJs } = await import("./js-reader.js")
  const js = await readStructureJs(bytes)
  if (js) return js
  if (bytes.length >= 8192 && !(bytes.length & 4095)) {
    try { return await readWorld(bytes, { region, dimension, onProgress }) } catch {}
  }
  throw new Error("couldn't detect the file format")
}
