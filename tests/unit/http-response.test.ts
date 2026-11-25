import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { consumeResponse, readResponseText } from "../../src/http-response";

interface MockResponse extends EventEmitter {
  headers: IncomingMessage["headers"];
  complete: boolean;
  destroy: ReturnType<typeof vi.fn>;
}

function response(headers: IncomingMessage["headers"] = {}, complete = true): MockResponse {
  return Object.assign(new EventEmitter(), {
    headers,
    complete,
    destroy: vi.fn(),
  });
}

describe("consumeResponse", () => {
  it("rejects an oversized Content-Length before processing data", async () => {
    const incoming = response({ "content-length": "3" });
    const onChunk = vi.fn();
    const pending = consumeResponse(incoming as unknown as IncomingMessage, "https://example.test/body", 2, onChunk);

    await expect(pending).rejects.toThrow("example.test exceeds the 2-byte limit");
    expect(onChunk).not.toHaveBeenCalled();
    expect(incoming.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the response and rejects before delivering an oversized chunk", async () => {
    const incoming = response();
    const onChunk = vi.fn();
    const pending = consumeResponse(incoming as unknown as IncomingMessage, "https://example.test/body", 2, onChunk);

    incoming.emit("data", Buffer.from("ok"));
    incoming.emit("data", Buffer.from("!"));

    await expect(pending).rejects.toThrow("example.test exceeds the 2-byte limit");
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith(Buffer.from("ok"));
    expect(incoming.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a response that ends before its Content-Length is received", async () => {
    const incoming = response({ "content-length": "5" });
    const pending = consumeResponse(incoming as unknown as IncomingMessage, "https://example.test/body", 5, vi.fn());

    incoming.emit("data", Buffer.from("hi"));
    incoming.emit("end");

    await expect(pending).rejects.toThrow("example.test ended with an incomplete body");
    expect(incoming.destroy).toHaveBeenCalledOnce();
  });
});

describe("readResponseText", () => {
  it("preserves a multi-byte UTF-8 code point split across chunks", async () => {
    const incoming = response({ "content-length": "3" });
    const pending = readResponseText(incoming as unknown as IncomingMessage, "https://example.test/body", 3);
    const bytes = Buffer.from("€");

    incoming.emit("data", bytes.subarray(0, 1));
    incoming.emit("data", bytes.subarray(1));
    incoming.emit("end");

    await expect(pending).resolves.toBe("€");
    expect(incoming.destroy).not.toHaveBeenCalled();
  });
});
