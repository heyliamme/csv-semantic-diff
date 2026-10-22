// Renders assets/icon.svg to media/icon.png (256 px) with headless Chrome.
//   node scripts/icon.mjs
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const svg = readFileSync(path.join(root, 'assets/icon.svg'), 'utf8');
mkdirSync(path.join(root, 'out'), { recursive: true });
const page = path.join(root, 'out/icon.html');
writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
const chrome = process.env.CHROME || 'google-chrome';
const png = path.join(root, 'out/icon.png');
execFileSync(chrome, ['--headless=new', '--hide-scrollbars', '--default-background-color=00000000', '--window-size=256,256', `--screenshot=${png}`, `file://${page}`], { stdio: 'ignore' });
renameSync(png, path.join(root, 'media/icon.png'));
unlinkSync(page);
console.log('media/icon.png');
