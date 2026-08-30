import { readNBT } from "./nbt.js"
import { readStructureFast, regionHandle, boxQuery, finishQuery, chunkExtentFast, chunkGridFast, chunkBlocksFast } from "./fast.js"
import { normState, REAL_AIR } from "./state.js"
import { withBlocks, withRaw } from "./blocks.js"

async function inflate(data, format) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const asSource = src =>
  src instanceof ArrayBuffer ? new Uint8Array(src)
    : ArrayBuffer.isView(src) && !(src instanceof Uint8Array) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : src

const sliceBytes = async (src, start, end) =>
  src instanceof Uint8Array ? src.subarray(start, end) : new Uint8Array(await src.slice(start, end).arrayBuffer())

const byteStream = (src, start, end) =>
  (src instanceof Uint8Array ? new Blob([src.subarray(start, end)]) : src.slice(start, end)).stream()

// central directory only (zip64 aware); entry bytes stay on disk until read,
// so multi-GB world zips never need the whole file in memory
async function parseZipBlob(src) {
  src = asSource(src)
  const size = src instanceof Uint8Array ? src.length : src.size
  const tail = await sliceBytes(src, Math.max(0, size - 66000), size)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { e = i; break }
  }
  if (e === -1) throw new Error("not a zip file (no end of central directory record)")
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let count = tdv.getUint16(e + 10, true)
  let cdSize = tdv.getUint32(e + 12, true)
  let cdOff = tdv.getUint32(e + 16, true)
  if ((cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) && e >= 20 && tdv.getUint32(e - 20, true) === 0x07064b50) {
    const off64 = Number(tdv.getBigUint64(e - 12, true))
    const rec = await sliceBytes(src, off64, off64 + 56)
    const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
    if (rdv.getUint32(0, true) === 0x06064b50) {
      count = Number(rdv.getBigUint64(32, true))
      cdSize = Number(rdv.getBigUint64(40, true))
      cdOff = Number(rdv.getBigUint64(48, true))
    }
  }
  const cd = await sliceBytes(src, cdOff, cdOff + cdSize)
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const td = new TextDecoder()
  const files = new Map()
  let o = 0
  for (let i = 0; i < count && o + 46 <= cd.length; i++) {
    const nameLen = dv.getUint16(o + 28, true)
    const extraLen = dv.getUint16(o + 30, true)
    const commentLen = dv.getUint16(o + 32, true)
    const filePath = td.decode(cd.subarray(o + 46, o + 46 + nameLen))
    if (!filePath.endsWith("/")) {
      const method = dv.getUint16(o + 10, true)
      let compressedSize = dv.getUint32(o + 20, true)
      const uncompressedSize = dv.getUint32(o + 24, true)
      let localOffset = dv.getUint32(o + 42, true)
      if (compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF) {
        let eo = o + 46 + nameLen
        const end = eo + extraLen
        while (eo + 4 <= end) {
          const id = dv.getUint16(eo, true), sz = dv.getUint16(eo + 2, true)
          if (id === 1) {
            let fo = eo + 4
            if (uncompressedSize === 0xFFFFFFFF) fo += 8
            if (compressedSize === 0xFFFFFFFF) {
              compressedSize = Number(dv.getBigUint64(fo, true))
              fo += 8
            }
            if (localOffset === 0xFFFFFFFF) localOffset = Number(dv.getBigUint64(fo, true))
            break
          }
          eo += 4 + sz
        }
      }
      files.set(filePath, { method, blob: src, localOffset, compressedSize })
    }
    o += 46 + nameLen + extraLen + commentLen
  }
  return files
}

async function entryStart(entry) {
  const head = await sliceBytes(entry.blob, entry.localOffset, entry.localOffset + 30)
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  return entry.localOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true)
}

async function entryData(entry) {
  const start = await entryStart(entry)
  return sliceBytes(entry.blob, start, start + entry.compressedSize)
}

