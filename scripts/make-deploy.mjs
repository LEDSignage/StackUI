/**
 * Package Stack UI for running on another machine — the GPU box.
 *
 *   npm run build && node scripts/make-deploy.mjs
 *
 * Produces `deploy/` containing everything needed and nothing else: the built
 * web app, the server, the shared code it imports, and the module and stack
 * files. No node_modules — that gets installed on the target.
 *
 * The point of running it on the GPU box is that ComfyUI is then local to it:
 * the box stays on whether or not any workstation does, and video streams off
 * local disk instead of crossing the network twice.
 */

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deploy');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const dir of ['dist', 'server', 'shared', 'modules', 'stacks']) {
  await cp(join(ROOT, dir), join(OUT, dir), {
    recursive: true,
    // Skip dotfiles. A stray .tmp-empty.json from a test once rode along to the
    // GPU box and showed up as a duplicate pipeline in the model list, because
    // it held the same stack id as a real one.
    filter: (src) => !basename(src).startsWith('.'),
  });
}

// Only the dependencies the server actually needs at runtime — the web app is
// already built, so React and Vite are not going along for the ride.
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
await writeFile(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'stack-ui',
      version: pkg.version,
      private: true,
      type: 'module',
      scripts: { start: 'tsx server/index.ts' },
      dependencies: {
        express: pkg.dependencies.express,
        'http-proxy-middleware': pkg.dependencies['http-proxy-middleware'],
      },
      devDependencies: { tsx: pkg.devDependencies.tsx, '@types/node': pkg.devDependencies['@types/node'] },
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

// ComfyUI is local when we run on the box, so talk to it over the loopback
// rather than back out across the network.
await writeFile(
  join(OUT, 'start.cmd'),
  [
    '@echo off',
    'REM Stack UI on the GPU box. ComfyUI is local here.',
    'set COMFY_URL=http://127.0.0.1:8188',
    'set PORT=8790',
    'npm start',
  ].join('\r\n') + '\r\n',
  'utf8',
);

await writeFile(
  join(OUT, 'README.txt'),
  `Stack UI — running on the GPU box
=================================

One process. It serves the web app and relays everything to ComfyUI, so the
browser only ever talks to this machine.

First time
----------
1. Install Node 20 or newer:  https://nodejs.org
   Check it worked:           node --version
2. In this folder:            npm install
3. Allow inbound port 8790 through Windows Firewall.

Running it
----------
Double-click start.cmd, or run "npm start" in this folder.

Then from any machine on the network:  http://10.130.91.138:8790

Settings
--------
COMFY_URL  where ComfyUI is           (default http://127.0.0.1:8188)
PORT       what Stack UI listens on   (default 8790)

Notes
-----
Your pipelines live in stacks/ and your modules in modules/ — plain JSON, safe
to copy back and forth or keep in version control.

modules/generated/ is rebuilt from whatever ComfyUI has installed. After adding
a node pack, regenerate it from the development copy and copy it across.
`,
  'utf8',
);

console.log(`deploy/ ready — copy it to the GPU box`);
