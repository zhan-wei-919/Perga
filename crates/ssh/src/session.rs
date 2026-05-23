//! [`SshSession`]:对外的 SSH backend 会话句柄。
//!
//! 同步构造、同步 Drop,内部用一个独立 OS 线程跑 current_thread tokio runtime
//! 驱动 russh。对外暴露 [`transport::Transport`],与本地 [`pty::PtySession`]
//! 互换,`terminal-session` 完全不感知 backend 类型。

use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use russh::client::AuthResult;
use russh::keys::agent::AgentIdentity;
use tokio::sync::oneshot;
use transport::{TerminalSize, Transport, TransportCommand, TransportEvent};

use crate::config::{Auth, SshConfig};
use crate::error::SshError;
use crate::handler::PergaHandler;
use crate::shuttle::shuttle_loop;

/// Drop 时 join shuttle + bridge 线程的总预算。超时则 detach,记 warn。
const SHUTDOWN_JOIN_BUDGET: Duration = Duration::from_secs(3);

pub struct SshSession {
    command_tx: Sender<TransportCommand>,
    event_rx: Receiver<TransportEvent>,
    /// `Drop` 时通过这个 oneshot 通知 shuttle loop 退出。
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// `Drop` 时唤醒 bridge thread 跳出 crossbeam `recv`。
    ///
    /// **必须有专用通道**:bridge 跑 `command_rx_xb.recv()` 阻塞,只在
    /// 「所有外部 sender 都 drop」或「收到消息」时返回。SshSession::Drop
    /// 持有 `command_tx` 但还有 engine thread 的 clone 在跑;光发 shuttle
    /// shutdown 不能唤醒 bridge。这条 channel 直接 unblock bridge,把
    /// drop 延迟从 ~3s(budget 上限)压回 ms 级。
    bridge_shutdown_tx: Option<crossbeam_channel::Sender<()>>,
    shuttle_thread: Option<JoinHandle<()>>,
    bridge_thread: Option<JoinHandle<()>>,
}

impl SshSession {
    /// 同步连接 + 认证 + 开 channel,失败立即返回 Err。
    ///
    /// `size` 是终端的初始 cell 维度,会通过 `request_pty` 告诉远端 shell。
    /// 成功后内部 spawn 一个 OS 线程跑 tokio runtime + shuttle loop。
    pub fn spawn(config: SshConfig, size: TerminalSize) -> Result<Self, SshError> {
        let known_hosts_path = match &config.known_hosts_path {
            Some(p) => p.clone(),
            None => default_known_hosts_path()?,
        };

        // 外部 sync ↔ 内部 async 的两座桥:
        // - 命令通路:crossbeam Sender(对外)+ bridge thread + tokio mpsc(shuttle 内消费)
        // - 事件通路:shuttle loop 直接 send 到 crossbeam Sender(unbounded send 不阻塞)
        let (command_tx, command_rx_xb) = crossbeam_channel::unbounded::<TransportCommand>();
        let (event_tx, event_rx) = crossbeam_channel::unbounded::<TransportEvent>();
        let (command_tx_tk, command_rx_tk) =
            tokio::sync::mpsc::unbounded_channel::<TransportCommand>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        // 单独的 bridge shutdown 通道,Drop 时直接唤醒 bridge ── 避免 bridge 干
        // 等 crossbeam recv 直到所有 sender(含 engine 线程持有的 clone)drop。
        let (bridge_shutdown_tx, bridge_shutdown_rx) = crossbeam_channel::bounded::<()>(1);

        // bridge thread:crossbeam Receiver → tokio mpsc Sender,
        // **同时**听 bridge_shutdown 信号。任一侧出事就退。
        let bridge_thread = thread::Builder::new()
            .name("perga-ssh-bridge".into())
            .spawn(move || run_bridge_loop(command_rx_xb, command_tx_tk, bridge_shutdown_rx))
            .map_err(|e| SshError::Io(format!("spawn ssh bridge thread: {e}")))?;

        // shuttle thread:owns tokio runtime + russh handle + russh channel。
        // 连接 / 认证在这条线程里发生(`block_on` 一段 async setup),成功 / 失败
        // 通过 ready channel 同步返回给调用者。
        let (ready_tx, ready_rx) = std_mpsc::sync_channel::<Result<(), SshError>>(1);
        let shuttle_thread = thread::Builder::new()
            .name("perga-ssh".into())
            .spawn({
                let config = config.clone();
                let event_tx = event_tx.clone();
                move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(e) => {
                            let _ = ready_tx
                                .send(Err(SshError::Io(format!("build ssh tokio runtime: {e}"))));
                            return;
                        }
                    };
                    runtime.block_on(async move {
                        let setup = connect_and_open_shell(&config, size, known_hosts_path).await;
                        let (handle, channel) = match setup {
                            Ok(v) => {
                                // 报告 ready 成功之前,session 必须已 fully set up。
                                let _ = ready_tx.send(Ok(()));
                                v
                            }
                            Err(e) => {
                                let _ = ready_tx.send(Err(e));
                                return;
                            }
                        };
                        shuttle_loop(handle, channel, command_rx_tk, event_tx, shutdown_rx).await;
                    });
                    // runtime 在 block_on 返回后 drop,会等其内 spawn 的任务完成。
                }
            })
            .map_err(|e| SshError::Io(format!("spawn ssh shuttle thread: {e}")))?;

        // 等 shuttle 线程发 ready 信号 —— 在这之前调用者不该看到 session。
        let ready = ready_rx.recv().map_err(|_| {
            // shuttle 线程在没发 ready 的情况下消失(panic)。bridge 也得收掉。
            SshError::Connect("ssh shuttle thread terminated before ready".into())
        });

        match ready {
            Ok(Ok(())) => Ok(Self {
                command_tx,
                event_rx,
                shutdown_tx: Some(shutdown_tx),
                bridge_shutdown_tx: Some(bridge_shutdown_tx),
                shuttle_thread: Some(shuttle_thread),
                bridge_thread: Some(bridge_thread),
            }),
            Ok(Err(e)) => {
                // 连接 / 认证失败。shuttle 已经 return;bridge 还在跑 ── 显式
                // 发 bridge_shutdown 信号 + drop 我们的 command_tx,让 bridge
                // 立刻退,然后 join。shutdown_tx 没必要发,shuttle 已主动退。
                let _ = bridge_shutdown_tx.send(());
                drop(command_tx);
                drop(shutdown_tx);
                let _ = shuttle_thread.join();
                let _ = bridge_thread.join();
                Err(e)
            }
            Err(e) => {
                let _ = bridge_shutdown_tx.send(());
                drop(command_tx);
                drop(shutdown_tx);
                let _ = shuttle_thread.join();
                let _ = bridge_thread.join();
                Err(e)
            }
        }
    }
}

