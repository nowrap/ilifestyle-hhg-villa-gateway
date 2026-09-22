'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

class BaresipControl extends EventEmitter {
  constructor({ host, port, reconnectMs = 1000, timeoutMs = 3000, maxFrameBytes = 1024 * 1024 }) {
    super();
    this.host = host;
    this.port = port;
    this.reconnectMs = reconnectMs;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.connected = false;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.socket?.destroy();
    this.#rejectPending(new Error('Baresip control stopped'));
  }

  command(command, params = '') {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) return reject(new Error('Baresip control is not connected'));
      const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const json = JSON.stringify({ command, ...(params ? { params } : {}), token });
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`Baresip ${command} timeout`));
      }, this.timeoutMs);
      this.pending.set(token, { resolve, reject, timer, command });
      this.socket.write(`${Buffer.byteLength(json)}:${json},`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(token);
        reject(error);
      });
    });
  }

  #connect() {
    if (this.stopped || this.socket) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.on('connect', () => {
      this.connected = true;
      this.emit('connect');
    });
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.emit('connectionError', error));
    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.buffer = Buffer.alloc(0);
      this.#rejectPending(new Error('Baresip control disconnected'));
      this.emit('disconnect');
      if (!this.stopped) setTimeout(() => this.#connect(), this.reconnectMs).unref();
    });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxFrameBytes) {
      this.socket?.destroy(new Error('Baresip control frame exceeds size limit'));
      return;
    }
    while (this.buffer.length) {
      const colon = this.buffer.indexOf(58);
      if (colon === 0 || colon > 20) {
        this.socket?.destroy(new Error('Invalid Baresip control frame length'));
        return;
      }
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxFrameBytes) {
        this.socket?.destroy(new Error('Invalid Baresip control frame'));
        return;
      }
      const end = colon + 1 + length;
      if (this.buffer.length < end + 1) return;
      if (this.buffer[end] !== 44) {
        this.socket?.destroy(new Error('Invalid Baresip netstring terminator'));
        return;
      }
      const raw = this.buffer.subarray(colon + 1, end).toString();
      this.buffer = this.buffer.subarray(end + 1);
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      if (message.response === true && typeof message.token === 'string') {
        const pending = this.pending.get(message.token);
        if (!pending) continue;
        this.pending.delete(message.token);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.data || '');
        else pending.reject(new Error(`Baresip ${pending.command}: ${message.data || 'failed'}`));
      } else if (message.event === true && message.class === 'call') {
        this.emit('callEvent', message);
      }
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = { BaresipControl };
