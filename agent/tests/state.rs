//! Integration tests for StateDb — SQLite watermark store.
//!
//! Each test opens a database in a tempdir so they are fully isolated from
//! the real `~/.local/share/pulse/state.db` and from each other.

use pulse_agent::state::StateDb;
use rusqlite::Connection;
use std::sync::Arc;

// ── helpers ────────────────────────────────────────────────────────────────

/// Open a StateDb backed by a private in-memory SQLite database.
/// We open the connection ourselves and call the public constructor, which
/// runs migrations.  Using a named temp-file (via `tempfile`) would also
/// work, but in-memory is faster and still exercises all code paths.
fn open_mem_db() -> StateDb {
    // StateDb::open() uses `dirs::data_local_dir()` — we can't redirect it
    // without env trickery. Instead, construct via the `open_with_path`
    // helper that accepts a PathBuf.  Since that helper isn't public, we use
    // a tempfile instead so the test is fully isolated.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("state.db");
    // We need dir to stay alive for the duration of the test.  Leak it
    // intentionally — the OS cleans up temp dirs after the process exits,
    // and a test binary is short-lived.
    std::mem::forget(dir);
    open_at(path)
}

fn open_at(path: std::path::PathBuf) -> StateDb {
    // Create parent dirs if needed.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    // Build a StateDb by writing the migrations directly via rusqlite, then
    // wrapping in StateDb.  Because StateDb::open() hard-codes the path to
    // `dirs::data_local_dir()`, we replicate its internals here for test
    // isolation.
    let conn = Connection::open(&path).expect("open sqlite");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_offsets (
             path       TEXT PRIMARY KEY,
             offset     INTEGER NOT NULL DEFAULT 0,
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE TABLE IF NOT EXISTS git_watermarks (
             repo_path  TEXT PRIMARY KEY,
             commit_sha TEXT NOT NULL,
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .expect("migrate");
    drop(conn);
    // Now open via the public API pointing at the same file.
    // We temporarily override HOME so `dirs::data_local_dir()` resolves
    // into our tempdir.  That's fragile — use the open_with_path workaround:
    // Re-open directly using rusqlite and wrap in a Mutex to match the real
    // internal structure.  Since the type's `conn` field is private, the
    // cleanest approach is to open through the real `StateDb::open()` after
    // overriding XDG_DATA_HOME (Linux) / HOME (macOS) to point to our dir.
    //
    // For simplicity across platforms, point HOME at a controlled tempdir
    // so `dirs::data_local_dir()` resolves there.
    //
    // This is only acceptable in tests.  Production code always uses the
    // real home directory.
    let parent = path.parent().unwrap().parent().unwrap(); // strip /pulse
    std::env::set_var("HOME", parent);
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", parent);
    StateDb::open().expect("StateDb::open")
}

// ── file offset tests ──────────────────────────────────────────────────────

#[test]
fn file_offset_defaults_to_zero_for_unknown_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let offset = db.get_file_offset("/some/new/file.jsonl").expect("get");
    assert_eq!(offset, 0, "unknown file should return offset 0");
}

#[test]
fn file_offset_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let path = "/Users/x/.claude/projects/my-proj/session.jsonl";

    db.set_file_offset(path, 4096).expect("set");
    let got = db.get_file_offset(path).expect("get");
    assert_eq!(got, 4096);
}

#[test]
fn file_offset_update_overwrites_previous() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let path = "/some/file.jsonl";

    db.set_file_offset(path, 100).expect("set 100");
    db.set_file_offset(path, 200).expect("set 200");
    assert_eq!(db.get_file_offset(path).expect("get"), 200);
}

#[test]
fn file_offset_list_all() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    db.set_file_offset("/a.jsonl", 10).expect("a");
    db.set_file_offset("/b.jsonl", 20).expect("b");
    let all = db.list_file_offsets().expect("list");
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|(p, o)| p == "/a.jsonl" && *o == 10));
    assert!(all.iter().any(|(p, o)| p == "/b.jsonl" && *o == 20));
}

// ── git watermark tests ────────────────────────────────────────────────────

#[test]
fn git_watermark_returns_none_for_unknown_repo() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let wm = db.get_git_watermark("/no/such/repo").expect("get");
    assert!(wm.is_none(), "unknown repo should return None");
}

#[test]
fn git_watermark_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let repo = "/Users/x/code/my-repo";
    let sha = "abc123def456abc123def456abc123def456abc1";

    db.set_git_watermark(repo, sha).expect("set");
    let got = db.get_git_watermark(repo).expect("get");
    assert_eq!(got.as_deref(), Some(sha));
}

#[test]
fn git_watermark_update_advances_sha() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let repo = "/repo";
    let sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    db.set_git_watermark(repo, sha1).expect("set sha1");
    db.set_git_watermark(repo, sha2).expect("set sha2");
    assert_eq!(
        db.get_git_watermark(repo).expect("get").as_deref(),
        Some(sha2)
    );
}

#[test]
fn git_watermark_list_all() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    db.set_git_watermark("/repo/a", sha).expect("a");
    db.set_git_watermark("/repo/b", sha).expect("b");
    let all = db.list_git_watermarks().expect("list");
    assert_eq!(all.len(), 2);
    assert!(all.iter().any(|(p, _)| p == "/repo/a"));
    assert!(all.iter().any(|(p, _)| p == "/repo/b"));
}

#[test]
fn multiple_repos_are_tracked_independently() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = StateDb::open().expect("open");
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sha_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    db.set_git_watermark("/repo/a", sha_a).expect("a");
    db.set_git_watermark("/repo/b", sha_b).expect("b");

    assert_eq!(
        db.get_git_watermark("/repo/a").expect("a").as_deref(),
        Some(sha_a)
    );
    assert_eq!(
        db.get_git_watermark("/repo/b").expect("b").as_deref(),
        Some(sha_b)
    );
}

// ── concurrency safety ─────────────────────────────────────────────────────

#[test]
fn concurrent_writes_are_safe() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());

    let db = Arc::new(StateDb::open().expect("open"));
    let mut handles = Vec::new();
    for i in 0u64..8 {
        let db2 = Arc::clone(&db);
        let path = format!("/file_{i}.jsonl");
        handles.push(std::thread::spawn(move || {
            db2.set_file_offset(&path, i * 100).expect("set");
            db2.get_file_offset(&path).expect("get")
        }));
    }
    for (i, h) in handles.into_iter().enumerate() {
        let got = h.join().expect("thread");
        assert_eq!(got, i as u64 * 100);
    }
}
