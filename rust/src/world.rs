use crate::chunk::{chunk_into, Acc, ChunkBlocks, ChunkOptions};
use crate::nbt::{Compound, Value};
use crate::region::{read_chunk, read_chunk_extent};
use crate::state::{is_real_air, norm_state};

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

    /// `(bottom, top)` of the non air blocks, or nothing when the chunk is empty.
    pub fn chunk_extent(&self, index: usize) -> Option<(i32, i32)> {
        let nbt = read_chunk_extent(&self.bytes, index)?;
        let Some(Value::List(_, sections)) = nbt.get("sections") else { return None };
        let mut top = i32::MIN;
        let mut bottom = i32::MAX;
        for s in sections {
            let Some(sc) = s.as_compound() else { continue };
            let Some(bs) = sc.get("block_states").and_then(|v| v.as_compound()) else { continue };
            let Some(Value::List(_, pal)) = bs.get("palette") else { continue };
            if !pal.iter().any(|e| !is_real_air(&norm_state(e).unwrap_or_default().id)) {
                continue;
            }
            let y = sc.get("Y").and_then(|v| v.as_i64()).unwrap_or(0) as i32 * 16;
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
