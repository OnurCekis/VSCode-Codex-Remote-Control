import { describe, expect, it } from "vitest";
import {
  socketArgumentToListenUrl,
  windowsPathToSocketArgument,
} from "../src/native-socket-supervisor.js";

describe("native Windows socket address normalization", () => {
  it("maps a drive-absolute path to the CLI's candidate Unix URL forms", () => {
    const argument = windowsPathToSocketArgument("C:\\cp-p05.sock");
    expect(argument).toBe("/C:/cp-p05.sock");
    expect(socketArgumentToListenUrl(argument)).toBe("unix:///C:/cp-p05.sock");
  });

  it("rejects paths beyond the sockaddr_un limit", () => {
    expect(() => windowsPathToSocketArgument(`C:\\${"a".repeat(110)}.sock`)).toThrow("107-byte");
  });
});
