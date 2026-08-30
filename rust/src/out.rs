use crate::nbt::{Compound, Value, Writer};
use crate::structure::Structure;

pub struct Packed {
    pub size: Vec<i32>,
    pub palette: String,
    pub blocks: Vec<i32>,
    pub extras: Vec<u8>,
    /// 0 read, 1 missing, 2 too old to read
    pub status: u8,
}

fn escape(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn palette_json(s: &Structure) -> String {
    let mut out = String::from("[");
    for (i, e) in s.palette.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        escape(&e.id, &mut out);
        if let Some(props) = &e.properties {
            out.push_str(",\"properties\":{");
            for (j, (k, v)) in props.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                escape(k, &mut out);
                out.push(':');
                escape(v, &mut out);
            }
            out.push('}');
        }
        out.push('}');
    }
    out.push(']');
    out
}

pub fn pack_chunk(c: &crate::chunk::ChunkBlocks) -> Packed {
    let mut nbt_index = Vec::with_capacity(c.block_nbt.len());
    let mut nbt_values = Vec::with_capacity(c.block_nbt.len());
    for (i, n) in &c.block_nbt {
        nbt_index.push(*i as i32);
        nbt_values.push(Value::Compound(n.clone()));
    }
    let mut ent_pos = Vec::with_capacity(c.entities.len() * 3);
    let mut ent_nbt = Vec::with_capacity(c.entities.len());
    for e in &c.entities {
        ent_pos.push(Value::Double(e.pos[0]));
        ent_pos.push(Value::Double(e.pos[1]));
        ent_pos.push(Value::Double(e.pos[2]));
        ent_nbt.push(Value::Compound(e.nbt.clone()));
    }
    let mut extras = Compound::default();
    extras.insert("bi", Value::IntArray(nbt_index));
    extras.insert("bn", Value::List(crate::nbt::COMPOUND, nbt_values));
    extras.insert("ep", Value::List(crate::nbt::DOUBLE, ent_pos));
    extras.insert("en", Value::List(crate::nbt::COMPOUND, ent_nbt));

    let s = Structure { size: [0, 0, 0], palette: c.palette.clone(), blocks: Vec::new(), entities: Vec::new() };
    Packed {
        size: vec![0, 0, 0],
        palette: palette_json(&s),
        blocks: c.flat.clone(),
        extras: Writer::new().root(&extras),
        status: 0,
    }
}

pub fn empty(status: u8) -> Packed {
    let mut extras = Compound::default();
    extras.insert("bi", Value::IntArray(Vec::new()));
    extras.insert("bn", Value::List(crate::nbt::COMPOUND, Vec::new()));
    extras.insert("ep", Value::List(crate::nbt::DOUBLE, Vec::new()));
    extras.insert("en", Value::List(crate::nbt::COMPOUND, Vec::new()));
    Packed {
        size: vec![0, 0, 0],
        palette: "[]".into(),
        blocks: Vec::new(),
        extras: Writer::new().root(&extras),
        status,
    }
}

pub fn pack(s: &Structure) -> Packed {
    let mut blocks = Vec::with_capacity(s.blocks.len() * 4);
    let mut nbt_index = Vec::new();
    let mut nbt_values = Vec::new();
    for (i, b) in s.blocks.iter().enumerate() {
        blocks.extend_from_slice(&[b.state, b.pos[0], b.pos[1], b.pos[2]]);
        if let Some(n) = &b.nbt {
            nbt_index.push(i as i32);
            nbt_values.push(Value::Compound(n.clone()));
        }
    }

    let mut ent_pos = Vec::with_capacity(s.entities.len() * 3);
    let mut ent_nbt = Vec::with_capacity(s.entities.len());
    for e in &s.entities {
        ent_pos.push(Value::Double(e.pos[0]));
        ent_pos.push(Value::Double(e.pos[1]));
        ent_pos.push(Value::Double(e.pos[2]));
        ent_nbt.push(Value::Compound(e.nbt.clone()));
    }

    let mut extras = Compound::default();
    extras.insert("bi", Value::IntArray(nbt_index));
    extras.insert("bn", Value::List(crate::nbt::COMPOUND, nbt_values));
    extras.insert("ep", Value::List(crate::nbt::DOUBLE, ent_pos));
    extras.insert("en", Value::List(crate::nbt::COMPOUND, ent_nbt));

    Packed {
        size: s.size.to_vec(),
        palette: palette_json(s),
        blocks,
        extras: Writer::new().root(&extras),
        status: 0,
    }
}
