/**
 * Repair / install the Electron binary.
 *
 * Why this exists:
 *   Newer npm versions block lifecycle scripts of dependencies by default
 *   ("npm warn install-scripts"), and Electron needs that script to download
 *   its binary. This script downloads the binary directly from a fast mirror
 *   and unpacks it into node_modules/electron/dist, then writes path.txt so
 *   `require('electron')` resolves correctly.
 *
 * Usage: node scripts/setup-electron.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');

const MIRRORS = [
  'https://cdn.npmmirror.com/binaries/electron',
  'https://npmmirror.com/mirrors/electron',
  'https://github.com/electron/electron/releases/download/v',
];

function log(msg) {
  process.stdout.write(msg + '\n');
}

function getElectronVersion() {
  const pkgPath = path.join(ELECTRON_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error('node_modules/electron not installed. Run: npm install --ignore-scripts');
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

function targetName() {
  const platform = process.platform;
  const arch = process.arch;
  return { platform, arch };
}

function zipName(version, platform, arch) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

function download(url, dest, depth = 0) {
  if (depth > 6) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'workbuddy-checkin-setup', Accept: '*/*' },
        timeout: 60000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(download(next, dest, depth + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        let lastTick = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received - lastTick > 10 * 1024 * 1024) {
            lastTick = received;
            const pct = total ? Math.round((received / total) * 100) : 0;
            log(`  downloading... ${(received / 1048576).toFixed(1)} MB (${pct}%)`);
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Connection timeout')));
    req.on('error', reject);
  });
}

async function downloadWithFallback(version, file, dest) {
  const errors = [];
  for (const base of MIRRORS) {
    // GitHub releases use a different path shape: .../v<version>/<file>
    const url = base.includes('releases/download/v') ? `${base}${version}/${file}` : `${base}/${version}/${file}`;
    log(`Trying ${url}`);
    try {
      await download(url, dest);
      const size = fs.statSync(dest).size;
      if (size < 50 * 1024 * 1024) throw new Error(`File too small (${size} bytes)`);
      log(`  OK (${(size / 1048576).toFixed(1)} MB)`);
      return true;
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
      log(`  failed: ${err.message}`);
      try {
        fs.unlinkSync(dest);
      } catch (_) {
        /* ignore */
      }
    }
  }
  throw new Error('All mirrors failed:\n' + errors.join('\n'));
}

function extract(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  // Windows 10+ ships bsdtar which understands .zip
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
    return;
  } catch (e) {
    log('  tar failed, falling back to PowerShell Expand-Archive');
  }
  const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit' });
}

function binaryPath(platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
  return 'electron';
}

async function main() {
  const version = getElectronVersion();
  const { platform, arch } = targetName();
  const file = zipName(version, platform, arch);
  log(`Electron version: ${version}  target: ${platform}-${arch}`);

  const exe = path.join(DIST_DIR, binaryPath(platform));
  if (fs.existsSync(exe)) {
    log('Binary already present, nothing to do.');
    writePathTxt(platform);
    return;
  }

  const cacheDir = path.join(ROOT, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, file);

  if (!fs.existsSync(zipPath)) {
    await downloadWithFallback(version, file, zipPath);
  } else {
    log(`Using cached ${zipPath}`);
  }

  log('Extracting...');
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  extract(zipPath, DIST_DIR);

  if (!fs.existsSync(path.join(DIST_DIR, binaryPath(platform)))) {
    throw new Error('Extraction finished but binary is still missing.');
  }
  writePathTxt(platform);
  log('Electron is ready.');
}

function writePathTxt(platform) {
  fs.writeFileSync(path.join(ELECTRON_DIR, 'path.txt'), binaryPath(platform), 'utf8');
}

main().catch((err) => {
  log('');
  log('ERROR: ' + err.message);
  process.exit(1);
});
