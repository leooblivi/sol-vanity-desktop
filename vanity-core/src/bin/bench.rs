use std::time::{Duration, Instant};
use vanity_core::{spawn_grind, GrindConfig, MatchPosition};

fn main() {
    let cfg = GrindConfig {
        keyword: "leon".to_string(),
        position: MatchPosition::Start,
        case_sensitive: false,
    };
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    println!("cores available: {}", cores);

    let start = Instant::now();
    let state = spawn_grind(cfg, cores);

    let result = loop {
        if let Some(r) = state.result.lock().unwrap().clone() {
            break r;
        }
        if start.elapsed() > Duration::from_secs(30) {
            println!("not found within 30s, tries so far: {}", state.tries.load(std::sync::atomic::Ordering::Relaxed));
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let elapsed = start.elapsed();
    let rate = result.tries as f64 / elapsed.as_secs_f64();
    println!("found: {}", result.address);
    println!("tries: {}", result.tries);
    println!("elapsed: {:?}", elapsed);
    println!("rate: {:.0} tries/sec", rate);
}
