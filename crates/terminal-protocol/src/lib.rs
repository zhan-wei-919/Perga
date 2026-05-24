//! Terminal Engine 之上的协议编码层。
//!
//! 把 `terminal-engine` 暴露的 `Snapshot / TerminalModes / title` 翻译成
//! 跨进程消息(`ProtocolEvent`),供 IPC / native client / 其他传输层序列化后
//! 发给客户端。
//!
//! 设计要点:
//! - 顶层 `ProtocolEvent` 用 `#[serde(tag = "type")]`,前端 switch(msg.type)
//!   走不同分支。
//! - `Init` 是完整帧(首次 + resize 后),`Patch` 是行级增量,`Exited` 是
//!   子进程退出。
//! - `ProtocolEncoder` 持有上一帧缓存,自己做行级 diff;**不**碰 alacritty
//!   damage API,Engine 边界保持纯净。
//! - Encoder 不做 IO,只产 events。序列化(serde_json / MessagePack / 其他)
//!   和发送到 IPC / socket / 其他传输层都是上层的事。
//!
//! # Wire format 契约(前端必须遵守)
//!
//! Grid 内容用行内 RLE 压缩(见 [`RowEntry`]):
//! - `Blank { count }`:连续 `count` 个默认空白 cell ── ch=' ', 默认色, 无 attrs。
//! - `Text { s, fg?, bg?, attrs? }`:共享属性的单宽字符串。**缺 fg / bg / attrs
//!   字段时按默认值解读**(fg=Foreground, bg=Background, attrs 空)。
//! - `Cells { cells }`:兜底数组 ── wide char + spacer 对、带 combining mark
//!   的 cell;前端按 cell 数组逐列覆盖。
//!
//! 一行的所有 entry 顺序展开后,占用列数之和 = `size.cols`。

mod encoder;
mod event;

pub use encoder::ProtocolEncoder;
pub use event::{DirtyRow, ExitStatus, ProtocolEvent, RowEntry, TitleChange};
