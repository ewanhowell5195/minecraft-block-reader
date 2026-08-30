function withBlockNbt(result, build) {
  let cache
  Object.defineProperty(result, "blockNbt", {
    enumerable: false,
    configurable: true,
    get: () => cache ??= build()
  })
}

export function withRaw(result) {
  let cache
  Object.defineProperty(result, "raw", {
    enumerable: false,
    configurable: true,
    get() {
      if (cache) return cache
      const blocks = result.blocks
      cache = new Int32Array(blocks.length * 4)
      for (let i = 0, j = 0; i < blocks.length; i++) {
        const b = blocks[i]
        cache[j++] = b.state
        cache[j++] = b.pos[0]
        cache[j++] = b.pos[1]
        cache[j++] = b.pos[2]
      }
      return cache
    }
  })
  withBlockNbt(result, () => {
    const out = new Map()
    const blocks = result.blocks
    for (let i = 0; i < blocks.length; i++) if (blocks[i].nbt) out.set(i, blocks[i].nbt)
    return out
  })
  return result
}

// `result` carries a placeholder `blocks` key so redefining it here leaves the
// key where the js readers put it
export function withBlocks(result, raw, nbtIndices, nbtValues) {
  Object.defineProperty(result, "raw", { value: raw, enumerable: false, configurable: true })
  let cache
  Object.defineProperty(result, "blocks", {
    enumerable: true,
    configurable: true,
    get() {
      if (cache) return cache
      cache = new Array(raw.length / 4)
      for (let i = 0, j = 0; i < raw.length; i += 4, j++) {
        cache[j] = { state: raw[i], pos: [raw[i + 1], raw[i + 2], raw[i + 3]] }
      }
      for (let k = 0; k < nbtIndices.length; k++) cache[nbtIndices[k]].nbt = nbtValues[k]
      return cache
    }
  })
  withBlockNbt(result, () => {
    const out = new Map()
    for (let k = 0; k < nbtIndices.length; k++) out.set(nbtIndices[k], nbtValues[k])
    return out
  })
  return result
}
