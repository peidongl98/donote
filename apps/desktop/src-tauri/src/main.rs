// 发布版不要额外弹一个控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    donote_lib::run()
}