/// Bridge loop:crossbeam `command_rx` → tokio `command_tx`,**同时**听
/// `shutdown_rx`。任一通道断 / 收到 shutdown 信号都立刻退出。
///
/// 提到独立函数:让 `Drop` 行为可单测(测试可以直接构造 channel + 跑这
/// 个函数 + 发 shutdown 验证退出延迟,不需要真的连 SSH)。
fn run_bridge_loop(
    command_rx: crossbeam_channel::Receiver<TransportCommand>,
    command_tx_tk: tokio::sync::mpsc::UnboundedSender<TransportCommand>,
    shutdown_rx: crossbeam_channel::Receiver<()>,
) {
    loop {
        crossbeam_channel::select! {
            recv(command_rx) -> msg => match msg {
                Ok(cmd) => {
                    if command_tx_tk.send(cmd).is_err() {
                        // shuttle 那侧 Receiver drop 了,继续转发没意义。
                        return;
                    }
                }
                // 所有 Sender 都 drop:外部命令通路结束。
                Err(_) => return,
            },
            recv(shutdown_rx) -> _ => return,
        }
    }
}

impl Transport for SshSession {
    fn command_tx(&self) -> &Sender<TransportCommand> {
        &self.command_tx
    }

    fn event_rx(&self) -> &Receiver<TransportEvent> {
        &self.event_rx
    }
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // 1. shuttle:发 oneshot,让 shuttle loop close channel + disconnect 退出。
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        // 2. bridge:发独立 shutdown 信号唤醒 crossbeam recv。**这是关键** ──
        //    没有它的话 bridge 干等所有 sender drop,而 engine 线程的 sender
        //    clone 是异步 drop 的,会拖到 join 超时。
        if let Some(tx) = self.bridge_shutdown_tx.take() {
            let _ = tx.send(());
        }

        // 3. join shuttle / bridge,带预算。超时记 warn 后 detach。
        let handles: Vec<JoinHandle<()>> = [self.shuttle_thread.take(), self.bridge_thread.take()]
            .into_iter()
            .flatten()
            .collect();
        if !handles.is_empty() {
            join_handles_with_timeout(handles, SHUTDOWN_JOIN_BUDGET);
        }
    }
}

