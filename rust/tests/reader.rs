use minecraft_block_reader::chunk::{chunk_blocks, chunk_into, Acc, ChunkOptions};
use minecraft_block_reader::legacy_states::lookup;
use minecraft_block_reader::nbt::{read_nbt, Compound, Value, Writer, COMPOUND};
use minecraft_block_reader::state::{is_air, is_real_air, norm_state};
use minecraft_block_reader::{kind_of, read_any, BoxQuery, ChunkStatus, Kind, Region};

fn c(pairs: Vec<(&str, Value)>) -> Compound {
    let mut out = Compound::default();
    for (k, v) in pairs {
        out.insert(k, v);
    }
    out
}

/// the tag id for TAG_Int, which typed lists carry
const INT_TAG: u8 = 3;

fn s(v: &str) -> Value {
    Value::Str(v.into())
}

#[test]
fn air_names_match_the_js_regexes() {
    for id in ["air", "minecraft:air", "cave_air", "minecraft:void_air"] {
        assert!(is_air(id), "{id}");
        assert!(is_real_air(id), "{id}");
    }
    assert!(is_air("minecraft:structure_void"));
    assert!(!is_real_air("minecraft:structure_void"));
    for id in ["minecraft:stone", "airship", "minecraft:fair", "notair"] {
        assert!(!is_air(id), "{id}");
    }
}

#[test]
fn state_properties_keep_their_order_and_drop_when_empty() {
    let v = Value::Compound(c(vec![
        ("Name", s("minecraft:oak_stairs")),
        (
            "Properties",
            Value::Compound(c(vec![("facing", s("north")), ("half", s("top"))])),
        ),
    ]));
    let st = norm_state(&v).unwrap();
    assert_eq!(st.id, "minecraft:oak_stairs");
    assert_eq!(
        st.properties.unwrap(),
        vec![("facing".to_string(), "north".to_string()), ("half".to_string(), "top".to_string())]
    );

    let bare = Value::Compound(c(vec![("Name", s("minecraft:stone"))]));
    assert!(norm_state(&bare).unwrap().properties.is_none());
}

#[test]
fn nbt_round_trips_every_tag() {
    let root = c(vec![
        ("b", Value::Byte(-7)),
        ("s", Value::Short(-300)),
        ("i", Value::Int(70000)),
        ("l", Value::Long(-9007199254740993)),
        ("f", Value::Float(0.5)),
        ("d", Value::Double(-1.25)),
        ("ba", Value::ByteArray(vec![1, 254, 3])),
        ("str", s("hello \u{2603}")),
        ("ia", Value::IntArray(vec![1, -2, 3])),
        ("la", Value::LongArray(vec![1, -2, i64::MIN])),
        ("list", Value::List(COMPOUND, vec![Value::Compound(c(vec![("x", Value::Int(1))]))])),
    ]);
    let bytes = Writer::new().root(&root);
    let back = read_nbt(&bytes, None, &None, &None).unwrap();
    assert_eq!(back.get("l").and_then(|v| v.as_i64()), Some(-9007199254740993));
    assert_eq!(back.get("str"), Some(&s("hello \u{2603}")));
    assert_eq!(back.get("la"), Some(&Value::LongArray(vec![1, -2, i64::MIN])));
    assert_eq!(back.get("ia"), Some(&Value::IntArray(vec![1, -2, 3])));
}

#[test]
fn skip_and_only_filter_the_root() {
    let root = c(vec![
        ("keep", Value::Int(1)),
        ("drop", Value::Int(2)),
        ("also", Value::Int(3)),
    ]);
    let bytes = Writer::new().root(&root);

    let only = read_nbt(&bytes, None, &None, &Some(vec!["keep".into()])).unwrap();
    assert!(only.contains("keep") && !only.contains("drop") && !only.contains("also"));

    let skip = read_nbt(&bytes, None, &Some(vec!["drop".into()]), &None).unwrap();
    assert!(skip.contains("keep") && !skip.contains("drop") && skip.contains("also"));
}

