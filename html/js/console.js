(function () {

    const originalLog = console.log;

    console.log = function (...args) {

        // Call normal console (for desktop)
        originalLog.apply(console, args);

        const consoleOutput = document.getElementById("consoleOutput");

        if (!consoleOutput) return;

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
        line.textContent = msg;

        consoleOutput.appendChild(line);

        // Auto-scroll
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    };

})();