// The Arduino tab: shows the code Blockly generates, compiles it, and sends the
// result to a board over Web Serial.
//
// Loaded as a module so it can import the flasher directly. The rest of the app
// is classic scripts sharing globals (Blockly, jQuery, Materialize), so this
// reaches for those off `window` rather than importing them.
//
// The code view is read-only and re-rendered from the workspace on every change.
// Blocks stay the single source of truth, which is why there is nothing to drag
// from one pane to the other.

import { flashArduinoUno } from "./arduino_flasher.js";

const ARDUINO_USB_FILTERS = [
    { usbVendorId: 0x2341 }, // Arduino LLC / Arduino SA
    { usbVendorId: 0x2a03 }, // Arduino.org
    { usbVendorId: 0x1a86 }, // CH340 (clone)
    { usbVendorId: 0x0403 }, // FTDI
    { usbVendorId: 0x10c4 }, // SiLabs CP210x
];

const CODE_REFRESH_DEBOUNCE_MS = 150;

const state = {
    port: null,
    hex: null,
    flashing: false,
    compiling: false,
};

const el = {};

function describePort(info) {
    const vid = info.usbVendorId?.toString(16)?.padStart(4, "0") ?? "????";
    const pid = info.usbProductId?.toString(16)?.padStart(4, "0") ?? "????";
    return `USB device ${vid}:${pid}`;
}

function translateFlashError(err) {
    const msg = (err?.message ?? String(err)).toLowerCase();
    if (msg.includes("sync") || msg.includes("timed out") || msg.includes("stk500")) {
        return "Couldn't talk to the bootloader. Press the reset button on the Arduino and try Upload again.";
    }
    if (msg.includes("port") && (msg.includes("open") || msg.includes("busy") || msg.includes("already"))) {
        return "The serial port is busy. Close the Arduino IDE's serial monitor and try again.";
    }
    if (msg.includes("disconnected") || msg.includes("not found") || msg.includes("no port")) {
        return "The Arduino was disconnected. Plug it back in and click Connect.";
    }
    return `Upload failed: ${err?.message ?? err}`;
}

const webSerialSupported = () => typeof navigator !== "undefined" && !!navigator.serial;

function setConsole(text) {
    el.console.textContent = text || "(compile output will appear here)";
}

function setFlashStatus(text, isError) {
    el.flashStatus.textContent = text || "";
    el.flashStatus.classList.toggle("arduino-flash-status--error", !!isError);
}

// The status box is red until a board is attached and green once one is, so the
// answer to "will Upload go anywhere?" is readable without reading.
function setBoardStatus(text, connected) {
    el.boardStatus.textContent = text;
    el.boardStatus.classList.toggle("arduino-board__status--connected", !!connected);
}

// A compiled hex only matches the code it was built from, so any workspace edit
// invalidates it — otherwise Upload would quietly flash a stale program.
function invalidateHex() {
    state.hex = null;
    refreshUploadButton();
}

function refreshUploadButton() {
    el.upload.disabled = !state.hex || !state.port || state.flashing || !webSerialSupported();
}

function refreshConnectButton() {
    el.connect.disabled = !webSerialSupported() || state.flashing;
}

export function renderCode() {
    if (!window.Blockly?.Arduino || !window.Blockly.mainWorkspace) return;

    const code = window.Blockly.Arduino.workspaceToCode();
    if (code === el.code.value) return;

    el.code.value = code;
    invalidateHex();
}

async function compile() {
    const config = window.FUSE_BLOCKLY;
    if (!config?.compileUrl) {
        setConsole("Compiling isn't available here — this page was opened outside FUSE.");
        return;
    }
    if (state.compiling) return;

    state.compiling = true;
    el.compile.disabled = true;
    el.compile.querySelector("span").textContent = "Compiling…";
    setConsole("Compiling…");
    setFlashStatus("");
    invalidateHex();

    try {
        const response = await fetch(config.compileUrl, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-CSRF-TOKEN": config.csrfToken,
                "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify({ sketch: el.code.value }),
        });

        if (response.status === 419) {
            setConsole("Your session expired. Reload the page and try again.");
            return;
        }
        if (!response.ok) {
            setConsole(`Compile service error (HTTP ${response.status}). Try again in a moment.`);
            return;
        }

        const result = await response.json();
        setConsole(result.console);

        if (result.status === "compiled" && result.hex) {
            state.hex = result.hex;
            window.Materialize?.toast("Compiled — ready to upload.", 3000);
        }
    } catch (e) {
        setConsole(`Couldn't reach the compile service: ${e?.message ?? e}`);
    } finally {
        state.compiling = false;
        el.compile.disabled = false;
        el.compile.querySelector("span").textContent = "Compile";
        refreshUploadButton();
    }
}

