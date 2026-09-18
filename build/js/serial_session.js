// The serial connection to the board, shared by the Serial Monitor tab and the
// Serial Plotter window.
//
// Web Serial opens a port once, so the two can't each hold their own. This
// opens the port while either one is watching, closes it when neither is, and
// fans what arrives out to both — the same arrangement as the Arduino IDE,
// whose monitor and plotter share one connection and one baud rate.
//
// Upload needs the port too, so it suspends the session for the flash and
// resumes it after, which reconnects whatever was watching. Opening the port
// resets an Uno (DTR), so the sketch restarts each time the monitor or plotter
// connects; the IDE behaves the same way.

export const BAUD_RATES = [
    300, 600, 750, 1200, 2400, 4800, 9600, 19200, 31250, 38400, 57600, 74880,
    115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000,
];

const DEFAULT_BAUD_RATE = 9600;

// The Arduino IDE's options and labels, keyed so they survive a <select>.
export const LINE_ENDINGS = [
    { key: "none", label: "No Line Ending", text: "" },
    { key: "nl", label: "New Line", text: "\n" },
    { key: "cr", label: "Carriage Return", text: "\r" },
    { key: "nlcr", label: "Both NL & CR", text: "\r\n" },
];

const NOT_CONNECTED = "Not connected. Select a board and port to connect automatically.";

// The baud rate the sketch asks for, so the monitor can match it without the
// student having to know what a baud rate is. The Serial blocks all emit
// Serial.begin(9600) today, but the generator profile could change that.
export function sketchBaudRate(code) {
    const match = /Serial\.begin\(\s*(\d+)\s*\)/.exec(code ?? "");
    return match ? Number(match[1]) : null;
}

export function populateSerialSelects(endingSelect, baudSelect) {
    for (const { key, label } of LINE_ENDINGS) {
        endingSelect.add(new Option(label, key));
    }
    for (const rate of BAUD_RATES) {
        baudSelect.add(new Option(`${rate} baud`, String(rate)));
    }
}

export function syncSerialSelects(endingSelect, baudSelect, session) {
    endingSelect.value = session.lineEnding;
    const rate = String(session.baudRate);
    // A sketch can ask for a rate the list doesn't have (Serial.begin(14400));
    // show it rather than leave the select blank.
    if (![...baudSelect.options].some((o) => o.value === rate)) {
        baudSelect.add(new Option(`${rate} baud`, rate));
    }
    baudSelect.value = rate;
}

// What to tell the student when the session isn't connected; null when it is.
export function describeStatus({ state, message }) {
    switch (state) {
        case "connected":
            return null;
        case "connecting":
            return "Connecting…";
        case "suspended":
            return "Uploading. This reconnects when the upload finishes.";
        case "error":
            return message;
        default:
            return NOT_CONNECTED;
    }
}

function describeOpenError(err) {
    if (err?.name === "InvalidStateError") {
        return "The serial port is already open in another tab. Close it there and try again.";
    }
    return "Couldn't open the serial port. Close any other program using the Arduino, such as the Arduino IDE, and try again.";
}

// Events: "data" (detail: decoded text), "status" (detail: { state, message }),
// "settings" (detail: { baudRate, lineEnding }).
export class SerialSession extends EventTarget {
    constructor() {
        super();
        this.port = null;
        this.portLabel = "";
        this.baudRate = DEFAULT_BAUD_RATE;
        this.lineEnding = "nl";
        this.status = { state: "no-port", message: null };

        this._baudRateChosen = false;
        this._watchers = new Set();
        this._suspended = false;
        this._open = false;
        this._keepReading = false;
        this._reader = null;
        this._reading = null;
        // Open, close and write are all async and all touch the same port, so
        // they run one at a time in the order they were asked for.
        this._queue = Promise.resolve();
    }

    get connected() {
        return this.status.state === "connected";
    }

    setPort(port, label = "") {
        if (port === this.port) return this._queue;
        return this._enqueue(async () => {
            await this._close();
            this.port = port;
            this.portLabel = port ? label : "";
            this._setStatus(port ? "idle" : "no-port");
            await this._reconcile();
        });
    }

    // Each view calls watch() while it is showing and unwatch() when it stops;
    // the port is open while at least one is watching.
    watch(key) {
        this._watchers.add(key);
        return this._enqueue(() => this._reconcile());
    }