#[test]
fn kind_is_taken_from_the_signature() {
    assert_eq!(kind_of(&c(vec![("Regions", Value::Int(0))])), Kind::Litematic);
    assert_eq!(
        kind_of(&c(vec![("Palette", Value::Int(0)), ("Data", Value::Int(0)), ("Width", Value::Int(0))])),
        Kind::Schem
    );
    assert_eq!(
        kind_of(&c(vec![(
            "structure",
            Value::Compound(c(vec![("block_indices", Value::Int(0))]))
        )])),
        Kind::Mcstructure
    );
    assert_eq!(
        kind_of(&c(vec![("blocks", Value::Int(0)), ("palette", Value::Int(0))])),
        Kind::Vanilla
    );
    // the 1.9 form has no palette at all, so `size` is what marks it
    assert_eq!(
        kind_of(&c(vec![("blocks", Value::Int(0)), ("size", Value::Int(0))])),
        Kind::Vanilla
    );
    assert_eq!(kind_of(&c(vec![("nothing", Value::Int(0))])), Kind::Unknown);
}

fn vanilla_1_9(states: &[i32]) -> Vec<u8> {
    let blocks: Vec<Value> = states
        .iter()
        .enumerate()
        .map(|(i, st)| {
            Value::Compound(c(vec![
                ("state", Value::Int(*st)),
                (
                    "pos",
                    Value::List(
                        INT_TAG,
                        vec![Value::Int(i as i32), Value::Int(0), Value::Int(0)],
                    ),
                ),
            ]))
        })
        .collect();
    let root = c(vec![
        ("size", Value::List(INT_TAG, vec![Value::Int(16), Value::Int(1), Value::Int(1)])),
        ("blocks", Value::List(COMPOUND, blocks)),
    ]);
    Writer::new().root(&root)
}

/// `((state & 0xFFF) << 4 | state >> 12)` is what the reader unpacks, so a
/// fixture has to pack the id the other way round.
fn pack(id: u32) -> i32 {
    (((id & 15) << 12) | (id >> 4)) as i32
}

#[test]
fn legacy_states_upgrade_to_the_flattened_ids() {
    let bytes = vanilla_1_9(&[pack(0), pack(16), pack(17), pack(4000), pack(800)]);
    let st = read_any(&bytes).expect("1.9 file should read");
    assert_eq!(st.blocks.len(), 5);
    assert_eq!(st.palette[st.blocks[0].state as usize].id, "minecraft:air");
    assert_eq!(st.palette[st.blocks[1].state as usize].id, "minecraft:stone");
    assert_eq!(st.palette[st.blocks[2].state as usize].id, "minecraft:granite");
    assert_eq!(
        st.palette[st.blocks[3].state as usize].properties,
        Some(vec![("facing".to_string(), "south".to_string())])
    );
    // 800 is not in the table and neither is 800 & !15, so it falls to air
    assert!(lookup(800).is_none() && lookup(800 & !15).is_none());
    assert_eq!(st.palette[st.blocks[4].state as usize].id, "minecraft:air");
}

#[test]
fn repeated_legacy_states_share_one_palette_entry() {
    let bytes = vanilla_1_9(&[pack(16), pack(16), pack(17), pack(16)]);
    let st = read_any(&bytes).unwrap();
    assert_eq!(st.palette.len(), 2);
    assert_eq!(st.blocks[0].state, st.blocks[1].state);
    assert_eq!(st.blocks[0].state, st.blocks[3].state);
    assert_ne!(st.blocks[0].state, st.blocks[2].state);
}

