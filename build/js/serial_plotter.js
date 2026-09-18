// The Serial Plotter: its own window, laid out like the Arduino IDE's, opened
// from the board sidebar.
//
// The window is about:blank, so it shares this page's origin and CSP, and
// everything in it is driven from here — including drawing into its canvas.
// That is what lets it read from the same SerialSession as the Serial Monitor
// rather than fight it for the port. It dies with this page: arduino_tab.js
// closes it on pagehide, since nothing in it can run once this realm is gone.
//
// Input follows the IDE's plotter format: one sample per line, values
// separated by commas, tabs or spaces, each optionally "label:value".

import { describeStatus, populateSerialSelects, syncSerialSelects } from "./serial_session.js";

// The IDE plots the most recent 50 samples.
const MAX_POINTS = 50;

// Fixed order of first appearance, never cycled. Validated as a set against
// the white chart surface for colour-vision-deficiency separation; three of
// them sit under 3:1 contrast, which the legend's labels and the hover
// readout carry. Eight is the IDE's series limit too.
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

// A stream that never sends a newline shouldn't grow a buffer forever.
const MAX_PARTIAL_LINE = 4096;

const WINDOW_NAME = "fuse-serial-plotter";
const WINDOW_FEATURES = "popup,width=820,height=520";
const STYLESHEET = new URL("../css/serial_plotter.css", import.meta.url).href;

const FONT = "12px Roboto, 'Helvetica Neue', Arial, sans-serif";
const INK = { axis: "#4e5b61", grid: "#e6ebeb", crosshair: "#9aa5a8", surface: "#ffffff" };
const PAD = { top: 14, right: 20, bottom: 30, labelGap: 10, left: 12 };

// The IDE's "clear" glyph: a cross, then lines.
export const CLEAR_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 4l6 6M9 4l-6 6M13 7h8M3 13h18M3 19h18"/></svg>';

const SKELETON = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Serial Plotter</title>
<link rel="stylesheet" href="${STYLESHEET}">
</head>
<body>
<div class="plotter">
  <header class="plotter__head">
    <div class="plotter__legend" data-el="legend" role="group" aria-label="Series"></div>
    <div class="plotter__controls">
      <label class="plotter__switch">
        Interpolate
        <input type="checkbox" role="switch" data-el="interpolate">
        <span class="plotter__track" aria-hidden="true"></span>
      </label>
      <button type="button" class="plotter__stop" data-el="stop" aria-pressed="false">Stop</button>
      <button type="button" class="plotter__clear" data-el="clear" aria-label="Clear" title="Clear">${CLEAR_ICON}</button>
    </div>
  </header>
  <div class="plotter__chart" data-el="chart">
    <canvas data-el="canvas" role="img" aria-label="Plot of the values the Arduino sends"></canvas>
    <div class="plotter__notice" data-el="notice" role="status"></div>
    <div class="plotter__tip" data-el="tip" hidden></div>
  </div>
  <footer class="plotter__foot">
    <input type="text" data-el="message" placeholder="Type Message" aria-label="Message" autocomplete="off" spellcheck="false">
    <button type="button" class="plotter__send" data-el="send">Send</button>
    <select data-el="ending" aria-label="Line ending"></select>
    <select data-el="baud" class="plotter__baud" aria-label="Baud rate"></select>
  </footer>
