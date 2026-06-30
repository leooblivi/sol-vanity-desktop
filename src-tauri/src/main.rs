#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::State;
use vanity_core::{spawn_grind, GrindConfig, GrindState, MatchPosition};

struct AppState {
    current: Mutex<Option<Arc<GrindState>>>,
}

#[derive(Serialize)]
struct PollResponse {
    tries: u64,
    found: Option<FoundPayload>,
}

#[derive(Serialize)]
struct FoundPayload {
    address: String,
    secret_key: Vec<u8>,
    tries: u64,
}

#[tauri::command]
fn cores_available() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

#[tauri::command]
fn start_grind(
    keyword: String,
    position: String,
    case_sensitive: bool,
    state: State<AppState>,
) -> Result<(), String> {
    if keyword.is_empty() || keyword.len() > 7 {
        return Err("keyword must be 1-7 characters".into());
    }

    let position = match position.as_str() {
        "start" => MatchPosition::Start,
        "end" => MatchPosition::End,
        "anywhere" => MatchPosition::Anywhere,
        _ => return Err("invalid position".into()),
    };

    // stop any previous run before starting a new one
    {
        let mut current = state.current.lock().unwrap();
        if let Some(old) = current.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
    }

    let cfg = GrindConfig {
        keyword,
        position,
        case_sensitive,
    };
    let threads = cores_available();
    let new_state = spawn_grind(cfg, threads);

    *state.current.lock().unwrap() = Some(new_state);
    Ok(())
}

#[tauri::command]
fn stop_grind(state: State<AppState>) {
    let mut current = state.current.lock().unwrap();
    if let Some(s) = current.take() {
        s.stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
fn poll_grind(state: State<AppState>) -> PollResponse {
    let current = state.current.lock().unwrap();
    match current.as_ref() {
        None => PollResponse {
            tries: 0,
            found: None,
        },
        Some(s) => {
            let tries = s.tries.load(Ordering::Relaxed);
            let found = s.result.lock().unwrap().clone().map(|r| FoundPayload {
                address: r.address,
                secret_key: r.secret_key,
                tries: r.tries,
            });
            PollResponse { tries, found }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            current: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            cores_available,
            start_grind,
            stop_grind,
            poll_grind
        ])
        .run(tauri::generate_context!())
        .expect("error while running sol-vanity-desktop");
}
