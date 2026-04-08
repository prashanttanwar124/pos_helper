const express = require('express');
const cors = require('cors');
const { NFC, TAG_ISO_14443_3 } = require('nfc-pcsc');

const HOST = '127.0.0.1';
const HTTP_PORT = 8090;
const TAG_TIMEOUT_MS = 20000;
const RECENT_ACTION_LIMIT = 25;
const NTAG215_CAPACITY_BYTE = 0x3e;
const NTAG215_FIRST_USER_PAGE = 4;
const NTAG215_LAST_USER_PAGE = 129;
const NTAG215_USER_BYTES =
  (NTAG215_LAST_USER_PAGE - NTAG215_FIRST_USER_PAGE + 1) * 4;
const NTAG215_DYNAMIC_LOCK_PAGE = 130;
const NTAG215_DYNAMIC_LOCK_BYTE_0 = 0xff;
const NTAG215_DYNAMIC_LOCK_BYTE_1 = 0x00;
const NTAG215_DYNAMIC_LOCK_BYTE_2_MASK = 0x0f;
const NTAG215_CONFIG_PAGE_0 = 131;
const NTAG215_CONFIG_PAGE_1 = 132;

const URI_PREFIX_MAP = {
  0x00: '',
  0x01: 'http://www.',
  0x02: 'https://www.',
  0x03: 'http://',
  0x04: 'https://',
};

const state = {
  readerConnected: false,
  readerName: null,
  lastSeenUid: null,
  lastReadValue: null,
  lastReadAt: null,
  lastError: null,
  actions: [],
  pendingOperation: null,
  tokenHistory: new Map(),
};

const app = express();
app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const isLocalOrigin =
        /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
        /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin);
      const isAllowedHostedOrigin =
        /^https:\/\/maniratn\.on-forge\.com$/i.test(origin);

      if (isLocalOrigin || isAllowedHostedOrigin) {
        callback(null, true);
        return;
      }

      callback(new Error('Only local origins and https://maniratn.on-forge.com are allowed.'));
    },
  })
);

function nowIso() {
  return new Date().toISOString();
}