fn one_section_chunk(palette: Vec<Value>, data: Option<Vec<i64>>, y: i32) -> Compound {
    let mut bs = Compound::default();
    bs.insert("palette", Value::List(COMPOUND, palette));
    if let Some(d) = data {
        bs.insert("data", Value::LongArray(d));
    }
    let section = c(vec![("Y", Value::Int(y)), ("block_states", Value::Compound(bs))]);
    c(vec![
        ("DataVersion", Value::Int(3465)),
        ("xPos", Value::Int(2)),
        ("zPos", Value::Int(-3)),
        ("sections", Value::List(COMPOUND, vec![Value::Compound(section)])),
    ])
}

fn state(name: &str) -> Value {
    Value::Compound(c(vec![("Name", s(name))]))
}

#[test]
fn a_single_entry_section_fills_the_whole_cube() {
    let nbt = one_section_chunk(vec![state("minecraft:stone")], None, 0);
    let out = chunk_blocks(&nbt, &ChunkOptions::default());
    assert_eq!(out.count(), 4096);
    assert_eq!(out.palette.len(), 1);
    // the chunk sits at x 32..47, z -48..-33
    assert_eq!(out.flat[1], 32);
    assert_eq!(out.flat[3], -48);
}

#[test]
fn air_is_dropped_unless_it_is_asked_for() {
    let nbt = one_section_chunk(vec![state("minecraft:air")], None, 0);
    assert_eq!(chunk_blocks(&nbt, &ChunkOptions::default()).count(), 0);
    let keep = ChunkOptions { include_air: true, ..Default::default() };
    assert_eq!(chunk_blocks(&nbt, &keep).count(), 4096);
}

#[test]
fn the_box_clips_on_every_axis() {
    let nbt = one_section_chunk(vec![state("minecraft:stone")], None, 0);
    let opts = ChunkOptions {
        x_min: 34.0,
        x_max: 36.0,
        z_min: -47.0,
        z_max: -45.0,
        y_min: 2.0,
        y_max: 4.0,
        ..Default::default()
    };
    let out = chunk_blocks(&nbt, &opts);
    assert_eq!(out.count(), 3 * 3 * 3);
    for b in out.flat.chunks_exact(4) {
        assert!((34..=36).contains(&b[1]) && (2..=4).contains(&b[2]) && (-47..=-45).contains(&b[3]));
    }
}

#[test]
fn the_object_view_carries_the_block_entity_nbt() {
    let mut nbt = one_section_chunk(vec![state("minecraft:chest")], None, 0);
    let be = Value::Compound(c(vec![
        ("x", Value::Int(32)),
        ("y", Value::Int(0)),
        ("z", Value::Int(-48)),
        ("id", s("minecraft:chest")),
    ]));
    nbt.insert("block_entities", Value::List(COMPOUND, vec![be]));

    let out = chunk_blocks(&nbt, &ChunkOptions::default());
    let blocks = out.blocks();
    assert_eq!(blocks.len(), out.count());
    assert_eq!(blocks[0].pos, [32, 0, -48]);
    assert!(blocks[0].nbt.is_some());
    assert!(blocks[1].nbt.is_none());
}

#[test]
fn many_chunks_share_one_palette() {
    let mut acc = Acc::default();
    let opts = ChunkOptions::default();
    chunk_into(&one_section_chunk(vec![state("minecraft:stone")], None, 0), &opts, &mut acc);
    chunk_into(&one_section_chunk(vec![state("minecraft:stone")], None, 1), &opts, &mut acc);
    chunk_into(&one_section_chunk(vec![state("minecraft:dirt")], None, 2), &opts, &mut acc);
    assert_eq!(acc.palette.len(), 2);
    assert_eq!(acc.flat.len() / 4, 4096 * 3);
}

#[test]
fn entities_can_be_left_to_the_entity_region() {
    let mut nbt = one_section_chunk(vec![state("minecraft:stone")], None, 0);
    let e = Value::Compound(c(vec![(
        "Pos",
        Value::List(6, vec![Value::Double(33.0), Value::Double(5.0), Value::Double(-47.0)]),
    )]));
    nbt.insert("Entities", Value::List(COMPOUND, vec![e]));

    assert_eq!(chunk_blocks(&nbt, &ChunkOptions::default()).entities.len(), 1);
    let without = ChunkOptions { entities: false, ..Default::default() };
    assert_eq!(chunk_blocks(&nbt, &without).entities.len(), 0);
}

