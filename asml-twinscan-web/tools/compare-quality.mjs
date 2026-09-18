/**
 * 画质档位 1:1 细节对比截图（不用整屏缩放，直接裁一块区域，方便肉眼比较清晰度）。
 *
 * 用法: node tools/compare-quality.mjs [标签]
 * 输出 artifacts/compare/<标签>-<档位>.png
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const label = process.argv[2] ?? 'cmp';
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'artifacts', 'compare');
mkdirSync(target, { recursive: true });

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', error => console.log('[pageerror]', error.message));

await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

// 刷新后默认是光刻机界面；设计面板由「开始光刻」触发，工具里显式打开。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.evaluate(() => {
  for (let i = 0; i < 400; i++) {
    const state = window.__twinscan.advance(0.25);
    if (state.exposing_stage && state.exposure_progress?.die_index >= 1) return;
    if (state.state === 'done') return;
  }
});
await page.evaluate(() => {
  window.__twinscan.action('follow', false);
  window.__twinscan.action('camera', 'optics');
});
await page.waitForTimeout(1500);

// 裁一块有精细结构的区域：光学模组 + 光束 + 机械细节。
const clip = { x: 430, y: 250, width: 520, height: 360 };
for (const preset of ['off', 'dlaa', 'quality', 'balanced', 'performance']) {
  await page.evaluate(preset => window.__twinscan.action('renderMode', preset), preset);
  await page.waitForTimeout(1600);
  const runtime = await page.evaluate(() => window.__twinscan.scene().render_pipeline);
  const file = resolve(target, `${label}-${preset}.png`);
  await page.screenshot({ path: file, clip });
  console.log(`${preset.padEnd(12)} 内部 ${runtime.internal.join('x')}  → ${file}`);
}

// 再拍一张整机视角（不看细节，看整体光效观感）。
await page.evaluate(() => window.__twinscan.action('renderMode', 'quality'));
await page.evaluate(() => window.__twinscan.action('camera', 'front'));
await page.waitForTimeout(1600);
await page.screenshot({ path: resolve(target, `${label}-front-quality.png`) });
console.log('整机视角 →', resolve(target, `${label}-front-quality.png`));

const errors = await page.evaluate(() => window.__twinscan.errors);
if (errors.length) console.log('页面错误:', errors);
await browser.close();