async function unzipEntry(entry) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`)
  const data = await entryData(entry)
  return entry.method === 8 ? inflate(data, "deflate-raw") : data
}

// the first `want` decompressed bytes without inflating the rest: region
// headers are 8KB out of multi-MB entries
async function entryPrefix(entry, want) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`)
  const start = await entryStart(entry)
  if (entry.method !== 8) return sliceBytes(entry.blob, start, start + Math.min(want, entry.compressedSize))
  const reader = byteStream(entry.blob, start, start + entry.compressedSize)
    .pipeThrough(new DecompressionStream("deflate-raw")).getReader()
  const chunks = []
  let got = 0
  while (got < want) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
  }
  reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(got, want))
  let off = 0
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - off)
    out.set(c.subarray(0, n), off)
    off += n
    if (off >= out.length) break
  }
  return out
}

export async function readWorld(src, { region, dimension, onProgress } = {}) {
  src = asSource(src)
  const head = await sliceBytes(src, 0, 2)
  const world = head[0] === 0x50 && head[1] === 0x4b
    ? await readWorldZip(src, onProgress)
    : readRegionFile(src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer()), region)
  makeWorld(world)
  if (dimension && dimension !== world.dimension) await world.setDimension(dimension, onProgress)
  return world
}

function makeWorld(world) {
  world.blocks = (box, onProgress) => readBlocks(world, box, onProgress)
  world.chunk = chunk => readChunk(world, chunk)
  world.chunkExtent = (chunk, opts) => chunkYExtent(world, chunk, opts)
  world.chunkGrid = (chunk, opts) => readChunkGrid(world, chunk, opts)
  world.chunkBlocks = (chunk, opts) => readChunkBlocks(world, chunk, opts)
  world.setDimension = async (id, onProgress) => {
    const d = world.dims?.find(d => d.id === id)
    if (!d) throw new Error("unknown dimension " + id)
    Object.assign(world, await readDimension(world.files, d.prefix, onProgress))
    world.dimension = id
    return world
  }
  world.file = async path => {
    const entry = world.files?.get((world.root ?? "") + path)
    return entry ? unzipEntry(entry) : null
  }
  world.structure = async rel => {
    const entry = world.structureEntries.get(rel)
    if (!entry) throw new Error("no generated structure " + rel)
    const bytes = await unzipEntry(entry)
    const fast = await readStructureFast(bytes)
    if (fast) return fast
    const { readStructure } = await import("./js-reader.js")
    return readStructure(bytes)
  }
  return world
}

const DIM_ORDER = { overworld: 0, the_nether: 1, the_end: 2 }

async function readWorldZip(src, onProgress) {
  const files = await parseZipBlob(src)
  const prefixes = new Set()
  for (const p of files.keys()) {
    const m = p.match(/^(.*?)region\/r\.-?\d+\.-?\d+\.mca$/)
    if (m) prefixes.add(m[1])
  }
  if (!prefixes.size) throw new Error("no region files found (is this a world zip?)")

  const dims = []
  const modern = new Set(Array.from(prefixes).filter(p => /(^|\/)dimensions\/[^/]+\/.+\/$/.test(p)))
  const plain = Array.from(prefixes).filter(p => !modern.has(p))
  const over = plain.filter(p => !/DIM-?1\/$/.test(p)).sort((a, b) => a.length - b.length)[0]
  const base = over ?? plain[0]?.replace(/DIM-?1\/$/, "")
  if (over !== undefined) dims.push({ id: "overworld", prefix: over, root: base })
  if (base !== undefined) {
    if (prefixes.has(base + "DIM-1/")) dims.push({ id: "the_nether", prefix: base + "DIM-1/", root: base })
    if (prefixes.has(base + "DIM1/")) dims.push({ id: "the_end", prefix: base + "DIM1/", root: base })
  }
  for (const p of modern) {
    const m = p.match(/^(.*?)dimensions\/([^/]+)\/(.+)\/$/)
    const id = m[2] === "minecraft" ? m[3] : m[2] + ":" + m[3]
    if (!dims.some(d => d.id === id)) dims.push({ id, prefix: p, root: m[1] })
  }
  dims.sort((a, b) => (DIM_ORDER[a.id] ?? 3) - (DIM_ORDER[b.id] ?? 3) || a.root.length - b.root.length || a.id.localeCompare(b.id))
  const root = dims[0].root

  let name = ""
  const levelEntry = files.get(root + "level.dat")
  if (levelEntry) {
    try { name = (await readNBT(await unzipEntry(levelEntry))).Data?.LevelName ?? "" } catch {}
  }

  const structureEntries = new Map()
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)generated\/([^/]+)\/structures?\/(.+)\.nbt$/)
    if (!m || m[1] !== root) continue
    structureEntries.set(m[2] + "/" + m[3], entry)
  }
  const data = await readDimension(files, dims[0].prefix, onProgress)
  return {
    name, files, root, dims, structureEntries,
    dimension: dims[0].id,
    dimensions: dims.map(d => d.id),
    structures: Array.from(structureEntries.keys()),
    ...data
  }
}

