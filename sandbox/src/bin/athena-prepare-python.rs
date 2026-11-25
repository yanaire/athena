//! Build-time tool only. This executable is never included in an Athena bundle.
//! Compile the hash-verified Python distribution with its own WASM interpreter;
//! Node's uvwasi lacks directory iteration on Windows.
use anyhow::{Result, ensure};
use std::{env, path::PathBuf};
use wasmtime::{Config, Engine, Linker, Module, Store};
use wasmtime_wasi::{I32Exit, WasiCtxBuilder, filesystem::FsPerms, p1};

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    ensure!(args.len() == 1, "Expected exactly one staged Python runtime directory");
    let root = PathBuf::from(&args[0]);
    ensure!(root.is_absolute(), "The build runtime directory must be absolute");
    let root = root.canonicalize()?;
    let python = root.join("python");
    ensure!(python.join("lib/python3.15/encodings/__init__.py").is_file(), "The pinned Python standard library is incomplete");
    let mut config = Config::new();
    config.target("pulley64")?.memory_init_cow(false).max_wasm_stack(1_048_576);
    let engine = Engine::new(&config)?;
    let module = Module::from_file(&engine, root.join("python.wasm"))?;
    let mut wasi = WasiCtxBuilder::new();
    wasi.inherit_stdout().inherit_stderr()
        .allow_tcp(false).allow_udp(false).allow_ip_name_lookup(false)
        .preopened_dir(&python, "/runtime", FsPerms::ReadWrite)?
        .initial_cwd("/runtime")
        .env("PYTHONHOME", "/runtime").env("PYTHONHASHSEED", "0")
        .args(&["python", "-B", "-s", "-P", "-m", "compileall", "-q",
            "--invalidation-mode", "checked-hash", "/runtime/lib/python3.15"]);
    let mut store = Store::new(&engine, wasi.build_p1());
    let mut linker = Linker::new(&engine);
    p1::add_to_linker_sync(&mut linker, |context| context)?;
    let start = linker.instantiate(&mut store, &module)?.get_typed_func::<(), ()>(&mut store, "_start")?;
    match start.call(&mut store, ()) {
        Ok(()) => Ok(()),
        Err(error) if error.downcast_ref::<I32Exit>().is_some_and(|exit| exit.0 == 0) => Ok(()),
        Err(error) => Err(error.context("Could not prepare the pinned offline Python standard library").into()),
    }
}
