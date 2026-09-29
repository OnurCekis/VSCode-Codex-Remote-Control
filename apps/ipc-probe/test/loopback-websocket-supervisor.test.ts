import { describe, expect, it } from "vitest";
import { parseLsofListenerAddresses } from "../src/loopback-websocket-supervisor.js";

describe("loopback WebSocket platform inspection", () => {
  it("extracts IPv4 and IPv6 listener addresses from lsof field output", () => {
    expect(parseLsofListenerAddresses([
      "p123",
      "n127.0.0.1:43123",
      "n[::1]:43124",
      "",
    ].join("\n"))).toEqual(["127.0.0.1", "::1"]);
  });

  it("does not treat process metadata as listener evidence", () => {
    expect(parseLsofListenerAddresses("p123\ncnode\nf17\n")).toEqual([]);
  });
});
