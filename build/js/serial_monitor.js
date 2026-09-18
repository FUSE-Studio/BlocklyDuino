// The Serial Monitor tab, beside Compiler under the code view, as in the
// Arduino IDE. Selecting the tab is what connects it: arduino_tab.js calls
// setActive() as the tab gains and loses focus.

import { describeStatus, populateSerialSelects, syncSerialSelects } from "./serial_session.js";

// Enough scrollback to read back through a burst without the rebuild on each
// frame getting expensive. Characters are capped as well as lines, and long
// lines are broken: a sketch that uses Serial.print() and never a newline
// would otherwise grow one line forever.
const MAX_LINES = 1000;
const MAX_CHARS = 100000;
const MAX_LINE_LENGTH = 1000;

const CONNECTED_PLACEHOLDER = "Message (Enter to send message to the Arduino)";

function formatTime(date) {
    const pad = (n, width = 2) => String(n).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export class SerialMonitor {
    constructor(session, el) {
        this.session = session;
        this.el = el;
        this.active = false;
        this.autoscroll = true;
        this.timestamps = false;

        // Finished lines, plus the one still arriving. A line is stamped with
        // the time its first character came in, as the IDE does.
        this.lines = [];
        this.chars = 0;
        this.current = null;
        this.renderPending = false;

        populateSerialSelects(el.ending, el.baud);
        this._syncSettings();
        this._syncStatus();

        session.addEventListener("data", (e) => this._receive(e.detail));
        session.addEventListener("status", () => this._syncStatus());
        session.addEventListener("settings", () => this._syncSettings());

        el.message.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this._send();
            }
        });
        el.ending.addEventListener("change", () => session.setLineEnding(el.ending.value));
        el.baud.addEventListener("change", () => session.setBaudRate(el.baud.value));

        el.autoscroll.addEventListener("click", () => {
            this.autoscroll = !this.autoscroll;
            el.autoscroll.setAttribute("aria-pressed", String(this.autoscroll));
            if (this.autoscroll) this._scrollToEnd();
        });
        el.timestamps.addEventListener("click", () => {
            this.timestamps = !this.timestamps;
            el.timestamps.setAttribute("aria-pressed", String(this.timestamps));
            this._scheduleRender();
        });
        el.clear.addEventListener("click", () => {
            this.lines = [];
            this.chars = 0;
            this.current = null;
            this._scheduleRender();
        });
    }

    setActive(active) {
        if (active === this.active) return;
        this.active = active;
        if (active) {
            this.session.watch("monitor");
            this._scheduleRender();
        } else {
            this.session.unwatch("monitor");
        }
    }

    _receive(text) {
        const now = new Date();
        const parts = text.split("\n");
        parts.forEach((part, i) => {
            if (i > 0) this._finishLine(now);
            if (part) {
                this.current ??= { time: now, text: "" };
                this.current.text += part;
                if (this.current.text.length >= MAX_LINE_LENGTH) this._finishLine(now);
            }
        });
        while (this.lines.length > MAX_LINES || this.chars > MAX_CHARS) {
            this.chars -= this.lines.shift().text.length;
        }
        this._scheduleRender();
    }

    _finishLine(now) {
        const line = this.current ?? { time: now, text: "" };
        // println() ends lines with \r\n; the \r would otherwise ride along.
        line.text = line.text.replace(/\r$/, "");
        this.lines.push(line);
        this.chars += line.text.length;
        this.current = null;
    }

    // Output can arrive far faster than it can usefully be painted, so render
    // at most once a frame, and not at all while the tab is hidden.
    _scheduleRender() {
        if (this.renderPending || !this.active) return;
        this.renderPending = true;
        requestAnimationFrame(() => {
            this.renderPending = false;
            this._render();
        });
    }

    _render() {
        const lines = this.current ? [...this.lines, this.current] : this.lines;
        this.el.output.textContent = lines
            .map((line) => (this.timestamps ? `${formatTime(line.time)} -> ${line.text}` : line.text))
            .join("\n");
        if (this.autoscroll) this._scrollToEnd();
    }

    _scrollToEnd() {
        this.el.output.scrollTop = this.el.output.scrollHeight;
    }

    async _send() {
        const text = this.el.message.value;
        if (!this.session.connected) return;
        try {
            await this.session.send(text);
            this.el.message.value = "";
        } catch (e) {
            this._showNotice(`Couldn't send: ${e?.message ?? e}`);
        }
    }

    _syncStatus() {
        const notice = describeStatus(this.session.status);
        const connected = this.session.connected;
        this.el.message.disabled = !connected;
        this.el.message.placeholder = connected ? CONNECTED_PLACEHOLDER : notice;
        // Only failures get the red line; the other states are already said
        // by the placeholder, which is where the IDE says them.
        this._showNotice(this.session.status.state === "error" ? notice : "");
    }

    _showNotice(text) {
        this.el.notice.textContent = text;
        this.el.notice.hidden = !text;
    }

    _syncSettings() {
        syncSerialSelects(this.el.ending, this.el.baud, this.session);
    }
}
