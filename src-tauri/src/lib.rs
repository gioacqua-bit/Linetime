// Linetime — native layer for the desktop app.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. This program is distributed WITHOUT ANY WARRANTY; see
// the LICENSE file for details.

mod fsops;
mod store;

use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use store::{Roots, Store};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/* ---------- folder access ---------- */

#[derive(Serialize)]
struct Picked {
    path: String,
    name: String,
}

/// Shows the native folder dialog. The chosen folder becomes one of the
/// folders Linetime may read and write, and is remembered across sessions.
#[tauri::command]
async fn pick_folder(
    app: AppHandle,
    roots: State<'_, Roots>,
    purpose: String,
) -> Result<Option<Picked>, String> {
    let title = if purpose == "parent" {
        "Choose where to create the project folder"
    } else {
        "Open a Linetime project folder"
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let Some(chosen) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let canon = dunce::canonicalize(&path).map_err(fsops::io_err)?;
    roots.add(canon.clone(), true)?;
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canon.to_string_lossy().into_owned());
    Ok(Some(Picked {
        path: canon.to_string_lossy().into_owned(),
        name,
    }))
}

#[tauri::command]
fn fs_stat(roots: State<'_, Roots>, path: String) -> Result<fsops::Stat, String> {
    Ok(fsops::stat(&roots.resolve(&path)?))
}

#[tauri::command]
fn fs_list(roots: State<'_, Roots>, path: String) -> Result<Vec<fsops::Entry>, String> {
    fsops::list(&roots.resolve(&path)?)
}

#[tauri::command]
fn fs_read(roots: State<'_, Roots>, path: String) -> Result<String, String> {
    fsops::read_text(&roots.resolve(&path)?)
}

#[tauri::command]
fn fs_write(roots: State<'_, Roots>, path: String, text: String) -> Result<(), String> {
    fsops::write_atomic(&roots.resolve(&path)?, text.as_bytes())
}

#[tauri::command]
fn fs_mkdir(roots: State<'_, Roots>, path: String) -> Result<(), String> {
    fsops::mkdir(&roots.resolve(&path)?)
}

#[tauri::command]
fn fs_remove(roots: State<'_, Roots>, path: String) -> Result<(), String> {
    fsops::remove_file(&roots.resolve(&path)?)
}

/* ---------- exports ---------- */

/// Shows the native "Save as" dialog and writes the exported file where the
/// user chose. Returns the file name, or nothing if the user cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, name: String, data: String) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| fsops::err("DataError", e))?;
    let ext = Path::new(&name)
        .extension()
        .map(|e| e.to_string_lossy().into_owned());
    let label = match ext.as_deref() {
        Some("zip") => "Zip archive",
        Some("md") => "Markdown",
        Some(_) | None => "File",
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Export").set_file_name(&name);
    if let Some(ext) = ext.as_deref() {
        dialog = dialog.add_filter(label, &[ext]);
    }
    dialog.save_file(move |f| {
        let _ = tx.send(f);
    });
    let Some(chosen) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path: PathBuf = chosen.into_path().map_err(|e| e.to_string())?;
    fsops::write_atomic(&path, &bytes)?;
    Ok(Some(
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(name),
    ))
}

/// Opens web and mail links in the system's default application.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
    {
        return Err(fsops::err(
            "NotAllowedError",
            "only web and mail links can be opened",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/* ---------- settings and recent projects ---------- */

#[tauri::command]
fn kv_get(store: State<'_, Store>, key: String) -> Result<serde_json::Value, String> {
    Ok(store.get(&key))
}

#[tauri::command]
fn kv_set(store: State<'_, Store>, key: String, value: serde_json::Value) -> Result<(), String> {
    store.set(&key, value)
}

#[tauri::command]
fn kv_del(store: State<'_, Store>, key: String) -> Result<(), String> {
    store.set(&key, serde_json::Value::Null)
}

/* ---------- closing with unsaved changes ---------- */

/// Closing the window or quitting is first offered to the interface, which
/// asks about unsaved changes. If the interface does not acknowledge the
/// request within two seconds (for example because the page failed to load),
/// the app closes anyway, so that it can never get stuck open.
#[derive(Default)]
struct CloseGuard {
    allow: AtomicBool,
    seq: AtomicU64,
    acked: AtomicU64,
}

fn request_close(app: &AppHandle) {
    let guard = app.state::<CloseGuard>();
    let seq = guard.seq.fetch_add(1, Ordering::SeqCst) + 1;
    match app.get_webview_window("main") {
        Some(w) => {
            let script = format!(
                "window.__linetimeCloseRequested && window.__linetimeCloseRequested({seq})"
            );
            let _ = w.eval(&script);
        }
        None => {
            guard.allow.store(true, Ordering::SeqCst);
            app.exit(0);
            return;
        }
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let guard = app.state::<CloseGuard>();
        if guard.acked.load(Ordering::SeqCst) < seq {
            guard.allow.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    });
}

#[tauri::command]
fn close_ack(guard: State<'_, CloseGuard>, seq: u64) {
    guard.acked.fetch_max(seq, Ordering::SeqCst);
}

#[tauri::command]
fn close_window(app: AppHandle, guard: State<'_, CloseGuard>) {
    guard.allow.store(true, Ordering::SeqCst);
    app.exit(0);
}

/* ---------- smoke test (see scripts/smoke.mjs) ---------- */

#[tauri::command]
fn smoke_info(roots: State<'_, Roots>) -> Result<Option<String>, String> {
    let Ok(dir) = std::env::var("LINETIME_SMOKE_DIR") else {
        return Ok(None);
    };
    let canon = dunce::canonicalize(&dir).map_err(fsops::io_err)?;
    roots.add(canon.clone(), false)?;
    Ok(Some(canon.to_string_lossy().into_owned()))
}

/// Sends a close request to the interface, as closing the window would.
#[tauri::command]
fn smoke_request_close(app: AppHandle) {
    if std::env::var("LINETIME_SMOKE_DIR").is_ok() {
        request_close(&app);
    }
}

#[tauri::command]
fn smoke_report(guard: State<'_, CloseGuard>, ok: bool, report: String) {
    if std::env::var("LINETIME_SMOKE_DIR").is_err() {
        return;
    }
    println!("LINETIME_SMOKE_RESULT {report}");
    if let Ok(out) = std::env::var("LINETIME_SMOKE_OUT") {
        let _ = std::fs::write(out, &report);
    }
    guard.allow.store(true, Ordering::SeqCst);
    std::process::exit(if ok { 0 } else { 1 });
}

/* ---------- app ---------- */

fn config_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = match std::env::var("LINETIME_CONFIG_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => app.path().app_config_dir()?,
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = config_dir(app)?;
            app.manage(Roots::load(dir.join("folders.json")));
            app.manage(Store::load(dir.join("settings.json")));
            app.manage(CloseGuard::default());
            if std::env::var("LINETIME_SMOKE_DIR").is_ok() {
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_secs(120));
                    eprintln!(
                        "LINETIME_SMOKE_RESULT timeout: the interface did not report within 120 s"
                    );
                    std::process::exit(3);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !app.state::<CloseGuard>().allow.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_close(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            fs_stat,
            fs_list,
            fs_read,
            fs_write,
            fs_mkdir,
            fs_remove,
            save_file,
            open_external,
            kv_get,
            kv_set,
            kv_del,
            close_ack,
            close_window,
            smoke_info,
            smoke_request_close,
            smoke_report
        ])
        .build(tauri::generate_context!())
        .expect("error while building Linetime");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() && !handle.state::<CloseGuard>().allow.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_close(handle);
            }
        }
    });
}
