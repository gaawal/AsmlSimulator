/**
 * 部件包围盒探测：为量测叠加层（镜面、光学头、零位模块）选址。
 *
 * 用法: node tools/probe-bounds.mjs
 * 需要 `npm run dev` 已启动。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', error => console.log('[pageerror]', error.message));
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(() => {
  const machine = window.__twinscan.machine;
  machine.scene.updateMatrixWorld(true);
  const fmt = box => (box.isEmpty() ? null : {
    min: box.min.toArray().map(v => +v.toFixed(3)),
    max: box.max.toArray().map(v => +v.toFixed(3)),
  });
  const ids = [
    'machine', 'wafer_stage', 'wafer_stage_base', 'wafer_stage_x', 'wafer_stage_y',
    'wafer_stage_dual_bed', 'wafer_chuck', 'wafer_300mm', 'reticle_bridge',
    'reticle_scan_stage', 'reticle_grating_scale', 'reticle_grating_readhead', 'metrology',
  ];
  const rows = {};
  for (const id of ids) rows[id] = fmt(machine._bounds(id));
  const meshCounts = {};
  for (const id of ids) meshCounts[id] = (machine.parts.get(id)?.mesh_nodes || []).length;
  return { rows, meshCounts };
});

console.log('=== 包围盒 ===');
for (const [id, box] of Object.entries(out.rows)) {
  console.log(`${id}\n   ${box ? `${JSON.stringify(box.min)} ~ ${JSON.stringify(box.max)}` : '(空)'}  meshes=${out.meshCounts[id]}`);
}
console.log('=== 交并 ===');
await browser.close();
