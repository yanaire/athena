use crate::legacy_keychain::Migration;
use anyhow::{anyhow, bail, ensure, Context as _, Result};
use serde::Serialize;
use std::{
    env,
    io::{BufRead, BufReader, Read as _, Write as _},
    num::NonZeroU16,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{App, Manager as _};

const TICK: Duration = Duration::from_millis(100);

pub struct Ready {
    pub port: NonZeroU16,
    pub token: String,
}

pub enum Notice {
    Ready(Ready),
}

pub struct Sidecar {
    host_dir: PathBuf,
    executable: PathBuf,
    workspace: PathBuf,
}

struct Process {
    child: Child,
    lifetime: Option<ChildStdin>,
}

impl Process {
    fn stop(&mut self) -> Result<()> {
        drop(self.lifetime.take());
        let deadline = Instant::now() + Duration::from_secs(9);
        while self.child.try_wait()?.is_none() {
            if Instant::now() >= deadline {
                self.child
                    .kill()
                    .context("Could not stop the Athena backend")?;
                self.child.wait()?;
                break;
            }
            thread::sleep(TICK);
        }
        Ok(())
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("Could not reap the Athena backend: {error}");
        }
    }
}

#[derive(Serialize)]
struct Bootstrap<'a> {
    token: &'a str,
}

enum Frame {
    Bootstrap,
    Import(String),
    Ready(NonZeroU16),
    Error(&'static str),
}

fn frame(bytes: &[u8]) -> Option<Frame> {
    let line = std::str::from_utf8(bytes).ok()?.strip_suffix('\n')?;
    match line {
        "ATHENA_DESKTOP_BOOTSTRAP" => Some(Frame::Bootstrap),
        "ATHENA_DESKTOP_ERROR WORKSPACE_BUSY" => Some(Frame::Error(
            "This workspace is open in another Athena host. Quit that host and reopen Athena.",
        )),
        "ATHENA_DESKTOP_ERROR VAULT_KEY_MISMATCH" => Some(Frame::Error(
            "Athena could not authenticate the existing credential vault with this key. Restore its original key and vault backup. The vault was not replaced.",
        )),
        "ATHENA_DESKTOP_ERROR VAULT_INVALID" => Some(Frame::Error(
            "The existing credential vault is damaged, unreadable, or has unsafe permissions. Athena left it unchanged. Check the vault or restore a known-good backup.",
        )),
        "ATHENA_DESKTOP_ERROR VAULT_WRITE_FAILED" => Some(Frame::Error(
            "Athena could not initialize local credential storage. Check its permissions and free disk space, then reopen Athena.",
        )),
        "ATHENA_DESKTOP_ERROR STARTUP_FAILED" => Some(Frame::Error(
            "The bundled backend could not start. Check access to the workspace and reopen Athena.",
        )),
        _ => {
            if let Some(account) = line.strip_prefix("ATHENA_DESKTOP_IMPORT ") {
                return (account.len() == 64 && account.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
                    .then(|| Frame::Import(account.to_owned()));
            }
            line.strip_prefix("ATHENA_DESKTOP_READY ")?.parse().ok().map(Frame::Ready)
        }
    }
}

fn random_hex() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow!("Could not initialize private randomness"))?;
    Ok(hex::encode(bytes))
}

