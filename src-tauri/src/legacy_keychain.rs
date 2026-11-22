use anyhow::{bail, ensure, Result};
use serde::Serialize;
use std::{io::Write, sync::mpsc, thread};

#[derive(Default)]
pub struct Migration {
    pending: Option<mpsc::Receiver<Option<String>>>,
}

#[derive(Serialize)]
struct Reply<'a> {
    migration: &'a str,
}

impl Migration {
    pub fn request(&mut self, account: String) -> Result<()> {
        ensure!(self.pending.is_none(), "A legacy credential import is already pending");
        let (send, receive) = mpsc::channel();
        thread::Builder::new()
            .name("athena-legacy-import".into())
            .spawn(move || {
                if send.send(read_key(&account)).is_err() {
                    // The desktop has already quit; no credential is published.
                }
            })?;
        self.pending = Some(receive);
        Ok(())
    }

    pub fn respond(&mut self, pipe: &mut impl Write) -> Result<()> {
        let Some(pending) = &self.pending else { return Ok(()) };
        match pending.try_recv() {
            Ok(key) => {
                self.pending = None;
                serde_json::to_writer(&mut *pipe, &Reply { migration: key.as_deref().unwrap_or("unavailable") })?;
                pipe.write_all(b"\n")?;
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => bail!("The legacy credential import stopped unexpectedly"),
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn read_key(account: &str) -> Option<String> {
    use security_framework::os::macos::passwords::find_generic_password;
    // Only the authenticated host's explicit import request reaches this read.
    // Never provision an item or expose native errors or key bytes in diagnostics.
    let (value, _) = find_generic_password(None, "Athena provider vault v1", account).ok()?;
    let key = std::str::from_utf8(value.as_ref()).ok()?;
    (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| key.to_owned())
}

#[cfg(not(target_os = "macos"))]
fn read_key(_account: &str) -> Option<String> {
    None
}
