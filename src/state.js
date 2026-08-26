export const AIR = /(^|:)(air|cave_air|void_air|structure_void)$/
export const REAL_AIR = /(^|:)(air|cave_air|void_air)$/

export function parseState(str) {
  const m = typeof str === "string" && str.trim().match(/^([\w./-]+(?::[\w./-]+)?)(?:\[(.*)\])?$/)
  if (!m) return { id: "minecraft:air" }
  const id = m[1].includes(":") ? m[1] : "minecraft:" + m[1]
  if (!m[2]) return { id }
  const properties = {}
  for (const kv of m[2].split(",")) {
    const [k, v] = kv.split("=")
    if (k && v !== undefined) properties[k.trim()] = v.trim()
  }
  return { id, properties }
}

// 26.3-snapshot-7 renamed the block state fields Name -> id and Properties ->
// properties, and writes a default state as the bare block id. older files
// still ship the old shape, so everything folds forward to the new one
const STATE_STR = /^[\w./-]+(?::[\w./-]+)?(?:\[.*\])?$/

export function normState(v) {
  if (typeof v === "string") return STATE_STR.test(v.trim()) ? parseState(v) : v
  if (!v || typeof v !== "object" || Array.isArray(v)) return v
  if (typeof v.Name !== "string") return v
  return v.Properties ? { id: v.Name, properties: v.Properties } : { id: v.Name }
}
