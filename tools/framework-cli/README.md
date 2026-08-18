# train-me framework CLI

Lint and package [train-me](https://github.com/sylm54/train-me) frameworks.

```
bun add -d github:sylm54/train-me/tools/framework-cli
bunx tm-framework lint      # validate everything; exit 1 on errors
bunx tm-framework package   # build dist/<id>.zip + dist/index.json
```

- **lint** — manifest/config/onboarding schemas, the full feature grammar
  (routines, habits, tasks, store), referenced XML scripts with
  `<include>` cycle detection, task-template references, prompt
  embed/include/link resolution, token estimates.
- **package** — zips the framework (flat root: `manifest.json`,
  `onboarding.json`, `base/` + parts) and writes the update-channel
  `index.json` (`version`/`url`/`sha256`/`description`/`min_app_version`).

The validators mirror train-me's canonical Rust parser
(`src-tauri/src/format.rs`, spec: `FORMAT.md`); the in-app
`validate_files` tool remains authoritative. Requires [Bun](https://bun.sh).