fn sidecar_path() -> Result<std::ffi::OsString> {
    let inherited = env::var_os("PATH").unwrap_or_default();
    let dirs = env::split_paths(&inherited)
        .filter(|path| path.is_absolute())
        .chain([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    env::join_paths(dirs).context("Could not construct the Athena backend search path")
}

impl Sidecar {
    pub fn from_app(app: &App) -> Result<Self> {
        let home = app.path().home_dir()?;
        let workspace = match env::var_os("ATHENA_DATA_DIR").filter(|value| !value.is_empty()) {
            Some(path) => PathBuf::from(path),
            None => home.join(".athena/workspace"),
        };
        ensure!(
            workspace.is_absolute(),
            "ATHENA_DATA_DIR must be an absolute workspace path"
        );
        let host_dir = app.path().resource_dir()?.join("host");
        let binary = env::current_exe().context("Could not locate Athena.app")?;
        let executable = binary
            .parent()
            .context("Athena executable has no parent")?
            .join("athena-node");
        Ok(Self {
            host_dir,
            executable,
            workspace,
        })
    }

    pub fn run(
        &self,
        stopping: &AtomicBool,
        notify: impl FnOnce(Notice) -> Result<()>,
    ) -> Result<()> {
        let entry = self.host_dir.join("runtime/server.ts");
        ensure!(
            entry.is_file(),
            "The Athena backend is missing from this app bundle"
        );
        let mut command = Command::new(&self.executable);
        command
            .arg(entry)
            .arg("--desktop")
            .current_dir(&self.host_dir)
            .env("PATH", sidecar_path()?)
            .env("ATHENA_DATA_DIR", &self.workspace)
            .env("PI_OAUTH_CALLBACK_HOST", "127.0.0.1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Finder can inherit operator model and analysis settings; Node's code,
        // loader options and the private credentials pipe stay app-owned.
        for name in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_V8_COVERAGE",
            "NODE_DEBUG",
            "NODE_DEBUG_NATIVE",
            "ATHENA_CREDENTIAL_KEY",
            "ATHENA_AUTH_PATH",
            "ATHENA_KEYCHAIN_NONINTERACTIVE",
            "ATHENA_NATIVE_MIGRATION_EXECUTABLE",
        ] {
            command.env_remove(name);
        }
        for (name, _) in
            env::vars_os().filter(|(name, _)| name.to_string_lossy().starts_with("DYLD_"))
        {
            command.env_remove(name);
        }
        let mut child = command
            .spawn()
            .context("Could not launch the Node runtime inside Athena.app")?;
        let lifetime = child.stdin.take();
        let mut process = Process { child, lifetime };
        let stdout = process
            .child
            .stdout
            .take()
            .context("Could not read Athena readiness")?;
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("athena-readiness".into())
            .spawn(move || {
                let mut input = BufReader::new(stdout);
                let mut bytes = Vec::with_capacity(128);
                loop {
                    // Drop arbitrary application logs; never send their contents
                    // to the GUI or hold an unbounded line in memory.
                    match input.by_ref().take(128).read_until(b'\n', &mut bytes) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if let Some(value) = frame(&bytes) {
                                if tx.send(value).is_err() {
                                    break;
                                }
                            }
                            if !bytes.ends_with(b"\n") && input.skip_until(b'\n').is_err() {
                                break;
                            }
                            bytes.clear();
                        }
                    }
                }
            })?;

        let mut notify = Some(notify);
        let mut token = None;
        let mut migration = Migration::default();
        let mut deadline = Instant::now() + Duration::from_secs(60);
        while !stopping.load(Ordering::Acquire) {
            migration.respond(process.lifetime.as_mut().context("Athena private pipe is unavailable")?)?;
            match rx.recv_timeout(TICK) {
                Ok(Frame::Bootstrap) if token.is_none() && notify.is_some() => {
                    let session = random_hex()?;
                    let pipe = process
                        .lifetime
                        .as_mut()
                        .context("Athena startup pipe is unavailable")?;
                    serde_json::to_writer(&mut *pipe, &Bootstrap { token: &session })?;
                    pipe.write_all(b"\n")
                        .context("Could not initialize the Athena backend")?;
                    token = Some(session);
                    deadline = Instant::now() + Duration::from_secs(60);
                }
                Ok(Frame::Ready(port)) => {
                    let session = token.take().context("Athena readiness received before bootstrap")?;
                    let publish = notify.take().context("Duplicate Athena readiness")?;
                    publish(Notice::Ready(Ready { port, token: session }))?;
                }
                Ok(Frame::Bootstrap) => bail!("The Athena backend repeated its startup request"),
                Ok(Frame::Import(account)) if notify.is_none() => migration.request(account)?,
                Ok(Frame::Import(_)) => bail!("The Athena backend requested an import before readiness"),
                Ok(Frame::Error(message)) => bail!("{message}"),
                Err(mpsc::RecvTimeoutError::Disconnected) => bail!("The Athena backend stopped unexpectedly. Reopen Athena to restore the workspace."),
                Err(mpsc::RecvTimeoutError::Timeout) => ensure!(notify.is_none() || Instant::now() < deadline,
                    "The Athena backend did not become ready. Reopen Athena to retry."),
            }
        }
        process.stop()
    }
}
