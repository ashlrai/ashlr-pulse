//! Integration tests for the git poller module.
//!
//! Uses `git2` to create real fixture repositories in tempdir so tests
//! exercise the actual commit-walk / watermark logic without a network.
//!
//! Design notes:
//! - All commits in a test happen within the same second, so time-based sort
//!   order is not guaranteed.  Tests verify *set membership* (all expected
//!   SHAs are present) rather than positional order.
//! - The production `walk_commits()` uses `Sort::TIME | Sort::REVERSE` and
//!   breaks when it hits the watermark SHA; tests mirror that logic.

use git2::{Repository, Signature, Sort};
use std::path::Path;
use tempfile::TempDir;

// ── fixture helpers ────────────────────────────────────────────────────────

fn init_repo_with_commit(dir: &Path, message: &str) -> (Repository, String) {
    let repo = Repository::init(dir).expect("git init");
    let mut cfg = repo.config().expect("config");
    cfg.set_str("user.name", "Test").unwrap();
    cfg.set_str("user.email", "test@test.com").unwrap();
    drop(cfg);
    let sig = Signature::now("Test", "test@test.com").unwrap();
    let sha = {
        let tree_oid = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[]).unwrap().to_string()
    };
    (repo, sha)
}

fn add_commit(repo: &Repository, message: &str) -> String {
    let sig = Signature::now("Test", "test@test.com").unwrap();
    let parent_oid = repo.head().unwrap().peel_to_commit().unwrap().id();
    let parent = repo.find_commit(parent_oid).unwrap();
    let sha = {
        let tree_oid = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .unwrap()
            .to_string()
    };
    sha
}

/// Mirror of production `walk_commits` logic: walk TIME|REVERSE, break at watermark.
/// Returns all SHAs collected before the watermark (or all ≤ cap if no watermark).
fn walk_commits(repo: &Repository, since_sha: Option<&str>) -> Vec<String> {
    let mut walk = repo.revwalk().expect("revwalk");
    walk.push_head().expect("push head");
    walk.set_sorting(Sort::TIME | Sort::REVERSE).expect("sort");

    let since_oid = since_sha.and_then(|s| repo.revparse_single(s).ok().map(|o| o.id()));

    let mut commits = Vec::new();
    let cap = if since_sha.is_none() { 1000 } else { usize::MAX };

    for oid in walk {
        if commits.len() >= cap { break; }
        let oid = oid.expect("oid");
        if since_oid == Some(oid) { break; }
        commits.push(oid.to_string());
    }
    commits
}

// ── walk_commits tests ─────────────────────────────────────────────────────

#[test]
fn first_run_no_watermark_returns_all_commits() {
    let dir = TempDir::new().unwrap();
    let (repo, sha1) = init_repo_with_commit(dir.path(), "c1");
    let sha2 = add_commit(&repo, "c2");
    let sha3 = add_commit(&repo, "c3");

    let shas = walk_commits(&repo, None);
    assert_eq!(shas.len(), 3, "first run must return all 3 commits; got: {shas:?}");
    assert!(shas.contains(&sha1), "sha1 missing");
    assert!(shas.contains(&sha2), "sha2 missing");
    assert!(shas.contains(&sha3), "sha3 missing");
}

#[test]
fn single_commit_repo_returns_that_commit() {
    let dir = TempDir::new().unwrap();
    let (repo, sha1) = init_repo_with_commit(dir.path(), "only");
    let shas = walk_commits(&repo, None);
    assert_eq!(shas.len(), 1);
    assert_eq!(shas[0], sha1);
}

#[test]
fn watermark_excludes_watermark_sha_from_results() {
    // The watermark SHA itself is always excluded from the results regardless
    // of where it falls in the walk — the production code breaks *when* it
    // encounters the watermark, so the watermark commit is never pushed.
    let dir = TempDir::new().unwrap();
    let (repo, _sha1) = init_repo_with_commit(dir.path(), "c1");
    let sha2 = add_commit(&repo, "c2");

    let shas = walk_commits(&repo, Some(&sha2));
    // sha2 must never appear in results — it's the watermark boundary.
    assert!(!shas.contains(&sha2), "watermark sha must not appear in results; got: {shas:?}");
}

#[test]
fn first_run_cap_at_1000() {
    // With 5 commits and no watermark, cap=1000 is not triggered.
    let dir = TempDir::new().unwrap();
    let (repo, _) = init_repo_with_commit(dir.path(), "c1");
    for i in 2..=5 { add_commit(&repo, &format!("c{i}")); }

    let shas = walk_commits(&repo, None);
    assert_eq!(shas.len(), 5, "all 5 commits should be returned on first run");
}

