/**
 * 部件世界坐标探测：给教学叠加层的几何定位用。
 *
 * 用法: node tools/probe-layout.mjs [部件ID ...]
 * 不带参数时输出一批关键的框架/台体/量测部件坐标与包围盒。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const wanted = process.argv.slice(2);
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', error => console.log('[pageerror]', error.message));
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

const list = wanted.length ? wanted : [
  'frame', 'frame_base', 'metrology', 'metrology_bridge', 'metrology_interferometer',
  'reticle_bridge', 'reticle_scan_stage', 'reticle_grating_scale', 'reticle_grating_readhead', 'reticle_mask',
  'wafer_stage', 'wafer_stage_base', 'wafer_stage_x', 'wafer_stage_y', 'wafer_chuck', 'wafer_stage_dual_bed',
  'wafer_300mm', 'wafer_300mm_secondary', 'source', 'source_chamber', 'source_collector',
  'source_droplet_generator', 'source_laser_interface', 'vacuum_gate_valve', 'vacuum_turbo_pump',
];

const out = await page.evaluate(ids => {
  const scene = window.__twinscan.machine;
  scene.scene.updateMatrixWorld(true);
  const rows = [];
  for (const id of ids) {
    const node = scene.nodes.get(id);
    const op = scene.operations.get(id);
    if (!node) { rows.push({ id, missing: true }); continue; }
    const p = node.getWorldPosition(new node.position.constructor());
    const q = node.getWorldQuaternion(new node.quaternion.constructor());
    const meshes = scene.meshes.get(id) || [];
    let min = null, max = null;
    for (const mesh of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      min = min ? min.min(b) : b.min.clone();
      max = max ? max.max(b) : b.max.clone();
    }
    rows.push({
      id, parent: node.parent?.name || null,
      world: p.toArray().map(v => +v.toFixed(4)),
      op_local: op ? op.position.toArray().map(v => +v.toFixed(4)) : null,
      op_parent: op?.parent?.name || null,
      bbox: min ? { min: min.toArray().map(v => +v.toFixed(3)), max: max.toArray().map(v => +v.toFixed(3)) } : null,
    });
  }
  return rows;
}, list);

for (const row of out) {
  if (row.missing) { console.log(`${row.id}: 不在模型里`); continue; }
  const b = row.bbox ? ` bbox=${JSON.stringify(row.bbox.min)}~${JSON.stringify(row.bbox.max)}` : '';
  console.log(`${row.id}\n  world=${JSON.stringify(row.world)} parent=${row.parent} op_parent=${row.op_parent} op_local=${JSON.stringify(row.op_local)}${b}`);
}
await browser.close();
