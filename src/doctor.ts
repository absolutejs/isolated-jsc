#!/usr/bin/env bun

import { resolveJscLibrary } from "./ffi/resolver";

const lines: string[] = [];

const print = (line = ""): void => {
  lines.push(line);
};

const bunVersion = Bun.version;
const probe = resolveJscLibrary();

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
