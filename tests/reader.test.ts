import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../web/src/components/Reader";

describe("Reader wikilinks", () => {
  test("renders a resolved wikilink as a clickable safe anchor", () => {
    const html = renderMarkdown("See [[wiki/example|Example]]", ["wiki/example.md"]);
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-wikipath="wiki/example.md"');
    expect(html).toContain(">Example</a>");
    expect(html).not.toContain("&lt;a");
  });

  test("resolves full, wiki-relative, and leaf-only targets", () => {
    const pages = ["wiki/context/example.md"];
    for (const target of ["wiki/context/example", "context/example.md", "example"]) {
      expect(renderMarkdown(`[[${target}]]`, pages)).toContain(
        'data-wikipath="wiki/context/example.md"',
      );
    }
  });

  test("escapes markdown HTML and hostile wikilink labels", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script> [[wiki/example|<img src=x onerror=alert(2)>]]',
      ["wiki/example.md"],
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });
});
