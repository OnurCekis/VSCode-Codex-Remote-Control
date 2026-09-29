import { describe, expect, it } from "vitest";
import { redactForReport } from "../src/protocol-log.js";

describe("protocol log redaction", () => {
  it("redacts explicit secrets, secret-bearing fields, bearer values, and the home path", () => {
    const result = redactForReport({
      authorization: "Bearer secret-value",
      nested: {
        text: "Bearer second-secret",
        command: `read C:\\Users\\onurc\\file using secret-value`,
      },
    }, ["secret-value"]);

    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("second-secret");
    expect(result).toMatchObject({ authorization: "<REDACTED>" });
  });
});
