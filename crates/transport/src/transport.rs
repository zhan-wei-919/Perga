//! [`Transport`] trait:把 backend 暴露给 `terminal-session` 的统一接口。

use crossbeam_channel::{Receiver, Sender};

use crate::command::TransportCommand;
use crate::event::TransportEvent;

/// 一个活的终端 backend 会话。
///
/// `terminal-session::TerminalSession` 通过 `Box<dyn Transport + Send>` 持有
/// 任意 backend(本地 PTY 或 SSH),engine 线程在 `command_tx` / `event_rx`
/// 上与 backend 通讯,不关心底层是什么。
///
/// **Drop 契约**:实现者负责在自己的 `Drop` 中完成资源清理。
/// `TerminalSession` 的 Drop 顺序是「先 drop input(让 engine 线程退出)→
/// 再 drop transport → 最后 join engine 线程」—— 实现者的 Drop 在中间那一步
/// 执行,期间应当**同步**等待 backend 资源回收完成(关 fd / 杀子进程 /
/// 关 SSH channel + disconnect)。
pub trait Transport: Send {
    fn command_tx(&self) -> &Sender<TransportCommand>;
    fn event_rx(&self) -> &Receiver<TransportEvent>;
}
