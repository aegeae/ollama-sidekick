import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const svgPath = resolve(__dirname, '../public/icons/icon.svg');
const outDir = resolve(__dirname, '../public/icons');

await mkdir(outDir, { recursive: true });

const svg = await readFile(svgPath);

const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const outPath = resolve(outDir, `icon${size}.png`);
  await sharp(svg)
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

console.log('Generated icons:', sizes.map((s) => `icon${s}.png`).join(', '));
