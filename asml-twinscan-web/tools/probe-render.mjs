/**
 * 画质基线校验：界面不应再出现画质档位开关；渲染必须恒定走原生高画质路径；
 * 光照 / 阴影参数要落在调优后的取值上。
 *
 * 用法: node tools/probe-render.mjs
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', error => console.log('[pageerror]', error.message));
const warnings = [];
page.on('console', msg => {
  if (msg.type() === 'error') console.log('[console]', msg.text().slice(0, 200));
  else if (msg.type() === 'warning') warnings.push(msg.text().slice(0, 160));
});
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });
await page.evaluate(() => window.__twinscan.advance(0.05));

const controls = await page.evaluate(() => ({
  renderRow: Boolean(document.querySelector('.render-row')),
  renderInfo: Boolean(document.querySelector('.render-info')),
  renderSelect: Boolean(document.querySelector('[name=renderMode]')),
}));
const leftover = Object.entries(controls).filter(([, present]) => present).map(([key]) => key);
console.log(leftover.length ? `❌ 界面仍残留画质开关: ${leftover.join(', ')}` : '✅ 界面已无画质档位开关');

const render = await page.evaluate(() => window.__twinscan.machine.debugState().render_pipeline);
console.log(`档位: ${render.preset} (${render.label}) | MSAA: ${render.samples}× | 时间重建: ${render.temporal}`);
console.log(`内部分辨率: ${render.internal.join('×')} → 输出 ${render.output.join('×')} | bloom: ${JSON.stringify(render.bloom)}`);
if (render.preset !== 'off' || render.temporal) console.log('❌ 默认档位不是原生高画质');
if (!render.samples) console.log('❌ 原生路径未启用多重采样');

const light = await page.evaluate(() => {
  const m = window.__twinscan.machine;
  const r = m.renderer;
  return {
    exposure: r.toneMappingExposure,
    pixel_ratio: Number(r.getPixelRatio().toFixed(2)),
    shadow_type: r.shadowMap.type,
    shadow_map: m.key.shadow.mapSize.x,
    hemi: m.ambient.intensity,
    key: m.key.intensity,
    key_color: `#${m.key.color.getHexString()}`,
    normal_bias: m.key.shadow.normalBias,
    bias: m.key.shadow.bias,
    radius: m.key.shadow.radius,
    fill: m.fill.intensity,
    rim: m.rim.intensity,
    env_intensity: m.scene.environmentIntensity,
    max_samples_hw: r.capabilities.maxSamples,
    max_texture_hw: r.capabilities.maxTextureSize,
  };
});
console.log('光照 / 阴影:', JSON.stringify(light));

const camera = await page.evaluate(() => {
  const m = window.__twinscan.machine;
  return { preset: m.cameraPreset, position: m.camera.position.toArray().map(v => +v.toFixed(2)) };
});
console.log('相机:', JSON.stringify(camera));

const errors = await page.evaluate(() => window.__twinscan.errors);
console.log(errors.length ? `❌ 页面错误: ${JSON.stringify(errors.slice(0, 3))}` : '✅ 无页面错误');
const shadowWarnings = warnings.filter(text => /shadow/i.test(text));
console.log(shadowWarnings.length ? `❌ 阴影相关警告: ${JSON.stringify(shadowWarnings)}` : '✅ 无阴影相关警告');
if (warnings.length) console.log(`（其他控制台警告 ${warnings.length} 条）`, JSON.stringify(warnings.slice(0, 2)));
await browser.close();
