import { expect, test } from "@playwright/test";

test("task descriptions render Mermaid math and prose styles while rejecting unsafe content", async ({ page }) => {
  const companyResponse = await page.request.post("/api/companies", { data: { name: "Markdown compatibility" } });
  expect(companyResponse.ok()).toBe(true);
  const company = await companyResponse.json();
  const issueResponse = await page.request.post(`/api/companies/${company.id}/issues`, {
    data: {
      title: "Markdown dependency compatibility",
      description: [
        "## Compatibility heading",
        "",
        "A paragraph with **strong text** and [a safe link](https://example.com).",
        "",
        "1. First list entry",
        "2. Second list entry",
        "",
        "> A quoted compatibility note.",
        "",
        "```mermaid",
        "flowchart LR",
        '  A["$$\\frac{1}{2} + x^2$$"] --> B["Safe result"]',
        '  click B "javascript:window.__markdownUnsafe = true"',
        "```",
        "",
        '<script>window.__markdownUnsafe = true</script>',
        '<img src="x" onerror="window.__markdownUnsafe = true">',
      ].join("\n"),
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json();
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  const markdown = page.locator(".paperclip-markdown").filter({ has: page.getByRole("heading", { name: "Compatibility heading", exact: true }) }).first();
  await expect(markdown.getByRole("heading", { name: "Compatibility heading" })).toBeVisible();
  await expect(markdown.locator(".paperclip-mermaid svg")).toBeVisible();
  await expect(markdown.locator(".paperclip-mermaid math")).toHaveCount(1);
  await expect(markdown.locator("math mfrac")).toBeVisible();
  await expect(markdown.locator("math msup")).toBeVisible();
  const mathLayout = await markdown.locator("math").evaluate((element) => {
    const fraction = element.querySelector("mfrac")!;
    const power = element.querySelector("msup")!;
    return {
      numeratorTop: fraction.children[0]!.getBoundingClientRect().top,
      denominatorTop: fraction.children[1]!.getBoundingClientRect().top,
      baseTop: power.children[0]!.getBoundingClientRect().top,
      exponentTop: power.children[1]!.getBoundingClientRect().top,
    };
  });
  expect(mathLayout.denominatorTop).toBeGreaterThan(mathLayout.numeratorTop);
  expect(mathLayout.exponentTop).toBeLessThan(mathLayout.baseTop);
  await expect(markdown.locator(".paperclip-mermaid-status-error")).toHaveCount(0);
  await expect(markdown.locator("ol")).toHaveCSS("list-style-type", "decimal");
  await expect(markdown.locator("strong")).toHaveCSS("font-weight", "600");
  await expect(markdown.getByRole("link", { name: "a safe link" })).toHaveCSS("text-decoration-line", "underline");
  await expect(markdown.locator("blockquote")).toHaveCSS("font-style", "italic");
  // These pseudo-elements come from the typography plugin's parsed selectors,
  // rather than Paperclip's own heading/list style overrides.
  expect(await markdown.locator("blockquote p").evaluate((element) => ({
    before: getComputedStyle(element, "::before").content,
    after: getComputedStyle(element, "::after").content,
  }))).toEqual({ before: "open-quote", after: "close-quote" });
  const typography = await markdown.evaluate((element) => ({
    headingSize: parseFloat(getComputedStyle(element.querySelector("h2")!).fontSize),
    bodySize: parseFloat(getComputedStyle(element.querySelector("p")!).fontSize),
  }));
  expect(typography.headingSize).toBeGreaterThan(typography.bodySize);
  await expect(markdown.locator('script, [onerror], a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "__markdownUnsafe"))).toBeUndefined();
});
