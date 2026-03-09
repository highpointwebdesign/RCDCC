(function () {

    const consoleOutput = document.getElementById("consoleOutput");
    const isCapacitorNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    const enableInAppConsole = localStorage.getItem('enableInAppConsole') === 'true';
    const shouldCaptureConsole = !!consoleOutput && (!isCapacitorNative || enableInAppConsole);
    const MAX_CONSOLE_LINES = 300;
    const MAX_MESSAGE_LENGTH = 1000;

    // Helper function to format and display messages
    function captureConsoleMessage(args, level = 'log') {
        if (!shouldCaptureConsole) return;

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

        const trimmedMsg = msg.length > MAX_MESSAGE_LENGTH
            ? msg.slice(0, MAX_MESSAGE_LENGTH) + ' ...[truncated]'
            : msg;

        const line = document.createElement("div");
        line.textContent = levelPrefix + trimmedMsg;
        
        // Add color styling for different log levels
        if (level === 'error') {
            line.style.color = '#ff5555';
        } else if (level === 'warn') {
            line.style.color = '#ffaa00';
        } else if (level === 'info') {
            line.style.color = '#00aaff';
        }

        consoleOutput.appendChild(line);

        // Keep log container bounded to avoid DOM/memory growth.
        while (consoleOutput.childElementCount > MAX_CONSOLE_LINES) {
            consoleOutput.removeChild(consoleOutput.firstElementChild);
        }

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

    if (isCapacitorNative && !enableInAppConsole) {
        originalInfo.call(console, '[Console] In-app console capture disabled on native platform (set localStorage.enableInAppConsole=true to re-enable).');
    }

})();