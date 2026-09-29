import { describe, expect, it } from "vitest";
import { startFixture } from "../src/phase-3-browser-copresence.js";

describe("Phase 3 deterministic browser fixture", () => {
  it("serves its exact marker and separates HTTP failure from transport failure", async () => {
    const fixture = await startFixture("fixture-marker");
    try {
      const page = await fetch(fixture.baseUrl);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("<title>Codex Pocket Browser Fixture</title>");
      expect(html).toContain("BEFORE_fixture-marker");
      expect(html).toContain("AFTER_fixture-marker");
      expect(html).toContain("POCKET_CONSOLE_fixture-marker");
      expect(html).toContain("Change deterministic state");
      expect(html).toContain("/api/http-500");
      expect(html).toContain("/api/network-failure");

      const httpFailure = await fetch(`${fixture.baseUrl}/api/http-500`);
      expect(httpFailure.status).toBe(500);
      await expect(fetch(`${fixture.baseUrl}/api/network-failure`)).rejects.toThrow();

      const replacement = await fetch(`${fixture.baseUrl}/replacement`);
      expect(await replacement.text()).toContain("REPLACED_fixture-marker");
    } finally {
      await fixture.close();
      await fixture.close();
    }
    await expect(fetch(fixture.baseUrl)).rejects.toThrow();
  });

  it("rejects markers that could make the local fixture nondeterministic", async () => {
    await expect(startFixture("bad marker<script>")).rejects.toThrow(/unsupported characters/u);
  });
});