function logAction(type, message, extra = {}) {
  const entry = {
    timestamp: nowIso(),
    type,
    message,
  };

  if (extra && Object.keys(extra).length > 0) {
    entry.details = extra;
  }

  state.actions.unshift(entry);
  state.actions = state.actions.slice(0, RECENT_ACTION_LIMIT);

  const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${entry.timestamp}] ${type}: ${message}${suffix}`);
}

function setLastError(error) {
  state.lastError = error.message;
  logAction('error', error.message);
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeUid(uid) {
  return String(uid || '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();
}

function sanitizeCard(card) {
  return {
    uid: normalizeUid(card.uid),
    type: card.type || null,
    standard: card.standard || null,
    atr: card.atr ? card.atr.toString('hex').toUpperCase() : null,
  };
}

function getReaderStatus() {
  return {
    connected: state.readerConnected,
    reader: state.readerName,
  };
}

function getPendingOperationInfo() {
  if (!state.pendingOperation) {
    return null;
  }

  return {
    type: state.pendingOperation.type,
    started_at: state.pendingOperation.startedAt,
    timeout_ms: state.pendingOperation.timeoutMs,
  };
}

function requireReader() {
  initializeNfc();
  if (!state.readerConnected || !state.readerName) {
    throw createHttpError(503, 'No reader found. Connect the ACR122U reader and try again.');
  }
}

function ensureNoPendingOperation() {
  if (state.pendingOperation) {
    throw createHttpError(
      409,
      `Another NFC operation is already running: ${state.pendingOperation.type}`
    );
  }
}

function validateToken(token) {
  if (!token || typeof token !== 'string') {
    throw createHttpError(400, 'token is required');
  }
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw createHttpError(400, 'url is required');
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid_protocol');
    }
  } catch (_error) {
    throw createHttpError(400, 'url must be a valid http or https URL');
  }
}

function validatePage(page) {
  if (!Number.isInteger(page) || page < NTAG215_FIRST_USER_PAGE || page > NTAG215_LAST_USER_PAGE) {
    throw createHttpError(
      400,
      `page must be an integer between ${NTAG215_FIRST_USER_PAGE} and ${NTAG215_LAST_USER_PAGE}`
    );
  }
}

function validateHex4(data) {
  if (typeof data !== 'string' || !/^[a-fA-F0-9]{8}$/.test(data)) {
    throw createHttpError(400, 'data must be an 8-character hex string representing 4 bytes');
  }
}

function ensureIso14443_3(card) {
  if (card.standard !== TAG_ISO_14443_3) {
    throw createHttpError(400, 'Unsupported tag type. Only NTAG215 is supported.');
  }
}

async function readPage(reader, page) {
  try {
    return await reader.read(page, 4);
  } catch (error) {
    if (!supportsAcr122uDirectTransmit(reader) || !isStatus6300ReadError(error)) {
      throw error;
    }

    logAction('warning', 'Standard read failed; retrying with ACR122U direct read.', {
      page,
      reader: readerName(reader),
    });

    try {
      return await directReadPageAcr122u(reader, page);
    } catch (fallbackError) {
      throw createReadFailureError(page, fallbackError);
    }
  }
}

async function readPages(reader, startPage, endPage) {
  const length = (endPage - startPage + 1) * 4;
  try {
    return await reader.read(startPage, length);
  } catch (error) {
    if (!supportsAcr122uDirectTransmit(reader) || !isStatus6300ReadError(error)) {
      throw error;
    }

    logAction('warning', 'Standard fast read failed; retrying with ACR122U direct fast read.', {
      startPage,
      endPage,
      reader: readerName(reader),
    });

    try {
      return await directFastReadAcr122u(reader, startPage, endPage);
    } catch (_fallbackError) {
      throw createHttpError(
        500,
        'Tag read failed. The tag may require authentication or was removed too quickly.'
      );
    }
  }
}

async function writePagesSequential(reader, startPage, data) {
  for (let offset = 0; offset < data.length; offset += 4) {
    const page = startPage + offset / 4;
    const chunk = data.slice(offset, offset + 4);
    await writePage(reader, page, chunk);
  }
}

async function erasePagesSequential(reader, startPage, pageCount) {
  for (let index = 0; index < pageCount; index += 1) {
    await writePage(reader, startPage + index, Buffer.alloc(4, 0x00));
  }
}

function assertStoredUrl(parsed, expectedUrl) {
  if (!parsed || parsed.kind !== 'url') {
    throw createHttpError(500, 'Write verification failed: tag does not contain a readable URL.');
  }

  if (parsed.value !== expectedUrl) {
    throw createHttpError(
      500,
      `Write verification failed: expected ${expectedUrl} but found ${parsed.value}.`
    );
  }

  return parsed.value;
}

function readerName(reader) {
  return reader && reader.reader && reader.reader.name ? String(reader.reader.name) : '';
}

function supportsAcr122uDirectTransmit(reader) {
  return /acr122/i.test(readerName(reader));
}

function isStatus6300ReadError(error) {
  return Boolean(
    error &&
      typeof error.message === 'string' &&
      error.message.includes('Read operation failed: Status code: 0x6300')
  );
}

function isStatus6300WriteError(error) {
  return Boolean(error && typeof error.message === 'string' && error.message.includes('0x6300'));
}

function createReadFailureError(page, fallbackError) {
  const details =
    fallbackError && fallbackError.message ? ` Details: ${fallbackError.message}` : '';

  if (page === 3) {
    return createHttpError(
      400,
      'Unable to read the NTAG capability page. This card is likely not an NTAG21x/Ultralight tag, or it requires authentication before reading.' +
        details
    );
  }

  return createHttpError(
    500,
    `Tag read failed on page ${page}. The tag may require authentication or was removed too quickly.` +
      details
  );
}

async function transmitAcr122u(reader, payload, expectedResponseLength) {
  const packet = Buffer.concat([
    Buffer.from([0xff, 0x00, 0x00, 0x00, payload.length]),
    payload,
  ]);
  return reader.transmit(packet, expectedResponseLength);
}

function parseAcr122uDirectResponse(response, expectedDataLength, operationLabel) {
  if (!Buffer.isBuffer(response) || response.length < 5) {
    throw createHttpError(
      500,
      `${operationLabel} failed: invalid ACR122U response length ${response ? response.length : 0}.`
    );
  }

  const acrStatus = response.slice(-2).readUInt16BE(0);
  if (acrStatus !== 0x9000) {
    throw createHttpError(
      500,
      `${operationLabel} failed: ACR122U status 0x${acrStatus.toString(16).padStart(4, '0')}.`
    );
  }

  if (response[0] !== 0xd5 || response[1] !== 0x43 || response[2] !== 0x00) {
    throw createHttpError(500, `${operationLabel} failed: unexpected direct transmit response.`);
  }

  const data = response.slice(3, -2);
  if (typeof expectedDataLength === 'number' && data.length !== expectedDataLength) {
    throw createHttpError(
      500,
      `${operationLabel} failed: expected ${expectedDataLength} bytes, received ${data.length}.`
    );
  }

  return data;
}

async function directReadPageAcr122u(reader, page) {
  const response = await transmitAcr122u(
    reader,
    Buffer.from([0xd4, 0x42, 0x30, page]),
    3 + 16 + 2
  );
  const data = parseAcr122uDirectResponse(response, 16, `NTAG page ${page} direct read`);
  return data.slice(0, 4);
}

async function directFastReadAcr122u(reader, startPage, endPage) {
  const expectedDataLength = (endPage - startPage + 1) * 4;
  const response = await transmitAcr122u(
    reader,
    Buffer.from([0xd4, 0x42, 0x3a, startPage, endPage]),
    3 + expectedDataLength + 2
  );
  return parseAcr122uDirectResponse(
    response,
    expectedDataLength,
    `NTAG fast read ${startPage}-${endPage}`
  );
}

async function directWritePageAcr122u(reader, page, data) {
  const response = await transmitAcr122u(
    reader,
    Buffer.from([0xd4, 0x42, 0xa2, page, ...data]),
    3 + 2
  );
  parseAcr122uDirectResponse(response, 0, `NTAG page ${page} direct write`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writePage(reader, page, data) {
  if (!Buffer.isBuffer(data) || data.length !== 4) {
    throw createHttpError(500, `Internal error: NTAG page ${page} write requires exactly 4 bytes.`);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await reader.write(page, data);
      await delay(80);
      return;
    } catch (error) {
      if (!isStatus6300WriteError(error)) {
        throw error;
      }

      if (supportsAcr122uDirectTransmit(reader)) {
        logAction('warning', 'Standard write failed; retrying with ACR122U direct write.', {
          page,
          reader: readerName(reader),
        });

        try {
          await directWritePageAcr122u(reader, page, data);
          await delay(80);
          return;
        } catch (_fallbackError) {
          // Continue with the retry loop below.
        }
      }

      if (attempt === 4) {
        throw createHttpError(
          500,
          `NTAG write failed on page ${page} after multiple retries. Keep the tag flat on the reader and try again.`
        );
      }

      await delay(120);
    }
  }
}

async function ensureNtag215(reader, card) {
  ensureIso14443_3(card);

  const ccPage = await readPage(reader, 3);
  const capacityByte = ccPage[2];

  if (capacityByte !== NTAG215_CAPACITY_BYTE) {
    throw createHttpError(
      400,
      `Unsupported tag type. Expected NTAG215, detected capability byte 0x${capacityByte
        .toString(16)
        .padStart(2, '0')}.`
    );
  }

  return ccPage;
}

function buildUriNdef(url) {
  const urlBytes = Buffer.from(url, 'utf8');
  const ndefMessageLength = 5 + urlBytes.length;
  const tlvLength = 3 + ndefMessageLength;

  if (tlvLength > NTAG215_USER_BYTES) {
    throw createHttpError(400, 'URL is too long for an NTAG215 tag');
  }

  const minimumBytes = tlvLength + 1;
  const paddedLength = Math.ceil(minimumBytes / 4) * 4;
  const buffer = Buffer.alloc(paddedLength, 0x00);
  let offset = 0;

  buffer[offset++] = 0x03;
  buffer[offset++] = ndefMessageLength;
  buffer[offset++] = 0xd1;
  buffer[offset++] = 0x01;
  buffer[offset++] = 1 + urlBytes.length;
  buffer[offset++] = 0x55;
  buffer[offset++] = 0x00;
  urlBytes.copy(buffer, offset);
  offset += urlBytes.length;
  buffer[offset] = 0xfe;

  return buffer;
}

function parseTextRecord(payload) {
  if (payload.length === 0) {
    return '';
  }

  const status = payload[0];
  const languageLength = status & 0x3f;
  return payload.slice(1 + languageLength).toString('utf8');
}

function parseNdefFromUserMemory(data) {
  let offset = 0;

  while (offset < data.length) {
    const tlvType = data[offset];

    if (tlvType === 0x00) {
      offset += 1;
      continue;
    }

    if (tlvType === 0xfe) {
      return null;
    }

    if (tlvType !== 0x03) {
      throw createHttpError(400, 'Tag contains unsupported data format.');
    }

    let length = data[offset + 1];
    let cursor = offset + 2;

    if (length === 0xff) {
      length = data.readUInt16BE(offset + 2);
      cursor = offset + 4;
    }

    const message = data.slice(cursor, cursor + length);
    if (message.length < 5) {
      throw createHttpError(400, 'Tag contains an incomplete NDEF record.');
    }

    const header = message[0];
    const isShortRecord = Boolean(header & 0x10);
    const typeLength = message[1];

    if (!isShortRecord) {
      throw createHttpError(400, 'Only short NDEF records are supported in this helper.');
    }

    const payloadLength = message[2];
    const typeOffset = 3;
    const payloadOffset = typeOffset + typeLength;
    const type = message.slice(typeOffset, payloadOffset).toString('utf8');
    const payload = message.slice(payloadOffset, payloadOffset + payloadLength);

    if (type === 'U') {
      const prefix = URI_PREFIX_MAP[payload[0]] || '';
      return {
        kind: 'url',
        value: prefix + payload.slice(1).toString('utf8'),
      };
    }

    if (type === 'T') {
      return {
        kind: 'text',
        value: parseTextRecord(payload),
      };
    }

    return {
      kind: 'unknown',
      value: payload.toString('utf8'),
    };
  }

  return null;
}

async function readTagPayload(reader, card) {
  await ensureNtag215(reader, card);
  const userData = await readPages(
    reader,
    NTAG215_FIRST_USER_PAGE,
    NTAG215_LAST_USER_PAGE
  );
  return parseNdefFromUserMemory(userData);
}

async function isTagLocked(reader) {
  const staticLockPage = await readPage(reader, 2);
  const dynamicLockPage = await readPage(reader, NTAG215_DYNAMIC_LOCK_PAGE);
  return (
    staticLockPage[2] === 0xff &&
    staticLockPage[3] === 0xff &&
    dynamicLockPage[0] === NTAG215_DYNAMIC_LOCK_BYTE_0 &&
    dynamicLockPage[1] === NTAG215_DYNAMIC_LOCK_BYTE_1 &&
    (dynamicLockPage[2] & NTAG215_DYNAMIC_LOCK_BYTE_2_MASK) ===
      NTAG215_DYNAMIC_LOCK_BYTE_2_MASK
  );
}

async function getPasswordProtectionInfo(reader) {
  const configPage0 = await readPage(reader, NTAG215_CONFIG_PAGE_0);
  const configPage1 = await readPage(reader, NTAG215_CONFIG_PAGE_1);
  const auth0 = configPage0[3];
  const access = configPage1[0];

  return {
    auth0,
    prot: Boolean(access & 0x80),
  };
}

async function ensureWritableRange(reader, startPage, endPage) {
  const protection = await getPasswordProtectionInfo(reader);

  if (protection.auth0 === 0xff || protection.auth0 > endPage) {
    return;
  }

  if (protection.auth0 <= endPage) {
    const mode = protection.prot ? 'read/write' : 'write';
    throw createHttpError(
      400,
      `Tag requires password authentication for ${mode} access starting at page ${protection.auth0}. This helper cannot write protected NTAG215 tags.`
    );
  }
}

async function lockTagReadOnly(reader, card) {
  await ensureNtag215(reader, card);

  if (await isTagLocked(reader)) {
    throw createHttpError(400, 'Tag is already locked.');
  }

  const staticLockPage = await readPage(reader, 2);
  staticLockPage[2] = 0xff;
  staticLockPage[3] = 0xff;
  await writePage(reader, 2, staticLockPage);

  const dynamicLockPage = await readPage(reader, NTAG215_DYNAMIC_LOCK_PAGE);
  dynamicLockPage[0] = NTAG215_DYNAMIC_LOCK_BYTE_0;
  dynamicLockPage[1] = NTAG215_DYNAMIC_LOCK_BYTE_1;
  dynamicLockPage[2] = NTAG215_DYNAMIC_LOCK_BYTE_2_MASK;
  await writePage(reader, NTAG215_DYNAMIC_LOCK_PAGE, dynamicLockPage);

  if (!(await isTagLocked(reader))) {
    throw createHttpError(
      500,
      'Lock command did not persist on the tag. Keep the tag on the reader and try again.'
    );
  }
}

function trackTokenWrite(token, uid, url) {
  state.tokenHistory.set(token, {
    uid,
    url,
    timestamp: nowIso(),
  });
}

function waitForCard(type, handler, options = {}) {
  requireReader();
  ensureNoPendingOperation();

  const timeoutMs = options.timeoutMs || TAG_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (state.pendingOperation && state.pendingOperation.timeoutHandle === timeoutHandle) {
        state.pendingOperation = null;
      }
      reject(createHttpError(408, 'No tag detected before timeout.'));
    }, timeoutMs);

    state.pendingOperation = {
      type,
      handler,
      resolve,
      reject,
      timeoutHandle,
      timeoutMs,
      startedAt: nowIso(),
      expectedUid: options.expectedUid || null,
    };
  });
}

async function completePendingOperation(reader, card) {
  const operation = state.pendingOperation;

  if (!operation) {
    return;
  }

  const uid = normalizeUid(card.uid);

  if (operation.expectedUid && uid !== operation.expectedUid) {
    logAction(
      'wait',
      `Ignoring different tag during ${operation.type}. Expected ${operation.expectedUid}, got ${uid}.`
    );
    return;
  }

  state.pendingOperation = null;
  clearTimeout(operation.timeoutHandle);

  try {
    const result = await operation.handler(reader, card);
    operation.resolve(result);
  } catch (error) {
    operation.reject(error);
  }
}

function sendSuccess(res, payload) {
  res.json({
    success: true,
    ...payload,
  });
}

function sendError(res, error) {
  const status = error.status || 500;
  const message =
    error.message || 'Unexpected NFC helper error.';

  if (status >= 500) {
    setLastError(error);
  } else {
    logAction('warning', message);
  }

  res.status(status).json({
    success: false,
    message,
  });
}

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    running: true,
    host: HOST,
    port: HTTP_PORT,
    reader_connected: state.readerConnected,
    reader_name: state.readerName,
    pending_operation: getPendingOperationInfo(),
    last_seen_uid: state.lastSeenUid,
    last_read_at: state.lastReadAt,
    last_error: state.lastError,
    recent_actions: state.actions,
  });
});

app.post('/nfc/read', async (_req, res) => {
  try {
    const result = await waitForCard('read', async (reader, card) => {
      const uid = normalizeUid(card.uid);
      const parsed = await readTagPayload(reader, card);

      state.lastSeenUid = uid;
      state.lastReadAt = nowIso();
      state.lastReadValue = parsed ? parsed.value : null;

      logAction('read', 'Tag read successfully.', { uid, kind: parsed ? parsed.kind : null });

      return {
        nfc_uid: uid,
        content: parsed ? parsed.value : null,
        content_type: parsed ? parsed.kind : null,
        message: parsed ? 'Tag read successfully' : 'Tag is empty',
      };
    });

    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/nfc/write-url', async (req, res) => {
  try {
    const { token, url } = req.body || {};
    validateToken(token);
    validateUrl(url);

    const result = await waitForCard('write-url', async (reader, card) => {
      const uid = normalizeUid(card.uid);
      await ensureNtag215(reader, card);

      if (await isTagLocked(reader)) {
        throw createHttpError(400, 'Tag is already locked.');
      }

      const existing = await readTagPayload(reader, card);
      if (existing && existing.kind === 'url' && existing.value === url) {
        trackTokenWrite(token, uid, url);
        logAction('write', 'Skipped write because the same URL is already present.', {
          token,
          uid,
          url,
        });

        return {
          nfc_uid: uid,
          token,
          url,
          message: 'Tag already contains this URL',
        };
      }

      const payload = buildUriNdef(url);
      const lastPayloadPage = NTAG215_FIRST_USER_PAGE + payload.length / 4 - 1;
      await ensureWritableRange(reader, NTAG215_FIRST_USER_PAGE, lastPayloadPage);
      await writePagesSequential(reader, NTAG215_FIRST_USER_PAGE, payload);
      const verified = await readTagPayload(reader, card);
      const storedUrl = assertStoredUrl(verified, url);
      trackTokenWrite(token, uid, storedUrl);

      logAction('write', 'Tag written and verified successfully.', {
        token,
        uid,
        url: storedUrl,
      });

      return {
        nfc_uid: uid,
        token,
        url: storedUrl,
        message: 'Tag written and verified successfully',
      };
    });

    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/nfc/lock', async (req, res) => {
  try {
    const { token } = req.body || {};
    validateToken(token);

    const previousWrite = state.tokenHistory.get(token);
    const expectedUid = previousWrite ? previousWrite.uid : null;

    const result = await waitForCard(
      'lock',
      async (reader, card) => {
        const uid = normalizeUid(card.uid);
        await lockTagReadOnly(reader, card);

        logAction('lock', 'Tag locked successfully.', { token, uid });

        return {
          nfc_uid: uid,
          token,
          message: 'Tag locked successfully',
        };
      },
      { expectedUid }
    );

    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/nfc/test-write-page', async (req, res) => {
  try {
    const { page, data } = req.body || {};
    validatePage(page);
    validateHex4(data);

    const result = await waitForCard('test-write-page', async (reader, card) => {
      const uid = normalizeUid(card.uid);
      await ensureNtag215(reader, card);

      const before = await readPage(reader, page);
      const writeData = Buffer.from(data, 'hex');
      await writePage(reader, page, writeData);
      const after = await readPage(reader, page);

      logAction('diagnostic', 'Page write diagnostic completed.', {
        uid,
        page,
        before: before.toString('hex').toUpperCase(),
        wrote: writeData.toString('hex').toUpperCase(),
        after: after.toString('hex').toUpperCase(),
      });

      return {
        nfc_uid: uid,
        page,
        before: before.toString('hex').toUpperCase(),
        wrote: writeData.toString('hex').toUpperCase(),
        after: after.toString('hex').toUpperCase(),
        message: 'Page write diagnostic completed',
      };
    });

    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/attendance/read-card', async (_req, res) => {
  try {
    const result = await waitForCard('attendance-read', async (_reader, card) => {
      const uid = normalizeUid(card.uid);
      logAction('attendance', 'Attendance card read successfully.', { uid });
      return {
        nfc_uid: uid,
        message: 'Card UID read successfully',
      };
    });

    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error);
  }
});

app.use((error, _req, res, _next) => {
  sendError(res, error);
});

let server = null;
let nfc = null;
let helperStarted = false;
let nfcInitializationStarted = false;

function initializeNfc() {
  if (nfcInitializationStarted || nfc) {
    return;
  }

  nfcInitializationStarted = true;

  setImmediate(() => {
    try {
      nfc = new NFC();
      nfc.on('reader', handleReader);
      nfc.on('error', handleNfcError);
      logAction('startup', 'NFC reader monitoring initialized.');
    } catch (error) {
      nfc = null;
      setLastError(new Error(`NFC initialization failed: ${error.message}`));
    }
  });
}

function handleReader(reader) {
  state.readerConnected = true;
  state.readerName = reader.reader.name;
  logAction('reader', 'Reader connected.', { reader: reader.reader.name });

  reader.on('card', async (card) => {
    state.lastSeenUid = normalizeUid(card.uid);
    logAction('card', 'Card detected.', sanitizeCard(card));

    try {
      await completePendingOperation(reader, card);
    } catch (error) {
      setLastError(error);
    }
  });

  reader.on('card.off', (card) => {
    logAction('card', 'Card removed.', sanitizeCard(card));
  });

  reader.on('error', (error) => {
    setLastError(new Error(`Reader error (${reader.reader.name}): ${error.message}`));
  });

  reader.on('end', () => {
    logAction('reader', 'Reader disconnected.', { reader: reader.reader.name });

    if (state.readerName === reader.reader.name) {
      state.readerConnected = false;
      state.readerName = null;
    }
  });
}

function handleNfcError(error) {
  setLastError(new Error(`NFC error: ${error.message}`));
}

function getHelperStatus() {
  return {
    running: helperStarted,
    host: HOST,
    port: HTTP_PORT,
    reader_connected: state.readerConnected,
    reader_name: state.readerName,
    pending_operation: getPendingOperationInfo(),
    last_seen_uid: state.lastSeenUid,
    last_read_at: state.lastReadAt,
    last_error: state.lastError,
    recent_actions: state.actions,
  };
}

function startHelper() {
  if (helperStarted) {
    return getHelperStatus();
  }

  server = app.listen(HTTP_PORT, HOST, () => {
    logAction('startup', `NFC helper listening on http://${HOST}:${HTTP_PORT}`);
  });
  server.on('error', (error) => {
    helperStarted = false;
    server = null;
    setLastError(new Error(`HTTP server failed to start: ${error.message}`));
  });

  helperStarted = true;
  return getHelperStatus();
}

