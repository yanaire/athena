fn locked_version(package: &str) -> &'static str {
    let name = format!("name = \"{package}\"");
    let mut versions = include_str!("Cargo.lock")
        .split("[[package]]")
        .filter_map(|entry| {
            let mut lines = entry.trim_start().lines();
            if lines.next()? == name {
                return lines
                    .next()?
                    .strip_prefix("version = \"")?
                    .strip_suffix('"');
            }
            None
        });
    let version = versions
        .next()
        .unwrap_or_else(|| panic!("{package} is missing from Cargo.lock"));
    assert!(
        versions.next().is_none(),
        "{package} has multiple locked versions"
    );
    version
}

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let version = locked_version("wasmtime");
    assert_eq!(locked_version("wasmtime-wasi"), version);
    assert_eq!(locked_version("wiggle"), version);
    println!("cargo:rustc-env=ATHENA_WASMTIME_VERSION={version}");
}
