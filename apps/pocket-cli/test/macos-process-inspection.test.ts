import { describe, expect, it } from "vitest";
import {
  ownedProfileProcesses,
  parseLsofEstablishedEndpoints,
  parseMacosProcessList,
} from "../src/macos-process-inspection.js";

describe.skipIf(process.platform !== "darwin")("macOS VS Code process inspection", () => {
  it("selects only processes containing both the exact app and profile roots", () => {
    const records = parseMacosProcessList([
      "  10   1 /pinned/Visual Studio Code.app/Contents/MacOS/Code --user-data-dir /pocket/profile",
      "  11  10 /pinned/Visual Studio Code.app/Contents/Frameworks/Helper --user-data-dir /pocket/profile",
      "  20   1 /daily/Visual Studio Code.app/Contents/MacOS/Code --user-data-dir /daily/profile",
    ].join("\n"));
    expect(ownedProfileProcesses(records, "/pocket/profile", "/pinned/Visual Studio Code.app"))
      .toEqual(records.slice(0, 2));
  });

  it("parses only lsof endpoint fields", () => {
    expect(parseLsofEstablishedEndpoints("p42\nf17\nn127.0.0.1:50000->127.0.0.1:43123\n"))
      .toEqual(["127.0.0.1:50000->127.0.0.1:43123"]);
  });
});
