// Exports the diagram in each docs/architecture/*.html as a standalone .svg next to it,
// so the README can embed it (GitHub renders SVG images, not HTML pages).
//
//   node docs/architecture/export-svg.mjs
//
// The HTML stays the source of truth: it has the numbered legend and the theme toggle.
// Re-run this after editing a diagram. The SVG carries its own styles, arrow markers and
// background, and follows the viewer's light/dark preference via prefers-color-scheme.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} html @param {RegExp} re @param {string} what */
function grab(html, re, what) {
  const m = html.match(re);
  if (!m || m[1] === undefined) throw new Error(`could not find ${what}`);
  return m[1];
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(join(DIR, file), "utf8");
  const style = grab(html, /<style>([\s\S]*?)<\/style>/, "<style>");
  const defs = grab(html, /<defs>([\s\S]*?)<\/defs>/, "marker <defs>");
  const diagram = grab(html, /<div class="diagram">\s*(<svg[\s\S]*?<\/svg>)\s*<\/div>/, "diagram <svg>");
  const viewBox = grab(diagram, /viewBox="([^"]+)"/, "viewBox");
  const [, , width, height] = viewBox.split(/\s+/);
  const inner = grab(diagram, /<svg[^>]*>([\s\S]*)<\/svg>/, "diagram contents");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">
<style>${style}
  .export-bg { fill: var(--surface); }
</style>
<defs>${defs}</defs>
<rect class="export-bg" x="0" y="0" width="${width}" height="${height}" rx="10"/>
${inner.trim()}
</svg>
`;
  const out = file.replace(/\.html$/, ".svg");
  writeFileSync(join(DIR, out), svg);
  console.log(`${file} -> ${out}`);
}
