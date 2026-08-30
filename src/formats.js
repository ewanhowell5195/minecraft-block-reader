import { rootOf } from "./nbt.js"
import { withRaw } from "./blocks.js"
import { AIR, parseState, normState } from "./state.js"

function collector() {
  const palette = [], idx = new Map(), cells = [], nbts = new Map(), ents = []
  function stateFor(id, properties) {
    const key = id + "|" + JSON.stringify(properties ?? null)
    let i = idx.get(key)
    if (i === undefined) {
      i = palette.length
      palette.push(properties ? { id, properties } : { id })
      idx.set(key, i)
    }
    return i
  }
  const push = (x, y, z, state) => cells.push([x, y, z, state])
  const blockNbt = (x, y, z, nbt) => nbts.set(x + "," + y + "," + z, nbt)
  const entity = (pos, nbt) => ents.push({ pos, nbt })
  function finish() {
    if (!cells.length) {
      return withRaw({
        size: [1, 1, 1],
        palette: [{ id: "minecraft:air" }],
        blocks: [{ state: 0, pos: [0, 0, 0] }],
        entities: ents.map(e => ({ pos: e.pos.slice(), nbt: e.nbt }))
      })
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const c of cells) for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], c[i])
      hi[i] = Math.max(hi[i], c[i])
    }
    return withRaw({
      size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1],
      palette,
      blocks: cells.map(c => {
        const b = { state: c[3], pos: [c[0] - lo[0], c[1] - lo[1], c[2] - lo[2]] }
        const nbt = nbts.get(c[0] + "," + c[1] + "," + c[2])
        if (nbt) b.nbt = nbt
        return b
      }),
      entities: ents.map(e => ({ pos: [e.pos[0] - lo[0], e.pos[1] - lo[1], e.pos[2] - lo[2]], nbt: e.nbt }))
    })
  }
  return { stateFor, push, blockNbt, entity, finish }
}

function strProps(props) {
  if (!props) return undefined
  const out = {}
  for (const [k, v] of Object.entries(props)) out[k] = String(v)
  return Object.keys(out).length ? out : undefined
}

// Litematica: packed indices span long boundaries (pre-1.16 style), order
// y, z, x fastest; negative Size extends the region negative from Position
export async function readLitematic(buf) {
  const root = await rootOf(buf)
  const { stateFor, push, blockNbt, entity, finish } = collector()
  for (const region of Object.values(root.Regions ?? {})) {
    const size = region.Size, pos = region.Position
    const sx = Math.abs(size.x), sy = Math.abs(size.y), sz = Math.abs(size.z)
    const mx = pos.x + Math.min(size.x + 1, 0), my = pos.y + Math.min(size.y + 1, 0), mz = pos.z + Math.min(size.z + 1, 0)
    const pal = (region.BlockStatePalette ?? []).map(normState)
    const states = region.BlockStates ?? []
    const bits = Math.max(2, 32 - Math.clz32(Math.max(1, pal.length - 1)))
    const mask = bits === 32 ? 0xFFFFFFFF : (1 << bits) - 1
    const mapped = pal.map(e => AIR.test(e?.id || "") ? -1 : stateFor(e.id, strProps(e.properties)))
    let w = 0, off = 0
    for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      let v = states[w] >>> off
      if (off + bits > 32) v |= states[w + 1] << (32 - off)
      off += bits
      if (off >= 32) { w += off >>> 5; off &= 31 }
      const state = mapped[(v & mask) >>> 0]
      if (state === undefined || state < 0) continue
      push(mx + x, my + y, mz + z, state)
    }
    // tile entity coords are relative to the region's min corner; entity
    // positions are relative to Position, which differs when Size is negative
    for (const be of region.TileEntities ?? []) {
      if (typeof be?.x !== "number") continue
      const { x, y, z, ...rest } = be
      blockNbt(mx + x, my + y, mz + z, rest)
    }
    for (const e of region.Entities ?? []) {
      const p = e?.Pos
      if (!Array.isArray(p) || p.length < 3) continue
      entity([pos.x + Number(p[0]), pos.y + Number(p[1]), pos.z + Number(p[2])], e)
    }
  }
  return finish()
}