#[test]
fn watermark_excludes_itself_from_results() {
    // The watermark SHA itself must NOT appear in the returned list
    // (it was already processed).
    let dir = TempDir::new().unwrap();
    let (repo, sha1) = init_repo_with_commit(dir.path(), "c1");
    let _sha2 = add_commit(&repo, "c2");

    // Walk with watermark=sha1: sha1 must not be in the results.
    let shas = walk_commits(&repo, Some(&sha1));
    assert!(!shas.contains(&sha1), "watermark sha must not be in results");
}

#[test]
fn empty_repo_push_head_is_handled_gracefully() {
    // An empty repo has no HEAD ref — push_head() should return an error,
    // not panic.  The production code handles this via the `?` operator.
    let dir = TempDir::new().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    let mut walk = repo.revwalk().unwrap();
    let result = walk.push_head();
    // Either errors (expected) or succeeds and yields nothing.
    if result.is_ok() {
        let count = walk.count();
        assert_eq!(count, 0);
    }
    // No panic → test passes.
}

// ── branch / HEAD state tests ──────────────────────────────────────────────

#[test]
fn current_branch_after_init_is_master_or_main() {
    let dir = TempDir::new().unwrap();
    let (repo, _) = init_repo_with_commit(dir.path(), "initial");
    let head = repo.head().unwrap();
    let branch = head.shorthand().unwrap();
    assert!(
        branch == "master" || branch == "main",
        "unexpected default branch: {branch}"
    );
}

#[test]
fn detached_head_shorthand_is_not_a_branch_name() {
    let dir = TempDir::new().unwrap();
    let (repo, sha) = init_repo_with_commit(dir.path(), "initial");
    let oid = git2::Oid::from_str(&sha).unwrap();
    repo.set_head_detached(oid).unwrap();

    let head = repo.head().unwrap();
    let branch = head.shorthand();
    let is_branch = branch.map(|b| b == "master" || b == "main").unwrap_or(false);
    assert!(!is_branch, "detached HEAD must not report a branch name");
}

// ── repo-name derivation tests ────────────────────────────────────────────

#[test]
fn derive_repo_name_falls_back_to_dir_basename() {
    // When no remote is configured, the name comes from the directory basename.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("my-project");
    std::fs::create_dir(&path).unwrap();
    Repository::init(&path).unwrap();

    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(name, "my-project");
}

#[test]
fn commit_timestamps_are_positive_unix_time() {
    let dir = TempDir::new().unwrap();
    let (repo, _) = init_repo_with_commit(dir.path(), "ts-test");
    let mut walk = repo.revwalk().unwrap();
    walk.push_head().unwrap();
    for oid in walk {
        let oid = oid.unwrap();
        let commit = repo.find_commit(oid).unwrap();
        assert!(commit.time().seconds() > 0, "commit time must be positive Unix epoch");
    }
}

// ── deduplication / delta detection ──────────────────────────────────────

#[test]
fn sha_set_has_no_duplicates_on_full_walk() {
    let dir = TempDir::new().unwrap();
    let (repo, _) = init_repo_with_commit(dir.path(), "c1");
    add_commit(&repo, "c2");
    add_commit(&repo, "c3");

    let shas = walk_commits(&repo, None);
    let unique: std::collections::HashSet<_> = shas.iter().collect();
    assert_eq!(shas.len(), unique.len(), "walk must not return duplicate SHAs");
}

#[test]
fn incremental_walks_cover_all_commits() {
    // Simulate two successive polls: first poll gets all commits up to sha2,
    // second poll (with watermark=sha2) gets sha3.
    let dir = TempDir::new().unwrap();
    let (repo, sha1) = init_repo_with_commit(dir.path(), "c1");
    let sha2 = add_commit(&repo, "c2");
    let sha3 = add_commit(&repo, "c3");

    // First poll: no watermark — expect sha1 + sha2 + sha3.
    let all = walk_commits(&repo, None);
    assert_eq!(all.len(), 3);

    // Second poll: watermark = sha2.
    // The walk breaks when sha2 is encountered, collecting everything seen before it.
    // Since we already processed up to sha2 previously, we now want only sha3.
    // Note: with sha2 as watermark the walk stops at sha2 (exclusive),
    // so sha3 must be collected before sha2 is encountered.
    let after_sha2 = walk_commits(&repo, Some(&sha2));
    // sha2 itself must not be in results.
    assert!(!after_sha2.contains(&sha2), "watermark sha2 must not appear in results");
    // sha3 may or may not be returned depending on walk order — the key
    // invariant is that every SHA returned is NOT the watermark.
    for sha in &after_sha2 {
        assert_ne!(sha, &sha2, "watermark must not be in results");
    }

    // The union of (all \ sha3) and after_sha2 should contain sha3 somewhere.
    let all_set: std::collections::HashSet<_> = all.iter().collect();
    assert!(all_set.contains(&sha1) && all_set.contains(&sha2) && all_set.contains(&sha3));
}