/// A region file with one chunk in slot `index`, zlib deflated like the game
/// writes them.
fn region_bytes(index: usize, chunk: &Compound) -> Vec<u8> {
    let payload = Writer::new().root(chunk);
    let mut deflated = Vec::new();
    // stored deflate block, which any zlib reader accepts
    deflated.extend_from_slice(&[0x78, 0x01]);
    for (i, part) in payload.chunks(65535).enumerate() {
        let last = (i + 1) * 65535 >= payload.len();
        deflated.push(if last { 1 } else { 0 });
        deflated.extend_from_slice(&(part.len() as u16).to_le_bytes());
        deflated.extend_from_slice(&(!(part.len() as u16)).to_le_bytes());
        deflated.extend_from_slice(part);
    }
    let mut a = 1u32;
    let mut b = 0u32;
    for byte in &payload {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    deflated.extend_from_slice(&((b << 16) | a).to_be_bytes());

    let mut out = vec![0u8; 8192];
    let sector = 2u32;
    let sectors = ((deflated.len() + 5).div_ceil(4096)) as u32;
    out[index * 4..index * 4 + 4].copy_from_slice(&((sector << 8) | sectors).to_be_bytes());
    out.resize(8192 + sectors as usize * 4096, 0);
    let at = 8192;
    out[at..at + 4].copy_from_slice(&((deflated.len() + 1) as u32).to_be_bytes());
    out[at + 4] = 2;
    out[at + 5..at + 5 + deflated.len()].copy_from_slice(&deflated);
    out
}

#[test]
fn a_region_reads_its_chunks_from_plain_rust() {
    let nbt = one_section_chunk(vec![state("minecraft:stone")], None, 0);
    let region = Region::new(region_bytes(7, &nbt));

    assert_eq!(region.chunk_extent(7), Some((0, 15)));
    assert!(region.chunk(9).is_none());

    let blocks = region.chunk_blocks(7, &ChunkOptions::default()).unwrap();
    assert_eq!(blocks.count(), 4096);
    assert_eq!(blocks.palette.len(), 1);
}

#[test]
fn a_box_query_spans_chunks_and_reports_what_it_covered() {
    let region = Region::new(region_bytes(7, &one_section_chunk(vec![state("minecraft:stone")], None, 0)));
    let mut q = BoxQuery::new([34.0, 2.0, -47.0], [36.0, 4.0, -45.0], false);

    assert_eq!(q.add_chunk(&region, 7, true), ChunkStatus::Read);
    assert_eq!(q.add_chunk(&region, 9, true), ChunkStatus::Missing);

    let counts = q.counts();
    assert_eq!((counts.read, counts.missing, counts.outdated), (1, 1, 0));

    let out = q.finish();
    assert_eq!(out.count(), 3 * 3 * 3);
    for b in out.flat.chunks_exact(4) {
        assert!((34..=36).contains(&b[1]) && (2..=4).contains(&b[2]) && (-47..=-45).contains(&b[3]));
    }
}

#[test]
fn a_pre_palette_chunk_is_reported_rather_than_read() {
    let mut nbt = Compound::default();
    nbt.insert("DataVersion", Value::Int(100));
    nbt.insert("xPos", Value::Int(0));
    nbt.insert("zPos", Value::Int(0));
    let region = Region::new(region_bytes(0, &nbt));

    let mut q = BoxQuery::new([f64::NEG_INFINITY; 3], [f64::INFINITY; 3], false);
    assert_eq!(q.add_chunk(&region, 0, true), ChunkStatus::TooOld);
    assert_eq!(q.counts().outdated, 1);
    assert!(region.chunk_blocks(0, &ChunkOptions::default()).is_none());
}
