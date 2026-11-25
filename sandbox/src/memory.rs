use anyhow::{Context, Result, ensure};
use std::{process, thread, time::Duration};

pub const LIMIT_BYTES: u64 = 768 * 1_048_576;
pub const SAMPLE_MS: u64 = 10;
pub const EXIT_CODE: u8 = 126;

#[cfg(target_os = "macos")]
fn usage() -> Result<u64> {
    use libproc::pid_rusage::{RUsageInfoV2, pidrusage};
    let pid = i32::try_from(process::id())?;
    let info = pidrusage::<RUsageInfoV2>(pid).map_err(anyhow::Error::msg)?;
    // Include compressed/private accounting as well as resident mappings.
    Ok(info.ri_phys_footprint.max(info.ri_resident_size))
}

#[cfg(target_os = "linux")]
fn linux_usage(status: &str) -> Result<u64> {
    let rss = status.lines().find_map(|line| line.strip_prefix("VmRSS:"))
        .context("Missing native memory accounting")?;
    let mut fields = rss.split_whitespace();
    let kib: u64 = fields.next().context("Missing RSS value")?.parse()?;
    ensure!(fields.next() == Some("kB"), "Invalid RSS units");
    kib.checked_mul(1024).context("RSS overflow")
}

#[cfg(target_os = "linux")]
fn sampler() -> Result<impl FnMut() -> Result<u64> + Send> {
    use std::io::{Read, Seek};
    // Keep the accounting descriptor open: a guest reaching its descriptor
    // bound must not prevent the independent watchdog from sampling itself.
    let mut file = std::fs::File::open("/proc/self/status")?;
    let mut status = String::with_capacity(4096);
    Ok(move || {
        file.rewind()?;
        status.clear();
        file.read_to_string(&mut status)?;
        linux_usage(&status)
    })
}

#[cfg(all(target_os = "linux", test))]
fn usage() -> Result<u64> { sampler()?() }

#[cfg(not(target_os = "linux"))]
fn sampler() -> Result<impl FnMut() -> Result<u64> + Send> { Ok(usage) }

#[cfg(target_os = "windows")]
fn usage() -> Result<u64> {
    let info = memory_stats::memory_stats().context("Missing Windows process memory accounting")?;
    // On Windows these fields are working set and private pagefile usage.
    // Count committed private pages even when the OS pages them out.
    Ok(u64::try_from(info.physical_mem.max(info.virtual_mem))?)
}

// This independent thread covers compilation and host calls as well as guest
// execution. It is sampled enforcement, not an allocation-time OS memory quota.
pub fn start(limit: u64) -> Result<()> {
    let mut measure = sampler()?;
    ensure!(measure()? <= limit, "Native helper memory limit exceeded at startup");
    thread::Builder::new().name("athena-memory".into()).spawn(move || loop {
        match measure() {
            Ok(bytes) if bytes <= limit => {}
            // Do not write to guest pipes here: a blocked pipe must not prevent
            // termination. The parent translates the reserved native exit code.
            Ok(_) | Err(_) => process::exit(i32::from(EXIT_CODE)),
        }
        thread::sleep(Duration::from_millis(SAMPLE_MS));
    }).context("Could not start native memory watchdog")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn watchdog_worker() -> Result<()> {
        let Some(mode) = std::env::var_os("ATHENA_MEMORY_TEST") else { return Ok(()) };
        let baseline = usage()?;
        let allowance = if mode == "over" { 8 } else { 64 };
        start(baseline + allowance * 1_048_576)?;
        let payload = vec![0x5a_u8; 32 * 1_048_576];
        std::hint::black_box(&payload);
        thread::sleep(Duration::from_millis(200));
        Ok(())
    }

    #[test]
    fn watchdog_stops_native_allocation_and_allows_bounded_work() -> Result<()> {
        for (mode, expected) in [("over", i32::from(EXIT_CODE)), ("within", 0)] {
            let result = Command::new(std::env::current_exe()?)
                .args(["--exact", "memory::tests::watchdog_worker", "--nocapture"])
                .env_clear().env("ATHENA_MEMORY_TEST", mode).output()?;
            assert_eq!(result.status.code(), Some(expected), "{mode}: {result:?}");
        }
        Ok(())
    }
}
