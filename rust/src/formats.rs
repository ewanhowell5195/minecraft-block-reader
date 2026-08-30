use crate::collector::{words, Collector};
use crate::nbt::{Compound, Value};
use crate::state::{is_air, norm_state, parse_state};
use crate::structure::Structure;

fn str_props(props: Option<&Vec<(String, String)>>) -> Option<Vec<(String, String)>> {
    let p = props?;
    if p.is_empty() {
        None
    } else {
        Some(p.clone())
    }
}

fn num(c: &Compound, key: &str) -> f64 {
    c.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

/// Litematica: packed indices span long boundaries, order y, z, x fastest;
/// a negative Size extends the region negative from Position.
pub fn read_litematic(root: &Compound) -> Structure {
    let mut col = Collector::new();
    let Some(Value::Compound(regions)) = root.get("Regions") else {
        return col.finish();
    };

    for (_, region) in &regions.entries {
        let Some(region) = region.as_compound() else { continue };
        let Some(size) = region.get("Size").and_then(|v| v.as_compound()) else { continue };
        let Some(pos) = region.get("Position").and_then(|v| v.as_compound()) else { continue };

        let (dx, dy, dz) = (num(size, "x"), num(size, "y"), num(size, "z"));
        let (sx, sy, sz) = (dx.abs() as i32, dy.abs() as i32, dz.abs() as i32);
        let mx = num(pos, "x") as i32 + (dx + 1.0).min(0.0) as i32;
        let my = num(pos, "y") as i32 + (dy + 1.0).min(0.0) as i32;
        let mz = num(pos, "z") as i32 + (dz + 1.0).min(0.0) as i32;

        let pal: Vec<_> = region
            .get("BlockStatePalette")
            .and_then(|v| v.as_list())
            .map(|items| items.iter().map(|v| norm_state(v).unwrap_or_default()).collect())
            .unwrap_or_else(Vec::new);

        let states: Vec<u32> = match region.get("BlockStates") {
            Some(Value::LongArray(a)) => words(a),
            _ => Vec::new(),
        };

        let bits = (32 - ((pal.len().max(2) - 1) as u32).leading_zeros()).max(2);
        let mask: u32 = if bits >= 32 { u32::MAX } else { (1u32 << bits) - 1 };

        let mapped: Vec<i32> = pal
            .iter()
            .map(|e| {
                if is_air(&e.id) {
                    -1
                } else {
                    col.state_for(&e.id, str_props(e.properties.as_ref()))
                }
            })
            .collect();

        let mut w = 0usize;
        let mut off = 0u32;
        for y in 0..sy {
            for z in 0..sz {
                for x in 0..sx {
                    let mut v = states.get(w).copied().unwrap_or(0) >> off;
                    if off + bits > 32 {
                        v |= states.get(w + 1).copied().unwrap_or(0) << (32 - off);
                    }
                    off += bits;
                    if off >= 32 {
                        w += (off >> 5) as usize;
                        off &= 31;
                    }
                    match mapped.get((v & mask) as usize) {
                        None => continue,
                        Some(&s) if s < 0 => continue,
                        Some(&s) => col.push(mx + x, my + y, mz + z, s),
                    }
                }
            }
        }

        // tile entity coords are relative to the region's min corner
        if let Some(Value::List(_, items)) = region.get("TileEntities") {
            for be in items {
                let Some(c) = be.as_compound() else { continue };
                let Some(x) = c.get("x").and_then(|v| v.as_i64()) else { continue };
                let y = c.get("y").and_then(|v| v.as_i64()).unwrap_or(0);
                let z = c.get("z").and_then(|v| v.as_i64()).unwrap_or(0);
                let mut rest = Compound::default();
                for (k, v) in &c.entries {
                    if k != "x" && k != "y" && k != "z" {
                        rest.entries.push((k.clone(), v.clone()));
                    }
                }
                col.block_nbt(mx + x as i32, my + y as i32, mz + z as i32, rest);
            }
        }

        // entity positions are relative to Position, not the min corner
        if let Some(Value::List(_, items)) = region.get("Entities") {
            for e in items {
                let Some(c) = e.as_compound() else { continue };
                let Some(Value::List(_, p)) = c.get("Pos") else { continue };
                if p.len() < 3 {
                    continue;
                }
                col.entity(
                    [
                        num(pos, "x") + p[0].as_f64().unwrap_or(0.0),
                        num(pos, "y") + p[1].as_f64().unwrap_or(0.0),
                        num(pos, "z") + p[2].as_f64().unwrap_or(0.0),
                    ],
                    c.clone(),
                );
            }
        }
    }

    col.finish()
}

/// v3 nests the payload under Data with the id as Id; v2 stores it inline.
fn be_nbt(c: &Compound) -> Compound {
    let mut out = Compound::default();
    match c.get("Data").and_then(|v| v.as_compound()) {
        Some(d) => {
            for (k, v) in &d.entries {
                out.entries.push((k.clone(), v.clone()));
            }
        }
        None => {
            for (k, v) in &c.entries {
                if k != "Pos" && k != "Id" && k != "Data" {
                    out.entries.push((k.clone(), v.clone()));
                }
            }
        }
    }
    if let Some(id) = c.get("Id") {
        out.entries.retain(|(k, _)| k != "id");
        out.entries.push(("id".into(), id.clone()));
    }
    out
}

/// Sponge .schem: varint indices, order y, z, x fastest.
pub fn read_schem(root: &Compound) -> Option<Structure> {
    let s = root.get("Schematic").and_then(|v| v.as_compound()).unwrap_or(root);
    let blocks_tag = s.get("Blocks").and_then(|v| v.as_compound()).unwrap_or(s);
    let palette_tag = blocks_tag.get("Palette").and_then(|v| v.as_compound());
    let data = match blocks_tag.get("Data").or_else(|| blocks_tag.get("BlockData")) {
        Some(Value::ByteArray(a)) => a.clone(),
        _ => return None,
    };
    let w = s.get("Width").and_then(|v| v.as_i64()).unwrap_or(0) as i64;
    let h = s.get("Height").and_then(|v| v.as_i64()).unwrap_or(0) as i64;
    let l = s.get("Length").and_then(|v| v.as_i64()).unwrap_or(0) as i64;
    if data.is_empty() || w == 0 || h == 0 || l == 0 {
        return None;
    }

    let mut col = Collector::new();
    let mut by_id: Vec<i32> = Vec::new();
    if let Some(p) = palette_tag {
        for (str_state, pi) in &p.entries {
            let e = parse_state(str_state);
            let idx = pi.as_i64().unwrap_or(0) as usize;
            if by_id.len() <= idx {
                by_id.resize(idx + 1, i32::MIN);
            }
            by_id[idx] = if is_air(&e.id) {
                -1
            } else {
                col.state_for(&e.id, str_props(e.properties.as_ref()))
            };
        }
    }

    let mut o = 0usize;
    for i in 0..(w * h * l) {
        let mut v: u32 = 0;
        let mut shift = 0u32;
        loop {
            let Some(b) = data.get(o).copied() else { break };
            o += 1;
            v |= ((b & 0x7f) as u32) << shift;
            shift += 7;
            if b & 0x80 == 0 {
                break;
            }
        }
        let state = match by_id.get(v as usize) {
            None => continue,
            Some(&x) if x == i32::MIN || x < 0 => continue,
            Some(&x) => x,
        };
        let x = (i % w) as i32;
        let z = ((i / w) % l) as i32;
        let y = (i / (w * l)) as i32;
        col.push(x, y, z, state);
    }

    let be_list = blocks_tag
        .get("BlockEntities")
        .or_else(|| s.get("BlockEntities"))
        .or_else(|| s.get("TileEntities"));
    if let Some(Value::List(_, items)) = be_list {
        for be in items {
            let Some(c) = be.as_compound() else { continue };
            let Some(Value::IntArray(p)) = c.get("Pos") else {
                if let Some(Value::List(_, p)) = c.get("Pos") {
                    if p.len() >= 3 {
                        col.block_nbt(
                            p[0].as_i64().unwrap_or(0) as i32,
                            p[1].as_i64().unwrap_or(0) as i32,
                            p[2].as_i64().unwrap_or(0) as i32,
                            be_nbt(c),
                        );
                    }
                }
                continue;
            };
            if p.len() >= 3 {
                col.block_nbt(p[0], p[1], p[2], be_nbt(c));
            }
        }
    }

    if let Some(Value::List(_, items)) = s.get("Entities") {
        for e in items {
            let Some(c) = e.as_compound() else { continue };
            let Some(Value::List(_, p)) = c.get("Pos") else { continue };
            if p.len() < 3 {
                continue;
            }
            col.entity(
                [
                    p[0].as_f64().unwrap_or(0.0),
                    p[1].as_f64().unwrap_or(0.0),
                    p[2].as_f64().unwrap_or(0.0),
                ],
                be_nbt(c),
            );
        }
    }

    Some(col.finish())
}

const FACING6: [&str; 6] = ["down", "up", "north", "south", "west", "east"];
const STAIRS4: [&str; 4] = ["east", "west", "south", "north"];
const DIR4: [&str; 4] = ["south", "west", "north", "east"];

fn as_string(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        Value::Byte(x) => x.to_string(),
        Value::Short(x) => x.to_string(),
        Value::Int(x) => x.to_string(),
        Value::Long(x) => x.to_string(),
        Value::Float(x) => fmt_num(*x as f64),
        Value::Double(x) => fmt_num(*x),
        _ => String::new(),
    }
}

