import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DualStagePipeline, ACTION_DURATIONS } from '../src/simulation/pipeline.js';
import { DESIGNS, catalogue, segments_for, find, die_center, wafer_dies, wafer_yield } from '../src/simulation/designs.js';

const close=(a,b,message='')=>assert.ok(Math.abs(a-b)<1e-7,`${message}: ${a} != ${b}`);
function run(batch,pattern=[1000]) {
  const sim=new DualStagePipeline(); sim.set_batch_count(batch);sim.start();
  let frames=0;
  while(sim.state==='running'&&frames<100000)sim.tick(pattern[frames++%pattern.length]);
  assert.equal(sim.state,'done');
  return sim;
}
const eventTime=(sim,type,id)=>sim.events.find(e=>e.type===type&&e.wafer_id===id)?.elapsed_s;

test('ready controls, invalid input, pause and reset preserve configuration',()=>{
  const sim=new DualStagePipeline();
  assert.equal(sim.state,'ready');assert.equal(sim.batch_count,6);
  assert.equal(sim.stages.A.station,'measurement');assert.equal(sim.stages.B.station,'exposure');
  for(const invalid of [0,13,1.5,NaN])assert.equal(sim.set_batch_count(invalid),false);
  assert.equal(sim.set_batch_count(2),true);assert.equal(sim.set_seed(99),true);assert.equal(sim.set_design('ai_accelerator'),true);
  assert.equal(sim.set_design('unknown'),false);assert.equal(sim.pause(),false);assert.equal(sim.resume(),false);
  assert.equal(sim.start(),true);assert.equal(sim.start(),false);
  assert.equal(sim.set_batch_count(3),false);assert.equal(sim.set_seed(2),false);assert.equal(sim.set_design('power_grid'),false);
  sim.tick(2);for(const invalid of [0,-1,NaN,Infinity])sim.tick(invalid);close(sim.elapsed_s,2);
  sim.pause();const frozen=sim.snapshot();sim.tick(100);assert.deepEqual(sim.snapshot(),frozen);
  sim.resume();sim.tick(100);assert.equal(sim.completed.length,2);
  sim.reset();assert.equal(sim.state,'ready');assert.equal(sim.elapsed_s,0);assert.equal(sim.completed.length,0);assert.equal(sim.events.length,0);
  assert.equal(sim.batch_count,2);assert.equal(sim.seed_value,99);assert.equal(sim.design_id,'ai_accelerator');
});

for(const batch of [1,2,6,12])test(`${batch} wafers: frame partition independence, synchronized two-stage timing`,()=>{
  const baseline=run(batch),expected=29+batch*20;
  close(baseline.elapsed_s,expected);assert.equal(baseline.exchange_count,batch+1);
  assert.deepEqual(baseline.completed.map(w=>w.wafer_id),Array.from({length:batch},(_,i)=>i+1));
  assert.equal(baseline.stages.A.wafer_id+baseline.stages.B.wafer_id,0);
  assert.equal(baseline.events.filter(e=>e.type==='homing_completed').length,1);assert.equal(baseline.events.filter(e=>e.type==='vacuum_ready').length,1);
  // 启动顺序：先建立工作真空，再做归零校准（真空未到位时量测基准不可信）
  const vacuumAt=eventTime(baseline,'vacuum_ready'),homingAt=eventTime(baseline,'homing_completed');
  assert.ok(vacuumAt<homingAt,`抽真空必须先于归零校准，实际 vacuum@${vacuumAt}s homing@${homingAt}s`);
  assert.equal(baseline.lot_yield().total,batch*25);
  assert.equal(baseline.lot_yield().passed,baseline.completed.reduce((s,w)=>s+w.pass_count,0));
  for(let id=1;id<=batch;id++)assert.equal(baseline.events.filter(e=>e.type==='wafer_measured'&&e.wafer_id===id).length,1);
  for(let id=2;id<batch;id++)close(eventTime(baseline,'wafer_exposed',id),eventTime(baseline,'wafer_measured',id+1));
  for(const pattern of [[1/60],[1/144],[.017,.081,.007,.333]]) {
    const sim=run(batch,pattern);close(sim.elapsed_s,expected);assert.deepEqual(sim.events,baseline.events);assert.deepEqual(sim.completed,baseline.completed);
  }
});

test('steady measurement unload/load remain at the same station, exposures overlap',()=>{
  const sim=new DualStagePipeline();sim.start();let overlap=false,reloads=0,previous=sim.snapshot();
  assert.equal(ACTION_DURATIONS.expose,ACTION_DURATIONS.unload+ACTION_DURATIONS.load+ACTION_DURATIONS.prealign+ACTION_DURATIONS.measure);
  while(sim.state==='running') {
    sim.tick(.01);const current=sim.snapshot();
    for(const letter of ['A','B']) {
      const old=previous.stages[letter],stage=current.stages[letter],other=current.stages[letter==='A'?'B':'A'];
      if(['load','unload'].includes(stage.action))assert.equal(stage.station,'measurement');
      if(old.action==='unload'&&stage.action==='load'){reloads++;assert.equal(stage.station,old.station);assert.equal(stage.progress<.01,true);assert.equal(stage.wafer_id,old.wafer_id+2);}
      if(stage.action==='expose'&&['load','unload','prealign','measure'].includes(other.action))overlap=true;
      if(stage.wafer_state==='exposed'&&other.station==='measurement')assert.ok(!['unload','load','prealign','measure'].includes(other.action),'finished exposure should not wait for measurement');
      if(stage.station!==old.station)assert.equal(previous.machine_phase,'exchange');
      if(['loading','loaded','measured'].includes(stage.wafer_state)){assert.equal(stage.exposed_segments,0);assert.equal(stage.wafer_dies.length,0);}
    }
    previous=current;
  }
  assert.ok(overlap);assert.equal(reloads,4);
});

