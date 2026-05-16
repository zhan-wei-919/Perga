//! `ProtocolEncoder`:Snapshot → ProtocolEvent 的有状态翻译器。
//!
//! 持有 `seq` 单调计数 + 上一帧缓存。每次 `encode_frame` 调用比较 size /
//! rows / modes / title,决定走 `Init`(首帧 / resize)还是 `Patch`(行级
//! 增量)。
//!
//! Grid 内容在产出 wire event 时通过 [`encode_row`] 做行内 RLE 压缩 ──
//! Encoder 内部 cache 仍是未压缩的 `Vec<Row>`,行级 diff 按 cell vector 直接
//! 比较,简单可靠;只有产出 entry 时才走压缩路径。
//!
//! Encoder **不**做任何 IO ── 既不 emit、也不 JSON.stringify。调用方拿到
//! `ProtocolEvent` 自己决定怎么序列化、往哪发。

use terminal_engine::{Cell, CellWidth, Row, Snapshot, TerminalModes, TerminalSize};

use crate::event::{DirtyRow, ExitStatus, ProtocolEvent, RowEntry, TitleChange};

pub struct ProtocolEncoder {
    /// 单调递增,从 1 开始。0 是「尚未发任何事件」的哨兵。
    seq: u64,
    last: Option<LastFrame>,
}

struct LastFrame {
    size: TerminalSize,
    rows: Vec<Row>,
    modes: TerminalModes,
    title: Option<String>,
    // 不缓存 cursor:Patch 总是带 cursor,不做 cursor diff。
}

impl ProtocolEncoder {
    pub fn new() -> Self {
        Self { seq: 0, last: None }
    }

    /// 喂入一帧新状态,产生 `Init` 或 `Patch` 事件。
    ///
    /// 判断顺序:
    /// 1. 缓存为空 → `Init`,记下缓存。
    /// 2. 缓存 size 与当前 size 不一致 → `Init` 重置(grid 维度变了,前端
    ///    本地 grid 已经对不上)。
    /// 3. 否则 → `Patch`,行级 diff + modes/title 变化检测。
    pub fn encode_frame(
        &mut self,
        snapshot: Snapshot,
        modes: TerminalModes,
        title: Option<String>,
    ) -> ProtocolEvent {
        self.seq += 1;

        match self.last.as_mut() {
            Some(last) if last.size == snapshot.size => {
                let dirty_rows = diff_rows(&last.rows, &snapshot.rows);
                let modes_changed = (last.modes != modes).then_some(modes);
                let title_changed = diff_title(last.title.as_deref(), title.as_deref());

                last.rows = snapshot.rows;
                last.modes = modes;
                last.title = title;

                ProtocolEvent::Patch {
                    seq: self.seq,
                    cursor: snapshot.cursor,
                    dirty_rows,
                    modes: modes_changed,
                    title: title_changed,
                }
            }
            _ => {
                // None 或 size mismatch ── 都走 Init,重置缓存。
                let encoded_rows: Vec<Vec<RowEntry>> =
                    snapshot.rows.iter().map(|r| encode_row(&r.cells)).collect();
                self.last = Some(LastFrame {
                    size: snapshot.size,
                    rows: snapshot.rows,
                    modes,
                    title: title.clone(),
                });
                ProtocolEvent::Init {
                    seq: self.seq,
                    size: snapshot.size,
                    cursor: snapshot.cursor,
                    rows: encoded_rows,
                    modes,
                    title,
                }
            }
        }
    }

    /// 产生子进程退出事件。`seq` 同样递增,与 frame events 共享一个序列。
    pub fn encode_exited(&mut self, status: ExitStatus) -> ProtocolEvent {
        self.seq += 1;
        ProtocolEvent::Exited {
            seq: self.seq,
            status,
        }
    }
}

impl Default for ProtocolEncoder {
    fn default() -> Self {
        Self::new()
    }
}

/// 行级 diff。Cell 已经 `PartialEq`,整行 `Vec<Cell>` 直接比较。脏行通过
/// [`encode_row`] 转成 `Vec<RowEntry>`。
///
/// `old` 长度短于 `new` 理论上不会发生(size 不一致已经走 Init 路径),但稳
/// 一手:`old.get(i)` 拿不到就视为整行脏。
fn diff_rows(old: &[Row], new: &[Row]) -> Vec<DirtyRow> {
    new.iter()
        .enumerate()
        .filter_map(|(i, row)| {
            let dirty = match old.get(i) {
                Some(o) => o.cells != row.cells,
                None => true,
            };
            dirty.then(|| DirtyRow {
                index: i as u16,
                entries: encode_row(&row.cells),
            })
        })
        .collect()
}

/// 把一行 cells 编成 `RowEntry` 序列。O(n) 单次扫描,三种 entry:
/// - **Blank**:连续默认空白 cell。
/// - **Text**:连续单宽、共享属性、无 combining 的 cell,压成字符串。
/// - **Cells**:wide char + spacer、或带 combining mark 的 cell。
fn encode_row(cells: &[Cell]) -> Vec<RowEntry> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < cells.len() {
        let cell = &cells[i];

        if cell.is_default_blank() {
            let start = i;
            while i < cells.len() && cells[i].is_default_blank() {
                i += 1;
            }
            out.push(RowEntry::Blank {
                count: (i - start) as u16,
            });
            continue;
        }

        if cell.width == CellWidth::Single && cell.combining.is_empty() {
            // 文本 run:共享 fg/bg/attrs。
            let (fg, bg, attrs) = (cell.fg, cell.bg, cell.attrs);
            let mut s = String::new();
            while i < cells.len() {
                let c = &cells[i];
                if c.is_default_blank()
                    || c.width != CellWidth::Single
                    || !c.combining.is_empty()
                    || c.fg != fg
                    || c.bg != bg
                    || c.attrs != attrs
                {
                    break;
                }
                s.push(c.ch);
                i += 1;
            }
            out.push(RowEntry::Text { s, fg, bg, attrs });
            continue;
        }

        // Cells 兜底:wide / spacer / combining。
        let start = i;
        while i < cells.len() {
            let c = &cells[i];
            if c.is_default_blank() {
                break;
            }
            // 单宽且无 combining 的 cell 应该让 Text run 接管,跳出。
            if c.width == CellWidth::Single && c.combining.is_empty() {
                break;
            }
            i += 1;
        }
        out.push(RowEntry::Cells {
            cells: cells[start..i].to_vec(),
        });
    }
    out
}

/// title 变化检测。`None → Some` 是 Set,`Some → None` 是 Reset,
/// `Some(a) → Some(b)` 当 a≠b 是 Set,相同则 None。`None → None` 也是 None。
fn diff_title(last: Option<&str>, current: Option<&str>) -> Option<TitleChange> {
    match (last, current) {
        (a, b) if a == b => None,
        (_, Some(s)) => Some(TitleChange::Set {
            value: s.to_owned(),
        }),
        (_, None) => Some(TitleChange::Reset),
    }
}