    unwatch(key) {
        this._watchers.delete(key);
        return this._enqueue(() => this._reconcile());
    }

    setBaudRate(rate) {
        this._baudRateChosen = true;
        return this._applyBaudRate(rate);
    }

    // Follows the sketch's Serial.begin() until the student picks a rate
    // themselves; after that, their choice stands.
    followSketchBaudRate(rate) {
        if (this._baudRateChosen || !rate) return this._queue;
        return this._applyBaudRate(rate);
    }

    setLineEnding(key) {
        if (key === this.lineEnding || !LINE_ENDINGS.some((e) => e.key === key)) return;
        this.lineEnding = key;
        this._emitSettings();
    }

    send(text) {
        return this._enqueue(async () => {
            if (!this._open || !this.port?.writable) {
                throw new Error("Not connected.");
            }
            const ending = LINE_ENDINGS.find((e) => e.key === this.lineEnding)?.text ?? "";
            const writer = this.port.writable.getWriter();
            try {
                await writer.write(new TextEncoder().encode(text + ending));
            } finally {
                writer.releaseLock();
            }
        });
    }

    // Upload's turn with the port. Resolves once the port is closed.
    suspend() {
        this._suspended = true;
        return this._enqueue(async () => {
            await this._close();
            if (this.port) this._setStatus("suspended");
        });
    }

    resume() {
        this._suspended = false;
        return this._enqueue(async () => {
            if (this.port) this._setStatus("idle");
            await this._reconcile();
        });
    }

    _enqueue(task) {
        const run = this._queue.then(task);
        // A failed task must not wedge everything queued behind it.
        this._queue = run.catch(() => {});
        return run;
    }

    _applyBaudRate(rate) {
        const baudRate = Number(rate);
        if (!Number.isFinite(baudRate) || baudRate <= 0 || baudRate === this.baudRate) {
            return this._queue;
        }
        this.baudRate = baudRate;
        this._emitSettings();
        // A port's speed is fixed when it opens, so a change means a reconnect.
        return this._enqueue(async () => {
            if (!this._open) return;
            await this._close();
            await this._reconcile();
        });
    }

    async _reconcile() {
        const wanted = !!this.port && this._watchers.size > 0 && !this._suspended;
        if (wanted && !this._open) {
            await this._openPort();
        } else if (!wanted && this._open) {
            await this._close();
            if (this.port) this._setStatus(this._suspended ? "suspended" : "idle");
        }
    }

    async _openPort() {
        const port = this.port;
        this._setStatus("connecting");
        try {
            await port.open({ baudRate: this.baudRate });
        } catch (e) {
            this._setStatus("error", describeOpenError(e));
            return;
        }
        this._open = true;
        this._keepReading = true;
        this._reading = this._readLoop(port);
        this._setStatus("connected");
    }

    async _readLoop(port) {
        const decoder = new TextDecoder();
        // Framing, parity, break and overrun errors are recoverable: the port
        // hands out a fresh readable and the outer loop picks it up. A lost
        // device is not — readable goes null and the loop ends.
        while (port.readable && this._keepReading) {
            const reader = port.readable.getReader();
            this._reader = reader;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value?.length) {
                        this._emit("data", decoder.decode(value, { stream: true }));
                    }
                }
            } catch (_) {
                // see above
            } finally {
                reader.releaseLock();
                this._reader = null;
            }
        }

        try { await port.close(); } catch (_) {}
        this._open = false;

        // Still meant to be reading, so this wasn't _close(): the board was
        // unplugged or the port failed underneath us.
        if (this._keepReading) {
            this._keepReading = false;
            this._setStatus("error", "The connection to the Arduino was lost.");
        }
    }

    async _close() {
        if (!this._open) return;
        this._keepReading = false;
        try { await this._reader?.cancel(); } catch (_) {}
        await this._reading;
        this._reading = null;
    }

    _setStatus(state, message = null) {
        if (this.status.state === state && this.status.message === message) return;
        this.status = { state, message };
        this._emit("status", this.status);
    }

    _emitSettings() {
        this._emit("settings", { baudRate: this.baudRate, lineEnding: this.lineEnding });
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
