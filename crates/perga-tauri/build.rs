// Tauri 2 build script:展开 tauri.conf.json,生成 capabilities / commands
// 元数据,设置 cargo rerun-if-changed。
fn main() {
    tauri_build::build()
}
