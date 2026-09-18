/** 验证各画质档位：切换 off / performance / dlaa 并截图，检查无报错。 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(import.meta.dirname, '..', 'artifacts', 'presets');
mkdirSync(target, { recursive: true });
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath: existsSync(localChrome) ? localChrome : undefined, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)); });

await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });
// 刷新后默认是光刻机界面；设计面板由「开始光刻」触发，工具里显式打开。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.evaluate(() => {
  for (let i = 0; i < 160; i++) {
    const state = window.__twinscan.advance(0.5);
    if (state.exposing_stage) return;
  }
});
await page.evaluate(() => window.__twinscan.action('camera', 'optics'));

for (const preset of ['off', 'performance', 'dlaa', 'balanced']) {
  await page.evaluate(p => window.__twinscan.action('renderMode', p), preset);
  await page.waitForTimeout(1000);
  const info = await page.evaluate(() => window.__twinscan.machine.debugState().render_pipeline);
  const file = resolve(target, `preset-${preset}.png`);
  await page.screenshot({ path: file });
  console.log(preset, JSON.stringify({ internal: info.internal, output: info.output, temporal: info.temporal }), '->', file);
}
await browser.close();
