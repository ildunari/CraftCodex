#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'craftcodex-logo-variants');

mkdirSync(outDir, { recursive: true });

const ePath = 'M474.78218,393.8 L474.78218,368 L566.666667,368 L566.666667,393.8 L474.78218,393.8 Z M521.101,419.6 L521.102306,445.4 L452,445.4 L452,393.8 L566.666667,393.8 L566.666667,419.6 L521.101,419.6 Z M474.78218,497 L474.775667,471.2 L452,471.2 L452,445.4 L566.666667,445.4 L566.666667,497 L474.78218,497 Z';

function agentSymbol(fill, x = 128, y = 116, scale = 2.15) {
  return `
    <g transform="translate(${x} ${y}) scale(${scale}) translate(-452 -368)">
      <path d="${ePath}" fill="${fill}" fill-rule="nonzero"/>
    </g>
  `;
}

const variants = [
  {
    id: '01-codex-night',
    title: 'CraftCodex Night',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="78" y1="58" x2="434" y2="454" gradientUnits="userSpaceOnUse">
          <stop stop-color="#111827"/>
          <stop offset="1" stop-color="#061923"/>
        </linearGradient>
        <linearGradient id="mark" x1="130" y1="116" x2="382" y2="386" gradientUnits="userSpaceOnUse">
          <stop stop-color="#E8F7FF"/>
          <stop offset="1" stop-color="#5EEAD4"/>
        </linearGradient>
        <filter id="shadow" x="-18%" y="-18%" width="136%" height="136%">
          <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#020617" flood-opacity=".48"/>
        </filter>
      </defs>
      <rect x="42" y="42" width="428" height="428" rx="96" fill="url(#bg)"/>
      <path d="M112 180L78 256l34 76" fill="none" stroke="#38BDF8" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
      <path d="M400 180l34 76-34 76" fill="none" stroke="#5EEAD4" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
      <g filter="url(#shadow)">${agentSymbol('url(#mark)')}</g>
    </svg>`,
  },
  {
    id: '02-graphite',
    title: 'CraftCodex Graphite',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="74" y1="58" x2="438" y2="454" gradientUnits="userSpaceOnUse">
          <stop stop-color="#2F3641"/>
          <stop offset="1" stop-color="#111827"/>
        </linearGradient>
        <linearGradient id="mark" x1="136" y1="112" x2="386" y2="388" gradientUnits="userSpaceOnUse">
          <stop stop-color="#F8FAFC"/>
          <stop offset="1" stop-color="#D1D5DB"/>
        </linearGradient>
      </defs>
      <rect x="42" y="42" width="428" height="428" rx="92" fill="url(#bg)"/>
      <rect x="84" y="92" width="344" height="328" rx="48" fill="#0B1120" opacity=".56"/>
      <rect x="84" y="92" width="344" height="54" rx="27" fill="#334155" opacity=".78"/>
      <circle cx="122" cy="119" r="7" fill="#94A3B8"/>
      <circle cx="146" cy="119" r="7" fill="#64748B"/>
      <path d="M366 205l34 51-34 51" fill="none" stroke="#67E8F9" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
      ${agentSymbol('url(#mark)')}
    </svg>`,
  },
  {
    id: '03-paper',
    title: 'CraftCodex Paper',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="80" y1="60" x2="432" y2="452" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="#EAF2FF"/>
        </linearGradient>
        <linearGradient id="mark" x1="132" y1="112" x2="384" y2="390" gradientUnits="userSpaceOnUse">
          <stop stop-color="#0F172A"/>
          <stop offset="1" stop-color="#155E75"/>
        </linearGradient>
      </defs>
      <rect x="42" y="42" width="428" height="428" rx="104" fill="url(#bg)"/>
      <path d="M382 186l40 70-40 70" fill="none" stroke="#06B6D4" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M130 186l-40 70 40 70" fill="none" stroke="#A78BFA" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/>
      ${agentSymbol('url(#mark)')}
    </svg>`,
  },
  {
    id: '04-teal',
    title: 'CraftCodex Teal',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="bg" x1="70" y1="54" x2="442" y2="458" gradientUnits="userSpaceOnUse">
          <stop stop-color="#042F2E"/>
          <stop offset="1" stop-color="#020617"/>
        </linearGradient>
        <linearGradient id="mark" x1="132" y1="112" x2="386" y2="388" gradientUnits="userSpaceOnUse">
          <stop stop-color="#99F6E4"/>
          <stop offset="1" stop-color="#2DD4BF"/>
        </linearGradient>
      </defs>
      <rect x="42" y="42" width="428" height="428" rx="96" fill="url(#bg)"/>
      <rect x="91" y="91" width="330" height="330" rx="70" fill="#0F172A" opacity=".42"/>
      <path d="M402 176l44 80-44 80" fill="none" stroke="#A7F3D0" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity=".72"/>
      ${agentSymbol('url(#mark)')}
    </svg>`,
  },
  {
    id: '05-black-white',
    title: 'CraftCodex Black White',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <defs>
        <filter id="shadow" x="-18%" y="-18%" width="136%" height="136%">
          <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity=".35"/>
        </filter>
      </defs>
      <rect x="42" y="42" width="428" height="428" rx="96" fill="#0A0A0B"/>
      <path d="M112 180L76 256l36 76" fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
      <path d="M400 180l36 76-36 76" fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
      <g filter="url(#shadow)">${agentSymbol('#FFFFFF')}</g>
    </svg>`,
  },
];

async function renderVariant(variant) {
  const svgPath = join(outDir, `${variant.id}.svg`);
  const pngPath = join(outDir, `${variant.id}.png`);
  writeFileSync(svgPath, variant.svg);
  await sharp(Buffer.from(variant.svg)).resize(512, 512).png().toFile(pngPath);
}

function run(command, args, cwd = here) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

for (const variant of variants) {
  await renderVariant(variant);
}

const primary = variants[0];
writeFileSync(join(here, 'icon.svg'), primary.svg);
writeFileSync(join(here, 'icon.icon', 'Assets', 'icon.svg'), primary.svg);
await sharp(Buffer.from(primary.svg)).resize(1024, 1024).png().toFile(join(here, 'source.png'));
await sharp(Buffer.from(primary.svg)).resize(512, 512).png().toFile(join(here, 'icon.png'));

const iconset = join(here, 'icon.iconset');
run('rm', ['-rf', iconset], '/');
mkdirSync(iconset, { recursive: true });
const sizes = [
  ['16', '16', 'icon_16x16.png'],
  ['32', '32', 'icon_16x16@2x.png'],
  ['32', '32', 'icon_32x32.png'],
  ['64', '64', 'icon_32x32@2x.png'],
  ['128', '128', 'icon_128x128.png'],
  ['256', '256', 'icon_128x128@2x.png'],
  ['256', '256', 'icon_256x256.png'],
  ['512', '512', 'icon_256x256@2x.png'],
  ['512', '512', 'icon_512x512.png'],
  ['1024', '1024', 'icon_512x512@2x.png'],
];

for (const [w, h, name] of sizes) {
  await sharp(Buffer.from(primary.svg)).resize(Number(w), Number(h)).png().toFile(join(iconset, name));
}

run('iconutil', ['-c', 'icns', iconset, '-o', join(here, 'icon.icns')]);
run('rm', ['-rf', iconset], '/');

try {
  run('xcrun', [
    'actool',
    join(here, 'icon.icon'),
    '--compile',
    here,
    '--app-icon',
    'AppIcon',
    '--minimum-deployment-target',
    '26.0',
    '--platform',
    'macosx',
    '--output-partial-info-plist',
    '/dev/null',
  ]);
} catch {
  console.warn('Warning: actool failed; icon.icns was still regenerated.');
}

console.log('Generated CraftCodex logo variants:');
for (const variant of variants) {
  console.log(`- ${variant.title}: ${join(outDir, `${variant.id}.png`)}`);
}
