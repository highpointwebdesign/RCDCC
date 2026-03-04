(function () {

    const consoleOutput = document.getElementById("consoleOutput");

    // Helper function to format and display messages
    function captureConsoleMessage(args, level = 'log') {
        if (!consoleOutput) return;

        const levelPrefix = level !== 'log' ? `[${level.toUpperCase()}] ` : '';
        const msg = args.map(arg => {
            if (typeof arg === "object") {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch {
                    return "[Object]";
                }
            }
            return String(arg);
        }).join(" ");

        const line = document.createElement("div");
        line.textContent = levelPrefix + msg;
        
        // Add color styling for different log levels
        if (level === 'error') {
            line.style.color = '#ff5555';
        } else if (level === 'warn') {
            line.style.color = '#ffaa00';
        } else if (level === 'info') {
            line.style.color = '#00aaff';
        }

        consoleOutput.appendChild(line);

        // Auto-scroll
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    // Override console.log
    const originalLog = console.log;
    console.log = function (...args) {
        originalLog.apply(console, args);
        captureConsoleMessage(args, 'log');
    };

    // Override console.error
    const originalError = console.error;
    console.error = function (...args) {
        originalError.apply(console, args);
        captureConsoleMessage(args, 'error');
    };

    // Override console.warn
    const originalWarn = console.warn;
    console.warn = function (...args) {
        originalWarn.apply(console, args);
        captureConsoleMessage(args, 'warn');
    };

    // Override console.info
    const originalInfo = console.info;
    console.info = function (...args) {
        originalInfo.apply(console, args);
        captureConsoleMessage(args, 'info');
    };

})();