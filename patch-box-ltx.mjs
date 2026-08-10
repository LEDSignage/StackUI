import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const path = '\\ANIMATION-4\StackUI\stacks\video-ltx.json';
const stack = JSON.parse(readFileSync(path, 'utf8'));

if (stack.lines.some((l) => l.id === 'l1b')) {
  console.log('already split — nothing to do');
  process.exit(0);
}

const i = stack.lines.findIndex((l) => l.tiles.some((t) => t.id === 't-text'));
const line = stack.lines[i];
if (line.tiles.length === 1) { console.log('already on its own line'); process.exit(0); }

const text = line.tiles.find((t) => t.id === 't-text');
line.tiles = line.tiles.filter((t) => t.id !== 't-text');
stack.lines.splice(i + 1, 0, { id: 'l1b', mode: 'parallel', bypassed: false, tiles: [text] });

if (!existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
// No BOM: the server's JSON.parse chokes on one, which took a stack offline once.
writeFileSync(path, JSON.stringify(stack, null, 2) + '\n', 'utf8');
console.log('split on the box; t-text now on its own line, params untouched');
