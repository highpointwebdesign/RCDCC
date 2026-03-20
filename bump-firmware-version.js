const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const configPath = path.join(projectRoot, 'firmware', 'include', 'Config.h');

function bumpPatch(version) {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const match = version.match(/^(\d{2})\.(\d{2})\.(\d+)$/);
  if (!match) {
    // If the existing value is in an older format, migrate to the new scheme.
    return `${year}.${month}.1`;
  }

  const currentYear = match[1];
  const currentMonth = match[2];
  const currentPatch = Number(match[3]);

  if (currentYear === year && currentMonth === month) {
    return `${year}.${month}.${currentPatch + 1}`;
  }

  return `${year}.${month}.1`;
}

function updateFirmwareVersion(content) {
  const pattern = /(#define\s+FIRMWARE_VERSION\s+")([^"]+)(")/;
  const match = content.match(pattern);
  if (!match) {
    throw new Error('Could not find #define FIRMWARE_VERSION in firmware/include/Config.h');
  }

  const previousVersion = match[2];
  const nextVersion = bumpPatch(previousVersion);
  const updated = content.replace(pattern, `$1${nextVersion}$3`);
  return { updated, previousVersion, nextVersion };
}

const original = fs.readFileSync(configPath, 'utf8');
const { updated, previousVersion, nextVersion } = updateFirmwareVersion(original);

if (updated !== original) {
  fs.writeFileSync(configPath, updated, 'utf8');
}

console.log(`Auto-incremented firmware version ${previousVersion} -> ${nextVersion}`);
