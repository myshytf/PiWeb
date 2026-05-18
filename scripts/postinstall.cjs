#!/usr/bin/env node

if (process.env.CI || process.env.PI_WEB_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

const lines = [
  "",
  "PiWeb installed.",
  "Run `pi-web setup` to configure port, login credentials, and optional public tunnel.",
  "Quick start: `pi-web --cwd /path/to/project`",
  "",
];

console.log(lines.join("\n"));
