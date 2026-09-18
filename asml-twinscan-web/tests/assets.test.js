import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../public/assets/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('models/parts_manifest.json', root), 'utf8'));
const provenance = JSON.parse(readFileSync(new URL('asset-provenance.json', root), 'utf8'));
const bytes = readFileSync(new URL('models/euv_training_machine.glb', root));
const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));

test('web asset copy preserves the source bytes and stable part mapping', () => {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  for (const file of provenance.copied) {
    const copy = readFileSync(new URL(file.file.replace('assets/', ''), root));
    assert.equal(createHash('sha256').update(copy).digest('hex'), file.sha256, file.file);
  }
  const parts = gltf.nodes.filter(n => n.name?.startsWith('p__') && n.extras?.part_id);
  assert.equal(parts.length, manifest.parts.length);
  assert.equal(new Set(parts.map(n => n.extras.part_id)).size, manifest.parts.length);
  assert.equal(manifest.parts.length, provenance.part_count);
});

test('GLB retains all manifest parent-child relationships and mesh ownership', () => {
  const byName = new Map(gltf.nodes.map((n, i) => [n.name, { ...n, index: i }]));
  const parents = new Map();
  gltf.nodes.forEach((node, index) => (node.children || []).forEach(child => parents.set(child, index)));
  const byId = new Map(manifest.parts.map(p => [p.part_id, p]));
  for (const part of manifest.parts) {
    const node = byName.get(part.node_name);
    assert.ok(node, part.part_id);
    assert.equal(node.extras.part_id, part.part_id);
    if (part.parent_id) assert.equal(gltf.nodes[parents.get(node.index)].name, byId.get(part.parent_id).node_name);
    for (const meshName of part.mesh_nodes) {
      const mesh = byName.get(meshName);
      assert.ok(mesh && Number.isInteger(mesh.mesh), meshName);
      assert.equal(parents.get(mesh.index), node.index, `mesh ownership: ${meshName}`);
    }
  }
  assert.ok(gltf.meshes.length > 100, 'Machine is not a single merged mesh');
});

test('required motion and optical interfaces are present for both stages', () => {
  const ids = new Set(manifest.parts.map(p => p.part_id));
  for (const id of ['wafer_stage_x', 'wafer_stage_y', 'wafer_chuck', 'wafer_300mm', 'wafer_300mm_secondary', 'wafer_stage_dual_bed', 'reticle_scan_stage', 'handling_arm_shoulder', 'handling_arm_forearm', 'handling_arm_wrist']) assert.ok(ids.has(id), id);
  assert.ok(manifest.education_optics.ray_points.length >= 10);
  for (const anchor of manifest.education_optics.ray_points) assert.ok(ids.has(anchor.part_id), anchor.part_id);
});
