fn main() {
    // Embed the pocket-tts model configs (one YAML per checkpoint) so the
    // binary carries the whole checkpoint catalog without shipping data files.
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let configs_dir = manifest_dir.join("pocket_tts").join("configs");
    println!("cargo:rerun-if-changed={}", configs_dir.display());
    let mut configs: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(&configs_dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", configs_dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "yaml"))
        .map(|path| {
            (
                path.file_stem().unwrap().to_string_lossy().into_owned(),
                path,
            )
        })
        .collect();
    configs.sort();
    use std::fmt::Write as _;
    let mut out = String::from(
        "/// The pocket-tts model configs, by checkpoint id.\npub const CONFIGS: &[(&str, &str)] = &[\n",
    );
    for (name, path) in &configs {
        println!("cargo:rerun-if-changed={}", path.display());
        writeln!(out, "    ({name:?}, include_str!({:?})),", path).unwrap();
    }
    out.push_str("];\n");
    let out_path =
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("pocket_tts_configs.rs");
    std::fs::write(out_path, out).unwrap();

    tauri_build::build()
}
