#!/usr/bin/env bun
/**
 * train-me framework CLI — lint and package train-me frameworks.
 *
 * Usage:
 *   bunx tm-framework lint [framework-dir]     Validate everything (exit 1 on errors)
 *   bunx tm-framework package [framework-dir]  Build dist/<id>.zip + dist/index.json
 *
 * `lint` runs `package`-equivalent manifest checks plus the full feature
 * grammar (routines/habits/tasks/store), onboarding.json, script include
 * trees, and prompt embed/link checks.
 */

import { lint } from "./lint";
import { pack } from "./package";

const [command, dir] = process.argv.slice(2);

switch (command) {
  case "lint":
    process.exit(lint(dir ?? "."));
  case "package":
  case "pack":
    process.exit(pack(dir ?? "."));
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(`train-me framework CLI

Usage:
  tm-framework lint [dir]     Validate the framework at <dir> (default: cwd)
  tm-framework package [dir]  Build dist/<id>.zip + dist/index.json`);
    process.exit(0);
  default:
    console.error(`Unknown command: ${command}\nRun with --help for usage.`);
    process.exit(2);
}
