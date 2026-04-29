//! Integration test for git_info_from_dir — used by both the Claude
//! tailer and the shell-hook tailer to attribute spans to a repo +
//! branch. Builds a real git repo in a tempdir using libgit2 (already
//! a dependency for git polling) so the test exercises the actual code
//! path rather than a stubbed one.

use git2::{Repository, Signature};
use pulse_agent::claude::git_info_from_dir;
use std::fs;
use tempfile::tempdir;

#[test]
fn extracts_repo_name_and_branch_from_real_repo() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path();

    let repo = Repository::init(path).expect("git init");

    // Add a remote so repo_name resolves.
    repo.remote("origin", "https://github.com/ashlrai/test-fixture.git")
        .expect("add remote");

    // Make one commit so HEAD points at a branch.
    fs::write(path.join("README.md"), "test fixture\n").expect("write file");
    let mut index = repo.index().expect("index");
    index.add_path(std::path::Path::new("README.md")).expect("index add");
    index.write().expect("index write");
    let tree_oid = index.write_tree().expect("write tree");
    let tree = repo.find_tree(tree_oid).expect("find tree");
    let sig = Signature::now("test", "test@example.test").expect("signature");
    repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
        .expect("initial commit");

    let dir_str = path.to_str().expect("utf-8 path");
    let (repo_name, branch) = git_info_from_dir(dir_str);

    assert_eq!(
        repo_name.as_deref(),
        Some("ashlrai/test-fixture"),
        "remote URL should map to owner/repo"
    );
    // libgit2 default initial branch may be "master" or "main" depending
    // on init.defaultBranch — accept either, just assert it's set.
    assert!(branch.is_some(), "branch should resolve from HEAD");
    let b = branch.unwrap();
    assert!(b == "master" || b == "main", "unexpected default branch: {b}");
}

#[test]
fn returns_none_for_non_repo_dir() {
    let dir = tempdir().expect("tempdir");
    let dir_str = dir.path().to_str().expect("utf-8 path");
    let (repo_name, branch) = git_info_from_dir(dir_str);
    assert!(repo_name.is_none(), "non-repo dir should yield None");
    assert!(branch.is_none(), "non-repo dir should yield None");
}
