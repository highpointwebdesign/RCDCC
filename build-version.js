const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const packageJsonPath = path.join(projectRoot, 'package.json');
const appJsPath = path.join(projectRoot, 'www', 'js', 'app.js');
const indexHtmlPath = path.join(projectRoot, 'www', 'index.html');
const androidGradlePath = path.join(projectRoot, 'android', 'app', 'build.gradle');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeFileIfChanged(filePath, content) {
  const current = fs.readFileSync(filePath, 'utf8');
  if (current === content) {
    return false;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function toVersionCode(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Version must use semantic format major.minor.patch. Received: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major * 10000 + minor * 100 + patch;
}

function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Version must use semantic format major.minor.patch. Received: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

function replaceOrThrow(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Unable to update ${label}. Pattern not found.`);
  }
  return content.replace(pattern, replacement);
}

function updateAssetVersion(content, assetPath, version) {
  const escapedPath = assetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(["'])${escapedPath}(?:\\?v=[^"']*)?\\1`, 'g');
  return content.replace(pattern, `$1${assetPath}?v=${version}$1`);
}

const pkg = readJson(packageJsonPath);
const previousVersion = pkg.version;
const appVersion = bumpPatch(previousVersion);
pkg.version = appVersion;
writeJson(packageJsonPath, pkg);
const buildDate = new Date().toISOString().split('T')[0];
const versionCode = toVersionCode(appVersion);

let appJs = fs.readFileSync(appJsPath, 'utf8');
appJs = replaceOrThrow(
  appJs,
  /const APP_VERSION = '[^']+';/,
  `const APP_VERSION = '${appVersion}';`,
  'APP_VERSION'
);
appJs = replaceOrThrow(
  appJs,
  /const BUILD_DATE = '[^']+';/,
  `const BUILD_DATE = '${buildDate}';`,
  'BUILD_DATE'
);
writeFileIfChanged(appJsPath, appJs);

let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
[
  'site.webmanifest',
  'css/bootstrap.min.css',
  'css/fonts.css',
  'lib/range-slider/style.css',
  'css/app.css',
  'js/bootstrap.bundle.min.js',
  'lib/range-slider/rangeslider.umd.min.js',
  'js/console.js',
  'js/bluetooth.js',
  'js/garage.js',
  'js/app.js'
].forEach((assetPath) => {
  indexHtml = updateAssetVersion(indexHtml, assetPath, appVersion);
});
writeFileIfChanged(indexHtmlPath, indexHtml);

let buildGradle = fs.readFileSync(androidGradlePath, 'utf8');
buildGradle = replaceOrThrow(
  buildGradle,
  /versionCode\s+\d+/,
  `versionCode ${versionCode}`,
  'Android versionCode'
);
buildGradle = replaceOrThrow(
  buildGradle,
  /versionName\s+"[^"]+"/,
  `versionName "${appVersion}"`,
  'Android versionName'
);
writeFileIfChanged(androidGradlePath, buildGradle);

console.log(`Auto-incremented app version ${previousVersion} -> ${appVersion} (${buildDate})`);
console.log(`Android versionCode set to ${versionCode}`);
