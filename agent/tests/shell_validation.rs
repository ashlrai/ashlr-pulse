//! Integration test for the shell-hook tailer's privacy floor.
//! The hook is supposed to strip argv before writing to the buffer,
//! but the tailer enforces it again as defense-in-depth: any `cmd`
//! containing whitespace or shell metachars is rejected. Without
//! this test, a future hook regression that lets argv slip through
//! would silently send prompt content over the wire.

use pulse_agent::shell::{classify_cmd, ShellCmdStatus, RECOGNIZED_CLIS};

#[test]
fn recognized_bare_clis_are_accepted() {
    for cli in RECOGNIZED_CLIS {
        assert_eq!(
            classify_cmd(cli),
            ShellCmdStatus::Ok,
            "{cli} should be accepted",
        );
    }
}

#[test]
fn cmd_containing_whitespace_is_rejected_as_metachar() {
    // The hook ought never to write this, but if it ever did, the
    // tailer must drop it on the floor — not emit a span containing
    // the prompt.
    assert_eq!(
        classify_cmd("claude write me a function"),
        ShellCmdStatus::MetaChar,
    );
}

#[test]
fn cmd_with_shell_metachars_is_rejected() {
    let cases = [
        "claude;ls",        // command chaining
        "claude|cat",       // pipe
        "claude&",          // background
        "claude`whoami`",   // backtick exec
        "claude$(id)",      // command substitution
        "claude<file",      // redirect
        "claude>out",       // redirect
        "claude(",          // subshell
        "claude\"x\"",      // quoted argv
    ];
    for c in cases {
        assert_eq!(
            classify_cmd(c),
            ShellCmdStatus::MetaChar,
            "{c} should be rejected as containing a metachar",
        );
    }
}

#[test]
fn unrecognized_bare_command_is_silently_skipped() {
    // Not on RECOGNIZED_CLIS, but no metachars — should be NotRecognized,
    // not MetaChar. (This distinction matters: NotRecognized is a benign
    // skip; MetaChar logs a warning because it indicates a privacy issue.)
    assert_eq!(classify_cmd("ls"),         ShellCmdStatus::NotRecognized);
    assert_eq!(classify_cmd("vim"),        ShellCmdStatus::NotRecognized);
    assert_eq!(classify_cmd("python"),     ShellCmdStatus::NotRecognized);
}
