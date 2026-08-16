// ADR-0019 Karar (f): v1 IPC surface started as a zero-command allowlist.
// ADR-0020 Karar (e)/(f)/(g) (F2-T3 PR3) adds the first command,
// `get_active_window_app_name`, scoped to the least-privilege
// `desktop-signals` capability (see
// `src-tauri/permissions/desktop-signals.toml` and
// `src-tauri/capabilities/desktop-signals.json`) -- `capabilities/default.json`
// stays untouched.
//
// ADR-0020 Karar (e), on-device-processing boundary: this command reads only
// the foreground window's process/application name (e.g. `Code.exe`),
// NEVER the full window title text -- the full-title-reading Win32 APIs are
// intentionally never called here.
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Returns the foreground window's process/application image name (e.g.
/// `Code.exe`), or an empty string if it cannot be determined. Per ADR-0020
/// Karar (e), this never reads the window title text.
#[tauri::command]
fn get_active_window_app_name() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return String::new();
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return String::new();
        }

        let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(_) => return String::new(),
        };

        let mut buffer = [0u16; 260];
        let len = GetModuleBaseNameW(process, None, &mut buffer);

        let _ = CloseHandle(process);

        if len == 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..len as usize])
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_active_window_app_name])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
