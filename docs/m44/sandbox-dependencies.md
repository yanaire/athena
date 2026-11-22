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
