import zlib from "node:zlib"

// minimal NBT writer for fixtures: values are { t, v } so tag types are explicit
export const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
}

export const B = v => ({ t: TAG.BYTE, v })
export const Sh = v => ({ t: TAG.SHORT, v })
export const I = v => ({ t: TAG.INT, v })
export const L = v => ({ t: TAG.LONG, v: BigInt(v) })
export const F = v => ({ t: TAG.FLOAT, v })
export const D = v => ({ t: TAG.DOUBLE, v })
export const Str = v => ({ t: TAG.STRING, v })
export const bytes = v => ({ t: TAG.BYTE_ARRAY, v: Uint8Array.from(v) })
export const ints = v => ({ t: TAG.INT_ARRAY, v })
export const longs = v => ({ t: TAG.LONG_ARRAY, v: v.map(BigInt) })
export const list = items => ({ t: TAG.LIST, v: items })
export const comp = obj => ({ t: TAG.COMPOUND, v: obj })

export function writeNBT(root, { littleEndian = false, name = "" } = {}) {
  const out = []
  const scratch = new DataView(new ArrayBuffer(8))
  const enc = new TextEncoder()
  function pushN(n, fn) {
    fn(scratch)
    for (let i = 0; i < n; i++) out.push(scratch.getUint8(i))
  }
  function str(v) {
    const b = enc.encode(v)
    pushN(2, s => s.setUint16(0, b.length, littleEndian))
    for (const c of b) out.push(c)
  }
  const i32 = v => pushN(4, s => s.setInt32(0, v, littleEndian))
  const i64 = v => pushN(8, s => s.setBigInt64(0, BigInt(v), littleEndian))
  function payload(x) {
    switch (x.t) {
      case TAG.BYTE: pushN(1, s => s.setInt8(0, x.v)); break
      case TAG.SHORT: pushN(2, s => s.setInt16(0, x.v, littleEndian)); break
      case TAG.INT: i32(x.v); break
      case TAG.LONG: i64(x.v); break
      case TAG.FLOAT: pushN(4, s => s.setFloat32(0, x.v, littleEndian)); break
      case TAG.DOUBLE: pushN(8, s => s.setFloat64(0, x.v, littleEndian)); break
      case TAG.BYTE_ARRAY: i32(x.v.length); for (const b of x.v) out.push(b); break
      case TAG.STRING: str(x.v); break
      case TAG.LIST: {
        out.push(x.v[0]?.t ?? TAG.END)
        i32(x.v.length)
        for (const e of x.v) payload(e)
        break
      }
      case TAG.COMPOUND:
        for (const [k, v] of Object.entries(x.v)) {
          out.push(v.t)
          str(k)
          payload(v)
        }
        out.push(TAG.END)
        break
      case TAG.INT_ARRAY: i32(x.v.length); for (const n of x.v) i32(n); break
      case TAG.LONG_ARRAY: i32(x.v.length); for (const n of x.v) i64(n); break
      default: throw new Error("unknown tag " + x.t)
    }
  }
  out.push(TAG.COMPOUND)
  str(name)
  payload(root)
  return Uint8Array.from(out)
}

const MASK64 = 0xFFFFFFFFFFFFFFFFn

// litematica packing: indices span long boundaries
export function packLitematic(indices, bits) {
  const longsArr = new Array(Math.ceil(indices.length * bits / 64) || 1).fill(0n)
  indices.forEach((v, n) => {
    const bit = BigInt(n * bits)
    const w = Number(bit >> 6n), off = bit & 63n
    longsArr[w] = (longsArr[w] | (BigInt(v) << off)) & MASK64
    if (off + BigInt(bits) > 64n) longsArr[w + 1] = (longsArr[w + 1] | (BigInt(v) >> (64n - off))) & MASK64
  })
  return longsArr.map(v => BigInt.asIntN(64, v))
}

// chunk packing (1.16+): values never span longs
export function packChunk(indices, bits) {
  const vpl = Math.floor(64 / bits)
  const longsArr = new Array(Math.ceil(indices.length / vpl) || 1).fill(0n)
  indices.forEach((v, n) => {
    const w = Math.floor(n / vpl), j = n % vpl
    longsArr[w] = (longsArr[w] | (BigInt(v) << BigInt(j * bits))) & MASK64
  })
  return longsArr.map(v => BigInt.asIntN(64, v))
}

// anvil region: 8KB header, chunks zlib-deflated with method 2
export function buildRegion(chunksByIndex) {
  const header = new Uint8Array(8192)
  const dvh = new DataView(header.buffer)
  const parts = [header]
  let sectorOff = 2
  for (const [index, raw] of chunksByIndex) {
    const compressed = zlib.deflateSync(raw)
    const len = compressed.length + 1
    const size = Math.ceil((len + 4) / 4096)
    dvh.setUint32(index * 4, (sectorOff << 8) | size)
    const sector = new Uint8Array(size * 4096)
    new DataView(sector.buffer).setUint32(0, len)
    sector[4] = 2
    sector.set(compressed, 5)
    parts.push(sector)
    sectorOff += size
  }
  return concat(parts)
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// stored-only zip; the reader never checks crcs
export function buildZip(files) {
  const enc = new TextEncoder()
  const parts = [], cd = []
  let off = 0
  for (const { name, data, method } of files) {
    const nameBytes = enc.encode(name)
    const local = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    if (method) dv.setUint16(8, method, true)
    dv.setUint32(18, data.length, true)
    dv.setUint32(22, data.length, true)
    dv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    parts.push(local, data)
    const central = new Uint8Array(46 + nameBytes.length)
    const cdv = new DataView(central.buffer)
    cdv.setUint32(0, 0x02014b50, true)
    cdv.setUint16(4, 20, true)
    cdv.setUint16(6, 20, true)
    if (method) cdv.setUint16(10, method, true)
    cdv.setUint32(20, data.length, true)
    cdv.setUint32(24, data.length, true)
    cdv.setUint16(28, nameBytes.length, true)
    cdv.setUint32(42, off, true)
    central.set(nameBytes, 46)
    cd.push(central)
    off += local.length + data.length
  }
  const cdBytes = concat(cd)
  const eocd = new Uint8Array(22)
  const edv = new DataView(eocd.buffer)
  edv.setUint32(0, 0x06054b50, true)
  edv.setUint16(8, files.length, true)
  edv.setUint16(10, files.length, true)
  edv.setUint32(12, cdBytes.length, true)
  edv.setUint32(16, off, true)
  return concat(parts.concat([cdBytes, eocd]))
}

export const gzip = data => new Uint8Array(zlib.gzipSync(data))
