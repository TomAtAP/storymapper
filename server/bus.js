"use strict";

/**
 * Process-wide EventEmitter for storage-change notifications.
 * Storage emits 'change' after every successful save / delete / restore.
 * The WebSocket layer subscribes and forwards to browser clients.
 *
 * Event shape: { projectId, revision, savedAt, op, actor, originId? }
 */

const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(0);  // no warning when many WS clients subscribe

module.exports = bus;
