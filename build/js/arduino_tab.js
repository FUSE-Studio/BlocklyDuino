// The Arduino tab: shows the code Blockly generates, compiles it, sends the
// result to a board over Web Serial, and reads back what the board prints —
// in the Serial Monitor tab and the Serial Plotter window, which share one
// connection (serial_session.js).
//
// Loaded as a module so it can import the flasher directly. The rest of the app
// is classic scripts sharing globals (Blockly, jQuery, Materialize), so this
// reaches for those off `window` rather than importing them.
//
// The code view is read-only and re-rendered from the workspace on every change.
// Blocks stay the single source of truth, which is why there is nothing to drag
// from one pane to the other.

import { flashArduinoUno } from "./arduino_flasher.js";
import { SerialMonitor } from "./serial_monitor.js";
import { SerialPlotter } from "./serial_plotter.js";
import { SerialSession, sketchBaudRate } from "./serial_session.js";

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

const serial = new SerialSession();
const plotter = new SerialPlotter(serial);
let monitor = null;

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

// Like Upload, there's nothing to plot until a board is attached. A window
// that is already open stays open through a disconnect and reconnects itself.
function refreshPlotterButton() {
    el.plotter.disabled = !state.port || !webSerialSupported();
}

function setPort(port) {
    state.port = port;
    serial.setPort(port, port ? describePort(port.getInfo()) : "");
    if (port) {
        setBoardStatus(describePort(port.getInfo()), true);
    } else {
        setBoardStatus("Not connected", false);
    }
    refreshUploadButton();
    refreshPlotterButton();
}

// Compiler | Serial Monitor. Selecting the monitor is what connects it.
function selectConsoleTab(name) {
    const monitorSelected = name === "monitor";
    el.tabCompiler.setAttribute("aria-selected", String(!monitorSelected));
    el.tabMonitor.setAttribute("aria-selected", String(monitorSelected));
    el.tabCompiler.tabIndex = monitorSelected ? -1 : 0;
    el.tabMonitor.tabIndex = monitorSelected ? 0 : -1;
    el.panelCompiler.hidden = monitorSelected;
    el.panelMonitor.hidden = !monitorSelected;
    el.monitorTools.hidden = !monitorSelected;
    monitor.setActive(monitorSelected);
}

export function renderCode() {
    if (!window.Blockly?.Arduino || !window.Blockly.mainWorkspace) return;

    const code = window.Blockly.Arduino.workspaceToCode();
    if (code === el.code.value) return;

    el.code.value = code;
    invalidateHex();
    serial.followSketchBaudRate(sketchBaudRate(code));
}

async function compile() {
    const config = window.FUSE_BLOCKLY;
    if (!config?.compileUrl) {
        setConsole("Compiling isn't available here — this page was opened outside FUSE.");
        selectConsoleTab("compiler");
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
        // A student watching the monitor stays on it when the compile works
        // (the toast says so); errors are only any use where they can be read.
        if (!state.hex) selectConsoleTab("compiler");
    }
}

async function connect() {
    setFlashStatus("");
    try {
        setPort(await navigator.serial.requestPort({ filters: ARDUINO_USB_FILTERS }));
    } catch (e) {
        if (e?.name === "NotFoundError") return; // the picker was dismissed
        setFlashStatus(`Could not connect: ${e?.message ?? e}`, true);
    }
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
        // The monitor or plotter may be holding the port, and the flasher
        // needs it to itself. Resuming reconnects whichever was watching.
        await serial.suspend();
        await flashArduinoUno(state.port, state.hex, {
            onProgress: (page, total) => setFlashStatus(`Writing page ${page} of ${total}…`),
        });
        setFlashStatus("Done — your program is running.");
    } catch (e) {
        setFlashStatus(translateFlashError(e), true);
    } finally {
        serial.resume();
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
    el.plotter = document.getElementById("arduino_plotter");
    el.tabList = document.getElementById("arduino_console_tablist");
    el.tabCompiler = document.getElementById("arduino_tab_compiler");
    el.tabMonitor = document.getElementById("arduino_tab_monitor");
    el.panelCompiler = document.getElementById("arduino_panel_compiler");
    el.panelMonitor = document.getElementById("arduino_panel_monitor");
    el.monitorTools = document.getElementById("arduino_monitor_tools");

    if (!el.code) return;

    monitor = new SerialMonitor(serial, {
        message: document.getElementById("arduino_monitor_message"),
        ending: document.getElementById("arduino_monitor_ending"),
        baud: document.getElementById("arduino_monitor_baud"),
        notice: document.getElementById("arduino_monitor_notice"),
        output: document.getElementById("arduino_monitor_output"),
        autoscroll: document.getElementById("arduino_monitor_autoscroll"),
        timestamps: document.getElementById("arduino_monitor_timestamps"),
        clear: document.getElementById("arduino_monitor_clear"),
    });

    el.compile.addEventListener("click", compile);
    el.connect.addEventListener("click", connect);
    el.upload.addEventListener("click", upload);

    el.tabCompiler.addEventListener("click", () => selectConsoleTab("compiler"));
    el.tabMonitor.addEventListener("click", () => selectConsoleTab("monitor"));
    // Arrow keys move between tabs, per the ARIA tabs pattern. With two
    // tabs, either arrow goes to the other one.
    el.tabList.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = el.tabMonitor.getAttribute("aria-selected") === "true" ? "compiler" : "monitor";
        selectConsoleTab(next);
        (next === "monitor" ? el.tabMonitor : el.tabCompiler).focus();
    });

    el.plotter.addEventListener("click", () => {
        setFlashStatus("");
        if (!plotter.open()) {
            setFlashStatus("The Serial Plotter opens in its own window. Allow pop-ups for this page and try again.", true);
        }
    });
    // Everything in the plotter window runs from this page, so it can't
    // outlive it.
    window.addEventListener("pagehide", () => plotter.close());

    if (!webSerialSupported()) {
        el.unsupported.style.display = "";
    } else {
        // A board authorised on a previous visit can be reused without prompting.
        navigator.serial.getPorts().then((ports) => {
            if (ports.length > 0 && !state.port) setPort(ports[0]);
        });
        navigator.serial.addEventListener("disconnect", (event) => {
            if (event.target === state.port) setPort(null);
        });
    }

    refreshConnectButton();
    refreshUploadButton();
    refreshPlotterButton();

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
