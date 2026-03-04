#!/usr/bin/env node
const fs = require('fs');

console.log('Updating index.html...');
let htmlContent = fs.readFileSync('html/index.html', 'utf-8');

// Replace <style>...</style> with <link>
htmlContent = htmlContent.replace(
    /<style>[\s\S]*?<\/style>/,
    '    <link rel="stylesheet" href="css/app.css">'
);

// Replace first <script>...</script> with <script src="js/console.js"></script>
let firstScriptReplaced = false;
htmlContent = htmlContent.replace(
    /<script>[\s\S]*?<\/script>/,
    function(match) {
        if (!firstScriptReplaced) {
            firstScriptReplaced = true;
            return '    <script src="js/console.js"><\/script>';
        }
        return match;
    }
);

// Replace second <script>...</script> with <script src="js/app.js"></script>
let secondScriptCount = 0;
htmlContent = htmlContent.replace(
    /<script>[\s\S]*?<\/script>/,
    function(match) {
        secondScriptCount++;
        if (secondScriptCount === 1) {
            return '    <script src="js/app.js"><\/script>';
        }
        return match;
    }
);

// Add defer attribute for better performance
htmlContent = htmlContent.replace(
    /<script src="js\//g,
    '<script defer src="js/'
);

fs.writeFileSync('html/index.html', htmlContent);
console.log('  ✓ Updated html/index.html');

// Verify the changes
const lines = htmlContent.split('\n');
console.log('\n✓ Verification:');
lines.forEach((line, i) => {
    if (line.includes('app.css') || line.includes('console.js') || line.includes('app.js')) {
        console.log(`  Line ${i+1}: ${line.trim()}`);
    }
});

console.log('\n✓ HTML update complete!');