async function readDimension(files, prefix, onProgress) {
  const regions = [], eRegions = []
  for (const [p, entry] of files) {
    const m = p.match(/^(.*?)region\/r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (m && m[1] === prefix) regions.push([m, entry])
    const em = p.match(/^(.*?)entities\/r\.(-?\d+)\.(-?\d+)\.mca$/)
    if (em && em[1] === prefix) eRegions.push([em, entry])
  }
  const regionBufs = new Map()
  const entityBufs = new Map()
  const chunks = []
  const total = regions.length
  const headers = new Array(regions.length)
  let done = 0, next = 0
  async function fetchNext() {
    for (;;) {
      const i = next++
      if (i >= regions.length) return
      headers[i] = await entryPrefix(regions[i][1], 4096)
      onProgress?.(++done, total)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, regions.length) }, fetchNext))
  for (let i = 0; i < regions.length; i++) {
    if (headers[i].length < 4096) continue
    const [m, entry] = regions[i]
    const key = m[2] + "," + m[3]
    regionBufs.set(key, entry)
    scanRegion(headers[i], Number(m[2]), Number(m[3]), key, chunks)
  }
  if (!chunks.length) throw new Error("the region files contain no chunks")
  for (const [m, entry] of eRegions) entityBufs.set(m[2] + "," + m[3], entry)
  return { regionBufs, entityBufs, chunks, regionCache: new Map() }
}

function scanRegion(bytes, rx, rz, key, chunks) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < 1024; i++) {
    if (dv.getUint32(i * 4) === 0) continue
    chunks.push({ cx: rx * 32 + (i & 31), cz: rz * 32 + (i >> 5), region: key, index: i })
  }
}

function readRegionFile(buf, region) {
  const bytes = asSource(buf)
  if (bytes.length < 8192) throw new Error("not a region file")
  const rx = Number(region?.[0] ?? 0), rz = Number(region?.[1] ?? 0)
  const key = rx + "," + rz
  const chunks = []
  scanRegion(bytes, rx, rz, key, chunks)
  if (!chunks.length) throw new Error("the region file contains no chunks")
  return {
    name: "", regionBufs: new Map([[key, bytes]]), entityBufs: new Map(), chunks, regionCache: new Map(),
    dimension: "overworld", dimensions: ["overworld"], dims: [], structures: [], structureEntries: new Map()
  }
}

// everything a chunk is read for. naming what to keep rather than what to drop
// means a new game version can add root fields without costing a parse
const CHUNK_KEEP = new Set(["sections", "block_entities", "xPos", "zPos", "Entities", "Level", "DataVersion"])
// light and biome data hangs off the sections, below the root filter; the
// capitalised names are the same data inside a pre-1.18 Level tag
const CHUNK_SKIP = new Set(["block_light", "sky_light", "BlockLight", "SkyLight", "biomes", "Biomes", "Heightmaps", "Structures", "UpgradeData"])

// 1.13-1.17 chunks (DataVersion 1451+) are the palette format inside a Level
// tag with older names; they fold to the current shape here. anything older is
// numeric-id storage and stays as-is, which readBlocks counts as outdated
function upgradeChunk(nbt) {
  const lvl = nbt?.Level
  if (!lvl || nbt.sections || !(nbt.DataVersion >= 1451)) return nbt
  const sections = []
  for (const s of lvl.Sections ?? []) {
    if (!s?.Palette) continue
    const block_states = { palette: s.Palette }
    if (s.BlockStates) block_states.data = s.BlockStates
    sections.push({ Y: s.Y, block_states })
  }
  const out = { DataVersion: nbt.DataVersion, xPos: lvl.xPos, zPos: lvl.zPos, sections }
  if (lvl.TileEntities?.length) out.block_entities = lvl.TileEntities
  if (lvl.Entities?.length) out.Entities = lvl.Entities
  return out
}

