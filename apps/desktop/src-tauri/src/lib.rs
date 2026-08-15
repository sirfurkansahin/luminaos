// ADR-0019 Karar (f): v1 IPC surface is a zero-command allowlist -- no
// custom command handlers, no plugin registrations. F2-T3 will add its own
// commands (e.g. get_active_window) in its own PR, once its consent/
// on-device-processing model is settled, per the least-privilege principle
// documented in ADR-0019 Karar (f).
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
