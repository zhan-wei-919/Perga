//! 多 session 注册表 + per-session 发射线程。
//!
//! 每个前端新建 leaf 对应一个 `TerminalSession`(本地 PTY 或 SSH)+ 一条
//! OS 线程把后端事件 emit 到 `session_event:<uuid>`。前端 `listen` 订阅自己那
//! 条事件名,多 session 不互相干扰。
//!
//! 关键不变量:
//! - `SessionEntry::input_tx` 在 entry 存活期间一直可发(crossbeam Sender clone)。
//! - `SessionEntry::session` 在 entry drop 时同步 drop,触发 TerminalSession::Drop
//!   → engine thread join + transport close。Tauri command 的 spawn_blocking
//!   会等这个 drop 完成,然后才返回(参考 perga-server::ws::drop_session_blocking)。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crossbeam_channel::Sender;
use terminal_session::{SessionInput, TerminalSession};

/// 一个 session 在 Tauri 应用里的注册项。
pub struct SessionEntry {
    /// `session_input` command 通过这个发输入到 engine 线程。Sender clone 自
    /// `TerminalSession::input()`,Sender::send 是 Send + Sync 的,直接用 &self 调即可。
    input_tx: Sender<SessionInput>,
    /// 真正的 session 句柄。close 时 take() 出来 drop,触发底层清理。
    /// Mutex 是为了让 SessionEntry: Sync(TerminalSession 自身不是 Sync)。
    session: Mutex<Option<TerminalSession>>,
    /// emit 线程的 JoinHandle。entry drop 时 session drop → event_rx 断 →
    /// emit 线程退出 → 这里 take + join。Mutex<Option> 同理。
    emit_thread: Mutex<Option<JoinHandle<()>>>,
}

impl SessionEntry {
    pub fn new(
        session: TerminalSession,
        input_tx: Sender<SessionInput>,
        emit_thread: JoinHandle<()>,
    ) -> Self {
        Self {
            input_tx,
            session: Mutex::new(Some(session)),
            emit_thread: Mutex::new(Some(emit_thread)),
        }
    }

    pub fn input_tx(&self) -> &Sender<SessionInput> {
        &self.input_tx
    }

    /// 同步关闭:drop session(触发 engine join + transport close),join emit 线程。
    /// **必须在 spawn_blocking 上调** —— drop 可能耗时数十 ms,在 tokio 工作线程
    /// 上跑会卡 runtime。
    pub fn close_blocking(&self) {
        // 顺序很重要:先 drop session(关闭 event_rx 的对端,emit 线程会收到 Disconnected),
        // 再 join emit 线程(确保 emit 不再访问 AppHandle)。
        if let Ok(mut guard) = self.session.lock() {
            // drop Option::Some(session) → 走 TerminalSession::Drop。
            let _ = guard.take();
        } else {
            tracing::error!("perga.tauri.session_close.session_mutex_poisoned");
        }
        if let Ok(mut guard) = self.emit_thread.lock() {
            if let Some(handle) = guard.take() {
                if let Err(e) = handle.join() {
                    tracing::warn!(?e, "perga.tauri.emit_thread_join_failed");
                }
            }
        } else {
            tracing::error!("perga.tauri.session_close.emit_mutex_poisoned");
        }
    }
}

/// 主注册表。`Arc<SessionEntry>` 让 command 拿出 entry 后立刻释放 map lock。
/// 简单 `Mutex<HashMap>` 足够:session 总数 ~10 量级,锁竞争极少。
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Arc<SessionEntry>>>,
}

impl SessionRegistry {
    pub fn insert(&self, id: String, entry: SessionEntry) {
        match self.sessions.lock() {
            Ok(mut map) => {
                map.insert(id, Arc::new(entry));
            }
            Err(_) => tracing::error!("perga.tauri.registry_insert_mutex_poisoned"),
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().ok()?.get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<SessionEntry>> {
        self.sessions.lock().ok()?.remove(id)
    }
}