function normChunk(nbt) {
  for (const s of nbt?.sections ?? []) {
    const pal = s.block_states?.palette
    if (pal) s.block_states.palette = pal.map(normState)
  }
  return nbt
}

async function readChunkFrom(bytes, index, only = CHUNK_KEEP, skip = CHUNK_SKIP) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const loc = dv.getUint32(index * 4)
  if (!loc) return null
  const off = (loc >>> 8) * 4096
  const len = dv.getUint32(off)
  const method = bytes[off + 4]
  const payload = bytes.subarray(off + 5, off + 4 + len)
  if (method === 3) return normChunk(upgradeChunk(await readNBT(payload, { skip, only })))
  if (method === 1 || method === 2) return normChunk(upgradeChunk(await readNBT(await inflate(payload, method === 1 ? "gzip" : "deflate"), { skip, only })))
  throw new Error(`unsupported chunk compression ${method}`)
}

// lazy worlds keep zip entries in the bufs maps; inflated regions live in a
// small LRU so a browse can't accumulate the whole world in memory. The cap is
// byte-based: full-height regions inflate to 100MB+ each, so an entry-count cap
// alone can balloon into gigabytes
const REGION_CACHE_MAX = 24
const REGION_CACHE_BYTES = 320 * 1024 * 1024
async function regionData(world, kind, key) {
  const src = kind === "entity" ? world.entityBufs : world.regionBufs
  const v = src?.get(key)
  if (!v) return null
  if (v instanceof Uint8Array) return v
  const cache = world.regionCache
  const ck = kind + ":" + key
  const hit = cache.get(ck)
  if (hit) {
    cache.delete(ck)
    cache.set(ck, hit)
    return hit
  }
  const bytes = await unzipEntry(v)
  cache.set(ck, bytes)
  let total = 0
  for (const b of cache.values()) total += b.byteLength
  while ((cache.size > REGION_CACHE_MAX || total > REGION_CACHE_BYTES) && cache.size > 1) {
    const k0 = cache.keys().next().value
    total -= cache.get(k0).byteLength
    cache.delete(k0)
  }
  return bytes
}

// entities moved to their own region files in 1.17; they fold back into the
// chunk here, so one read answers for both
async function readChunk(world, chunk) {
  const nbt = await readChunkFrom(await regionData(world, "region", chunk.region), chunk.index)
  const ebytes = await regionData(world, "entity", chunk.region)
  const entityNbt = ebytes && ebytes.length >= 8192 ? await readChunkFrom(ebytes, chunk.index) : null
  const entities = entityNbt?.Entities
  if (!entities?.length) return nbt
  if (!nbt) return { Entities: entities }
  return { ...nbt, Entities: entities }
}

// only section palettes are needed, so the packed block data and the entity
// region are never touched
const EXTENT_ONLY = new Set(["sections", "Level", "DataVersion"])
const EXTENT_SKIP = new Set([...CHUNK_SKIP, "data", "BlockStates", "TileEntities", "Entities"])

async function chunkYExtent(world, chunk, { yMin = -Infinity, yMax = Infinity } = {}) {
  const bytes = await regionData(world, "region", chunk.region)
  const handle = bytes ? await regionHandle(bytes) : null
  if (handle) return chunkExtentFast(handle, chunk.index, yMin, yMax)
  const nbt = bytes ? await readChunkFrom(bytes, chunk.index, EXTENT_ONLY, EXTENT_SKIP) : null
  let top = -Infinity, bottom = Infinity
  for (const s of nbt?.sections ?? []) {
    const pal = s.block_states?.palette
    if (!pal || s.Y * 16 + 15 < yMin || s.Y * 16 > yMax) continue
    if (!pal.some(e => !REAL_AIR.test(e?.id ?? ""))) continue
    if (s.Y * 16 + 15 > top) top = s.Y * 16 + 15
    if (s.Y * 16 < bottom) bottom = s.Y * 16
  }
  return top === -Infinity ? null : { top, bottom }
}

