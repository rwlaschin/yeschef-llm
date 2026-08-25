// The SANITIZER must pass an ordinary interactive chart and must run in the BROWSER.
//
// Measured 2026-08-24: two things bit here. (1) An earlier tag-balance check read `i<bars.length`
// inside <script> as markup and rejected valid charts — grading markup is the `chart_check` step's
// job now, and this file pins that a script full of `<` comparisons is not a safety defect.
// (2) The byte cap used `Buffer.byteLength`, which is Node-only: the dashboard imports this module
// as `#svg-chart`, so the throw blanked the whole results panel. Hence the no-Buffer test.
import test from "node:test";
import assert from "node:assert/strict";
import { unsafeSvgReasons, extractSvg, MAX_SVG_BYTES } from "./svgChart.js";

// Assembled from parts so the closing script tag cannot terminate this module.
const svgWithLoop = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 420" width="100%">',
  "<title>Waste</title>",
  '<g id="bars"><rect class="bar" data-v="62" fill="hsl(28,70%,45%)"/></g>',
  '<circle id="handle" cx="90" cy="390" r="10" style="touch-action:none"/>',
  "<script><![CDATA[",
  'var bars=[].slice.call(document.querySelectorAll("#bars .bar"));',
  "for(var i=0;i<bars.length;i++){ if(i<3 && 2<5){ bars[i].setAttribute(\"height\",10); } }",
  'document.getElementById("handle").addEventListener("pointerdown",function(e){',
  "  this.setPointerCapture(e.pointerId);});",
  "]]></scr" + "ipt></svg>",
].join("\n");

test("a script containing < comparisons is safe", () => {
  assert.deepEqual(unsafeSvgReasons(svgWithLoop), []);
});

test("reaching off the page is still caught", () => {
  const phoning = svgWithLoop.replace("var bars=", 'fetch("https://x.example/y");var bars=');
  assert.ok(unsafeSvgReasons(phoning).some((d) => d.includes("fetch(")));
  assert.ok(unsafeSvgReasons(svgWithLoop.replace(' xmlns="http://www.w3.org/2000/svg"', "")).includes("missing the SVG namespace"));
});

// The size check must use a universal API — `Buffer` is absent in the dashboard's bundle, and the
// throw there is not a rejected chart, it is a blank page.
test("the byte cap works without Buffer", () => {
  const savedBuffer = globalThis.Buffer;
  delete globalThis.Buffer;
  try {
    assert.deepEqual(unsafeSvgReasons(svgWithLoop), []);
    const fat = svgWithLoop.replace("<title>Waste</title>", `<title>${"w".repeat(MAX_SVG_BYTES)}</title>`);
    assert.ok(unsafeSvgReasons(fat).some((d) => d.includes("over the")));
  } finally {
    globalThis.Buffer = savedBuffer;
  }
});

test("extractSvg keeps the script intact", () => {
  assert.ok(extractSvg(`here you go:\n${svgWithLoop}`).includes("i<bars.length"));
});
