#!/usr/bin/env bun

import { resolveJscLibrary } from "./ffi/resolver";

const lines: string[] = [];
const json = Bun.argv.includes("--json");

const print = (line = ""): void => {
  lines.push(line);
};

const bunVersion = Bun.version;
const probe = resolveJscLibrary();
const report =
  probe.kind === "found"
    ? {
        arch: process.arch,
        bun: bunVersion,
        defaultBackend: "ffi" as const,
        ffi: {
          available: true,
          flavor: probe.flavor,
          path: probe.path,
        },
        platform: process.platform,
        status: "ok" as const,
      }
    : {
        arch: process.arch,
        bun: bunVersion,
        defaultBackend: "worker" as const,
        ffi: {
          available: false,
          checked: probe.checked,
          installHint: probe.installHint,
        },
        platform: process.platform,
        status: "worker-fallback-available" as const,
      };

if (json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

print("@absolutejs/isolated-jsc doctor");
print("");
print(`Bun: ${bunVersion}`);
print(`Platform: ${process.platform}`);
print(`Arch: ${process.arch}`);
print("");

if (probe.kind === "found") {
  print("FFI backend: available");
  print(`JavaScriptCore flavor: ${probe.flavor}`);
  print(`JavaScriptCore path: ${probe.path}`);
  print("Default backend: ffi");
  print("");
  print("Status: ok");
} else {
  print("FFI backend: unavailable");
  print("Default backend: worker");
  print("");
  print("Checked paths:");
  if (probe.checked.length === 0) {
    print("- none for this platform");
  } else {
    for (const path of probe.checked) print(`- ${path}`);
  }
  print("");
  print("Install hint:");
  print(probe.installHint);
  print("");
  print("Status: worker fallback available");
}

console.log(lines.join("\n"));
