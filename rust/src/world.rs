use crate::chunk::{chunk_into, Acc, ChunkBlocks, ChunkOptions};
use crate::nbt::{Compound, Value};
use crate::region::{read_chunk, read_chunk_extent};
use crate::state::{is_real_air, norm_state, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkStatus {
    Read,
    /// Not generated, or not in this region file.
    Missing,
    /// Older than the palette format, so the numeric ids are not read.
    TooOld,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub read: u32,
    pub missing: u32,
    pub outdated: u32,
}

/// One region file, held so a browse does not copy it per chunk.
pub struct Region {
    bytes: Vec<u8>,
}

impl Region {
    pub fn new(bytes: Vec<u8>) -> Region {
        Region { bytes }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// `index` is the chunk's slot in the region header, `(cx & 31) + (cz & 31) * 32`.
    pub fn chunk(&self, index: usize) -> Option<Compound> {
        read_chunk(&self.bytes, index)
    }

    pub fn chunk_blocks(&self, index: usize, opts: &ChunkOptions) -> Option<ChunkBlocks> {
        let nbt = self.chunk(index)?;
        if !nbt.contains("sections") {
            return None;
        }
        Some(crate::chunk::chunk_blocks(&nbt, opts))
    }

    /// `(bottom, top)` of the non air blocks, or nothing when the chunk holds
    /// none inside `y_min..=y_max`. Sections are judged by their palette, so a
    /// section counts when it overlaps the range and is not all air.
    pub fn chunk_extent(&self, index: usize, y_min: f64, y_max: f64) -> Option<(i32, i32)> {
        let nbt = read_chunk_extent(&self.bytes, index)?;
        let Some(Value::List(_, sections)) = nbt.get("sections") else { return None };
        let mut top = i32::MIN;
        let mut bottom = i32::MAX;
        for s in sections {
            let Some(sc) = s.as_compound() else { continue };
            let Some(bs) = sc.get("block_states").and_then(|v| v.as_compound()) else { continue };
            let Some(Value::List(_, pal)) = bs.get("palette") else { continue };
            let y = sc.get("Y").and_then(|v| v.as_i64()).unwrap_or(0) as i32 * 16;
            if ((y + 15) as f64) < y_min || (y as f64) > y_max {
                continue;
            }
            if !pal.iter().any(|e| !is_real_air(&norm_state(e).unwrap_or_default().id)) {
                continue;
            }
            top = top.max(y + 15);
            bottom = bottom.min(y);
        }
        if top == i32::MIN {
            None
        } else {
            Some((bottom, top))
        }
    }
}

/// A box query across many chunks, sharing one palette. Chunks are fed in one
/// at a time, so the caller owns however it finds the region files.
pub struct BoxQuery {
    acc: Acc,
    opts: ChunkOptions,
    counts: Counts,
}

impl BoxQuery {
    pub fn new(min: [f64; 3], max: [f64; 3], include_air: bool) -> BoxQuery {
        BoxQuery {
            acc: Acc::default(),
            opts: ChunkOptions {
                x_min: min[0],
                x_max: max[0],
                y_min: min[1],
                y_max: max[1],
                z_min: min[2],
                z_max: max[2],
                include_air,
                entities: true,
            },
            counts: Counts::default(),
        }
    }

    /// `with_entities` is false when a 1.17+ entity region will supply them.
    pub fn add_chunk(&mut self, region: &Region, index: usize, with_entities: bool) -> ChunkStatus {
        let Some(nbt) = region.chunk(index) else {
            self.counts.missing += 1;
            return ChunkStatus::Missing;
        };
        if !nbt.contains("sections") {
            self.counts.outdated += 1;
            return ChunkStatus::TooOld;
        }
        self.counts.read += 1;
        self.opts.entities = with_entities;
        chunk_into(&nbt, &self.opts, &mut self.acc);
        ChunkStatus::Read
    }

    /// Entities from a 1.17+ entity region, replacing any the chunk carried.
    pub fn add_entities(&mut self, region: &Region, index: usize) {
        let Some(nbt) = region.chunk(index) else { return };
        self.opts.entities = true;
        chunk_into(&nbt, &self.opts, &mut self.acc);
    }

    pub fn counts(&self) -> Counts {
        self.counts
    }

    pub fn finish(&mut self) -> ChunkBlocks {
        ChunkBlocks {
            palette: std::mem::take(&mut self.acc.palette),
            flat: std::mem::take(&mut self.acc.flat),
            block_nbt: std::mem::take(&mut self.acc.block_nbt),
            entities: std::mem::take(&mut self.acc.entities),
        }
    }
}

/// A chunk as a dense voxel grid, for renderers that need O(1) neighbour
/// lookups. `grid` is `256 * height` cells indexed `(y - y_min) * 256 + z * 16 + x`,
/// holding 0 for air or a one based index into `palette`.
pub struct ChunkGrid {
    pub palette: Vec<State>,
    pub grid: Vec<u16>,
    /// Absolute position and nbt, for the block entities inside the y range.
    pub block_entities: Vec<([i32; 3], Compound)>,
    pub empty: bool,
}

impl Region {
    pub fn chunk_grid(&self, index: usize, y_min: i32, y_max: i32) -> Option<ChunkGrid> {
        let nbt = self.chunk(index)?;
        let height = (y_max - y_min + 1).max(0) as usize;
        let mut out = ChunkGrid {
            palette: Vec::new(),
            grid: vec![0u16; 256 * height],
            block_entities: Vec::new(),
            empty: true,
        };
        let Some(Value::List(_, sections)) = nbt.get("sections") else { return Some(out) };

        if let Some(Value::List(_, items)) = nbt.get("block_entities") {
            for it in items {
                let Some(c) = it.as_compound() else { continue };
                let (Some(x), Some(y), Some(z)) = (
                    c.get("x").and_then(|v| v.as_i64()),
                    c.get("y").and_then(|v| v.as_i64()),
                    c.get("z").and_then(|v| v.as_i64()),
                ) else {
                    continue;
                };
                if (y as i32) < y_min || (y as i32) > y_max {
                    continue;
                }
                let mut rest = Compound::default();
                for (k, v) in &c.entries {
                    if k != "x" && k != "y" && k != "z" && k != "keepPacked" {
                        rest.entries.push((k.clone(), v.clone()));
                    }
                }
                out.block_entities.push(([x as i32, y as i32, z as i32], rest));
            }
        }

        let data_version = nbt.get("DataVersion").and_then(|v| v.as_i64()).unwrap_or(0);
        let mut index_of: std::collections::HashMap<String, u16> = std::collections::HashMap::new();

        for s in sections {
            let Some(sc) = s.as_compound() else { continue };
            let Some(bs) = sc.get("block_states").and_then(|v| v.as_compound()) else { continue };
            let Some(Value::List(_, pal)) = bs.get("palette") else { continue };
            let sy = sc.get("Y").and_then(|v| v.as_i64()).unwrap_or(0) as i32 * 16;
            if sy + 15 < y_min || sy > y_max {
                continue;
            }

            let map: Vec<u16> = pal
                .iter()
                .map(|e| {
                    let st = norm_state(e).unwrap_or_default();
                    if is_real_air(&st.id) {
                        return 0;
                    }
                    let key = st.key();
                    if let Some(i) = index_of.get(&key) {
                        return *i;
                    }
                    let i = out.palette.len() as u16 + 1;
                    out.palette.push(st);
                    index_of.insert(key, i);
                    i
                })
                .collect();

            let y_lo = (y_min - sy).max(0);
            let y_hi = (y_max - sy).min(15);

            if pal.len() == 1 {
                if map[0] == 0 {
                    continue;
                }
                for y in y_lo..=y_hi {
                    let row = (sy + y - y_min) as usize * 256;
                    out.grid[row..row + 256].fill(map[0]);
                }
                out.empty = false;
                continue;
            }

            let data: Vec<u32> = match bs.get("data") {
                Some(Value::LongArray(a)) => crate::collector::words(a),
                _ => Vec::new(),
            };
            let bits = (32 - ((pal.len() - 1) as u32).leading_zeros()).max(4);
            let mask: u32 = if bits >= 32 { u32::MAX } else { (1u32 << bits) - 1 };

            let put = |i: usize, gi: u16, grid: &mut Vec<u16>, empty: &mut bool| {
                if gi == 0 {
                    return;
                }
                let y = (i >> 8) as i32;
                if y < y_lo || y > y_hi {
                    return;
                }
                grid[(sy + y - y_min) as usize * 256 + (i & 255)] = gi;
                *empty = false;
            };

            if data_version < 2527 {
                let mut w = 0usize;
                let mut off = 0u32;
                for i in 0..4096 {
                    let mut v = data.get(w).copied().unwrap_or(0) >> off;
                    if off + bits > 32 {
                        v |= data.get(w + 1).copied().unwrap_or(0) << (32 - off);
                    }
                    off += bits;
                    if off >= 32 {
                        w += (off >> 5) as usize;
                        off &= 31;
                    }
                    if let Some(&gi) = map.get((v & mask) as usize) {
                        put(i, gi, &mut out.grid, &mut out.empty);
                    }
                }
                continue;
            }

            let vpl = 64 / bits;
            let longs = data.len() / 2;
            let mut i = 0usize;
            for li in 0..longs {
                if i >= 4096 {
                    break;
                }
                let lo = data[li * 2];
                let hi = data[li * 2 + 1];
                for j in 0..vpl {
                    if i >= 4096 {
                        break;
                    }
                    let off = j * bits;
                    let v = if off + bits <= 32 {
                        (lo >> off) & mask
                    } else if off >= 32 {
                        (hi >> (off - 32)) & mask
                    } else {
                        ((lo >> off) | (hi << (32 - off))) & mask
                    };
                    if let Some(&gi) = map.get(v as usize) {
                        put(i, gi, &mut out.grid, &mut out.empty);
                    }
                    i += 1;
                }
            }
        }
        Some(out)
    }
}
