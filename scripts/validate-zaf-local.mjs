import fs from 'node:fs';
import path from 'node:path';

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  const sig = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== sig) {
    throw new Error(`${filePath} is not a valid PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

const root = path.resolve('zaf-app');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'translations', 'en.json'), 'utf8'));

if (manifest.frameworkVersion !== '2.0') throw new Error('frameworkVersion must be 2.0');
if (!manifest.location?.support?.ticket_sidebar) throw new Error('Missing ticket_sidebar location');
if (!manifest.location?.support?.nav_bar) throw new Error('Missing nav_bar location');
if (!en.app?.name || !en.app?.short_description || !en.app?.long_description || !en.app?.installation_instructions) {
  throw new Error('Missing required Marketplace strings in translations/en.json');
}
if (!fs.existsSync(path.join(root, 'assets', 'icon_nav_bar.svg'))) {
  throw new Error('Missing assets/icon_nav_bar.svg required for nav_bar apps');
}

const logo = readPngDimensions(path.join(root, 'assets', 'logo.png'));
const logoSmall = readPngDimensions(path.join(root, 'assets', 'logo-small.png'));
if (logo.width !== 320 || logo.height !== 320) throw new Error(`logo.png must be 320x320, got ${logo.width}x${logo.height}`);
if (logoSmall.width !== 128 || logoSmall.height !== 128) throw new Error(`logo-small.png must be 128x128, got ${logoSmall.width}x${logoSmall.height}`);

const shots = ['screenshot-0.png', 'screenshot-1.png', 'screenshot-2.png'].map((name) => {
  const dim = readPngDimensions(path.join(root, 'assets', name));
  if (dim.width !== 1024 || dim.height !== 768) {
    throw new Error(`${name} must be 1024x768, got ${dim.width}x${dim.height}`);
  }
  return { name, ...dim };
});

console.log('ZAF Marketplace Local Validation PASSED:', {
  name: manifest.name,
  version: manifest.version,
  frameworkVersion: manifest.frameworkVersion,
  logo,
  logoSmall,
  screenshots: shots,
});