/// 默认 `~/.ssh/known_hosts` 路径。`$HOME` 缺失 → 报错(spawn 失败),
/// 比偷偷写到 `/known_hosts` 之类的怪地方安全。
fn default_known_hosts_path() -> Result<PathBuf, SshError> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| SshError::Io("$HOME not set; cannot locate ~/.ssh/known_hosts".into()))?;
    let mut p = PathBuf::from(home);
    p.push(".ssh");
    p.push("known_hosts");
    Ok(p)
}

/// 连接 + 认证 + 开 channel + request_pty + request_shell 的全程 async setup。
async fn connect_and_open_shell(
    config: &SshConfig,
    size: TerminalSize,
    known_hosts_path: PathBuf,
) -> Result<
    (
        russh::client::Handle<PergaHandler>,
        russh::Channel<russh::client::Msg>,
    ),
    SshError,
> {
    let cfg = Arc::new(russh::client::Config::default());
    let handler = PergaHandler {
        host: config.host.clone(),
        port: config.port,
        known_hosts_path,
    };

    let addr = (config.host.as_str(), config.port);
    let mut handle = russh::client::connect(cfg, addr, handler)
        .await
        .map_err(classify_connect_error)?;

    match &config.auth {
        Auth::Agent => authenticate_via_agent(&mut handle, &config.user).await?,
        Auth::Password { password } => {
            authenticate_via_password(&mut handle, &config.user, password).await?
        }
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::Channel(format!("open_session: {e}")))?;

    // 默认 terminal modes(空数组让远端使用 sshd 默认值)。
    channel
        .request_pty(
            false,
            "xterm-256color",
            size.cols as u32,
            size.rows as u32,
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| SshError::Channel(format!("request_pty: {e}")))?;

    channel
        .request_shell(false)
        .await
        .map_err(|e| SshError::Channel(format!("request_shell: {e}")))?;

    Ok((handle, channel))
}

/// russh connect 阶段的错误分类:host key 拒绝 → `HostKeyMismatch`,其他 → `Connect`。
///
/// russh 把 handler 返回 `Ok(false)` 翻成一种通用的"拒绝"错误,不会直接告诉
/// 我们「是 fingerprint mismatch 还是 IO 失败」。这里靠 handler 已经 log 过的
/// `host_key_mismatch` 事件 + 错误 Display 字符串模糊匹配:不完美,但够把最
/// 常见的 fingerprint 不匹配挑出来给用户清晰提示。其他类型还是 `Connect`。
fn classify_connect_error(e: russh::Error) -> SshError {
    let msg = format!("{e}");
    // russh 的拒绝错误一般包含 "key" / "host key" / "rejected" 字样。这一刀
    // 的策略宁可漏也不要假报警,所以保持 fallthrough 到 Connect。
    let looks_like_host_key_reject = msg.contains("Server refused") || msg.contains("host key");
    if looks_like_host_key_reject {
        SshError::HostKeyMismatch
    } else {
        SshError::Connect(msg)
    }
}

/// 通过密码认证。**对端必须开放 `password` 方法**(`sshd_config` 的
/// `PasswordAuthentication yes`)—— 现代默认是 `no`,会回退到
/// keyboard-interactive,russh 0.61 的 `authenticate_password` 不会自动跨方法
/// 尝试,所以失败原因可能是「密码错」也可能是「服务端不让密码登录」。
async fn authenticate_via_password(
    handle: &mut russh::client::Handle<PergaHandler>,
    user: &str,
    password: &str,
) -> Result<(), SshError> {
    let result = handle
        .authenticate_password(user.to_string(), password.to_string())
        .await
        .map_err(|e| SshError::Auth(format!("password auth: {e}")))?;
    if matches!(result, AuthResult::Success) {
        Ok(())
    } else {
        // AuthResult::Failure 携带剩余允许的方法,可能提示「该开 PasswordAuthentication」。
        Err(SshError::Auth(format!(
            "password rejected (server may not allow password auth); result = {result:?}"
        )))
    }
}