</div>
</body>
</html>`;

// One line of output as { label -> value }. Unlabelled values are named by
// position ("value 1"), as the IDE names them; anything non-numeric is
// skipped, so debug text mixed into the stream doesn't plot.
export function parsePlotterLine(line) {
    const fields = [];
    for (const field of line.split(/[,\t]+/)) {
        const trimmed = field.trim();
        if (!trimmed) continue;
        // "temp: 21" is one labelled value; "a:1 b:2" and "1 2 3" are several.
        if (/^[^:]+:\s*\S+$/.test(trimmed)) fields.push(trimmed);
        else fields.push(...trimmed.split(/\s+/));
    }

    const values = new Map();
    fields.forEach((field, i) => {
        const colon = field.indexOf(":");
        const label = colon >= 0 ? field.slice(0, colon).trim() : `value ${i + 1}`;
        const raw = (colon >= 0 ? field.slice(colon + 1) : field).trim();
        const value = Number(raw);
        if (label && raw && Number.isFinite(value)) values.set(label, value);
    });
    return values;
}

// 1, 2, 2.5 or 5 times a power of ten, giving about `count` intervals.
// Integer axes skip 2.5.
function niceStep(span, count, integer = false) {
    const raw = span / Math.max(1, count);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / magnitude;
    const steps = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
    const step = steps.find((s) => norm <= s) * magnitude;
    return integer ? Math.max(1, Math.round(step)) : step;
}

function decimalsFor(step) {
    let d = 0;
    while (d < 10 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-6) d++;
    return d;
}

// Fritsch–Carlson monotone cubic: smooth, but never overshoots a sample the
// way a plain spline does, so a curve never shows a value that wasn't sent.
function traceMonotone(ctx, pts) {
    const n = pts.length;
    const slope = [];
    for (let i = 0; i < n - 1; i++) {
        slope.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
    }
    const tangent = [slope[0]];
    for (let i = 1; i < n - 1; i++) {
        tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
    }
    tangent.push(slope[n - 2]);
    for (let i = 0; i < n - 1; i++) {
        if (slope[i] === 0) {
            tangent[i] = tangent[i + 1] = 0;
            continue;
        }
        const a = tangent[i] / slope[i];
        const b = tangent[i + 1] / slope[i];
        const s = a * a + b * b;
        if (s > 9) {
            const t = 3 / Math.sqrt(s);
            tangent[i] = t * a * slope[i];
            tangent[i + 1] = t * b * slope[i];
        }
    }

    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < n - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const h = (q.x - p.x) / 3;
        ctx.bezierCurveTo(p.x + h, p.y + tangent[i] * h, q.x - h, q.y - tangent[i + 1] * h, q.x, q.y);
    }
}

export class SerialPlotter {
    constructor(session) {
        this.session = session;
        this.win = null;
        this.el = null;
        this.interpolate = false;
        this.paused = false;
        this._onData = (e) => this._receive(e.detail);
        this._onStatus = () => this._syncStatus();
        this._onSettings = () => syncSerialSelects(this.el.ending, this.el.baud, this.session);
    }

    // Call straight from a click handler, or the popup blocker steps in.
    // Returns false if the window couldn't be opened.
    open() {
        if (this.win && !this.win.closed) {
            this.win.focus();
            return true;
        }
        const win = window.open("", WINDOW_NAME, WINDOW_FEATURES);
        if (!win) return false;

        this.win = win;
        this.interpolate = false;
        this.paused = false;
        this.drawPending = false;
        this.pointerX = null;
        this._clearData();
        this._build();

        this.session.addEventListener("data", this._onData);
        this.session.addEventListener("status", this._onStatus);
        this.session.addEventListener("settings", this._onSettings);
        this.session.watch("plotter");

        win.addEventListener("pagehide", () => this._closed());
        // pagehide is the normal signal; this catches a window closed in a way
        // that skipped it, so the plotter never holds the port open unseen.
        this.closedPoll = setInterval(() => {
            if (win.closed) this._closed();
        }, 1000);
        return true;
    }

    close() {
        if (this.win && !this.win.closed) this.win.close();
        this._closed();
    }

    _closed() {
        if (!this.win) return;
        clearInterval(this.closedPoll);
        this.session.removeEventListener("data", this._onData);
        this.session.removeEventListener("status", this._onStatus);
        this.session.removeEventListener("settings", this._onSettings);
        this.session.unwatch("plotter");
        this.win = null;
        this.el = null;
    }

    _build() {
        const win = this.win;
        const doc = win.document;
        // Also resets a window of the same name left over from an earlier load.
        doc.open();
        doc.write(SKELETON);
        doc.close();

        const el = {};
        for (const node of doc.querySelectorAll("[data-el]")) el[node.dataset.el] = node;
        this.el = el;

        populateSerialSelects(el.ending, el.baud);
        syncSerialSelects(el.ending, el.baud, this.session);
        this._syncStatus();

        el.interpolate.addEventListener("change", () => {
            this.interpolate = el.interpolate.checked;
            this._scheduleDraw();
        });
        // The IDE's Stop drops what arrives while stopped, rather than
        // queueing it, so Start picks up from live data.
        el.stop.addEventListener("click", () => {
            this.paused = !this.paused;
            el.stop.textContent = this.paused ? "Start" : "Stop";
            el.stop.setAttribute("aria-pressed", String(this.paused));
        });
        el.clear.addEventListener("click", () => {
            this._clearData();
            this._scheduleDraw();
        });
        el.send.addEventListener("click", () => this._send());
        el.message.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this._send();
            }
        });
        el.ending.addEventListener("change", () => this.session.setLineEnding(el.ending.value));
        el.baud.addEventListener("change", () => this.session.setBaudRate(el.baud.value));

        el.canvas.addEventListener("pointermove", (e) => {
            this.pointerX = e.offsetX;
            this._scheduleDraw();
        });
        el.canvas.addEventListener("pointerleave", () => {
            this.pointerX = null;
            this._scheduleDraw();
        });
        win.addEventListener("resize", () => this._scheduleDraw());
        // Tick labels are measured, so redraw once Roboto has actually loaded.
        doc.fonts?.ready.then(() => this._scheduleDraw());

        this._scheduleDraw();
    }

    _clearData() {
        this.series = [];
        this.samples = [];
        this.nextIndex = 0;
        this.partial = "";
        if (this.el) this._renderLegend();
    }

    _receive(text) {
        const lines = (this.partial + text).split("\n");
        this.partial = lines.pop();
        if (this.partial.length > MAX_PARTIAL_LINE) this.partial = "";
        if (this.paused) return;

        for (const line of lines) {
            const values = parsePlotterLine(line.replace(/\r$/, ""));
            if (values.size) this._addSample(values);
        }
    }

    _addSample(values) {
        let legendChanged = false;
        for (const label of values.keys()) {
            if (this.series.length >= SERIES_COLORS.length) break;
            if (!this.series.some((s) => s.label === label)) {
                this.series.push({ label, color: SERIES_COLORS[this.series.length], visible: true });
                legendChanged = true;
            }
        }
        this.samples.push({ index: this.nextIndex++, values });
        if (this.samples.length > MAX_POINTS) this.samples.shift();

        if (legendChanged) this._renderLegend();
        this._scheduleDraw();
    }

    _renderLegend() {
        const doc = this.win.document;
        const items = this.series.map((series) => {
            const item = doc.createElement("label");
            item.className = "plotter__legend-item";
            const box = doc.createElement("input");
            box.type = "checkbox";
            box.checked = series.visible;
            box.style.setProperty("--series", series.color);
            box.addEventListener("change", () => {
                series.visible = box.checked;
                this._scheduleDraw();
            });
            // Labels come off the wire: text nodes only, never markup.
            item.append(box, doc.createTextNode(series.label));
            return item;
        });
        this.el.legend.replaceChildren(...items);
    }

    async _send() {
        if (!this.session.connected) return;
        try {
            await this.session.send(this.el.message.value);
            this.el.message.value = "";
        } catch (_) {
            // The status line already says why the port went away.
        }
    }

    _syncStatus() {
        const el = this.el;
        const notice = describeStatus(this.session.status);
        const connected = this.session.connected;
        el.notice.textContent = notice ?? "";
        el.notice.hidden = !notice;
        el.message.disabled = !connected;
        el.send.disabled = !connected;
        // The IDE titles the window with the port it is plotting.
        this.win.document.title = connected && this.session.portLabel
            ? `Serial Plotter · ${this.session.portLabel}`
            : "Serial Plotter";
    }

    _scheduleDraw() {
        if (this.drawPending || !this.win) return;
        this.drawPending = true;
        this.win.requestAnimationFrame(() => {
            this.drawPending = false;
            if (this.el) this._draw();
        });
    }

    _draw() {
        const { chart, canvas } = this.el;
        const width = chart.clientWidth;
        const height = chart.clientHeight;
        const dpr = this.win.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.font = FONT;

        const visible = this.series.filter((s) => s.visible);
        const samples = this.samples;

        // Y: fit the visible data, with a little grace so a line never runs
        // along the frame, on ticks a person would pick.
        let min = Infinity;
        let max = -Infinity;
        for (const sample of samples) {
            for (const s of visible) {
                const v = sample.values.get(s.label);
                if (v !== undefined) {
                    min = Math.min(min, v);
                    max = Math.max(max, v);
                }
            }
        }
        if (min === Infinity) {
            min = 0;
            max = 1;
        }
        if (min === max) {
            const spread = Math.abs(min) * 0.1 || 1;
            min -= spread;
            max += spread;
        }
        const grace = (max - min) * 0.05;
        const yCount = Math.max(2, Math.floor((height - PAD.top - PAD.bottom) / 44));
        const yStep = niceStep(max - min + 2 * grace, yCount);
        const yLo = Math.floor((min - grace) / yStep);
        const yHi = Math.ceil((max + grace) / yStep);
        const yMin = yLo * yStep;
        const yMax = yHi * yStep;
        const decimals = decimalsFor(yStep);
        const yTicks = [];
        for (let i = yLo; i <= yHi; i++) {
            const v = i * yStep;
            yTicks.push({ v, label: (Math.abs(v) < yStep / 1e6 ? 0 : v).toFixed(decimals) });
        }

        const labelWidth = Math.max(...yTicks.map((t) => ctx.measureText(t.label).width));
        const plot = {
            left: PAD.left + Math.ceil(labelWidth) + PAD.labelGap,
            right: width - PAD.right,
            top: PAD.top,
            bottom: height - PAD.bottom,
        };
        const plotWidth = Math.max(1, plot.right - plot.left);
        const plotHeight = Math.max(1, plot.bottom - plot.top);

        // X: sample numbers. Until the window fills, the samples spread across
        // the full width, as the IDE's do.
        const xMin = samples[0]?.index ?? 0;
        const xMax = Math.max(samples.at(-1)?.index ?? 0, xMin + 1);
        const xStep = niceStep(xMax - xMin, Math.max(2, Math.floor(plotWidth / 90)), true);
        const xTicks = [];
        for (let i = Math.ceil(xMin / xStep) * xStep; i <= xMax; i += xStep) xTicks.push(i);

        const xAt = (i) => plot.left + ((i - xMin) / (xMax - xMin)) * plotWidth;
        const yAt = (v) => plot.bottom - ((v - yMin) / (yMax - yMin)) * plotHeight;

        // Grid and axis labels: recessive, so the data leads.
        ctx.lineWidth = 1;
        ctx.strokeStyle = INK.grid;
        ctx.beginPath();
        for (const t of yTicks) {
            const y = Math.round(yAt(t.v)) + 0.5;
            ctx.moveTo(plot.left, y);
            ctx.lineTo(plot.right, y);
        }
        for (const i of xTicks) {
            const x = Math.round(xAt(i)) + 0.5;
            ctx.moveTo(x, plot.top);
            ctx.lineTo(x, plot.bottom);
        }
        ctx.stroke();

        ctx.fillStyle = INK.axis;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (const t of yTicks) ctx.fillText(t.label, plot.left - PAD.labelGap, yAt(t.v));
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (const i of xTicks) ctx.fillText(String(i), xAt(i), plot.bottom + 8);

        // Series: 2px lines, broken wherever a sample didn't carry the value.
        ctx.save();
        ctx.beginPath();
        ctx.rect(plot.left, plot.top - 2, plotWidth, plotHeight + 4);
        ctx.clip();
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const s of visible) {
            ctx.strokeStyle = s.color;
            ctx.fillStyle = s.color;
            let run = [];
            const flush = () => {
                if (run.length === 1) {
                    ctx.beginPath();
                    ctx.arc(run[0].x, run[0].y, 2, 0, Math.PI * 2);
                    ctx.fill();
                } else if (run.length > 1) {
                    ctx.beginPath();
                    if (this.interpolate && run.length > 2) {
                        traceMonotone(ctx, run);
                    } else {
                        ctx.moveTo(run[0].x, run[0].y);
                        for (const p of run.slice(1)) ctx.lineTo(p.x, p.y);
                    }
                    ctx.stroke();
                }
                run = [];
            };
            for (const sample of samples) {
                const v = sample.values.get(s.label);
                if (v === undefined) flush();
                else run.push({ x: xAt(sample.index), y: yAt(v) });
            }
            flush();
        }
        ctx.restore();

        this._drawHover(ctx, plot, xMin, xMax, xAt, yAt, visible);
    }

    // The crosshair snaps to the nearest sample and the readout lists every
    // visible series there. It follows the pointer, not a sample, so it stays
    // put while the data streams underneath it.
    _drawHover(ctx, plot, xMin, xMax, xAt, yAt, visible) {
        const tip = this.el.tip;
        const px = this.pointerX;
        const inside = px !== null && px >= plot.left && px <= plot.right;
        const index = inside ? Math.round(xMin + ((px - plot.left) / (plot.right - plot.left)) * (xMax - xMin)) : null;
        const sample = index === null ? null : this.samples.find((s) => s.index === index);
        const rows = sample ? visible.filter((s) => sample.values.has(s.label)) : [];

        if (!rows.length) {
            tip.hidden = true;
            return;
        }

        const x = Math.round(xAt(sample.index)) + 0.5;
        ctx.strokeStyle = INK.crosshair;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.bottom);
        ctx.stroke();

        for (const s of rows) {
            const y = yAt(sample.values.get(s.label));
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = s.color;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = INK.surface;
            ctx.stroke();
        }

        const doc = this.win.document;
        const head = doc.createElement("div");
        head.className = "plotter__tip-head";
        head.textContent = `Sample ${sample.index}`;
        const lines = rows.map((s) => {
            const row = doc.createElement("div");
            row.className = "plotter__tip-row";
            const key = doc.createElement("span");
            key.className = "plotter__tip-key";
            key.style.setProperty("--series", s.color);
            const value = doc.createElement("strong");
            value.textContent = String(sample.values.get(s.label));
            const label = doc.createElement("span");
            label.textContent = s.label;
            row.append(key, value, label);
            return row;
        });
        tip.replaceChildren(head, ...lines);
        tip.hidden = false;

        const chartWidth = this.el.chart.clientWidth;
        const left = x + 12 + tip.offsetWidth <= chartWidth ? x + 12 : x - 12 - tip.offsetWidth;
        tip.style.transform = `translate(${Math.max(0, left)}px, ${plot.top}px)`;
    }
}