function stopHelper() {
  return new Promise((resolve) => {
    if (!helperStarted) {
      resolve(getHelperStatus());
      return;
    }

    logAction('shutdown', 'Shutting down NFC helper.');

    if (state.pendingOperation) {
      clearTimeout(state.pendingOperation.timeoutHandle);
      state.pendingOperation.reject(createHttpError(503, 'NFC helper is shutting down.'));
      state.pendingOperation = null;
    }

    if (nfc) {
      nfc.removeListener('reader', handleReader);
      nfc.removeListener('error', handleNfcError);
      nfc.close();
      nfc = null;
    }
    nfcInitializationStarted = false;

    const currentServer = server;
    server = null;
    helperStarted = false;
    state.readerConnected = false;
    state.readerName = null;

    if (!currentServer) {
      resolve(getHelperStatus());
      return;
    }

    currentServer.close(() => {
      resolve(getHelperStatus());
    });
  });
}

async function shutdownAndExit() {
  await stopHelper();
  process.exit(0);
}

process.on('SIGINT', shutdownAndExit);
process.on('SIGTERM', shutdownAndExit);

module.exports = {
  HOST,
  HTTP_PORT,
  app,
  state,
  startHelper,
  stopHelper,
  getHelperStatus,
};

if (require.main === module) {
  startHelper();
}
