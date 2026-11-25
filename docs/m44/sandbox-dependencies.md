# M4.4 sandbox dependency supplement

`libproc` 0.15.0 (MIT) is the new normal dependency on the Apple Silicon target. It uses the existing `libc` and `errno` dependencies. `cargo tree --offline --locked --target aarch64-apple-darwin --edges normal,build --manifest-path sandbox/Cargo.toml` distinguishes this runtime edge from the `bindgen` build edge. Consult `sandbox/Cargo.lock` for the exact registry sources and archive checksums.

| Additional locked package | Declared license |
| --- | --- |
| libproc 0.15.0 | MIT |
| bindgen 0.73.2 | BSD-3-Clause |
| cexpr 0.6.0, minimal-lexical 0.2.1 | MIT / Apache-2.0 |
| clang-sys 1.9.1 | Apache-2.0 |
| glob 0.3.4 | MIT or Apache-2.0 |
| libloading 0.8.9 | ISC |
| nom 7.1.3 | MIT |
| regex 1.13.2, regex-automata 0.4.19, regex-syntax 0.8.12 | MIT or Apache-2.0 |
| aho-corasick 1.1.5 | Unlicense or MIT |

This inventory is based on the locked graph and crate manifest declarations; it does not identify every linked binary component. In particular, the macOS bindings used by `libproc` are generated at build time from an Xcode SDK. Verify the archive notices and clarify redistribution of generated SDK bindings before publishing the compiled helper. The source candidate does not contain the generated SDK bindings or the compiled helper.

## Windows x64 memory accounting delta

The cross-platform candidate adds `memory-stats = 1.2.0` only under `cfg(target_os = "windows")` in `sandbox/Cargo.toml`. Its published manifest selects `windows-sys` 0.52 with the `Win32_Foundation`, `Win32_System`, `Win32_System_ProcessStatus` and `Win32_System_Threading` features. The exact lock resolves that edge to `windows-sys` 0.52.0 → `windows-targets` 0.52.6 → `windows_x86_64_msvc` 0.52.6 for the ordinary `x86_64-pc-windows-msvc` configuration, without `windows_raw_dylib`. The `memory-stats` edge is not selected by either native macOS build; their existing `libproc` dependency remains.

On 2026-11-25, each archive below was downloaded from the official registry and matched byte-for-byte against its SHA-256 in `sandbox/Cargo.lock`. The original manifests and license files were inspected. This is a scoped archive and target-condition check, not a statement that the complete Windows linker output has been inventoried.

| Locked package | Declared license | Verified registry archive SHA-256 |
| --- | --- | --- |
| [memory-stats 1.2.0](https://static.crates.io/crates/memory-stats/memory-stats-1.2.0.crate) | MIT OR Apache-2.0 | `c73f5c649995a115e1a0220b35e4df0a1294500477f97a91d0660fb5abeb574a` |
| [windows-sys 0.52.0](https://static.crates.io/crates/windows-sys/windows-sys-0.52.0.crate) | MIT OR Apache-2.0 | `282be5f36a8ce781fad8c8ae18fa3f9beff57ec1b52cb3de0789201425d9a33d` |
| [windows-targets 0.52.6](https://static.crates.io/crates/windows-targets/windows-targets-0.52.6.crate) | MIT OR Apache-2.0 | `9b724f72796e036ab90c1021d4780d4d3d648aca59e491e6b98e725b84e99973` |
| [windows_x86_64_msvc 0.52.6](https://static.crates.io/crates/windows_x86_64_msvc/windows_x86_64_msvc-0.52.6.crate) | MIT OR Apache-2.0 | `589f6da84c646204747d1270a2a5661ea66ed1cced2631d546fdfb155959f9ec` |

The source tree now retains unmodified copies of both licenses supplied by each archive:

- `memory-stats`: [MIT](notices/windows-sandbox/memory-stats-1.2.0-LICENSE-MIT.txt) and [Apache-2.0](notices/windows-sandbox/memory-stats-1.2.0-LICENSE-APACHE.txt), copyright 2022 Arc'blroth.
- The three Windows crates: [MIT](notices/windows-sandbox/windows-rs-0.52-LICENSE-MIT.txt) and [Apache-2.0](notices/windows-sandbox/windows-rs-0.52-LICENSE-APACHE.txt), copyright Microsoft Corporation. The corresponding files in all three exact archives are byte-identical, so one copy of each is retained with an explicit per-archive mapping.

The [notice provenance record](notices/windows-sandbox/provenance.json) includes original archive paths, copied filenames, byte lengths and notice SHA-256 values. Each of these four archives contains its two license files and no separate `NOTICE` or `COPYING` file. Other Windows architecture packages present in the all-target lock are not evidence that those architectures ship in this x64 candidate. The pre-existing `windows-sys` 0.61.2 edge is separate from this new 0.52.0 dependency and is not covered by this delta.

To record the actual resolved normal/build dependency graph on the build runner, use:

```sh
cargo tree --locked --target x86_64-pc-windows-msvc --edges normal,build --manifest-path sandbox/Cargo.toml
```

These copies are review material in the repository. Their presence does not establish that the current installer includes a complete notice pack, clear the earlier npm/MPL/SDK findings, or satisfy release acceptance. Preserve the corresponding notices with any eventual distribution of the affected components and review the exact final payload under the existing release process.
