/** Pure educational circuit data. Ported from Godot ChipDesigns.
 * Randomness uses Mulberry32 in the web edition rather than Godot's PCG.
 * Seeds reproduce web runs; a given seed is not bit-identical across engines.
 */
export const DIE_ROWS = 5;
export const DIE_COLUMNS = 5;
export const DIE_COUNT = 25;
export const FAMILY_POOL = ['soc', 'array', 'bus', 'radial', 'grid'];
export const DESIGNS = [
  { id: 'flagship_soc', name: '旗舰手机 SoC', class_zh: '3nm 级 · 高密度逻辑', hint: '密集互连网格 + 四个大核区：扫描最密，最容易被套刻误差打坏', family: 'soc', accent: [.55,.86,.98], fatigue: 1 },
  { id: 'ai_accelerator', name: 'AI 加速芯片', class_zh: '算力阵列 · 近存 HBM 通道', hint: '规则算力阵列 + 两条 HBM 总线：热点集中，段数最多', family: 'array', accent: [.72,.62,1], fatigue: 1 },
  { id: 'auto_drive', name: '智驾/车载芯片', class_zh: '车规 · 长走线可靠性', hint: '少量长总线 + 冗余焊盘：走线稀疏，容错最好', family: 'bus', accent: [1,.78,.42], fatigue: .6 },
  { id: 'baseband_rf', name: '通信基站射频', class_zh: '射频 · 放射状匹配网络', hint: '放射状馈线与同心环：轨迹是放射图案，最容易看出方向差异', family: 'radial', accent: [.45,.95,.78], fatigue: .8 },
  { id: 'power_grid', name: '电源管理芯片', class_zh: 'BCD · 大电流栅格', hint: '粗栅格 + 大焊盘：走线最粗，扫描最慢但最稳', family: 'grid', accent: [1,.62,.62], fatigue: .5 },
];
export const DEFECT_LABELS = { none: '图形正确', overlay: '套刻偏移超出窗口', broken: '走线断开（显影残留）', dose: '剂量偏差 · 线宽失控' };
const TYPE_POOL = ['旗舰手机 SoC','AI 算力芯片','智驾域控芯片','基站射频芯片','数据中心 GPU','游戏掌机 SoC','HBM 存储控制','PC 主控芯片','物联网 MCU','边缘推理芯片','显示驱动芯片','Wi-Fi 连接芯片'];
const VENDOR_POOL = ['星辰半导体','沧龙微电子','极光科技','昆仑芯造','曙光集成','云枢芯联','玄芯微纳','天工先进封装'];
const NODE_POOL = ['28nm','22nm','16nm','12nm','7nm','6nm','5nm','4nm','3nm','2nm'];
const ACCENTS = [[.55,.86,.98],[.72,.62,1],[1,.78,.42],[.45,.95,.78],[1,.62,.62],[.62,.72,1],[.95,.85,.45],[.62,1,.72]];
const FAMILY_LABELS = { soc: '高密度逻辑版图', array: '算力阵列版图', bus: '长走线总线版图', radial: '放射状匹配版图', grid: '大电流栅格版图' };
const FAMILY_HINTS = { soc: '密集互连网格 + 大核区：扫描最密', array: '规则算力瓦片阵列：段数多、热点集中', bus: '少量长总线：走线稀疏，容错最好', radial: '放射馈线与同心环：轨迹方向差异最明显', grid: '粗栅格大焊盘：线最粗、扫描最稳' };
const FATIGUE = { soc: 1, array: 1, bus: .6, radial: .8, grid: .5 };
const clone = (value) => structuredClone(value);
const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, float: (a,b) => a+(b-a)*next(), int: (a,b) => a+Math.floor(next()*(b-a+1)), pick: a => a[Math.floor(next()*a.length)] };
}
export function find(id) { return clone(DESIGNS.find(d => d.id === id) ?? DESIGNS[0]); }
export function die_center(index) { return [index % DIE_COLUMNS - 2, Math.floor(index / DIE_COLUMNS) - 2]; }
export function catalogue(seed = Date.now(), count = 16) {
  const rng = random(seed), result = [], names = new Set();
  for (let guard=0; result.length<count && guard<count*40; guard++) {
    const family=rng.pick(FAMILY_POOL), type=rng.pick(TYPE_POOL), vendor=rng.pick(VENDOR_POOL), node=rng.pick(NODE_POOL);
    const name = `${type} · ${vendor} X${rng.int(1,9)}${rng.int(1,9)}0`;
    if (names.has(name)) continue;
    names.add(name);
    const design_seed = rng.int(1,999999999);
    result.push({id:`gen_${design_seed}`,name,type,vendor,node,class_zh:`${node} 制程 · ${FAMILY_LABELS[family]}`,hint:FAMILY_HINTS[family],family,seed:design_seed,accent:[...ACCENTS[result.length%ACCENTS.length]],fatigue:FATIGUE[family]*rng.float(.85,1.15)});
  }
  return result;
}
const segment = (a,b,w) => ({a,b,w});
function square(center, half, width, sink) {
  const corners = [[-half,-half],[half,-half],[half,half],[-half,half]].map(p=>[p[0]+center[0],p[1]+center[1]]);
  for(let i=0;i<4;i++) sink.push(segment(corners[i],corners[(i+1)%4],width));
}
export function segments_for(design) {
  if (typeof design === 'string') design = find(design);
  if (Array.isArray(design?.segments)) return clone(design.segments);
  const rng=random((Math.imul(Number(design?.seed ?? 1),2654435761)+97)>>>0), out=[];
  switch(design?.family ?? 'soc') {
    case 'array': {
      const tiles=rng.int(3,5), span=.72, step=span/tiles, half=step*rng.float(.26,.34);
      for(let row=0;row<tiles;row++) for(let col=0;col<tiles;col++) square([-span*.5+step*(col+.5),-span*.5+step*(row+.5)],half,rng.float(.011,.015),out);
      const width=rng.float(.018,.026);
      out.push(segment([-.42,-.42],[-.42,.42],width),segment([.42,-.42],[.42,.42],width),segment([-.42,-.42],[.42,-.42],width*.75),segment([-.42,.42],[.42,.42],width*.75));
      break;
    }
    case 'bus': {
      const width=rng.float(.018,.024), mains=rng.int(2,4);
      for(let i=0;i<mains;i++) { const y=-.3+.6*i/Math.max(mains-1,1); out.push(segment([-.42,y],[.42,y],width)); }
      const taps=rng.int(3,5);
      for(let i=0;i<taps;i++) { const x=-.34+.68*i/Math.max(taps-1,1); out.push(segment([x,-.42],[x,.42],rng.float(.012,.016))); }
      const pads=rng.int(1,2);
      for(let i=0;i<pads;i++) square([.28*(i%2===0?-1:1),.34],rng.float(.055,.075),.018,out);
      break;
    }
    case 'radial': {
      const spokes=rng.int(8,16), rings=rng.int(1,3), radii=[];
      for(let i=0;i<rings;i++) radii.push(.16+.26*(i+1)/rings+rng.float(-.02,.02));
      for(let i=0;i<spokes;i++) { const a=Math.PI*2*i/spokes+rng.float(-.05,.05); out.push(segment([Math.cos(a)*.1,Math.sin(a)*.1],[Math.cos(a)*.42,Math.sin(a)*.42],rng.float(.009,.013))); }
      for(const r of radii) for(let i=0;i<spokes;i++) { const a=Math.PI*2*i/spokes,b=Math.PI*2*(i+1)/spokes; out.push(segment([Math.cos(a)*r,Math.sin(a)*r],[Math.cos(b)*r,Math.sin(b)*r],.01)); }
      square([0,0],rng.float(.045,.06),.016,out);
      break;
    }
    case 'grid': {
      const lines=rng.int(4,7), width=rng.float(.024,.034), half=.4, step=half*2/(lines-1);
      for(let i=0;i<lines;i++) { const v=-half+step*i; out.push(segment([v,-half],[v,half],width),segment([-half,v],[half,v],width)); }
      const pads=rng.int(1,2);
      for(let i=0;i<pads;i++) square([.2*(i%2===0?-1:1),rng.float(-.08,.08)],rng.float(.1,.13),.026,out);
      break;
    }
    default: {
      const lines=rng.int(7,11), half=.34+.06*rng.next(), step=half*2/(lines-1), width=rng.float(.01,.015);
      for(let i=0;i<lines;i++) { const v=-half+step*i; out.push(segment([v,-half],[v,half],width)); if(i%2===0)out.push(segment([-half,v],[half,v],width)); }
      const cores=rng.int(2,4);
      for(let i=0;i<cores;i++) square([rng.float(-.22,.22),rng.float(-.22,.22)],rng.float(.07,.11),rng.float(.018,.024),out);
    }
  }
  return out;
}
export function wafer_dies(seed, wafer_id, defect_scale=1, count=DIE_COUNT) {
  const rng=random((Math.imul(seed,2654435761)+Math.imul(wafer_id,7919))>>>0);
  const dies=Array.from({length:count},(_,die)=>({die,passed:true,defect:'none',shift:[0,0],broken:[],width_scale:1}));
  const budget=Math.round(rng.int(0,3)*clamp(defect_scale,0,2)), candidates=Array.from({length:count},(_,i)=>i);
  for(let i=count-1;i>0;i--) { const j=rng.int(0,i); [candidates[i],candidates[j]]=[candidates[j],candidates[i]]; }
  for(let i=0;i<Math.min(budget,count);i++) {
    const entry=dies[candidates[i]], kind=rng.pick(['overlay','broken','dose']);
    entry.passed=false; entry.defect=kind;
    if(kind==='overlay')entry.shift=[rng.float(-.035,.035),rng.float(-.035,.035)];
    if(kind==='broken')entry.broken=Array.from({length:rng.int(3,8)},()=>rng.int(0,Math.max(segments_for(find('flagship_soc')).length-1,1)));
    if(kind==='dose')entry.width_scale=rng.float(1.7,2.3);
  }
  return dies;
}
export function wafer_yield(dies) {
  const passed=dies.filter(d=>d.passed).length;
  return {passed,total:dies.length,yield_pct:100*passed/Math.max(dies.length,1)};
}
