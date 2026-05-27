/**
 * Find a usable `libJavaScriptCore` on the host. The v2 FFI backend depends
 * on the public JSC C API (`JSContextGroupCreate`, `JSEvaluateScript`, etc.)
 * being reachable at runtime; we probe well-known install paths in priority
 * order and return the first hit. If nothing matches we return `null` so
 * callers can fall back to the v1 Worker backend.
 *
 * Install hints by platform (printed in {@link JscLibraryNotFoundError}):
 *
 * - **macOS**: the system framework at
 *   `/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore` is
 *   present on every Mac. No install needed.
 * - **Linux**: `sudo apt install libjavascriptcoregtk-4.1-0` on Debian / Ubuntu,
 *   `sudo dnf install webkit2gtk4.1` on Fedora. Bonus: if Playwright is
 *   installed locally we accept its bundled libJSC under
 *   `~/.cache/ms-playwright/webkit-<NNN>/minibrowser-gtk/lib/libjavascriptcoregtk-6.0.so.1`.
 * - **Windows**: no realistic system JSC. The Worker backend is the only
 *   supported v2 backend on Windows.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

export type JscFlavor = "macos-framework" | "gtk-4.1" | "gtk-6.0";

/** Tagged result so callers can distinguish "library found at /path" from
 * "no library found, here's why" without exception control flow. */
export type JscLibraryProbe =
  | { kind: "found"; path: string; flavor: JscFlavor }
  | { kind: "not-found"; checked: string[]; installHint: string };

const MACOS_FRAMEWORK =
  "/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore";

/** Linux probes in priority order. Bare names get tried first because the
 * loader searches LD_LIBRARY_PATH + /etc/ld.so.cache. Absolute paths cover
 * the common apt locations directly. */
const LINUX_CANDIDATES: Array<{ path: string; flavor: JscFlavor }> = [
  { path: "libjavascriptcoregtk-4.1.so.0", flavor: "gtk-4.1" },
  {
    path: "/usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0",
    flavor: "gtk-4.1",
  },
  {
    path: "/usr/lib/aarch64-linux-gnu/libjavascriptcoregtk-4.1.so.0",
    flavor: "gtk-4.1",
  },
  { path: "libjavascriptcoregtk-6.0.so.1", flavor: "gtk-6.0" },
  {
    path: "/usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-6.0.so.1",
    flavor: "gtk-6.0",
  },
  {
    path: "/usr/lib/aarch64-linux-gnu/libjavascriptcoregtk-6.0.so.1",
    flavor: "gtk-6.0",
  },
];

const linuxInstallHint =
  "Install libJavaScriptCore: `sudo apt install libjavascriptcoregtk-4.1-0` (Debian/Ubuntu), " +
  "`sudo dnf install webkit2gtk4.1` (Fedora). " +
  "Or fall back to the Worker backend with `backend: 'worker'` in the IsolateOptions.";

const macosInstallHint =
  "macOS framework not found at " +
  MACOS_FRAMEWORK +
  " — expected on every Mac. Did SIP move it? " +
  "Or fall back to the Worker backend with `backend: 'worker'` in the IsolateOptions.";

const windowsInstallHint =
  "No system JavaScriptCore on Windows; the FFI backend is unsupported here. " +
  "Use `backend: 'worker'` (the Worker backend is the default on Windows).";

/** Walk Playwright's cache for any bundled libJSC. Lets developers who already
 * have Playwright installed pick up FFI for free without an apt install. */
const probePlaywrightCache = (): string | null => {
  const cacheDir = join(homedir(), ".cache", "ms-playwright");
  try {
    if (!existsSync(cacheDir)) return null;
    // ms-playwright/webkit-NNNN/minibrowser-gtk/lib/libjavascriptcoregtk-6.0.so.1
    for (const entry of readdirSync(cacheDir)) {
      if (!entry.startsWith("webkit-")) continue;
      const candidate = join(
        cacheDir,
        entry,
        "minibrowser-gtk",
        "lib",
        "libjavascriptcoregtk-6.0.so.1",
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // permission denied / stat error — treat as miss
  }
  return null;
};

/** Try to open a library via Bun's FFI dlopen with a single throw-away
 * symbol so we know it's reachable. Returns true on success.
 *
 * Important: we do NOT call `lib.close()` on the probe handle. Some libJSC
 * builds — notably the WebKitGTK 6.0 that ships with Playwright — segfault
 * Bun when the library is unloaded (likely a static-destructor ordering
 * issue in JSC's globals). The dlopen itself is safe; the library stays
 * loaded for the process lifetime, which matches how the actual FFI
 * backend uses it anyway. */
const tryDlopen = (path: string): boolean => {
  try {
    dlopen(path, {
      JSContextGroupCreate: { args: [], returns: FFIType.pointer },
    });
    return true;
  } catch (error) {
    if (process.env.ISOJSC_DEBUG === "1") {
      // eslint-disable-next-line no-console
      console.error(`[isolated-jsc] tryDlopen(${path}) failed:`, error);
    }
    return false;
  }
};

export const resolveJscLibrary = (): JscLibraryProbe => {
  const checked: string[] = [];

  if (process.platform === "darwin") {
    checked.push(MACOS_FRAMEWORK);
    if (existsSync(MACOS_FRAMEWORK) && tryDlopen(MACOS_FRAMEWORK)) {
      return {
        kind: "found",
        path: MACOS_FRAMEWORK,
        flavor: "macos-framework",
      };
    }
    return { kind: "not-found", checked, installHint: macosInstallHint };
  }

  if (process.platform === "linux") {
    for (const candidate of LINUX_CANDIDATES) {
      checked.push(candidate.path);
      // For absolute paths skip dlopen if the file isn't there (faster, no
      // ELF read attempt). For bare names go straight to dlopen — the
      // dynamic loader will search its own paths.
      if (candidate.path.startsWith("/") && !existsSync(candidate.path)) {
        continue;
      }
      if (tryDlopen(candidate.path)) {
        return {
          kind: "found",
          path: candidate.path,
          flavor: candidate.flavor,
        };
      }
    }
    const playwrightLib = probePlaywrightCache();
    if (playwrightLib !== null) {
      checked.push(playwrightLib);
      if (tryDlopen(playwrightLib)) {
        return { kind: "found", path: playwrightLib, flavor: "gtk-6.0" };
      }
    }
    return { kind: "not-found", checked, installHint: linuxInstallHint };
  }

  return { kind: "not-found", checked, installHint: windowsInstallHint };
};

export class JscLibraryNotFoundError extends Error {
  readonly checked: string[];
  readonly installHint: string;
  constructor(checked: string[], installHint: string) {
    super(
      `Could not find libJavaScriptCore. Probed: ${checked.join(", ")}. ${installHint}`,
    );
    this.name = "JscLibraryNotFoundError";
    this.checked = checked;
    this.installHint = installHint;
  }
}
