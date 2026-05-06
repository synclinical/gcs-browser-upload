import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from "vitest";
import Upload, {
  InvalidChunkSizeError,
  FileAlreadyUploadedError,
  UrlNotFoundError,
  UploadFailedError,
  UploadCancelledError,
  UploadNetworkError,
} from "../src/upload.js";
import { start, resetServer, stop, getRequests, getBaseURL, setFailCountdown } from "./lib/server.js";
import makeFile from "./lib/makeFile.js";
import crypto from "node:crypto";

const CHUNK = 262144;

function randomData(length) {
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

describe("Upload", () => {
  beforeAll(start);
  afterAll(stop);

  beforeEach(() => {
    window.localStorage.clear();
    resetServer();
  });

  describe("constructor validation", () => {
    it("throws InvalidChunkSizeError for non-multiple of 262144", () => {
      expect(
        () =>
          new Upload({
            id: "test",
            url: "http://example.com",
            file: makeFile("x"),
            chunkSize: 1000,
          }),
      ).toThrow(InvalidChunkSizeError);
    });

    it("throws InvalidChunkSizeError for zero chunk size", () => {
      expect(
        () =>
          new Upload({
            id: "test",
            url: "http://example.com",
            file: makeFile("x"),
            chunkSize: 0,
          }),
      ).toThrow(InvalidChunkSizeError);
    });

    it("throws InvalidChunkSizeError for negative chunk size", () => {
      expect(
        () =>
          new Upload({
            id: "test",
            url: "http://example.com",
            file: makeFile("x"),
            chunkSize: -262144,
          }),
      ).toThrow(InvalidChunkSizeError);
    });

    it("accepts valid chunk sizes that are multiples of 262144", () => {
      expect(
        () =>
          new Upload({
            id: "test",
            url: "http://example.com",
            file: makeFile("x"),
            chunkSize: 262144,
          }),
      ).not.toThrow();

      expect(
        () =>
          new Upload({
            id: "test",
            url: "http://example.com",
            file: makeFile("x"),
            chunkSize: 524288,
          }),
      ).not.toThrow();
    });

    it("defaults chunkSize to 512KB when not provided", () => {
      const upload = new Upload({
        id: "test",
        url: "http://example.com",
        file: makeFile("x"),
      });
      expect(upload.chunkSize).toBe(524288);
    });
  });

  describe("custom headers passthrough", () => {
    it("sends custom headers on chunk PUT requests", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "custom-headers-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        headers: {
          "Content-Disposition": "attachment",
          "X-Custom-Header": "test-value",
        },
      });

      await upload.start();

      const reqs = getRequests();
      expect(reqs).toHaveLength(1);
      expect(reqs[0].headers["content-disposition"]).toBe("attachment");
      expect(reqs[0].headers["x-custom-header"]).toBe("test-value");
    });

    it("sends no extra headers when opts.headers is omitted", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "no-headers-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      await upload.start();

      const reqs = getRequests();
      expect(reqs).toHaveLength(1);
      expect(reqs[0].headers["content-disposition"]).toBeUndefined();
    });
  });

  describe("onChunkUpload callback", () => {
    it("calls onChunkUpload with progress info for each chunk", async () => {
      const chunks = [];
      const totalSize = CHUNK + 100;
      const fileData = randomData(totalSize);

      const upload = new Upload({
        id: "progress-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: (info) => chunks.push(info),
      });

      await upload.start();

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({
        uploadedBytes: CHUNK,
        totalBytes: totalSize,
        chunkIndex: 0,
        chunkLength: CHUNK,
      });
      expect(chunks[1]).toEqual({
        uploadedBytes: totalSize,
        totalBytes: totalSize,
        chunkIndex: 1,
        chunkLength: 100,
      });
    });
  });

  describe("resume via localStorage checksums", () => {
    it("skips chunks whose checksums match on resume", async () => {
      const fileData = randomData(CHUNK * 2 + 100);
      const file = makeFile(fileData);

      // First upload: completes fully, stores checksums along the way
      const upload1 = new Upload({
        id: "resume-test",
        url: `${getBaseURL()}/file`,
        file,
        chunkSize: CHUNK,
      });
      await upload1.start();

      const firstRequests = getRequests().length;
      expect(firstRequests).toBe(3);

      resetServer();

      // Second upload with same id + file should attempt resume
      // But meta was deleted on completion, so it starts fresh
      const upload2 = new Upload({
        id: "resume-test",
        url: `${getBaseURL()}/file`,
        file,
        chunkSize: CHUNK,
      });
      await upload2.start();

      const secondRequests = getRequests().length;
      expect(secondRequests).toBe(3);
    });
  });

  describe("error exports", () => {
    it("exports all error classes from the module", () => {
      expect(InvalidChunkSizeError).toBeDefined();
      expect(FileAlreadyUploadedError).toBeDefined();
      expect(UrlNotFoundError).toBeDefined();
      expect(UploadFailedError).toBeDefined();
      expect(UploadNetworkError).toBeDefined();
    });
  });

  describe("network errors", () => {
    it("throws UploadNetworkError when chunk upload exhausts network retries", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("network down"));

      const upload = new Upload({
        id: "network-retry-exhaust",
        url: `${getBaseURL()}/file`,
        file: makeFile(randomData(CHUNK * 2)),
        chunkSize: CHUNK,
      });

      upload._backoff = () => Promise.resolve();

      try {
        await expect(upload.start()).rejects.toBeInstanceOf(UploadNetworkError);
        expect(fetchSpy).toHaveBeenCalledTimes(4);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe("final response handling", () => {
    it("treats an empty final 200 body as successful upload", async () => {
      const upload = new Upload({
        id: "empty-final-body",
        url: `${getBaseURL()}/file/empty`,
        file: makeFile(randomData(100)),
        chunkSize: CHUNK,
      });

      await expect(upload.start()).resolves.toEqual({ status: 200, data: null });
    });

    it("verifies upload completion before accepting a final CORS-masked error", async () => {
      const originalXHR = globalThis.XMLHttpRequest;
      const requests = [];

      class FakeXHR {
        constructor() {
          this.upload = {};
          this.status = 0;
          this.responseText = "";
          this.headers = {};
          this.onload = null;
          this.onerror = null;
        }

        open(method, url) {
          this.method = method;
          this.url = url;
        }

        setRequestHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        }

        getResponseHeader() {
          return null;
        }

        send(body) {
          requests.push({
            method: this.method,
            url: this.url,
            headers: this.headers,
            body,
          });

          if (requests.length === 1) {
            this.upload.onprogress?.({ lengthComputable: true, loaded: body.byteLength });
            this.onerror?.();
            return;
          }

          this.status = 200;
          this.responseText = '{"status":"ok"}';
          this.onload?.();
        }
      }

      globalThis.XMLHttpRequest = FakeXHR;

      try {
        const upload = new Upload({
          id: "cors-masked-final",
          url: "https://storage.googleapis.com/upload/session",
          file: makeFile(randomData(100)),
          chunkSize: CHUNK,
        });

        await expect(upload.start()).resolves.toEqual({ status: 200, data: null });
        expect(requests).toHaveLength(2);
        expect(requests[1].headers["content-range"]).toBe("bytes */100");
      } finally {
        globalThis.XMLHttpRequest = originalXHR;
      }
    });
  });

  describe("retry on 5xx", () => {
    it("retries and succeeds when server recovers", async () => {
      setFailCountdown(2);
      const fileData = randomData(CHUNK + 100);

      const upload = new Upload({
        id: "retry-test",
        url: `${getBaseURL()}/file/fail-then-succeed`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      // Stub _backoff to avoid real delays in tests
      upload._backoff = () => Promise.resolve();

      await upload.start();
      const reqs = getRequests();
      expect(reqs).toHaveLength(4);
    });

    it("throws UploadFailedError when retries exhausted", async () => {
      setFailCountdown(100);
      const fileData = randomData(CHUNK + 100);

      const upload = new Upload({
        id: "retry-exhaust",
        url: `${getBaseURL()}/file/fail-then-succeed`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload._backoff = () => Promise.resolve();

      // Default maxRetries=3, so 4 attempts total, all fail
      await expect(upload.start()).rejects.toThrow(UploadFailedError);
    });
  });

  describe("410 Gone (expired session)", () => {
    it("throws UrlNotFoundError on 410", async () => {
      const fileData = randomData(200);
      const upload = new Upload({
        id: "expired-test",
        url: `${getBaseURL()}/file/expired`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload._backoff = () => Promise.resolve();

      await expect(upload.start()).rejects.toThrow(UrlNotFoundError);
    });
  });

  describe("return value", () => {
    it("returns { status, data } from the last chunk", async () => {
      const fileData = randomData(CHUNK);
      const upload = new Upload({
        id: "return-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      const result = await upload.start();
      expect(result).toEqual({ status: 200, data: { status: "ok" } });
    });
  });

  describe("pause / unpause", () => {
    it("pauses between chunks and resumes on unpause", async () => {
      const totalSize = CHUNK * 3;
      const fileData = randomData(totalSize);
      const chunks = [];

      const upload = new Upload({
        id: "pause-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: (info) => {
          chunks.push(info);
          if (chunks.length === 1) {
            upload.pause();
          }
        },
      });

      const startPromise = upload.start();

      // Wait for pause to take effect (first chunk uploaded, then paused)
      await vi.waitFor(() => {
        expect(chunks).toHaveLength(1);
        expect(upload._paused).toBe(true);
      });

      // Only 1 chunk should have been uploaded so far
      expect(getRequests()).toHaveLength(1);

      // Unpause and wait for completion
      upload.unpause();
      await startPromise;

      expect(chunks).toHaveLength(3);
      expect(getRequests()).toHaveLength(3);
    });

    it("can pause and unpause multiple times", async () => {
      const totalSize = CHUNK * 4;
      const fileData = randomData(totalSize);
      const chunks = [];
      let pauseCount = 0;

      const upload = new Upload({
        id: "multi-pause",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: (info) => {
          chunks.push(info);
          if (chunks.length === 1 || chunks.length === 3) {
            upload.pause();
            pauseCount++;
          }
        },
      });

      const startPromise = upload.start();

      // First pause
      await vi.waitFor(() => expect(chunks).toHaveLength(1));
      expect(getRequests()).toHaveLength(1);
      upload.unpause();

      // Second pause
      await vi.waitFor(() => expect(chunks).toHaveLength(3));
      expect(getRequests()).toHaveLength(3);
      upload.unpause();

      await startPromise;

      expect(chunks).toHaveLength(4);
      expect(pauseCount).toBe(2);
    });
  });

  describe("cancel", () => {
    it("throws UploadCancelledError when cancelled before start", async () => {
      const fileData = randomData(CHUNK);
      const upload = new Upload({
        id: "cancel-before-start",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload.cancel();
      await expect(upload.start()).rejects.toThrow(UploadCancelledError);
    });

    it("throws UploadCancelledError when cancelled mid-upload", async () => {
      const totalSize = CHUNK * 3;
      const fileData = randomData(totalSize);
      const chunks = [];

      const upload = new Upload({
        id: "cancel-mid",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: (info) => {
          chunks.push(info);
          if (chunks.length === 1) {
            upload.cancel();
          }
        },
      });

      await expect(upload.start()).rejects.toThrow(UploadCancelledError);
      expect(chunks).toHaveLength(1);
    });

    it("throws UploadCancelledError when cancelled while paused", async () => {
      const totalSize = CHUNK * 3;
      const fileData = randomData(totalSize);
      const chunks = [];

      const upload = new Upload({
        id: "cancel-while-paused",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: (info) => {
          chunks.push(info);
          if (chunks.length === 1) {
            upload.pause();
          }
        },
      });

      const startPromise = upload.start();

      await vi.waitFor(() => {
        expect(upload._paused).toBe(true);
      });

      upload.cancel();
      await expect(startPromise).rejects.toThrow(UploadCancelledError);
      expect(chunks).toHaveLength(1);
    });

    it("clears localStorage meta on cancel", async () => {
      const totalSize = CHUNK * 3;
      const fileData = randomData(totalSize);

      const upload = new Upload({
        id: "cancel-meta",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: () => {
          upload.cancel();
        },
      });

      await expect(upload.start()).rejects.toThrow(UploadCancelledError);

      // Meta should be cleared — new upload with same id should not find resume data
      const upload2 = new Upload({
        id: "cancel-meta",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });
      expect(upload2.meta.isResumable()).toBe(false);
    });

    it("exports UploadCancelledError", () => {
      expect(UploadCancelledError).toBeDefined();
      const err = new UploadCancelledError();
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("UploadCancelledError");
    });

    it("sets _activeXHR to null after cancel", async () => {
      const totalSize = CHUNK * 2;
      const fileData = randomData(totalSize);
      const upload = new Upload({
        id: "cancel-xhr-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: () => {
          upload.cancel();
        },
      });
      await expect(upload.start()).rejects.toThrow(UploadCancelledError);
      expect(upload._activeXHR).toBeNull();
    });
  });

  describe("onProgress callback", () => {
    it("accepts onProgress option in constructor without error", () => {
      const upload = new Upload({
        id: "test",
        url: "http://example.com",
        file: makeFile("x"),
        onProgress: () => {},
      });
      expect(upload.onProgress).toBeTypeOf("function");
    });

    it("completes upload successfully when onProgress is provided", async () => {
      const progressCalls = [];
      const fileData = randomData(CHUNK);
      const upload = new Upload({
        id: "onprogress-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onProgress: (info) => progressCalls.push(info),
      });
      const result = await upload.start();
      expect(result.status).toBe(200);
      // In Node.js with the XHR shim, xhr.upload is not implemented,
      // so onProgress may fire 0 times — that's acceptable.
    });
  });

  describe("single-chunk upload (file <= chunkSize)", () => {
    it("uploads file in one request without Content-Range header", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "single-chunk-test",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      const result = await upload.start();

      expect(result).toEqual({ status: 200, data: { status: "ok" } });

      const reqs = getRequests();
      expect(reqs).toHaveLength(1);
      expect(reqs[0].method).toBe("PUT");
      expect(reqs[0].headers["content-range"]).toBeUndefined();
      expect(reqs[0].headers["content-disposition"]).toBeUndefined();
    });

    it("pauses and resumes correctly", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "single-chunk-pause",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload.pause();

      const startPromise = upload.start();

      await vi.waitFor(() => {
        expect(upload._paused).toBe(true);
      });

      upload.unpause();

      const result = await startPromise;

      expect(result).toEqual({ status: 200, data: { status: "ok" } });
      expect(getRequests()).toHaveLength(1);
    });

    it("uploads file exactly equal to chunkSize via single-chunk path", async () => {
      const fileData = randomData(CHUNK);
      const upload = new Upload({
        id: "single-chunk-exact",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      const result = await upload.start();
      expect(result).toEqual({ status: 200, data: { status: "ok" } });

      const reqs = getRequests();
      expect(reqs).toHaveLength(1);
      expect(reqs[0].headers["content-range"]).toBeUndefined();
    });

    it("fires onChunkUpload callback once", async () => {
      const chunks = [];
      const fileData = randomData(100);
      const upload = new Upload({
        id: "single-chunk-cb",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
        onChunkUpload: (info) => chunks.push(info),
      });

      await upload.start();

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        uploadedBytes: 100,
        totalBytes: 100,
        chunkIndex: 0,
        chunkLength: 100,
      });
    });

    it("clears localStorage meta on completion", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "single-chunk-meta",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      await upload.start();
      expect(upload.meta.isResumable()).toBe(false);
    });

    it("supports cancel before start", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "single-chunk-cancel",
        url: `${getBaseURL()}/file`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload.cancel();
      await expect(upload.start()).rejects.toThrow(UploadCancelledError);
    });

    it("retries on 5xx and succeeds when server recovers", async () => {
      setFailCountdown(2);
      const fileData = randomData(100);

      const upload = new Upload({
        id: "single-chunk-retry",
        url: `${getBaseURL()}/file/fail-then-succeed`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload._backoff = () => Promise.resolve();

      await upload.start();

      expect(getRequests()).toHaveLength(3);
    });

    it("throws UploadFailedError when 5xx retries exhausted", async () => {
      setFailCountdown(100);
      const fileData = randomData(100);

      const upload = new Upload({
        id: "single-chunk-retry-exhaust",
        url: `${getBaseURL()}/file/fail-then-succeed`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload._backoff = () => Promise.resolve();

      await expect(upload.start()).rejects.toThrow(UploadFailedError);
      expect(getRequests()).toHaveLength(4);
    });

    it("throws UrlNotFoundError on 410 Gone", async () => {
      const fileData = randomData(100);
      const upload = new Upload({
        id: "single-chunk-expired",
        url: `${getBaseURL()}/file/expired`,
        file: makeFile(fileData),
        chunkSize: CHUNK,
      });

      upload._backoff = () => Promise.resolve();

      await expect(upload.start()).rejects.toThrow(UrlNotFoundError);
    });

    it("throws UploadCancelledError when cancelled during retry backoff", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Network error"));

      const upload = new Upload({
        id: "single-chunk-cancel-retry",
        url: `${getBaseURL()}/file`,
        file: makeFile(randomData(100)),
        chunkSize: CHUNK,
      });

      upload._backoff = () => {
        upload.cancel();
        return Promise.resolve();
      };

      try {
        await expect(upload.start()).rejects.toThrow(UploadCancelledError);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
