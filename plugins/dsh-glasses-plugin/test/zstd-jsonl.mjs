// Reusable zstd-JSONL helpers for the disposable DSH runtime tests (T27-02+
// / T27-09). DSH persists each session-log line as its own concatenated Zstandard
// frame (first frame = the one-line session header). This mirrors the frame
// scanner in @deepseek-ai/dsh-session-persistence-jsonl so tests can SEED
// deterministic synthetic durable events into a disposable session without an
// LLM/vLLM (synthetic provenance), then let the real runtime cold-read them.
//
// Node's one-shot zlib zstd APIs only decode a SINGLE frame; concatenated frames
// require this boundary scanner + per-frame decode. Building frames uses
// zstdCompressSync per line, exactly what DSH itself writes.
//
// Node builtins only.

import { readFileSync, writeFileSync } from "node:fs";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216; // 0x28B52FFD

// Find complete frame ranges WITHOUT decompressing blocks (subset of DSH's
// scanZstdFrames). Throws on invalid complete structure; tolerates a trailing
// torn partial frame (returns it as tornStart, matching DSH's repair window).
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt zstd log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt zstd log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart: null };
}

function decodeFrame(frameBuffer) {
  return zstdDecompressSync(frameBuffer).toString("utf8");
}

/**
 * Read every already-complete line of a zstd-JSONL session log. DSH guarantees
 * ONLY the first frame decodes to exactly one header line; later frames may
 * batch several event lines, so each frame's decoded text is split on newlines.
 */
export function readLines(logPath) {
  const buffer = readFileSync(logPath);
  const { frames, tornStart } = scanFrames(buffer);
  const lines = [];
  for (const { start, end } of frames) {
    const text = decodeFrame(buffer.subarray(start, end));
    for (const segment of text.split("\n")) {
      if (segment.trim()) lines.push(segment);
    }
  }
  return { lines, tornStart };
}

/** Next sequence number DSH would assign, derived from the durable log tail. */
export function nextSeq(logPath) {
  const { lines, tornStart } = readLines(logPath);
  if (tornStart != null) {
    throw new Error(`corrupt zstd log ${logPath}: trailing torn frame at byte ${tornStart}`);
  }
  if (!lines.length) return 0;
  const last = JSON.parse(lines[lines.length - 1]);
  const seq = last?.seq;
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`corrupt zstd log ${logPath}: last event has invalid seq ${String(seq)}`);
  }
  return seq + 1;
}

/**
 * Append one JSON-line-per-zstd-frame batch of synthetic durable events.
 * Existing frames are untouched (only appended). Returns the next seq after.
 */
export function appendEvents(logPath, events) {
  const existing = readFileSync(logPath);
  const next = nextSeq(logPath);
  const baseTime = Date.now();
  const frames = events.map((event, index) => {
    if (typeof event.seq !== "undefined" && event.seq !== next + index) {
      throw new Error(`appendEvents: event ${index} declares seq ${event.seq}, expected ${next + index}`);
    }
    // DSH requires time as a safe integer (Unix epoch ms); stamp when absent.
    const stamped = {
      ...event,
      seq: next + index,
      time: Number.isSafeInteger(event.time) ? event.time : baseTime + index,
    };
    return zstdCompressSync(Buffer.from(JSON.stringify(stamped) + "\n", "utf8"));
  });
  writeFileSync(logPath, Buffer.concat([existing, ...frames]));
  return next + events.length;
}

/** Build standard synthetic M1 events (matches rc.2 SessionEventMap shapes). Sequence is assigned by appendEvents. */
export function syntheticUserEvent({ id, text, rpcId }) {
  return {
    type: "user/message",
    data: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user", rpcId },
    },
    surfaceOp: "append",
  };
}

export function syntheticAssistantEvent({ id, text, provider, model, turn, step }) {
  return {
    type: "assistant/message",
    data: {
      turn: turn ?? 0,
      step: step ?? 0,
      message: {
        id,
        role: "assistant",
        content: [{ type: "text", text }],
        source: { kind: "model", provider: provider ?? "synthetic", model: model ?? "harmless" },
      },
      usage: { inputTokens: 1, outputTokens: text.length },
    },
    surfaceOp: "append",
  };
}