// Sponge .schem: varint indices, order y, z, x fastest
export async function readSchem(buf) {
  const root = await rootOf(buf)
  const s = root.Schematic ?? root
  const blocks = s.Blocks ?? s
  const paletteTag = blocks.Palette ?? {}
  const data = blocks.Data ?? blocks.BlockData
  const W = Number(s.Width), H = Number(s.Height), L = Number(s.Length)
  if (!data || !W || !H || !L) throw new Error("not a Sponge schematic")
  const { stateFor, push, blockNbt, entity, finish } = collector()
  const byId = []
  for (const [str, pi] of Object.entries(paletteTag)) {
    const e = parseState(str)
    byId[Number(pi)] = AIR.test(e.id) ? -1 : stateFor(e.id, e.properties)
  }
  let o = 0
  for (let i = 0; i < W * H * L; i++) {
    let v = 0, shift = 0, b
    do { b = data[o++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
    const state = byId[v]
    if (state === undefined || state < 0) continue
    const x = i % W, z = Math.floor(i / W) % L, y = Math.floor(i / (W * L))
    push(x, y, z, state)
  }
  // v3 nests the payload under Data with the id as Id; v2 stores it inline
  function beNbt(be) {
    const { Pos, Id, Data, ...rest } = be
    return { ...(Data ?? rest), ...(Id ? { id: Id } : {}) }
  }
  for (const be of blocks.BlockEntities ?? s.BlockEntities ?? s.TileEntities ?? []) {
    const p = be?.Pos
    if (!Array.isArray(p) || p.length < 3) continue
    blockNbt(Number(p[0]), Number(p[1]), Number(p[2]), beNbt(be))
  }
  for (const e of s.Entities ?? []) {
    const p = e?.Pos
    if (!Array.isArray(p) || p.length < 3) continue
    entity(p.map(Number), beNbt(e))
  }
  return finish()
}

// Bedrock .mcstructure: LITTLE-endian NBT, index order x, y, z fastest;
// layer 1 is mostly waterlogging, -1 = not saved. state mapping is best-effort
const FACING6 = ["down", "up", "north", "south", "west", "east"]
const STAIRS4 = ["east", "west", "south", "north"]
const DIR4 = ["south", "west", "north", "east"]

function bedrockProps(states) {
  const p = {}
  for (const [k, v] of Object.entries(states ?? {})) {
    switch (k) {
      case "pillar_axis": p.axis = String(v); break
      case "minecraft:cardinal_direction": p.facing = String(v); break
      case "minecraft:facing_direction": p.facing = String(v); break
      case "facing_direction": if (FACING6[v]) p.facing = FACING6[v]; break
      case "weirdo_direction": if (STAIRS4[v]) p.facing = STAIRS4[v]; break
      case "direction": if (DIR4[v]) p.facing = DIR4[v]; break
      case "minecraft:vertical_half": p.type = String(v); break
      case "top_slot_bit": p.type = v ? "top" : "bottom"; break
      case "upside_down_bit": p.half = v ? "top" : "bottom"; break
      case "half": p.half = String(v); break
      case "open_bit": p.open = v ? "true" : "false"; break
      case "door_hinge_bit": p.hinge = v ? "right" : "left"; break
      case "upper_block_bit": p.half = v ? "upper" : "lower"; break
      case "ground_sign_direction": p.rotation = String(v); break
      case "hanging": p.hanging = v ? "true" : "false"; break
      case "lit": case "extinguished": p.lit = v ? "true" : "false"; break
      case "persistent_bit": p.persistent = v ? "true" : "false"; break
      case "candles": p.candles = String(Number(v) + 1); break
      case "growth": case "age": p.age = String(v); break
    }
  }
  return Object.keys(p).length ? p : undefined
}

export async function readMcstructure(buf) {
  const root = await rootOf(buf, { littleEndian: true })
  const [sx, sy, sz] = (root.size ?? []).map(Number)
  const layers = root.structure?.block_indices ?? []
  const pal = root.structure?.palette?.default?.block_palette ?? []
  if (!sx || !layers.length) throw new Error("not a .mcstructure file")
  const { stateFor, push, blockNbt, entity, finish } = collector()
  const layer0 = layers[0], layer1 = layers[1]
  const posData = root.structure?.palette?.default?.block_position_data ?? {}
  const water = new Set(pal.map((e, i) => /(^|:)(water|flowing_water)$/.test(e?.name || "") ? i : null).filter(i => i !== null))
  for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
    const i = (x * sy + y) * sz + z
    const pi = Number(layer0[i])
    if (pi < 0) continue
    const e = pal[pi]
    if (!e?.name || AIR.test(e.name)) continue
    let props = bedrockProps(e.states)
    if (layer1 && water.has(Number(layer1[i]))) props = { ...props, waterlogged: "true" }
    push(x, y, z, stateFor(e.name, props))
    const nbt = posData[i]?.block_entity_data
    if (nbt) blockNbt(x, y, z, nbt)
  }
  // entity positions are world coordinates; the origin brings them local
  const [ox, oy, oz] = (root.structure_world_origin ?? [0, 0, 0]).map(Number)
  for (const e of root.structure?.entities ?? []) {
    const p = e?.Pos
    if (!Array.isArray(p) || p.length < 3) continue
    entity([Number(p[0]) - ox, Number(p[1]) - oy, Number(p[2]) - oz], e)
  }
  return finish()
}
