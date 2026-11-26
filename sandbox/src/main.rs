use anyhow::{Context, Result, bail, ensure};
#[cfg(unix)]
use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
use std::{
    collections::BTreeSet,
    env,
    io::{self, Read, Write},
    path::Path,
    process, thread,
    sync::mpsc::{self, RecvTimeoutError},
    time::{Duration, Instant},
};
use wasmtime::{AsContextMut, Caller, Config, Engine, Extern, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{I32Exit, WasiCtxBuilder, filesystem::FsPerms, p1::{self, WasiP1Ctx, wasi_snapshot_preview1}};
use wasmtime_wasi::p1::{types, wasi_snapshot_preview1::WasiSnapshotPreview1};

mod memory;

const STARTUP_MS: u64 = 30_000;
const PREVIEW1: &str = "wasi_snapshot_preview1";
const NOTCAPABLE: i32 = 76;
const OUTPUTS_FD: i32 = 5;
const MAX_BYTES: u64 = 1_048_576;
const MEMORY_BYTES: usize = 192 * 1_048_576;
const MAX_NAME: usize = 96;
const MAX_OUTPUTS: usize = 8;
const MAX_DESCRIPTORS: usize = 96;

struct Guest {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
    outputs: Vec<String>,
    descriptors: BTreeSet<i32>,
    stdio: BTreeSet<i32>,
}

#[cfg(unix)]
fn restrict(resource: Resource, cap: u64) -> Result<()> {
    let prior = getrlimit(resource);
    let bound = prior.maximum.map_or(cap, |maximum| maximum.min(cap));
    let current = prior.current.map_or(bound, |current| current.min(bound));
    setrlimit(resource, Rlimit { current: Some(current), maximum: Some(bound) })?;
    Ok(())
}

fn native_limits(hard_deadline_ms: u64) -> Result<()> {
    #[cfg(unix)]
    {
        restrict(Resource::Core, 0)?;
        restrict(Resource::Fsize, MAX_BYTES)?;
        restrict(Resource::Nofile, MAX_DESCRIPTORS as u64)?;
        restrict(Resource::Cpu, hard_deadline_ms.div_ceil(1000))?;
    }
    // Windows has no rlimit. Guest writes/growth and descriptor allocation are
    // bounded in the WASI ABI below, and the independent wall/epoch and process
    // memory watchdogs cover compilation, host calls and guest execution.
    #[cfg(not(unix))]
    let _ = hard_deadline_ms;
    Ok(())
}

fn write_length(caller: &mut Caller<'_, Guest>, pointer: i32, count: i32) -> Option<u64> {
    let (Ok(start), Ok(count)) = (usize::try_from(pointer), usize::try_from(count)) else { return None };
    if count > 1024 { return None; }
    let Some(Extern::Memory(memory)) = caller.get_export("memory") else { return None };
    let bytes = memory.data(&*caller).get(start..start.checked_add(count.checked_mul(8)?)?)?;
    bytes.chunks_exact(8).try_fold(0_u64, |sum, item| {
        let size = u32::from_le_bytes(item[4..8].try_into().ok()?);
        sum.checked_add(u64::from(size)).filter(|total| *total <= MAX_BYTES)
    })
}

fn bounded_write(caller: &mut Caller<'_, Guest>, fd: i32, pointer: i32, count: i32, offset: Option<u64>) -> Result<(), types::Error> {
    // Shadowed ABI calls must reset the pinned adapter's per-hostcall budget,
    // exactly as Wiggle's normal generated linker does. Reusing the previous
    // call's remainder would reject valid writes and eventually starve stdout.
    let fuel = caller.as_context_mut().hostcall_fuel();
    caller.data_mut().wasi.set_hostcall_fuel(fuel);
    // Only original stdio descriptors use the parent's pipe limit. Closing a
    // stdio descriptor may let path_open reuse its number for a regular file.
    if caller.data().stdio.contains(&fd) { return Ok(()); }
    let Some(length) = write_length(caller, pointer, count) else { return Err(types::Errno::Fbig.into()) };
    let Some(Extern::Memory(memory)) = caller.get_export("memory") else { return Err(types::Errno::Fbig.into()) };
    let (bytes, guest) = memory.data_and_store_mut(caller);
    let mut memory = wiggle::GuestMemory::Unshared(bytes);
    let fd = types::Fd::from(fd);
    let flags = wasmtime_wasi::runtime::in_tokio(guest.wasi.fd_fdstat_get(&mut memory, fd))?;
    let position = if flags.fs_flags.contains(types::Fdflags::APPEND) {
        wasmtime_wasi::runtime::in_tokio(guest.wasi.fd_filestat_get(&mut memory, fd))?.size
    } else { match offset { Some(offset) => offset, None => guest.wasi.fd_tell(&mut memory, fd)? } };
    if position.checked_add(length).is_some_and(|end| end <= MAX_BYTES) { Ok(()) }
    else { Err(types::Errno::Fbig.into()) }
}

fn name(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= MAX_NAME && !value.contains("..")
        && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn output_allowed(caller: &mut Caller<'_, Guest>, pointer: i32, size: i32) -> bool {
    let (Ok(start), Ok(size)) = (usize::try_from(pointer), usize::try_from(size)) else {
        return false;
    };
    if size == 0 || size > MAX_NAME {
        return false;
    }
    let mut buffer = [0; MAX_NAME];
    if !matches!(caller.get_export("memory"), Some(Extern::Memory(memory)) if memory.read(&*caller, start, &mut buffer[..size]).is_ok()) {
        return false;
    }
    caller.data().outputs.iter().any(|name| name.as_bytes() == &buffer[..size])
}

fn add_wasi(linker: &mut Linker<Guest>) -> Result<()> {
    p1::add_to_linker_sync(linker, |guest| &mut guest.wasi)?;
    linker.allow_shadowing(true);
    // Deny namespace changes, including remapping the capability's descriptor.
    // A file may be created by path_open only with an exact declared basename.
    linker.func_wrap(PREVIEW1, "path_create_directory", |_: i32, _: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "path_remove_directory", |_: i32, _: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "path_unlink_file", |_: i32, _: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "path_rename", |_: i32, _: i32, _: i32, _: i32, _: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "path_symlink", |_: i32, _: i32, _: i32, _: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "path_link", |_: i32, _: i32, _: i32, _: i32, _: i32, _: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "path_filestat_set_times", |_: i32, _: i32, _: i32, _: i32, _: i64, _: i64, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "fd_renumber", |_: i32, _: i32| NOTCAPABLE)?;
    linker.func_wrap(PREVIEW1, "fd_close", |mut caller: Caller<'_, Guest>, fd: i32| -> wasmtime::Result<i32> {
        if fd == OUTPUTS_FD { return Ok(NOTCAPABLE); }
        let Some(Extern::Memory(memory)) = caller.get_export("memory") else { wasmtime::bail!("Expected guest memory"); };
        let (bytes, guest) = memory.data_and_store_mut(&mut caller);
        let mut memory = wiggle::GuestMemory::Unshared(bytes);
        let status = wasmtime_wasi::runtime::in_tokio(wasi_snapshot_preview1::fd_close(&mut guest.wasi, &mut memory, fd))?;
        if status == 0 { guest.descriptors.remove(&fd); guest.stdio.remove(&fd); }
        Ok(status)
    })?;
    linker.func_wrap(PREVIEW1, "fd_write", |mut caller: Caller<'_, Guest>, fd: i32, iovs: i32, count: i32, result: i32| -> wasmtime::Result<i32> {
        // Lower recoverable WASI errors just as the generated ABI does. Only
        // an actual host trap may escape this callback and terminate the guest.
        if let Err(error) = bounded_write(&mut caller, fd, iovs, count, None) { return Ok(error.downcast()? as i32); }
        let Some(Extern::Memory(memory)) = caller.get_export("memory") else { wasmtime::bail!("Expected guest memory"); };
        let (bytes, guest) = memory.data_and_store_mut(&mut caller);
        let mut memory = wiggle::GuestMemory::Unshared(bytes);
        wasmtime_wasi::runtime::in_tokio(wasi_snapshot_preview1::fd_write(&mut guest.wasi, &mut memory, fd, iovs, count, result))
    })?;
    linker.func_wrap(PREVIEW1, "fd_pwrite", |mut caller: Caller<'_, Guest>, fd: i32, iovs: i32, count: i32, offset: i64, result: i32| -> wasmtime::Result<i32> {
        let Ok(offset) = u64::try_from(offset) else { return Ok(types::Errno::Fbig as i32); };
        if let Err(error) = bounded_write(&mut caller, fd, iovs, count, Some(offset)) { return Ok(error.downcast()? as i32); }
        let Some(Extern::Memory(memory)) = caller.get_export("memory") else { wasmtime::bail!("Expected guest memory"); };
        let (bytes, guest) = memory.data_and_store_mut(&mut caller);
        let mut memory = wiggle::GuestMemory::Unshared(bytes);
        wasmtime_wasi::runtime::in_tokio(wasi_snapshot_preview1::fd_pwrite(&mut guest.wasi, &mut memory, fd, iovs, count, offset as i64, result))
    })?;
    linker.func_wrap(PREVIEW1, "fd_filestat_set_size", |mut caller: Caller<'_, Guest>, fd: i32, size: i64| -> wasmtime::Result<i32> {
        if !u64::try_from(size).is_ok_and(|size| size <= MAX_BYTES) { return Ok(types::Errno::Fbig as i32); }
        let Some(Extern::Memory(memory)) = caller.get_export("memory") else { wasmtime::bail!("Expected guest memory"); };
        let (bytes, guest) = memory.data_and_store_mut(&mut caller);
        let mut memory = wiggle::GuestMemory::Unshared(bytes);
        wasmtime_wasi::runtime::in_tokio(wasi_snapshot_preview1::fd_filestat_set_size(&mut guest.wasi, &mut memory, fd, size))
    })?;
    linker.func_wrap(PREVIEW1, "fd_allocate", |mut caller: Caller<'_, Guest>, fd: i32, offset: i64, len: i64| -> wasmtime::Result<i32> {
        if !(u64::try_from(offset).ok().zip(u64::try_from(len).ok())
            .and_then(|(offset, len)| offset.checked_add(len)).is_some_and(|end| end <= MAX_BYTES)) {
            return Ok(types::Errno::Fbig as i32);
        }
        let Some(Extern::Memory(memory)) = caller.get_export("memory") else { wasmtime::bail!("Expected guest memory"); };
        let (bytes, guest) = memory.data_and_store_mut(&mut caller);
        let mut memory = wiggle::GuestMemory::Unshared(bytes);
        wasi_snapshot_preview1::fd_allocate(&mut guest.wasi, &mut memory, fd, offset, len)
    })?;
    linker.func_wrap(PREVIEW1, "path_open", move |mut caller: Caller<'_, Guest>, fd: i32,
        lookup: i32, path: i32, len: i32, flags: i32, rights: i64, inheriting: i64,
        fd_flags: i32, result: i32| -> wasmtime::Result<i32> {
        if fd == OUTPUTS_FD && !output_allowed(&mut caller, path, len) {
            return Ok(NOTCAPABLE);
        }
        if caller.data().descriptors.len() >= MAX_DESCRIPTORS { return Ok(types::Errno::Mfile as i32); }
        // Calling a linked host Func directly loses the original Wasm caller.
        // Invoke the pinned Preview 1 ABI with the original instance memory.
        let Some(Extern::Memory(memory)) = caller.get_export("memory") else { wasmtime::bail!("Expected guest memory"); };
        let (bytes, guest) = memory.data_and_store_mut(&mut caller);
        let mut memory = wiggle::GuestMemory::Unshared(bytes);
        use wasi_snapshot_preview1::WasiSnapshotPreview1;
        guest.wasi.set_hostcall_fuel(1024 * 1024);
        let status = wasmtime_wasi::runtime::in_tokio(wasi_snapshot_preview1::path_open(
            &mut guest.wasi, &mut memory, fd, lookup, path, len, flags, rights, inheriting, fd_flags, result,
        ))?;
        if status == 0 {
            let opened: types::Fd = memory.read(wiggle::GuestPtr::new(result as u32))?;
            guest.descriptors.insert(i32::from(opened));
        }
        Ok(status)
    })?;
    linker.allow_shadowing(false);
    Ok(())
}

