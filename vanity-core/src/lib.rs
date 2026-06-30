use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchPosition {
    Start,
    End,
    Anywhere,
}

#[derive(Clone, Debug)]
pub struct GrindConfig {
    pub keyword: String,
    pub position: MatchPosition,
    pub case_sensitive: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct GrindResult {
    pub address: String,
    pub secret_key: Vec<u8>,
    pub tries: u64,
}

pub struct GrindState {
    pub tries: AtomicU64,
    pub stop: AtomicBool,
    pub result: Mutex<Option<GrindResult>>,
}

impl GrindState {
    fn new() -> Self {
        GrindState {
            tries: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            result: Mutex::new(None),
        }
    }
}

fn matches(address: &str, cfg: &GrindConfig) -> bool {
    let (haystack, needle): (String, String) = if cfg.case_sensitive {
        (address.to_string(), cfg.keyword.clone())
    } else {
        (address.to_lowercase(), cfg.keyword.to_lowercase())
    };

    match cfg.position {
        MatchPosition::Start => haystack.starts_with(&needle),
        MatchPosition::End => haystack.ends_with(&needle),
        MatchPosition::Anywhere => haystack.contains(&needle),
    }
}

fn grind_one_thread(cfg: &GrindConfig, state: &Arc<GrindState>) {
    let mut local_tries: u64 = 0;
    const REPORT_EVERY: u64 = 2000;
    let mut rng = OsRng;

    loop {
        if state.stop.load(Ordering::Relaxed) {
            return;
        }

        let mut seed = [0u8; 32];
        rng.fill_bytes(&mut seed);
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        let address = bs58::encode(verifying_key.as_bytes()).into_string();

        local_tries += 1;

        if matches(&address, cfg) {
            let mut secret_key = Vec::with_capacity(64);
            secret_key.extend_from_slice(&seed);
            secret_key.extend_from_slice(verifying_key.as_bytes());

            let total = state.tries.fetch_add(local_tries, Ordering::Relaxed) + local_tries;
            let mut result = state.result.lock().unwrap();
            if result.is_none() {
                *result = Some(GrindResult {
                    address,
                    secret_key,
                    tries: total,
                });
                state.stop.store(true, Ordering::Relaxed);
            }
            return;
        }

        if local_tries >= REPORT_EVERY {
            state.tries.fetch_add(local_tries, Ordering::Relaxed);
            local_tries = 0;
        }
    }
}

pub fn spawn_grind(cfg: GrindConfig, threads: usize) -> Arc<GrindState> {
    let state = Arc::new(GrindState::new());
    let thread_count = threads.max(1);

    for _ in 0..thread_count {
        let cfg = cfg.clone();
        let state = Arc::clone(&state);
        thread::spawn(move || {
            grind_one_thread(&cfg, &state);
        });
    }

    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn finds_a_short_prefix_match() {
        let cfg = GrindConfig {
            keyword: "a".to_string(),
            position: MatchPosition::Start,
            case_sensitive: false,
        };
        let state = spawn_grind(cfg, 4);

        let result = loop {
            if let Some(r) = state.result.lock().unwrap().clone() {
                break r;
            }
            thread::sleep(Duration::from_millis(10));
        };

        assert!(result.address.to_lowercase().starts_with('a'));
        assert_eq!(result.secret_key.len(), 64);
    }
}
