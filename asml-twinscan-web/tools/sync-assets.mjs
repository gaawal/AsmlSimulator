import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Explicit source files only: never copy import caches or edit the Blender master.
const project = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(process.argv[2] || path.join(project, '..'));
const files = [
  ['assets/models/euv_training_machine.glb', 'assets/models/euv_training_machine.glb'],
  ['assets/models/parts_manifest.json', 'assets/models/parts_manifest.json'],
  ['assets/branding/asml_logo_source.svg', 'assets/branding/asml_logo_source.svg'],
  ['assets/branding/asml_logo_source.svg', 'assets/branding/asml_logo.svg'],
];
const copied = [];
for (const [from, to] of files) {
  const input = path.join(source, from);
  const output = path.join(project, 'public', to);
  const bytes = await readFile(input);
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(input, output);
  copied.push({ source: from, file: to, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = JSON.parse(await readFile(path.join(project, 'public/assets/models/parts_manifest.json'), 'utf8'));
const ids = manifest.parts.map(p => p.part_id);
if (new Set(ids).size !== ids.length) throw new Error('Source manifest contains duplicate part_id');
await writeFile(path.join(project, 'public/assets/asset-provenance.json'), JSON.stringify({
  asset_id: manifest.asset_id, part_count: ids.length, copied,
  notice: 'Unmodified Blender GLB and parts manifest copied from the native project. Internal layout and purple EUV visualization are educational.',
}, null, 2));
console.log(`Synced ${copied.length} files; ${ids.length} stable part IDs. Original Blender/Godot assets are unchanged.`);
