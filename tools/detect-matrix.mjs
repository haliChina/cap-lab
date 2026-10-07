// Feed four probe vectors through Cap's own detectAutomation().
// The vector is CLIENT-supplied JSON — this is what the server actually sees.
import { pathToFileURL } from "node:url";

const CORE = process.env.CAP_CORE || "../cap/standalone/node_modules/capjs-core/src/detect.js";
const { detectAutomation } = await import(pathToFileURL(CORE).href);

const FONT_STACKS = 18;

// (a) a typical desktop Chrome profile vector (values are representative)
const real = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  productSub: "20030107",
  webdriver: false,
  oscpu: "__undefined",
  deviceMemory: undefined,
  uaDataPresent: false,
  uaData: null,
  plugins: { length: 0 },
  pdfViewerEnabled: false,
  engine: { hasMozInnerScreenX: false, hasChrome: false },
  screen: { width: 2560, height: 1440 },
  outerWH: [1512, 945],
  innerWH: [1512, 860],
  isExtended: null,
  fontWidths: [1080.18, 1304.21, 1345.32, 987.26, 1326.02, 1304.21, 1304.21, 1326.02, 1089.85, 1326.02, 1304.21, 1304.21, 1304.21, 1304.21, 1304.21, 1089.85, 1326.02, 1326.02],
  tamper: { getParameterWebGL: true, toDataURL: true, getImageData: true, permissionsQuery: true, fnToString: true },
};

// (b) vanilla headless Chrome, no evasion
const headless = {
  ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36",
  productSub: "20030107",
  webdriver: true,
  oscpu: "__undefined",
  uaDataPresent: true,
  uaData: { mobile: false, brands: ["Chromium;v=153", "HeadlessChrome;v=153", "Not?A_Brand;v=24"] },
  plugins: { length: 5 },
  engine: { hasMozInnerScreenX: false, hasChrome: true },
  screen: { width: 1280, height: 720 },
  outerWH: [1280, 720],
  innerWH: [1280, 660],
  isExtended: false,
  fontWidths: Array(FONT_STACKS).fill(756.45), // identical + whole-ish
  tamper: { getParameterWebGL: true, toDataURL: true, getImageData: true, permissionsQuery: true, fnToString: true },
};

// (c) "hardened" headless: stealth patches applied
const hardened = {
  ...headless,
  ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  webdriver: undefined,
  uaDataPresent: true,
  uaData: { mobile: false, brands: ["Chromium;v=153", "Google Chrome;v=153", "Not?A_Brand;v=24"] },
  outerWH: [1280, 1040],
  innerWH: [1280, 913],
  fontWidths: [756.45, 1021.33, 1010.12, 1088.77, 1265.4, 1021.33, 1010.12, 1088.77, 1290.51, 1265.4, 1021.33, 1010.12, 1088.77, 1265.4, 1290.51, 1021.33, 1010.12, 1290.51],
  tamper: { getParameterWebGL: true, toDataURL: true, getImageData: true, permissionsQuery: true, fnToString: true },
};

// (d) invented by a script that never ran a browser at all
const fabricated = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  productSub: "20030107",
  webdriver: false,
  oscpu: "__undefined",
  uaDataPresent: true,
  uaData: { mobile: false, brands: ["Chromium;v=152", "Google Chrome;v=152", "Not?A_Brand;v=24"] },
  plugins: { length: 5 },
  engine: { hasMozInnerScreenX: false, hasChrome: true },
  screen: { width: 2560, height: 1440 },
  outerWH: [1512, 945],
  innerWH: [1512, 860],
  isExtended: false,
  fontWidths: [1021.44, 1413.27, 1398.11, 1502.66, 1703.9, 1413.27, 1398.11, 1502.66, 1731.5, 1703.9, 1413.27, 1398.11, 1502.66, 1703.9, 1731.5, 1413.27, 1398.11, 1731.5],
  tamper: { getParameterWebGL: true, toDataURL: true, getImageData: true, permissionsQuery: true, fnToString: true },
};

for (const [name, v] of [["real-browser", real], ["headless-default", headless], ["headless-hardened", hardened], ["fabricated-in-node", fabricated]]) {
  const r = detectAutomation(v, { fontStackCount: FONT_STACKS });
  console.log(`\n== ${name}: pass=${r.pass} blockedBy=[${r.blockedBy}] riskFlags=[${r.riskFlags}]`);
  for (const c of r.checks) {
    console.log(`   ${c.passed ? "ok  " : "FAIL"} ${c.id.padEnd(20)} ${c.detail}`);
  }
}