use crate::nbt::{inflate_zlib, read_nbt, Compound, Value};

const KEEP: [&str; 6] = ["sections", "block_entities", "xPos", "zPos", "Entities", "Level"];
const SKIP: [&str; 8] = [
    "block_light",
    "sky_light",
    "BlockLight",
    "SkyLight",
    "biomes",
    "Biomes",
    "Heightmaps",
    "Structures",
];

fn keep_keys() -> Vec<String> {
    let mut v: Vec<String> = KEEP.iter().map(|s| s.to_string()).collect();
    v.push("DataVersion".into());
    v
}

fn skip_keys() -> Vec<String> {
    let mut v: Vec<String> = SKIP.iter().map(|s| s.to_string()).collect();
    v.push("UpgradeData".into());
    v
}

/// 1.13-1.17 chunks store the palette format inside a `Level` tag under older
/// names. Anything older is numeric id storage and is left alone.
fn upgrade_chunk(nbt: Compound) -> Compound {
    let data_version = nbt.get("DataVersion").and_then(|v| v.as_i64()).unwrap_or(0);
    if nbt.contains("sections") || data_version < 1451 {
        return nbt;
    }
    let Some(Value::Compound(lvl)) = nbt.get("Level") else {
        return nbt;
    };

    let mut sections = Vec::new();
    if let Some(Value::List(_, items)) = lvl.get("Sections") {
        for s in items {
            let Some(sc) = s.as_compound() else { continue };
            let Some(pal) = sc.get("Palette") else { continue };
            let mut bs = Compound::default();
            bs.insert("palette", pal.clone());
            if let Some(d) = sc.get("BlockStates") {
                bs.insert("data", d.clone());
            }
            let mut sec = Compound::default();
            sec.insert("Y", sc.get("Y").cloned().unwrap_or(Value::Int(0)));
            sec.insert("block_states", Value::Compound(bs));
            sections.push(Value::Compound(sec));
        }
    }

    let mut out = Compound::default();
    out.insert("DataVersion", Value::Int(data_version as i32));
    out.insert("xPos", lvl.get("xPos").cloned().unwrap_or(Value::Int(0)));
    out.insert("zPos", lvl.get("zPos").cloned().unwrap_or(Value::Int(0)));
    out.insert("sections", Value::List(crate::nbt::COMPOUND, sections));
    if let Some(Value::List(t, items)) = lvl.get("TileEntities") {
        if !items.is_empty() {
            out.insert("block_entities", Value::List(*t, items.clone()));
        }
    }
    if let Some(Value::List(t, items)) = lvl.get("Entities") {
        if !items.is_empty() {
            out.insert("Entities", Value::List(*t, items.clone()));
        }
    }
    out
}

/// A y extent only needs the section palettes.
const EXTENT_SKIP: [&str; 5] = ["data", "BlockStates", "TileEntities", "Entities", "block_entities"];

pub fn read_chunk_extent(bytes: &[u8], index: usize) -> Option<Compound> {
    let mut skip = skip_keys();
    skip.extend(EXTENT_SKIP.iter().map(|s| s.to_string()));
    decode(bytes, index, &Some(skip), &Some(keep_keys()))
}

/// `index` is the chunk's slot in the region header, `(cx & 31) + (cz & 31) * 32`.
pub fn read_chunk(bytes: &[u8], index: usize) -> Option<Compound> {
    decode(bytes, index, &Some(skip_keys()), &Some(keep_keys()))
}

fn decode(
    bytes: &[u8],
    index: usize,
    skip: &Option<Vec<String>>,
    keep: &Option<Vec<String>>,
) -> Option<Compound> {
    let head = bytes.get(index * 4..index * 4 + 4)?;
    let loc = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    if loc == 0 {
        return None;
    }
    let off = ((loc >> 8) as usize) * 4096;
    let len_bytes = bytes.get(off..off + 4)?;
    let len = u32::from_be_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
    let method = *bytes.get(off + 4)?;
    let payload = bytes.get(off + 5..off + 4 + len)?;

    let root = match method {
        3 => read_nbt(payload, None, skip, keep).ok()?,
        1 => read_nbt(payload, None, skip, keep).ok()?,
        2 => {
            let raw = inflate_zlib(payload)?;
            read_nbt(&raw, None, skip, keep).ok()?
        }
        _ => return None,
    };
    Some(upgrade_chunk(root))
}
