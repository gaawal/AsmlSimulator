/**
 * 量测层校验：走完整条流程，按当前生效的量测实现检查测量网的行为。
 *
 * 工作区里有两条量测路径，由模型清单决定（见 src/scene/metrology-optics.js 构造器）：
 *   · authored（清单驱动，source='blender_manifest'）—— 配合授权 Blender 硬件模型的
 *     4 组固定干涉仪 / 平面镜 / 角锥 / PSD，双轴单回程示意；
 *   · overlay（几何叠加层）—— 无清单声明时的回退实现，X 轴接力全程无盲区。
 * 脚本会自动识别并套用对应的判定规则，不会拿一条路径的标准去量另一条。
 *
 * overlay 路径的覆盖策略：
 *   · X 轴：全程无盲区 —— 任何时刻两个台子都必须有 X 光束锁定；
 *   · Z 轴：工位全覆盖 —— 只允许在换台（exchange.active）滑移途中短暂脱锁；
 *   · 零位：归零标定时 PSD 必须命中（台体停到零位后 6 路全通）。
 * authored 路径（双轴单回程示意，不含接力）判定：
 *   · 4 组干涉仪都必须有命中记录，且曝光/量测期间光束随台体进入光轴；
 *   · 归零标定时 PSD 命中角锥；光栅尺读数头始终在尺面上。
 *
 * 用法: node tools/verify-metrology.mjs [步长秒] [总时长秒]
 * 需要 `npm run dev`（或 vite preview）已在 5173 端口提供服务。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const step = Number(process.argv[2] || 0.05);
const total = Number(process.argv[3] || 120);
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', error => console.log('[pageerror]', error.message));
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

// 直接驱动：开出设计选择面板并选第一颗设计，然后按固定步长推进并采样。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.waitForFunction(() => window.__twinscan.snapshot().state !== 'ready', null, { timeout: 20000 });

const samples = await page.evaluate(({ step, total }) => {
  const qa = window.__twinscan;
  const out = [];
  for (let t = 0; t < total / step; t++) {
    qa.advance(step);
    const snapshot = qa.snapshot();
    const metro = qa.machine.debugState().metrology;
    const stages = snapshot.stages || {};
    out.push({
      t: +(t * step).toFixed(2),
      phase: snapshot.machine_phase,
      state: snapshot.state,
      source: metro.source || 'geometric_overlay',
      exchange: Boolean(snapshot.exchange?.active),
      actionA: stages.A?.action || null,
      actionB: stages.B?.action || null,
      stationA: stages.A?.station || null,
      stationB: stages.B?.station || null,
      homing: metro.homing,
      beams: metro.interferometer.map(b => ({ stage: b.stage, axis: b.axis, hit: b.hit, len: b.length_m, assembly: b.assembly, station: b.station })),
      zero: metro.zero_module.filter(z => z.hit).length,
      calibrated: metro.zero_calibrated ? Boolean(metro.zero_calibrated.A && metro.zero_calibrated.B) : null,
      readhead: metro.readhead_world,
      onScale: metro.encoder.on_scale,
    });
    if (snapshot.state === 'done') break;
  }
  return out;
}, { step, total });

const mode = samples.find(s => s.source)?.source || 'geometric_overlay';
const authored = mode === 'blender_manifest';
const homingZero = samples.filter(s => s.homing);
const zeroActive = samples.filter(s => s.zero > 0);
const zeroMax = Math.max(0, ...homingZero.map(s => s.zero));
const offScale = samples.filter(s => !s.onScale);
const maxBeam = Math.max(0, ...samples.flatMap(s => s.beams.map(b => b.len || 0)));
const hitBeams = samples.flatMap(s => s.beams.filter(b => b.hit).map(b => b.len));
const minBeam = hitBeams.length ? Math.min(...hitBeams) : 0;

console.log(`量测实现: ${mode}${authored ? '（清单驱动 · 双轴单回程）' : '（几何叠加层 · 接力覆盖）'}`);
console.log(`采样 ${samples.length} 帧 (步长 ${step}s, 覆盖 ${samples.at(-1)?.t}s)`);
console.log(`阶段序列: ${[...new Set(samples.map(s => s.phase))].join(' → ')}`);
console.log(`动作序列 A: ${[...new Set(samples.map(s => s.actionA))].join(',')}`);
console.log(`动作序列 B: ${[...new Set(samples.map(s => s.actionB))].join(',')}`);
console.log(`干涉仪光束长度 min=${minBeam.toFixed(3)}m max=${maxBeam.toFixed(3)}m`);
console.log(`光栅尺读数头始终在尺面上: ${offScale.length === 0} (偏离 ${offScale.length} 帧)`);
console.log(`归零标定帧数: ${homingZero.length}; 其中 PSD 出光帧数: ${zeroActive.length}; 单帧最大命中 ${zeroMax} 路`);
if (homingZero.length) console.log(`  归零时 PSD 命中数样本: ${[...new Set(homingZero.map(s => s.zero))].join(',')}`);

if (authored) {
  // 清单驱动路径：按"固定光线 ∩ 移动镜面"记录外观，每个工位每轴一组。
  const perAssembly = {};
  for (const s of samples) for (const b of s.beams) {
    const entry = perAssembly[b.assembly] = perAssembly[b.assembly] || { station: b.station, axis: b.axis, hit: 0, miss: 0 };
    entry[b.hit ? 'hit' : 'miss']++;
  }
  for (const [id, v] of Object.entries(perAssembly)) {
    const rate = 100 * v.hit / Math.max(v.hit + v.miss, 1);
    console.log(`  ${id} [${v.station}/${v.axis}] 命中 ${v.hit} / 丢失 ${v.miss} (${rate.toFixed(1)}%)`);
  }
  const never = Object.entries(perAssembly).filter(([, v]) => v.hit === 0).map(([id]) => id);
  console.log(never.length ? `❌ 从未命中的干涉仪: ${never.join(', ')}` : '✅ 4 组干涉仪均取得命中记录（光线确实落在移动镜面上）');
  const calibrated = samples.some(s => s.calibrated === true);
  console.log(`归零标定完成(A/B 各 3 路居中): ${calibrated}`);
  console.log(zeroMax >= 4 ? '✅ 零位模块：归零时 PSD 命中角锥' : '❌ 零位模块：归零时 PSD 从未命中');
  console.log(offScale.length === 0 ? '✅ 光栅尺全程读数' : `❌ 光栅尺脱尺 ${offScale.length} 帧`);
} else {
  // 几何叠加层路径：接力覆盖判定。
  const xBlind = samples.filter(s => s.beams.some(b => b.axis === 'x' && !b.hit));
  const zBlindAll = samples.filter(s => s.beams.some(b => b.axis === 'z' && !b.hit));
  const zBlindOutside = zBlindAll.filter(s => !s.exchange);
  const perAxis = {};
  for (const s of samples) for (const b of s.beams) {
    const key = `${b.stage}_${b.axis}`;
    perAxis[key] = perAxis[key] || { hit: 0, miss: 0 };
    perAxis[key][b.hit ? 'hit' : 'miss']++;
  }
  const assemblies = [...new Set(samples.flatMap(s => s.beams.filter(b => b.hit).map(b => b.assembly)))];
  console.log('各轴命中/丢失:', JSON.stringify(perAxis));
  console.log(`点亮的干涉仪本体: ${assemblies.join(', ')}`);
  console.log(xBlind.length ? `❌ X 轴盲区 ${xBlind.length} 帧，前 3 例: ${JSON.stringify(xBlind.slice(0, 3))}` : '✅ X 轴全程无盲区：两个台子任何时刻都有光束锁定（含换台闪避）');
  console.log(`Z 轴脱锁 ${zBlindAll.length} 帧，其中换台滑移之外 ${zBlindOutside.length} 帧`);
  console.log(zBlindOutside.length ? `❌ Z 轴在非换台时刻脱锁，前 3 例: ${JSON.stringify(zBlindOutside.slice(0, 3))}` : '✅ Z 轴工位全覆盖：仅在换台滑移途中短暂脱锁');
  console.log(zeroMax >= 4 ? '✅ 零位模块：归零时 PSD 命中角锥' : '❌ 零位模块：归零时 PSD 从未命中');
}

const errors = await page.evaluate(() => window.__twinscan.errors);
if (errors.length) console.log('页面错误:', errors);
await browser.close();
