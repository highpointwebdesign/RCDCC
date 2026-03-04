#!/usr/bin/env python3
"""Extract CSS and JS from index.html into separate files"""

import os
import re

def extract_css_js():
    html_file = 'html/index.html'
    
    # Create directories
    os.makedirs('html/css', exist_ok=True)
    os.makedirs('html/js', exist_ok=True)
    
    print("Reading index.html...")
    with open(html_file, 'r', encoding='utf-8') as f:
        html_content = f.read()
    
    # Extract CSS content between <style> tags
    print("Extracting CSS...")
    css_match = re.search(r'<style>(.*?)</style>', html_content, re.DOTALL)
    if css_match:
        css_content = css_match.group(1).strip()
        with open('html/css/app.css', 'w', encoding='utf-8') as f:
            f.write(css_content)
        print(f"  ✓ Created html/css/app.css ({len(css_content)} chars)")
    
    # Extract console.js (first script block after body)
    print("Extracting console.js...")
    # Find the first script tag with the console override
    console_match = re.search(
        r'<script>\s*(\(function.*?onlineMode.*?\)\(\);)\s*</script>',
        html_content,
        re.DOTALL
    )
    if console_match:
        console_content = console_match.group(1).strip()
        with open('html/js/console.js', 'w', encoding='utf-8') as f:
            f.write(console_content)
        print(f"  ✓ Created html/js/console.js ({len(console_content)} chars)")
    
    # Extract main app.js (second script block)
    print("Extracting app.js...")
    # Find all script tags
    scripts = re.findall(r'<script>(.*?)</script>', html_content, re.DOTALL)
    if len(scripts) >= 2:
        app_js_content = scripts[1].strip()
        with open('html/js/app.js', 'w', encoding='utf-8') as f:
            f.write(app_js_content)
        print(f"  ✓ Created html/js/app.js ({len(app_js_content)} chars)")
    
    print("\n✓ Extraction complete!")

if __name__ == '__main__':
    extract_css_js()