fn run(args: &[String]) -> Result<u8> {
    let [root, language, raw_deadline, script, tail @ ..] = args else { bail!("Invalid sandbox request") };
    let timeout: u64 = raw_deadline.parse().context("Invalid sandbox deadline")?;
    ensure!((1..=30_000).contains(&timeout) && name(script), "Invalid sandbox job");
    let sep = tail.iter().position(|value| value == "--").context("Missing sandbox argument boundary")?;
    let (outputs, rest) = tail.split_at(sep);
    let script_args = &rest[1..];
    ensure!(outputs.len() <= MAX_OUTPUTS && outputs.iter().all(|s| name(s)), "Invalid output names");
    let python = match language.as_str() {
        "python" => true,
        "node" => false,
        _ => bail!("Unsupported sandbox language"),
    };

    // RLIMIT_CPU counts compilation and guest execution cumulatively. Use
    // the same total budget as the hard wall deadline; the guest epoch below
    // starts at readiness and still enforces the requested execution timeout.
    let hard_deadline_ms = STARTUP_MS + timeout;
    native_limits(hard_deadline_ms)?;
    memory::start(memory::LIMIT_BYTES)?;

    // This is a host-only liveness pipe. The guest has an empty stdin instead.
    thread::Builder::new().name("athena-parent".into()).spawn(|| {
        let mut byte = [0];
        let _event = io::stdin().lock().read(&mut byte);
        process::exit(125);
    })?;
    // Independent deadlines also cover blocking host calls, which the guest
    // epoch cannot interrupt. Startup never consumes or extends the guest budget.
    let (guest_ready, readiness) = mpsc::channel::<Instant>();
    let startup_deadline = Instant::now() + Duration::from_millis(STARTUP_MS);
    thread::Builder::new().name("athena-deadline".into()).spawn(move || {
        match readiness.recv_timeout(startup_deadline.saturating_duration_since(Instant::now())) {
            Ok(started) if started <= startup_deadline => {
                let deadline = started + Duration::from_millis(timeout);
                thread::sleep(deadline.saturating_duration_since(Instant::now()));
                process::exit(124);
            }
            Ok(_) | Err(RecvTimeoutError::Timeout) => process::exit(124),
            // Preserve an initialization error's own exit code.
            Err(RecvTimeoutError::Disconnected) => {}
        }
    })?;

    let root = Path::new(root);
    let mut config = Config::new();
    // Interpret guest bytecode so this helper needs no executable-memory entitlement.
    config.target("pulley64")?;
    // The Python initialization image exceeds RLIMIT_FSIZE on Linux memfds.
    config.memory_init_cow(false);
    config.epoch_interruption(true).max_wasm_stack(1_048_576);
    let engine = Engine::new(&config)?;
    let mut wasi = WasiCtxBuilder::new();
    let script = format!("/workspace/{script}");
    wasi.inherit_stdout().inherit_stderr()
        .allow_tcp(false).allow_udp(false).allow_ip_name_lookup(false)
        .initial_cwd("/workspace")
        // Preview 1 assigns these preopens in order at descriptors 3, 4, 5.
        // The same read-only directory is available via `.` for relative opens.
        .preopened_dir("workspace", ".", FsPerms::ReadOnly)?
        .preopened_dir("workspace", "/workspace", FsPerms::ReadOnly)?
        .preopened_dir("outputs", "/outputs", FsPerms::ReadWrite)?;
    let module = if python {
        wasi.preopened_dir(root.join("python"), "/runtime", FsPerms::ReadOnly)?
            .env("PYTHONHOME", "/runtime").args(&["python", "-B", "-s", "-P", &script]);
        root.join("python.wasm")
    } else {
        wasi.args(&["qjs", "--module", &script]);
        root.join("qjs.wasm")
    };
    wasi.args(script_args);
    let limits = StoreLimitsBuilder::new().memory_size(MEMORY_BYTES).memories(1)
        .instances(1).tables(1).table_elements(20_000).trap_on_grow_failure(true).build();
    let mut store = Store::new(&engine, Guest { wasi: wasi.build_p1(), limits, outputs: outputs.to_vec(),
        descriptors: (0..if python { 7 } else { 6 }).collect(), stdio: (0..3).collect() });
    store.limiter(|guest| &mut guest.limits);
    store.set_epoch_deadline(1);
    let module = Module::from_file(&engine, module)?;
    let mut linker = Linker::new(&engine);
    add_wasi(&mut linker)?;
    let start = linker.instantiate(&mut store, &module)?.get_typed_func::<(), ()>(&mut store, "_start")?;
    guest_ready.send(Instant::now()).context("Sandbox deadline watchdog stopped")?;
    thread::Builder::new().name("athena-guest-deadline".into()).spawn(move || {
        thread::sleep(Duration::from_millis(timeout));
        engine.increment_epoch();
    })?;
    // The first stdout line precedes any guest code and is consumed by the host.
    io::stdout().lock().write_all(b"ATHENA_SANDBOX_READY\n")?;
    match start.call(&mut store, ()) {
        Ok(()) => Ok(0),
        Err(error) if error.downcast_ref::<wasmtime::Trap>() == Some(&wasmtime::Trap::Interrupt) => Ok(124),
        Err(error) => {
            if let Some(exit) = error.downcast_ref::<I32Exit>() {
                // Reserve lifecycle and memory-watchdog codes for the host.
                return Ok(u8::try_from(exit.0).ok().filter(|code| ![124, 125, memory::EXIT_CODE].contains(code)).unwrap_or(1));
            }
            eprintln!("Analysis stopped: {error:#}");
            Ok(1)
        }
    }
}

fn main() -> process::ExitCode {
    let args: Vec<_> = env::args().skip(1).collect();
    if args == ["--version"] {
        println!("athena-sandbox/1 wasmtime/{}", env!("ATHENA_WASMTIME_VERSION"));
        return process::ExitCode::SUCCESS;
    }
    match run(&args) {
        Ok(code) => process::ExitCode::from(code),
        Err(error) => {
            eprintln!("Sandbox initialization failed: {error:#}");
            process::ExitCode::from(1)
        }
    }
}
