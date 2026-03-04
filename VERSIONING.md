# Version Management Guide

This document explains how versioning works in the RCDCC project and how to automate it further.

## Current Implementation

### Manual Versioning (Current Approach)
Both app and firmware versions are manually maintained in their respective files:

**App Version:**
- Location: `html/index.html` 
- Constants: `APP_VERSION` and `BUILD_DATE`
- Update these when releasing new versions

**Firmware Version:**
- Location: `firmware/include/Config.h`
- Constant: `FIRMWARE_VERSION`
- Default: "1.0.0"
- Update when releasing new firmware builds

### How It Works
1. App displays its version from the `APP_VERSION` constant
2. App fetches firmware version from ESP32 via `/api/health-check` endpoint
3. Both versions are displayed in Settings > System > About card

## Automated Versioning Strategies

### Option 1: Git-Based Versioning (Recommended)

**For Firmware (PlatformIO):**

Add to `firmware/platformio.ini`:
```ini
[env:esp32]
build_flags = 
    -DFIRMWARE_VERSION=\"$(git describe --tags --always)\"
    # ... other flags
```

This will automatically use git tags/commits as version.

**For App (HTML):**

Create a build script `build.sh` or `build.ps1`:
```bash
#!/bin/bash
VERSION=$(git describe --tags --always)
BUILD_DATE=$(date +%Y-%m-%d)
sed -i "s/const APP_VERSION = '.*'/const APP_VERSION = '$VERSION'/g" html/index.html
sed -i "s/const BUILD_DATE = '.*'/const BUILD_DATE = '$BUILD_DATE'/g" html/index.html
```

### Option 2: Package.json Versioning

Create `package.json` in project root:
```json
{
  "name": "rcdcc-webapp",
  "version": "1.0.0",
  "description": "RCDCC Web Interface"
}
```

Then use a build script to inject version from package.json.

### Option 3: CI/CD Pipeline Versioning

In your GitHub Actions / GitLab CI / Jenkins pipeline:
- Use `${{ github.run_number }}` or pipeline build number
- Inject as environment variable during build
- Replace version constants before deployment

### Option 4: Semantic Release

Use tools like:
- `semantic-release` for automated semantic versioning
- Automatic changelog generation
- Git tag creation based on commit messages

## Version Format Recommendations

**Semantic Versioning (SemVer):**
- Format: `MAJOR.MINOR.PATCH` (e.g., `1.2.3`)
- MAJOR: Breaking changes
- MINOR: New features (backwards compatible)
- PATCH: Bug fixes

**Git-based:**
- Tag releases: `git tag -a v1.0.0 -m "Release 1.0.0"`
- `git describe` outputs: `v1.0.0-5-g3ab4d` (5 commits after v1.0.0)

**Date-based:**
- Format: `YYYY.MM.DD` (e.g., `2026.03.04`)
- Good for rapid iteration

## Build Automation Example

**Pre-commit Hook** (`.git/hooks/pre-commit`):
```bash
#!/bin/bash
# Auto-update BUILD_DATE before each commit
BUILD_DATE=$(date +%Y-%m-%d)
sed -i "s/const BUILD_DATE = '.*'/const BUILD_DATE = '$BUILD_DATE'/g" html/index.html
git add html/index.html
```

**PlatformIO Extra Script** (`version_inject.py`):
```python
Import("env")
import subprocess

def get_firmware_version():
    try:
        version = subprocess.check_output(["git", "describe", "--tags", "--always"]).decode().strip()
        return version
    except:
        return "dev"

firmware_version = get_firmware_version()
env.Append(CPPDEFINES=[("FIRMWARE_VERSION", f'\"{firmware_version}\"')])
```

Add to `platformio.ini`:
```ini
extra_scripts = pre:version_inject.py
```

## Best Practices

1. **Tag releases** in git: `git tag -a v1.0.0 -m "Release 1.0.0"`
2. **Keep CHANGELOG.md** to document changes
3. **Use pre-release tags** for beta/alpha: `v1.0.0-beta.1`
4. **Sync versions** between app and firmware for major releases
5. **Display in UI** for easy troubleshooting
6. **Include in logs** for debugging

## Quick Release Checklist

- [ ] Update CHANGELOG.md
- [ ] Update version in Config.h (firmware) if manual
- [ ] Update version in index.html (app) if manual
- [ ] Test build and deployment
- [ ] Create git tag: `git tag -a vX.Y.Z -m "Release X.Y.Z"`
- [ ] Push tag: `git push origin vX.Y.Z`
- [ ] Build and upload firmware
- [ ] Deploy web interface

## Future Enhancements

- [ ] Add update notification system (detect when new version available)
- [ ] OTA (Over-The-Air) firmware updates via web interface
- [ ] Version compatibility checking (app vs firmware)
- [ ] Auto-update check on boot
- [ ] Release notes display in About card
