//! SQLite watermark store.
//!
//! Tracks:
//!   - Per-file byte offsets for Claude JSONL tailing
//!   - Per-repo last-seen commit hash for git polling
//!
//! Database lives at `~/.local/share/pulse/state.db`.
//!
//! `StateDb` is `Send + Sync` because we wrap the non-Send `Connection`
//! in a `Mutex`. All callers hold the lock only for the duration of a
//! single synchronous DB call — never across an `.await`.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct StateDb {
    conn: Mutex<Connection>,
}

impl StateDb {
    pub fn open() -> Result<Self> {
        let path = db_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating state dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening state db at {}", path.display()))?;
        let db = StateDb { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS file_offsets (
                path       TEXT PRIMARY KEY,
                offset     INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS git_watermarks (
                repo_path  TEXT PRIMARY KEY,
                commit_sha TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            ",
        )?;
        Ok(())
    }

    // ── File offset watermarks ─────────────────────────────────────────────

    pub fn get_file_offset(&self, path: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let result: rusqlite::Result<i64> = conn.query_row(
            "SELECT offset FROM file_offsets WHERE path = ?1",
            params![path],
            |row| row.get(0),
        );
        match result {
            Ok(n) => Ok(n as u64),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_file_offset(&self, path: &str, offset: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO file_offsets (path, offset, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(path) DO UPDATE SET offset = excluded.offset,
                                             updated_at = excluded.updated_at",
            params![path, offset as i64],
        )?;
        Ok(())
    }

    // ── Git watermarks ─────────────────────────────────────────────────────

    pub fn get_git_watermark(&self, repo_path: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let result: rusqlite::Result<String> = conn.query_row(
            "SELECT commit_sha FROM git_watermarks WHERE repo_path = ?1",
            params![repo_path],
            |row| row.get(0),
        );
        match result {
            Ok(sha) => Ok(Some(sha)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_git_watermark(&self, repo_path: &str, commit_sha: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO git_watermarks (repo_path, commit_sha, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(repo_path) DO UPDATE SET commit_sha = excluded.commit_sha,
                                                   updated_at = excluded.updated_at",
            params![repo_path, commit_sha],
        )?;
        Ok(())
    }

    /// List all tracked repos (path, sha) for the doctor command.
    pub fn list_git_watermarks(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT repo_path, commit_sha FROM git_watermarks ORDER BY repo_path",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Return the last-seen offset for all tracked files (for doctor).
    pub fn list_file_offsets(&self) -> Result<Vec<(String, u64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, offset FROM file_offsets ORDER BY path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

pub fn db_path() -> Result<PathBuf> {
    let mut p = dirs::data_local_dir()
        .context("could not determine local data directory")?;
    p.push("pulse");
    p.push("state.db");
    Ok(p)
}