async function connect() {
    setFlashStatus("");
    try {
        state.port = await navigator.serial.requestPort({ filters: ARDUINO_USB_FILTERS });
        setBoardStatus(describePort(state.port.getInfo()), true);
    } catch (e) {
        if (e?.name === "NotFoundError") return; // the picker was dismissed
        setFlashStatus(`Could not connect: ${e?.message ?? e}`, true);
    }
    refreshUploadButton();
}

async function upload() {
    if (!state.hex) {
        setFlashStatus("Compile your program first.", true);
        return;
    }
    if (!state.port) {
        setFlashStatus("No Arduino connected. Click Connect first.", true);
        return;
    }

    state.flashing = true;
    refreshUploadButton();
    refreshConnectButton();
    setFlashStatus("Resetting board…");

    try {
        await flashArduinoUno(state.port, state.hex, {
            onProgress: (page, total) => setFlashStatus(`Writing page ${page} of ${total}…`),
        });
        setFlashStatus("Done — your program is running.");
    } catch (e) {
        setFlashStatus(translateFlashError(e), true);
    } finally {
        state.flashing = false;
        refreshUploadButton();
        refreshConnectButton();
    }
}

function debounce(fn, ms) {
    let timer;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

export function initArduinoTab() {
    el.code = document.getElementById("arduino_code");
    el.console = document.getElementById("arduino_console");
    el.compile = document.getElementById("arduino_compile");
    el.connect = document.getElementById("arduino_connect");
    el.upload = document.getElementById("arduino_upload");
    el.boardStatus = document.getElementById("arduino_board_status");
    el.flashStatus = document.getElementById("arduino_flash_status");
    el.unsupported = document.getElementById("arduino_unsupported");

    if (!el.code) return;

    el.compile.addEventListener("click", compile);
    el.connect.addEventListener("click", connect);
    el.upload.addEventListener("click", upload);

    if (!webSerialSupported()) {
        el.unsupported.style.display = "";
    } else {
        // A board authorised on a previous visit can be reused without prompting.
        navigator.serial.getPorts().then((ports) => {
            if (ports.length > 0 && !state.port) {
                state.port = ports[0];
                setBoardStatus(describePort(ports[0].getInfo()), true);
                refreshUploadButton();
            }
        });
        navigator.serial.addEventListener("disconnect", (event) => {
            if (event.target === state.port) {
                state.port = null;
                setBoardStatus("Not connected", false);
                refreshUploadButton();
            }
        });
    }

    refreshConnectButton();
    refreshUploadButton();

    // Track the workspace so the tab is never stale, whichever tab is showing.
    //
    // This Blockly predates workspace.addChangeListener(): here it is a global
    // that binds "blocklyWorkspaceChange" on the main workspace canvas, so it
    // only works once Blockly.inject() has run. init.js calls us after that.
    const onWorkspaceChange = debounce(renderCode, CODE_REFRESH_DEBOUNCE_MS);
    if (typeof window.Blockly?.addChangeListener === "function") {
        window.Blockly.addChangeListener(onWorkspaceChange);
    } else if (typeof window.Blockly?.mainWorkspace?.addChangeListener === "function") {
        window.Blockly.mainWorkspace.addChangeListener(onWorkspaceChange);
    }

    renderCode();
}

// init.js drives boot order (messages load, then init()), so expose these
// rather than binding to DOMContentLoaded and racing it.
window.initArduinoTab = initArduinoTab;
window.renderArduinoCode = renderCode;
