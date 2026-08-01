// In-house STK500v1 flasher for Arduino Uno (Optiboot bootloader, ATmega328P) over Web Serial.
// Replaces avrgirl-arduino, whose prebuilt bundle inlines an old version of the `stk500`
// npm package that assigns to an undeclared `match` global — illegal under ESM strict mode.

const PAGE_SIZE = 128;            // ATmega328P flash page size
const BAUD = 115200;              // Optiboot speed
const SYNC_TIMEOUT_MS = 500;
const CMD_TIMEOUT_MS = 5000;

const STK = {
    GET_SYNC: 0x30,
    ENTER_PROGMODE: 0x50,
    LEAVE_PROGMODE: 0x51,
    LOAD_ADDRESS: 0x55,
    PROG_PAGE: 0x64,
    CRC_EOP: 0x20,
    INSYNC: 0x14,
    OK: 0x10,
};

export function parseIntelHex(text) {
    const bytes = new Map();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith(":")) continue;
        const len = parseInt(line.substr(1, 2), 16);
        const addr = parseInt(line.substr(3, 4), 16);
        const type = parseInt(line.substr(7, 2), 16);
        if (type === 0x01) break;       // EOF record
        if (type !== 0x00) continue;    // skip extended-address records (Uno fits in 16-bit)
        for (let i = 0; i < len; i++) {
            bytes.set(addr + i, parseInt(line.substr(9 + i * 2, 2), 16));
        }
    }
    if (bytes.size === 0) throw new Error("Hex file is empty.");

    const maxAddr = Math.max(...bytes.keys());
    const pageCount = Math.ceil((maxAddr + 1) / PAGE_SIZE);
    const pages = [];
    for (let p = 0; p < pageCount; p++) {
        const base = p * PAGE_SIZE;
        const data = new Uint8Array(PAGE_SIZE).fill(0xff);
        let hasData = false;
        for (let i = 0; i < PAGE_SIZE; i++) {
            if (bytes.has(base + i)) {
                data[i] = bytes.get(base + i);
                hasData = true;
            }
        }
        if (hasData) pages.push({ address: base, data });
    }
    return pages;
}

class SerialReadBuffer {
    constructor(reader) {
        this.reader = reader;
        this.chunks = [];
        this.length = 0;
        this.waiters = [];
        this.closed = false;
        this._loop();
    }

    async _loop() {
        try {
            while (!this.closed) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value && value.length) {
                    this.chunks.push(value);
                    this.length += value.length;
                    this._wake();
                }
            }
        } catch (_) {
            // reader cancelled or stream closed
        }
    }

    _wake() {
        while (this.waiters.length && this.length >= this.waiters[0].n) {
            const { n, resolve } = this.waiters.shift();
            resolve(this._take(n));
        }
    }

    _take(n) {
        const out = new Uint8Array(n);
        let pos = 0;
        while (pos < n) {
            const head = this.chunks[0];
            const need = n - pos;
            if (head.length <= need) {
                out.set(head, pos);
                pos += head.length;
                this.chunks.shift();
            } else {
                out.set(head.subarray(0, need), pos);
                this.chunks[0] = head.subarray(need);
                pos += need;
            }
        }
        this.length -= n;
        return out;
    }

    discard() {
        this.chunks = [];
        this.length = 0;
    }

    read(n, timeoutMs) {
        if (this.length >= n) return Promise.resolve(this._take(n));
        return new Promise((resolve, reject) => {
            const waiter = { n, resolve };
            this.waiters.push(waiter);
            const timer = setTimeout(() => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) {
                    this.waiters.splice(i, 1);
                    reject(new Error(`Timed out waiting for ${n} bytes from Arduino`));
                }
            }, timeoutMs);
            const wrapped = waiter.resolve;
            waiter.resolve = (v) => { clearTimeout(timer); wrapped(v); };
        });
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function expectInSync(buf, label) {
    const resp = await buf.read(2, CMD_TIMEOUT_MS);
    if (resp[0] !== STK.INSYNC || resp[1] !== STK.OK) {
        const hex = Array.from(resp, (b) => b.toString(16).padStart(2, "0")).join(" ");
        throw new Error(`STK500 ${label} failed — got [${hex}]`);
    }
}

async function sync(buf, writer) {
    for (let attempt = 0; attempt < 5; attempt++) {
        buf.discard();
        await writer.write(new Uint8Array([STK.GET_SYNC, STK.CRC_EOP]));
        try {
            const resp = await buf.read(2, SYNC_TIMEOUT_MS);
            if (resp[0] === STK.INSYNC && resp[1] === STK.OK) return;
        } catch (_) {
            // retry
        }
    }
    throw new Error("STK500 sync failed — bootloader did not respond. Try pressing the reset button on the Arduino.");
}

async function loadAddress(buf, writer, byteAddr) {
    const wordAddr = byteAddr >> 1;
    await writer.write(new Uint8Array([
        STK.LOAD_ADDRESS,
        wordAddr & 0xff,
        (wordAddr >> 8) & 0xff,
        STK.CRC_EOP,
    ]));
    await expectInSync(buf, "load address");
}

async function progPage(buf, writer, data) {
    const cmd = new Uint8Array(5 + data.length);
    cmd[0] = STK.PROG_PAGE;
    cmd[1] = (data.length >> 8) & 0xff;
    cmd[2] = data.length & 0xff;
    cmd[3] = 0x46; // 'F' for flash
    cmd.set(data, 4);
    cmd[cmd.length - 1] = STK.CRC_EOP;
    await writer.write(cmd);
    await expectInSync(buf, "prog page");
}

export async function flashArduinoUno(port, hexText, { onProgress } = {}) {
    const pages = parseIntelHex(hexText);

    await port.open({ baudRate: BAUD });

    let reader;
    let writer;
    let buf;
    try {
        // Pulse DTR/RTS low to reset the board into the bootloader.
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        await sleep(250);
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await sleep(50);

        reader = port.readable.getReader();
        writer = port.writable.getWriter();
        buf = new SerialReadBuffer(reader);

        await sync(buf, writer);
        await writer.write(new Uint8Array([STK.ENTER_PROGMODE, STK.CRC_EOP]));
        await expectInSync(buf, "enter prog mode");

        for (let i = 0; i < pages.length; i++) {
            onProgress?.(i + 1, pages.length);
            await loadAddress(buf, writer, pages[i].address);
            await progPage(buf, writer, pages[i].data);
        }

        await writer.write(new Uint8Array([STK.LEAVE_PROGMODE, STK.CRC_EOP]));
        await expectInSync(buf, "leave prog mode");
    } finally {
        if (buf) buf.closed = true;
        try { if (reader) await reader.cancel(); } catch (_) {}
        try { if (reader) reader.releaseLock(); } catch (_) {}
        try { if (writer) await writer.close(); } catch (_) {}
        try { await port.close(); } catch (_) {}
    }
}
