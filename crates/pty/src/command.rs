//! 历史保留模块。`PtyCommand` 已经统一成 `transport::TransportCommand`,
//! 这个模块只是一个 re-export 入口便于阅读。新代码请直接用
//! `transport::TransportCommand`。

pub use transport::TransportCommand;