test('single-step stops at action boundaries without serializing parallel stages',()=>{
  const sim=new DualStagePipeline();sim.set_batch_count(3);sim.set_single_step(true);sim.start();
  sim.tick(1000);assert.equal(sim.state,'paused');assert.equal(sim.step_waiting,true);close(sim.elapsed_s,4);assert.equal(sim.machine_phase,'homing');
  const frozen=sim.snapshot();sim.tick(100);assert.deepEqual(sim.snapshot(),frozen);
  sim.step();sim.tick(1000);close(sim.elapsed_s,9);assert.equal(sim.stages.A.action,'load');
  let sawParallelAdvance=false,stops=0;
  while(sim.state!=='done'&&stops++<80) {
    const exposed=sim.exposing_stage(),before=exposed?sim.stages[exposed].progress:0;
    sim.step();sim.tick(1000);
    if(exposed&&sim.stages[exposed].action==='expose'&&sim.stages[exposed].progress>before)sawParallelAdvance=true;
    assert.ok(sim.state==='paused'||sim.state==='done');
  }
  assert.ok(sawParallelAdvance);assert.equal(sim.state,'done');assert.deepEqual(sim.events,run(3).events);close(sim.elapsed_s,89);
  sim.reset();assert.equal(sim.single_step,true);sim.set_single_step(false);sim.start();sim.tick(1000);assert.equal(sim.state,'done');
});

test('design catalogue, circuit paths and defect results are deterministic and independent',()=>{
  const cards=catalogue(4242,16);assert.equal(cards.length,16);assert.equal(new Set(cards.map(d=>d.name)).size,16);assert.deepEqual(cards,catalogue(4242,16));assert.notDeepEqual(cards,catalogue(4243,16));
  for(const design of [...DESIGNS,...cards]) {
    const path=segments_for(design);assert.ok(path.length>=8);assert.deepEqual(path,segments_for(design));
    assert.ok(path.every(s=>[...s.a,...s.b,s.w].every(Number.isFinite)&&s.w>0));
    const sim=new DualStagePipeline();assert.equal(sim.set_design(design),true);assert.equal(sim.segments_per_die(),path.length);
    assert.deepEqual(segments_for(sim.snapshot().design),path);
  }
  assert.deepEqual(die_center(0),[-2,-2]);assert.deepEqual(die_center(24),[2,2]);
  assert.deepEqual(wafer_dies(42,2),wafer_dies(42,2));assert.notDeepEqual(wafer_dies(42,2),wafer_dies(43,2));
  const dies=wafer_dies(42,2),summary=wafer_yield(dies);assert.equal(summary.total,25);assert.equal(summary.passed,dies.filter(d=>d.defect==='none').length);
  const fixed=find('flagship_soc');fixed.accent[0]=99;assert.notEqual(find('flagship_soc').accent[0],99);
});

test('custom circuit segments and all snapshot objects cannot mutate simulation state',()=>{
  const sim=new DualStagePipeline(),entry={id:'custom',name:'自定义',family:'soc',seed:3,accent:[.1,.2,.3],segments:[{a:[0,0],b:[.4,.4],w:.02}]};
  assert.equal(sim.set_design(entry),true);entry.segments[0].a[0]=99;assert.equal(sim.design().segments[0].a[0],0);
  assert.equal(sim.segments_per_die(),1);assert.equal(sim.total_segments_per_wafer(),25);
  assert.equal(sim.set_design({id:'invalid',segments:[{a:[0,0],b:[NaN,0],w:.01}]}),false);
  sim.start();sim.tick(60);const original=sim.snapshot(),copy=sim.snapshot();
  copy.stages.A.wafer_id=99;copy.events.push({fake:true});copy.completed.push({fake:true});copy.design.segments[0].b[0]=99;copy.design.accent[0]=99;copy.stages.B.wafer_dies[0].shift[0]=99;
  assert.deepEqual(sim.snapshot(),original);
});

test('actual Godot 4.7.2 exported fixtures match every action/station/wafer event boundary',()=>{
  // Deliberately compare process behavior, not PRNG samples: Godot uses PCG,
  // this web build uses Mulberry32 (documented in designs.js).
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/godot-pipeline.json',import.meta.url),'utf8'));
  assert.equal(fixture.runs.length,4);
  for(const expected of fixture.runs) {
    const sim=new DualStagePipeline();sim.set_batch_count(expected.batch);sim.start();
    for(const sample of expected.samples) {
      sim.tick(Math.max(sample.time-sim.elapsed_s,0));
      assert.equal(sim.machine_phase,sample.phase,`batch ${expected.batch} at ${sample.time}`);
      for(const letter of ['A','B'])for(const key of ['action','station','wafer_id','wafer_state'])assert.equal(sim.stages[letter][key],sample.stages[letter][key],`batch ${expected.batch} ${letter}.${key} at ${sample.time}`);
    }
    sim.tick(1000);close(sim.elapsed_s,expected.elapsed_s);assert.equal(sim.exchange_count,expected.exchange_count);assert.deepEqual(sim.completed.map(w=>w.wafer_id),expected.completed_ids);
    assert.deepEqual(sim.events.map(e=>({type:e.type,actor:e.actor,time:e.elapsed_s,wafer_id:e.wafer_id??0})),expected.events);
  }
});