fn fmt_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

fn truthy(v: &Value) -> bool {
    v.as_f64().map(|x| x != 0.0).unwrap_or(false)
}

/// Bedrock state names differ from Java's; this is the same best-effort mapping
/// the js reader does.
fn bedrock_props(states: Option<&Compound>) -> Option<Vec<(String, String)>> {
    let states = states?;
    let mut p: Vec<(String, String)> = Vec::new();
    let set = |k: &str, v: String, p: &mut Vec<(String, String)>| {
        if let Some(e) = p.iter_mut().find(|(a, _)| a == k) {
            e.1 = v;
        } else {
            p.push((k.to_string(), v));
        }
    };
    for (k, v) in &states.entries {
        match k.as_str() {
            "pillar_axis" => set("axis", as_string(v), &mut p),
            "minecraft:cardinal_direction" | "minecraft:facing_direction" => set("facing", as_string(v), &mut p),
            "facing_direction" => {
                if let Some(i) = v.as_i64() {
                    if let Some(f) = FACING6.get(i as usize) {
                        set("facing", f.to_string(), &mut p);
                    }
                }
            }
            "weirdo_direction" => {
                if let Some(i) = v.as_i64() {
                    if let Some(f) = STAIRS4.get(i as usize) {
                        set("facing", f.to_string(), &mut p);
                    }
                }
            }
            "direction" => {
                if let Some(i) = v.as_i64() {
                    if let Some(f) = DIR4.get(i as usize) {
                        set("facing", f.to_string(), &mut p);
                    }
                }
            }
            "minecraft:vertical_half" => set("type", as_string(v), &mut p),
            "top_slot_bit" => set("type", if truthy(v) { "top".into() } else { "bottom".into() }, &mut p),
            "upside_down_bit" => set("half", if truthy(v) { "top".into() } else { "bottom".into() }, &mut p),
            "half" => set("half", as_string(v), &mut p),
            "open_bit" => set("open", if truthy(v) { "true".into() } else { "false".into() }, &mut p),
            "door_hinge_bit" => set("hinge", if truthy(v) { "right".into() } else { "left".into() }, &mut p),
            "upper_block_bit" => set("half", if truthy(v) { "upper".into() } else { "lower".into() }, &mut p),
            "ground_sign_direction" => set("rotation", as_string(v), &mut p),
            "hanging" => set("hanging", if truthy(v) { "true".into() } else { "false".into() }, &mut p),
            "lit" | "extinguished" => set("lit", if truthy(v) { "true".into() } else { "false".into() }, &mut p),
            "persistent_bit" => set("persistent", if truthy(v) { "true".into() } else { "false".into() }, &mut p),
            "candles" => set("candles", (v.as_i64().unwrap_or(0) + 1).to_string(), &mut p),
            "growth" | "age" => set("age", as_string(v), &mut p),
            _ => {}
        }
    }
    if p.is_empty() {
        None
    } else {
        Some(p)
    }
}

