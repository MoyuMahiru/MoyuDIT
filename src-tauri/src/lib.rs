mod commands;

use tauri::Manager;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

pub fn run() {
    tauri::Builder::default()
        .manage(commands::ImportCancellationState(Arc::new(AtomicBool::new(false))))
        .manage(commands::ScanCacheState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let main_window = app.get_webview_window("main");

            #[cfg(target_os = "macos")]
            if let Some(window) = &main_window {
                let _ = apply_vibrancy(window, NSVisualEffectMaterial::HudWindow, None, None);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::detect_sources,
            commands::scan_card,
            commands::preview_import,
            commands::run_import,
            commands::resume_pending_import,
            commands::cancel_import,
            commands::get_import_history,
            commands::get_pending_import_resume,
            commands::dismiss_pending_import_resume,
            commands::get_duplicate_import_warning,
            commands::open_in_file_manager,
            commands::export_import_report,
            commands::check_target_space,
            commands::load_media_preview
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
