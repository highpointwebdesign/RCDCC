#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Create directories
const dirs = ['html/css', 'html/js'];
dirs.forEach(dir => {
   if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

console.log('Reading index.html...');
const htmlFile = 'html/index.html';
const htmlContent = fs.readFileSync(htmlFile, 'utf-8');

// Extract CSS
console.log('Extracting CSS...');
const cssMatch = htmlContent.match(/<style>([\s\S]*?)<\/style>/);
if (cssMatch) {
    const cssContent = cssMatch[1];
    fs.writeFileSync('html/css/app.css', cssContent.trim());
    console.log(`  ✓ Created html/css/app.css (${cssContent.length} chars)`);
}

// Extract scripts
console.log('Extracting JavaScript...');
const scriptMatches = htmlContent.match(/<script>([\s\S]*?)<\/script>/g);

if (scriptMatches && scriptMatches.length >= 2) {
    // First script: console override
    const consoleScript = scriptMatches[0].match(/<script>([\s\S]*?)<\/script>/)[1];
    fs.writeFileSync('html/js/console.js', consoleScript.trim());
    console.log(`  ✓ Created html/js/console.js (${consoleScript.length} chars)`);
    
    // Second script: main app
    const appScript = scriptMatches[1].match(/<script>([\s\S]*?)<\/script>/)[1];
    fs.writeFileSync('html/js/app.js', appScript.trim());
    console.log(`  ✓ Created html/js/app.js (${appScript.length} chars)`);
}

console.log('\n✓ Extraction complete!');
console.log('\nNext steps:');
console.log('1. Update index.html to reference the new files');
console.log('2. Update service worker to cache CSS/JS files');
console.log('3. Minify CSS and JS files');
