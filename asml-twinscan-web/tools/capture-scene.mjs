/**
 * 光效对比截图工具。
 *
 * 用法: node tools/capture-scene.mjs <输出子目录> [标签]
 * 需要先跑起 `npm run dev`（127.0.0.1:5173）。会依次截取：
 *   front      整机正视（无光路）
 *   optics     投影光学特写（曝光光路可见）
 *   stage      双台特写（曝光光路可见）
 * 截图写入 artifacts/<输出子目录>/。
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [outDir = 'lighting', label = ''] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'artifacts', outDir);
mkdirSync(target, { recursive: true });

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('console', msg => { if (msg.type() === 'error') console.log('[console]', msg.text()); });
page.on('pageerror', error => console.log('[pageerror]', error.message));

await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });
await page.waitForTimeout(1200);

// 选一张设计，跑批开始，让曝光光路与走线出现
// 刷新后默认是光刻机界面；设计面板由「开始光刻」触发，工具里显式打开。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.evaluate(() => {
  for (let i = 0; i < 200; i++) {
    const state = window.__twinscan.advance(0.5);
    if (state.exposing_stage && state.exposure_progress?.die_index >= 2) return;
    if (state.state === 'done') return;
  }
});
await page.waitForTimeout(400);

const shot = async (name, camera) => {
  await page.evaluate(camera => window.__twinscan.action('camera', camera), camera);
  await page.waitForTimeout(900);
  const file = resolve(target, `${label ? `${label}-` : ''}${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
};
await shot('front', 'front');
await shot('optics', 'optics');
await shot('stage', 'stage');

const diagnostics = await page.evaluate(() => ({ scene: window.__twinscan.scene(), errors: window.__twinscan.errors }));
console.log('renderer:', JSON.stringify(diagnostics.scene.renderer));
console.log('pipeline:', JSON.stringify(diagnostics.scene.render_pipeline ?? null));
if (diagnostics.errors.length) console.log('errors:', diagnostics.errors);
await browser.close();
