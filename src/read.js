import { readNBT, readStructure } from "./nbt.js"
import { readLitematic, readSchem, readMcstructure } from "./formats.js"
import { readWorld } from "./world.js"

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
  try {
    const root = await readNBT(bytes)
    if (root.Regions) return readLitematic(root)
    if (root.Schematic || (root.Palette && (root.BlockData || root.Data) && root.Width)) return readSchem(root)
    if (root.structure?.block_indices) return readMcstructure(root)
    if (root.blocks && (root.palette || root.palettes)) return readStructure(root)
  } catch {}
  if (bytes.length >= 8192 && !(bytes.length & 4095)) {
    try { return await readWorld(bytes, { region, dimension, onProgress }) } catch {}
  }
  throw new Error("couldn't detect the file format")
}
