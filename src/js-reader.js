// The js reader, reached only when the wasm module cannot load. Nothing in the
// eager graph imports this, so a bundler splits it into its own chunk and the
// 118kB legacy state table only downloads if it is actually needed.

import { readNBT, rootOf } from "./nbt.js"
import { readLitematic, readSchem, readMcstructure } from "./formats.js"
import { normState } from "./state.js"
import { withRaw } from "./blocks.js"
import legacyStates from "./legacyStates.js"

// Null when the bytes are not a structure file, so read can go on to try a
// region file.
export async function readStructureJs(bytes) {
  try {
    const root = await readNBT(bytes)
    if (root.Regions) return readLitematic(root)
    if (root.Schematic || (root.Palette && (root.BlockData || root.Data) && root.Width)) return readSchem(root)
    if (root.structure?.block_indices) return readMcstructure(root)
    if (root.blocks && (root.palette || root.palettes || root.size)) return readStructure(root)
  } catch {}
  return null
}

// some vanilla files (shipwrecks) use the plural `palettes` form
export async function readStructure(input) {
  const root = await rootOf(input)
  const size = (root.size ?? [0, 0, 0]).map(Number)
  const palette = (root.palette ?? root.palettes?.[0] ?? []).map(normState)
  const blocks = (root.blocks ?? []).map(b => {
    const out = { state: Number(b.state), pos: b.pos.map(Number) }
    if (b.nbt) out.nbt = b.nbt
    return out
  })
  if (!palette.length && blocks.length) upgradeLegacyStates(palette, blocks)
  const entities = (root.entities ?? []).flatMap(e => e.nbt ? [{
    pos: (e.pos ?? e.blockPos ?? [0, 0, 0]).map(Number),
    nbt: e.nbt
  }] : [])
  return withRaw({ size, palette, blocks, entities })
}

function upgradeLegacyStates(palette, blocks) {
  const indices = new Map()
  for (const b of blocks) {
    const id = (b.state & 0xFFF) << 4 | b.state >> 12
    const entry = legacyStates[id] ?? legacyStates[id & ~15]
    let state, key = b.state
    if (entry?.[0] === "%%FILTER_ME%%") {
      state = skullState(entry[1], b.nbt)
      key = b.state + "|" + state.id + "|" + (state.properties.rotation ?? "")
    } else if (entry) {
      state = entry[1] ? { id: entry[0], properties: { ...entry[1] } } : { id: entry[0] }
    } else {
      state = { id: "minecraft:air" }
    }
    let index = indices.get(key)
    if (index === undefined) {
      indices.set(key, index = palette.length)
      palette.push(state)
    }
    b.state = index
  }
}

const SKULL_TYPES = ["skeleton", "wither_skeleton", "zombie", "player", "creeper", "dragon"]

function skullState(props, nbt) {
  const mob = SKULL_TYPES[nbt?.SkullType ?? 0] ?? "skeleton"
  const part = mob.includes("skeleton") ? "skull" : "head"
  if (props?.facing === "up" || props?.facing === "down") {
    return { id: `minecraft:${mob}_${part}`, properties: { rotation: String(nbt?.Rot ?? 0) } }
  }
  return { id: `minecraft:${mob}_wall_${part}`, properties: { facing: props?.facing ?? "north" } }
}