fn int_list(v: Option<&Value>) -> Vec<i64> {
    match v {
        Some(Value::IntArray(a)) => a.iter().map(|x| *x as i64).collect(),
        Some(Value::List(_, items)) => items.iter().map(|x| x.as_i64().unwrap_or(0)).collect(),
        _ => Vec::new(),
    }
}

/// Bedrock .mcstructure: little endian nbt, index order x, y, z fastest;
/// layer 1 is mostly waterlogging, -1 meaning not saved.
pub fn read_mcstructure(root: &Compound) -> Option<Structure> {
    let size = int_list(root.get("size"));
    let (sx, sy, sz) = (
        *size.first().unwrap_or(&0) as i32,
        *size.get(1).unwrap_or(&0) as i32,
        *size.get(2).unwrap_or(&0) as i32,
    );
    let structure = root.get("structure").and_then(|v| v.as_compound())?;
    let layers = structure.get("block_indices").and_then(|v| v.as_list())?;
    if sx == 0 || layers.is_empty() {
        return None;
    }
    let default = structure
        .get("palette")
        .and_then(|v| v.as_compound())
        .and_then(|p| p.get("default"))
        .and_then(|v| v.as_compound());
    let pal = default
        .and_then(|d| d.get("block_palette"))
        .and_then(|v| v.as_list())
        .cloned()
        .unwrap_or_default();

    let layer0 = int_list(layers.first());
    let layer1 = layers.get(1).map(|l| int_list(Some(l)));
    let pos_data = default.and_then(|d| d.get("block_position_data")).and_then(|v| v.as_compound());

    let mut water = Vec::new();
    for (i, e) in pal.iter().enumerate() {
        if let Some(name) = e.as_compound().and_then(|c| c.get("name")).and_then(|v| v.as_str()) {
            let short = name.rsplit(':').next().unwrap_or(name);
            if short == "water" || short == "flowing_water" {
                water.push(i as i64);
            }
        }
    }

    let mut col = Collector::new();
    for x in 0..sx {
        for y in 0..sy {
            for z in 0..sz {
                let i = ((x * sy + y) * sz + z) as usize;
                let pi = *layer0.get(i).unwrap_or(&-1);
                if pi < 0 {
                    continue;
                }
                let Some(e) = pal.get(pi as usize).and_then(|v| v.as_compound()) else { continue };
                let Some(name) = e.get("name").and_then(|v| v.as_str()) else { continue };
                if is_air(name) {
                    continue;
                }
                let mut props = bedrock_props(e.get("states").and_then(|v| v.as_compound()));
                if let Some(l1) = &layer1 {
                    if water.contains(l1.get(i).unwrap_or(&-1)) {
                        let mut p = props.unwrap_or_default();
                        p.retain(|(k, _)| k != "waterlogged");
                        p.push(("waterlogged".into(), "true".into()));
                        props = Some(p);
                    }
                }
                let state = col.state_for(name, props);
                col.push(x, y, z, state);
                if let Some(pd) = pos_data {
                    if let Some(entry) = pd.get(&i.to_string()).and_then(|v| v.as_compound()) {
                        if let Some(nbt) = entry.get("block_entity_data").and_then(|v| v.as_compound()) {
                            col.block_nbt(x, y, z, nbt.clone());
                        }
                    }
                }
            }
        }
    }

    let origin = int_list(root.get("structure_world_origin"));
    let (ox, oy, oz) = (
        *origin.first().unwrap_or(&0) as f64,
        *origin.get(1).unwrap_or(&0) as f64,
        *origin.get(2).unwrap_or(&0) as f64,
    );
    if let Some(Value::List(_, items)) = structure.get("entities") {
        for e in items {
            let Some(c) = e.as_compound() else { continue };
            let Some(Value::List(_, p)) = c.get("Pos") else { continue };
            if p.len() < 3 {
                continue;
            }
            col.entity(
                [
                    p[0].as_f64().unwrap_or(0.0) - ox,
                    p[1].as_f64().unwrap_or(0.0) - oy,
                    p[2].as_f64().unwrap_or(0.0) - oz,
                ],
                c.clone(),
            );
        }
    }

    Some(col.finish())
}
