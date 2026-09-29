import { describe, expect, it } from "vitest";
import { descendants, parsePosixProcessList, phase3BrowserName } from "../src/phase-3-platform-runtime.js";

describe("Phase 3 platform runtime", () => {
  it("selects an installed Edge channel on Windows and pinned Playwright Chromium elsewhere", () => {
    expect(phase3BrowserName("win32", undefined)).toBe("msedge");
    expect(phase3BrowserName("darwin", undefined)).toBe("chromium");
    expect(phase3BrowserName("linux", "chrome")).toBe("chrome");
    expect(() => phase3BrowserName("darwin", "bad browser")).toThrow(/invalid browser name/u);
  });

  it("parses POSIX process output and follows descendants without OS-specific commands", () => {
    const records = parsePosixProcessList(`  10  1 node mcp.js\n  11 10 chromium --user-data-dir=/tmp/pocket\n  12 11 chromium helper\n  20  1 unrelated\n`);
    expect(records).toHaveLength(4);
    expect(descendants(records, 10).map((entry) => entry.ProcessId)).toEqual([11, 12]);
  });
});