/// 通过 SSH agent 认证。遍历 agent 持有的 identities,任一成功视作 auth 成功。
async fn authenticate_via_agent(
    handle: &mut russh::client::Handle<PergaHandler>,
    user: &str,
) -> Result<(), SshError> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| SshError::Auth(format!("connect ssh-agent (is SSH_AUTH_SOCK set?): {e}")))?;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Auth(format!("request_identities from agent: {e}")))?;

    if identities.is_empty() {
        return Err(SshError::Auth(
            "ssh-agent has no identities loaded (run `ssh-add` to add a key)".into(),
        ));
    }

    let mut last_failure: Option<String> = None;
    for id in identities {
        let pubkey = match &id {
            AgentIdentity::PublicKey { key, .. } => key.clone(),
            // Certificate 走相同的认证路径,把内部的 KeyData 包成 PublicKey;
            // russh 的 `authenticate_publickey_with` 接收 PublicKey,Certificate
            // 的 attestation 信息当前不参与 v1 校验。
            AgentIdentity::Certificate { certificate, .. } => {
                certificate.public_key().clone().into()
            }
        };
        let comment = id.comment().to_string();
        let result = handle
            .authenticate_publickey_with(user.to_string(), pubkey, None, &mut agent)
            .await;
        match result {
            Ok(AuthResult::Success) => return Ok(()),
            Ok(AuthResult::Failure { .. }) => {
                last_failure = Some(format!("identity '{comment}' rejected"));
                continue;
            }
            Err(e) => {
                last_failure = Some(format!("identity '{comment}': {e}"));
                continue;
            }
        }
    }

    Err(SshError::Auth(format!(
        "all agent identities rejected by server{}",
        last_failure
            .map(|m| format!(" (last: {m})"))
            .unwrap_or_default()
    )))
}

/// 并发 join 任意线程,整体 deadline。超时 detach + warn。
///
/// 复刻自 `pty::session` 的同名函数 —— SSH 同样面临「shutdown 后线程偶尔卡死
/// 在 russh 内部 await 上」的问题,需要一个不会让上层 Drop 永远不返回的兜底。
fn join_handles_with_timeout(handles: Vec<JoinHandle<()>>, timeout: Duration) {
    let total = handles.len();
    if total == 0 {
        return;
    }
    let (done_tx, done_rx) = crossbeam_channel::bounded::<usize>(total);

    for (idx, handle) in handles.into_iter().enumerate() {
        let tx = done_tx.clone();
        let _ = thread::Builder::new()
            .name(format!("ssh-join-{idx}"))
            .spawn(move || {
                if let Err(panic) = handle.join() {
                    tracing::warn!(idx, ?panic, "ssh.session.thread_panicked");
                }
                let _ = tx.send(idx);
            });
    }
    drop(done_tx);

    let deadline = Instant::now() + timeout;
    let mut received = 0usize;
    while received < total {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            tracing::warn!(
                remaining = total - received,
                "ssh.session.join_timeout_detaching"
            );
            return;
        };
        match done_rx.recv_timeout(left) {
            Ok(_) => received += 1,
            Err(_) => {
                tracing::warn!(
                    remaining = total - received,
                    "ssh.session.join_timeout_detaching"
                );
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 复现 Drop 等满 budget 的核心场景:bridge 在阻塞 recv,有外部 sender 没 drop
    /// (模拟 engine 线程的 clone),靠 bridge_shutdown 信号叫醒它快速退出。
    ///
    /// 旧实现 = 干等到 sender drop,这里会 hang。新实现 = 收到 shutdown 立退。
    #[test]
    fn bridge_loop_exits_on_shutdown_even_with_live_sender() {
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<TransportCommand>();
        let (tk_tx, _tk_rx) = tokio::sync::mpsc::unbounded_channel::<TransportCommand>();
        let (sd_tx, sd_rx) = crossbeam_channel::bounded::<()>(1);

        let bridge = thread::spawn(move || run_bridge_loop(cmd_rx, tk_tx, sd_rx));

        // 故意保留 cmd_tx 不 drop —— 模拟 engine 线程的 sender clone 还活着。
        let start = Instant::now();
        sd_tx.send(()).expect("send shutdown");
        bridge.join().expect("bridge joins");
        let elapsed = start.elapsed();

        // 真正的 bug 修复证据:bridge 在 sender 没 drop 时,靠 shutdown 信号
        // 也能立刻退,远低于 SHUTDOWN_JOIN_BUDGET(3s)。
        assert!(
            elapsed < Duration::from_millis(200),
            "bridge should exit fast on shutdown, took {elapsed:?}"
        );

        // 显式 drop cmd_tx,避免 unused 警告;表达"sender 一直活到测试结束"。
        drop(cmd_tx);
    }

    /// 反方向兜底:没人发 shutdown,所有 sender drop 也能让 bridge 退出。
    #[test]
    fn bridge_loop_exits_when_all_senders_drop() {
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<TransportCommand>();
        let (tk_tx, _tk_rx) = tokio::sync::mpsc::unbounded_channel::<TransportCommand>();
        let (_sd_tx, sd_rx) = crossbeam_channel::bounded::<()>(1);

        let bridge = thread::spawn(move || run_bridge_loop(cmd_rx, tk_tx, sd_rx));
        drop(cmd_tx);
        bridge.join().expect("bridge joins on sender drop");
    }
}
