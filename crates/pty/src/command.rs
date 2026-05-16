//! 上层 → PTY 线程的统一命令枚举。
//!
//! 按 CLAUDE.md「线程间通信」节,优先用一个命令枚举承载多种意图,不为
//! Resize / Shutdown 单拆 channel —— 它们和 Write 的优先级、背压都一致。

use crate::config::PtySize;

#[derive(Debug, Clone)]
pub enum PtyCommand {
    /// 把字节原样写入 PTY 主端,不做任何转译。
    Write(Vec<u8>),
    /// 调整 PTY 行列。调用方根据自己拿到的真实 terminal 大小决定。
    Resize(PtySize),
    /// 关闭会话。**契约是「杀掉 child」**,不是「只发 SIGHUP」:
    /// writer 收到后先 SIGHUP(给 shell 写 history 的机会),
    /// waiter 线程在 500ms grace 后向 child pgroup SIGKILL,
    /// 把 `trap '' HUP` 之类拒绝退出的进程也连同孙子一起收掉。
    Shutdown,
}
