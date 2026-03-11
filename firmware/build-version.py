#!/usr/bin/env python3
"""
Firmware Version Auto-Increment Script
Automatically increments the build number in Config.h before each firmware build.
Version format: MAJOR.MINOR.BUILD (e.g., 1.0.42)
"""

Import("env")
import re
import os
from datetime import datetime

def increment_firmware_version():
    """Pre-build script to auto-increment firmware version"""
    
    # Get the path to Config.h
    project_dir = env.get("PROJECT_DIR")
    config_h_path = os.path.join(project_dir, "include", "Config.h")
    
    print("=" * 60)
    print("🔧 Firmware Version Auto-Increment")
    print("=" * 60)
    
    try:
        # Read Config.h
        with open(config_h_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Match: #define FIRMWARE_VERSION "1.0.0"
        match = re.search(r'#define FIRMWARE_VERSION\s+"(\d+)\.(\d+)\.(\d+)"', content)
        
        if not match:
            print("⚠️  Could not find FIRMWARE_VERSION in Config.h")
            return
        
        # Extract version components
        major = int(match.group(1))
        minor = int(match.group(2))
        build = int(match.group(3))
        
        current_version = f"{major}.{minor}.{build}"
        print(f"📋 Current version: {current_version}")
        
        # Increment build number
        new_build = build + 1
        new_version = f"{major}.{minor}.{new_build}"
        
        # Replace version in content
        new_content = re.sub(
            r'(#define FIRMWARE_VERSION\s+)"(\d+)\.(\d+)\.(\d+)"',
            rf'\1"{new_version}"',
            content
        )
        
        # Write back to Config.h
        with open(config_h_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        print(f"✅ New version: {new_version}")
        
        # Build timestamp
        build_date = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"📅 Build date: {build_date}")
        print("=" * 60)
        
    except Exception as e:
        print(f"❌ Error incrementing version: {e}")

# Execute the version increment
increment_firmware_version()