// One chunk's blocks, for callers walking a selection a chunk at a time rather
// than asking for a whole box.
async function readChunkBlocks(world, chunk, { yMin = -Infinity, yMax = Infinity, includeAir = false } = {}) {
  const bytes = await regionData(world, "region", chunk.region)
  const handle = bytes ? await regionHandle(bytes) : null
  if (handle) {
    const out = await chunkBlocksFast(handle, chunk.index, yMin, yMax, includeAir)
    if (out) return out
  }
  const nbt = await readChunk(world, chunk)
  if (!nbt?.sections) return null
  return chunkBlocks(nbt, { yMin, yMax, includeAir })
}

// indices are bit-packed low-to-high; before 20w17a (DataVersion 2527, the
// game's BitStorageAlignFix) they span long boundaries, after they don't.
// readNBT hands the longs over as [lo, hi] uint32 pairs
export function chunkBlocks(nbt, { yMin = -Infinity, yMax = Infinity, includeAir = false } = {}) {
  const palette = [], palIdx = new Map()
  const stateFor = e => {
    const key = e.id + "|" + JSON.stringify(e.properties ?? null)
    let i = palIdx.get(key)
    if (i === undefined) {
      i = palette.length
      palette.push(e.properties ? { id: e.id, properties: e.properties } : { id: e.id })
      palIdx.set(key, i)
    }
    return i
  }
  const beMap = new Map()
  for (const be of nbt?.block_entities ?? []) {
    if (typeof be?.x !== "number") continue
    const { x, y, z, keepPacked, ...rest } = be
    beMap.set(x + "," + y + "," + z, rest)
  }
  const cx = (nbt?.xPos ?? 0) * 16, cz = (nbt?.zPos ?? 0) * 16
  const hasBE = beMap.size > 0
  const blocks = []
  for (const s of nbt?.sections ?? []) {
    const pal = s.block_states?.palette
    if (!pal) continue
    const sy = s.Y * 16
    if (sy > yMax || sy + 15 < yMin) continue
    const map = pal.map(e => !includeAir && REAL_AIR.test(e?.id ?? "") ? -1 : stateFor(e))
    const put = (i, st) => {
      const y = sy + (i >> 8)
      if (y < yMin || y > yMax) return
      const x = cx + (i & 15), z = cz + ((i >> 4) & 15)
      const b = { state: st, pos: [x, y, z] }
      if (hasBE) {
        const nb = beMap.get(x + "," + y + "," + z)
        if (nb) b.nbt = nb
      }
      blocks.push(b)
    }
    if (pal.length === 1) {
      if (map[0] === -1) continue
      for (let i = 0; i < 4096; i++) put(i, map[0])
      continue
    }
    const data = s.block_states.data ?? []
    const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
    const mask = (1 << bits) - 1
    if (nbt.DataVersion < 2527) {
      let w = 0, off = 0
      for (let i = 0; i < 4096; i++) {
        let v = data[w] >>> off
        if (off + bits > 32) v |= data[w + 1] << (32 - off)
        off += bits
        if (off >= 32) { w += off >>> 5; off &= 31 }
        const st = map[v & mask]
        if (st !== -1 && st !== undefined) put(i, st)
      }
      continue
    }
    const vpl = Math.floor(64 / bits)
    const longs = data.length >> 1
    let i = 0
    for (let li = 0; li < longs && i < 4096; li++) {
      const lo = data[li * 2], hi = data[li * 2 + 1]
      for (let j = 0; j < vpl && i < 4096; j++, i++) {
        const off = j * bits
        let v
        if (off + bits <= 32) v = (lo >>> off) & mask
        else if (off >= 32) v = (hi >>> (off - 32)) & mask
        else v = ((lo >>> off) | (hi << (32 - off))) & mask
        const st = map[v]
        if (st !== -1 && st !== undefined) put(i, st)
      }
    }
  }
  const entities = []
  for (const e of nbt?.Entities ?? []) {
    const p = e?.Pos
    if (!Array.isArray(p) || p.length < 3) continue
    const pos = p.map(Number)
    if (pos[1] < yMin || pos[1] > yMax + 1) continue
    entities.push({ pos, nbt: e })
  }
  return withRaw({ palette, blocks, entities })
}

