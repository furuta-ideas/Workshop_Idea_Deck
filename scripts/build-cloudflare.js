import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import './stamp-build.js';
const target = resolve('.cloudflare-assets');
for (const file of [
  'index.html',
  'app.js',
  'build-info.js',
  'style.css',
  'WorkShop_Top.png',
  'fonts/BIZUDPGothic-Regular.ttf',
  'fonts/BIZUDPGothic-Bold.ttf',
  ...readdirSync('public/characters')
    .filter((n) => n.endsWith('.png'))
    .map((n) => 'characters/' + n),
]) {
  mkdirSync(dirname(resolve(target, file)), { recursive: true });
  copyFileSync(resolve('public', file), resolve(target, file));
}
copyFileSync(
  resolve('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'),
  resolve(target, 'webauthn.js'),
);
console.log('Cloudflare public assets prepared');
