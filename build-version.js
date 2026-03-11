#!/usr/bin/env node

/**
 * Build script to auto-inject version info into the app
 * Runs before the app is built/deployed to get:
 * - Current git commit hash (or version tag)
 * - Build date
 * - Firmware version from Config.h
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const appJsPath = path.join(__dirname, 'www', 'js', 'app.js');
const configHPath = path.join(__dirname, 'firmware', 'include', 'Config.h');

// Get git commit hash (short form)
function getGitCommitHash() {
    try {
        const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
        return hash || 'unknown';
    } catch (error) {
        console.warn('Warning: Could not get git commit hash:', error.message);
        return 'unknown';
    }
}

// Get firmware version from Config.h
function getFirmwareVersion() {
    try {
        const configContent = fs.readFileSync(configHPath, 'utf8');
        const match = configContent.match(/#define\s+FIRMWARE_VERSION\s+"([^"]+)"/);
        return match ? match[1] : '1.0.0';
    } catch (error) {
        console.warn('Warning: Could not read firmware version from Config.h:', error.message);
        return '1.0.0';
    }
}

// Get build date in YYYY-MM-DD HH:MM:SS format (24-hour)
function getBuildDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Update version constants in app.js
function updateVersionInAppJs(appVersion, buildDate) {
    try {
        let content = fs.readFileSync(appJsPath, 'utf8');
        
        // Update APP_VERSION constant
        content = content.replace(
            /const\s+APP_VERSION\s*=\s*['"][^'"]*['"]/,
            `const APP_VERSION = '${appVersion}'`
        );
        
        // Update BUILD_DATE constant
        content = content.replace(
            /const\s+BUILD_DATE\s*=\s*['"][^'"]*['"]/,
            `const BUILD_DATE = '${buildDate}'`
        );
        
        fs.writeFileSync(appJsPath, content, 'utf8');
        return true;
    } catch (error) {
        console.error('Error updating app.js:', error.message);
        return false;
    }
}

// Main execution
console.log('🔨 Generating version information...');

const appVersion = getGitCommitHash();
const buildDate = getBuildDate();
const firmwareVersion = getFirmwareVersion();

console.log(`  App Version (git commit): ${appVersion}`);
console.log(`  Build Date: ${buildDate}`);
console.log(`  Firmware Version: ${firmwareVersion}`);

if (updateVersionInAppJs(appVersion, buildDate)) {
    console.log('✅ Version information injected into app.js');
} else {
    console.error('❌ Failed to inject version information');
    process.exit(1);
}

console.log(`\nℹ️  Firmware version ${firmwareVersion} will be fetched from ESP32 at runtime`);