// keyed on the chunks array itself, so setDimension replacing it invalidates
const chunkIndexes = new WeakMap()
function chunkIndexOf(world) {
  let ci = chunkIndexes.get(world)
  if (!ci || ci.chunks !== world.chunks) {
    const byKey = new Map()
    for (const c of world.chunks) byKey.set(c.cx + "," + c.cz, c)
    ci = { chunks: world.chunks, byKey }
    chunkIndexes.set(world, ci)
  }
  return ci.byKey
}

// ungenerated and pre-1.13 chunks are counted rather than thrown, so an empty
// result can say why it is empty
async function readBlocks(world, { x0, y0 = -Infinity, z0, x1, y1 = Infinity, z1, includeAir = false } = {}, onProgress) {
  if (![x0, z0, x1, z1].every(Number.isFinite)) throw new Error("blocks needs a block box: x0, z0, x1, z1")
  if (x1 < x0) [x0, x1] = [x1, x0]
  if (y1 < y0) [y0, y1] = [y1, y0]
  if (z1 < z0) [z0, z1] = [z1, z0]
  const byKey = chunkIndexOf(world)
  const counts = { read: 0, missing: 0, outdated: 0 }
  const cx0 = Math.floor(x0 / 16), cx1 = Math.floor(x1 / 16)
  const cz0 = Math.floor(z0 / 16), cz1 = Math.floor(z1 / 16)
  const total = (cx1 - cx0 + 1) * (cz1 - cz0 + 1)
  let done = 0

  const query = await boxQuery({ x0, y0, z0, x1, y1, z1, includeAir })
  if (query) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const chunk = byKey.get(cx + "," + cz)
        const handle = chunk ? await regionHandle(await regionData(world, "region", chunk.region)) : null
        if (!handle) {
          counts.missing++
          onProgress?.(++done, total)
          continue
        }
        // 1.17 moved entities into their own region files
        const ebytes = await regionData(world, "entity", chunk.region)
        const eh = ebytes && ebytes.length >= 8192 ? await regionHandle(ebytes) : null
        const status = query.addChunk(handle, chunk.index, !eh)
        if (status === 1) counts.missing++
        else if (status === 2) counts.outdated++
        else {
          counts.read++
          if (eh) query.addEntities(eh, chunk.index)
        }
        onProgress?.(++done, total)
      }
    }
    return finish(await finishQuery(query), counts)
  }

  const palette = [], palIdx = new Map()
  const stateFor = e => {
    const key = e.id + "|" + JSON.stringify(e.properties ?? null)
    let i = palIdx.get(key)
    if (i === undefined) {
      i = palette.length
      palette.push(e)
      palIdx.set(key, i)
    }
    return i
  }
  const entities = []
  let flat = new Int32Array(1 << 16)
  let flatLen = 0
  const pushFlat = (state, x, y, z) => {
    if (flatLen + 4 > flat.length) {
      const bigger = new Int32Array(Math.max(flat.length * 2, flatLen + 4))
      bigger.set(flat.subarray(0, flatLen))
      flat = bigger
    }
    flat[flatLen++] = state; flat[flatLen++] = x; flat[flatLen++] = y; flat[flatLen++] = z
  }
  const nbtIdx = [], nbtVal = []
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const chunk = byKey.get(cx + "," + cz)
      const nbt = chunk ? await readChunk(world, chunk) : null
      if (!nbt) {
        counts.missing++
        onProgress?.(++done, total)
        continue
      }
      if (nbt.Level && !nbt.sections) {
        counts.outdated++
        onProgress?.(++done, total)
        continue
      }
      counts.read++
      const part = chunkBlocks(nbt, { yMin: y0, yMax: y1, includeAir })
      const map = part.palette.map(stateFor)
      for (const b of part.blocks) {
        const [x, , z] = b.pos
        if (x < x0 || x > x1 || z < z0 || z > z1) continue
        if (b.nbt) { nbtIdx.push(flatLen / 4); nbtVal.push(b.nbt) }
        pushFlat(map[b.state], x, b.pos[1], z)
      }
      for (const e of part.entities) {
        const [x, , z] = e.pos
        if (x < x0 || x > x1 + 1 || z < z0 || z > z1 + 1) continue
        entities.push(e)
      }
      onProgress?.(++done, total)
    }
  }
  return finish({ palette, raw: flat.subarray(0, flatLen), blockNbt: { bi: nbtIdx, bn: nbtVal }, entities }, counts)
}

