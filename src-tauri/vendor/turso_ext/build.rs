fn main() {
    // Original upstream used `cfg!(target_os = "windows")`, but inside a build
    // script that macro is evaluated against the *host* platform, not the
    // *target*. When cross-compiling from Windows to Android this wrongly
    // emitted `cargo:rustc-link-lib=advapi32` and the Android linker failed
    // with "unable to find library -ladvapi32". Cargo sets `CARGO_CFG_TARGET_OS`
    // to the target OS; check that instead.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
