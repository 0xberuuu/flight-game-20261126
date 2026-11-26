// Sky Courier — Ring Run: entrypoint (Node 22, stdlib only).
//
// Stages game/ and screenshots/ into the output directory and writes
// dossier.json with make.fun's vendored library. Deterministic: files are
// copied in sorted order and buildDossier's output is deterministic.
import { buildDossier } from './vendor/makefun-game.ts';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const OUT = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? join(ROOT, 'out'));

const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    cpSync(join(src, name), join(dest, name), { recursive: true });
  }
}

if (!existsSync(join(ROOT, 'game'))) throw new Error('game/: no such directory');
if (!existsSync(join(ROOT, 'screenshots'))) throw new Error('screenshots/: no such directory');

mkdirSync(OUT, { recursive: true });
copyTree(join(ROOT, 'game'), join(OUT, 'game'));
copyTree(join(ROOT, 'screenshots'), join(OUT, 'screenshots'));

const dossier = buildDossier(OUT, CAPS);
writeFileSync(join(OUT, 'dossier.json'), dossier);
console.log(`staged ${OUT} (game/ + screenshots/ + dossier.json, ${dossier.length} bytes)`);