function finish({ palette, raw, blockNbt, entities }, counts) {
  return withBlocks({ palette, blocks: null, entities, chunks: counts }, raw, blockNbt.bi, blockNbt.bn)
}

// A chunk as a dense voxel grid, for renderers that need O(1) neighbour lookups.
// `grid` is 256 * height cells of (y - yMin) * 256 + z * 16 + x, holding 0 for
// air or a one-based index into `palette`.
async function readChunkGrid(world, chunk, { yMin = -Infinity, yMax = Infinity } = {}) {
  const bytes = await regionData(world, "region", chunk.region)
  const handle = bytes ? await regionHandle(bytes) : null
  if (handle) {
    const out = await chunkGridFast(handle, chunk.index, yMin, yMax)
    if (out) return out
  }
  return chunkGridJs(await readChunk(world, chunk), yMin, yMax)
}

function chunkGridJs(nbt, yMin, yMax) {
  const height = Math.max(0, yMax - yMin + 1)
  const grid = new Uint16Array(256 * height)
  const palette = []
  const palIdx = new Map()
  const blockEntities = []
  let empty = true
  if (!nbt?.sections) return { palette, grid, blockEntities, empty }

  for (const be of nbt.block_entities ?? []) {
    if (typeof be?.x !== "number" || be.y < yMin || be.y > yMax) continue
    const { x, y, z, keepPacked, ...rest } = be
    blockEntities.push({ x, y, z, nbt: rest })
  }

  for (const s of nbt.sections) {
    const pal = s.block_states?.palette
    if (!pal) continue
    const sy = s.Y * 16
    if (sy + 15 < yMin || sy > yMax) continue
    const map = pal.map(e => {
      if (REAL_AIR.test(e?.id ?? "")) return 0
      const key = e.id + "|" + JSON.stringify(e.properties ?? null)
      let i = palIdx.get(key)
      if (i === undefined) {
        i = palette.length + 1
        palette.push(e.properties ? { id: e.id, properties: e.properties } : { id: e.id })
        palIdx.set(key, i)
      }
      return i
    })
    const yLo = Math.max(0, yMin - sy), yHi = Math.min(15, yMax - sy)
    const put = (i, gi) => {
      if (!gi) return
      const y = i >> 8
      if (y < yLo || y > yHi) return
      grid[(sy + y - yMin) * 256 + (i & 255)] = gi
      empty = false
    }

    if (pal.length === 1) {
      if (!map[0]) continue
      for (let y = yLo; y <= yHi; y++) grid.fill(map[0], (sy + y - yMin) * 256, (sy + y - yMin) * 256 + 256)
      empty = false
      continue
    }

    const data = s.block_states.data ?? []
    const bits = Math.max(4, 32 - Math.clz32(pal.length - 1))
    const mask = (1 << bits) - 1
    if (nbt.DataVersion < 2527) {
      let w = 0, off = 0
      for (let i = 0; i < 4096; i++) {
        let v = data[w] >>> off
        if (off + bits > 32) v |= data[w + 1] << (32 - off)
        off += bits
        if (off >= 32) { w += off >>> 5; off &= 31 }
        put(i, map[v & mask])
      }
      continue
    }
    const vpl = Math.floor(64 / bits)
    const longs = data.length >> 1
    let i = 0
    for (let li = 0; li < longs && i < 4096; li++) {
      const lo = data[li * 2], hi = data[li * 2 + 1]
      for (let j = 0; j < vpl && i < 4096; j++, i++) {
        const off = j * bits
        let v
        if (off + bits <= 32) v = (lo >>> off) & mask
        else if (off >= 32) v = (hi >>> (off - 32)) & mask
        else v = ((lo >>> off) | (hi << (32 - off))) & mask
        put(i, map[v])
      }
    }
  }
  return { palette, grid, blockEntities, empty }
}
