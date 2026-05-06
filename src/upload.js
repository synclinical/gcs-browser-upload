/**
 * GCS Resumable Upload - browser-side chunked upload to Google Cloud Storage.
 *
 * Forked from QubitProducts/gcs-browser-upload and modernized:
 * - Replaced axios with native XMLHttpRequest for smooth upload progress events
 * - Replaced es6-promise with native Promise
 * - Replaced debug with no-op (remove if you don't need debug logging)
 * - Zero external runtime dependencies
 *
 * Usage:
 *   import Upload from './vendor/gcs-resumable-upload/index.js';
 *
 *   const upload = new Upload({
 *     id: uniqueId,
 *     url: sessionUri,     // from server's resumable_write_url endpoint
 *     file: fileObject,
 *     chunkSize: 524288,  // 512KB default — 2x the 256KB GCS minimum chunk unit
 *     onChunkUpload: ({uploadedBytes, totalBytes, chunkIndex, chunkLength}) => {},
 *   });
 *
 *   const result = await upload.start();
 *
 * The session URI (url) is obtained from the server's resumable_write_url endpoint
 * and acts as an auth token -- no additional credentials needed.
 */

import FileMeta from "./file-meta.js";
import FileProcessor from "./file-processor.js";
import {
  DontBotherError,
  FileAlreadyUploadedError,
  UrlNotFoundError,
  UploadFailedError,
  UploadIncompleteError,
  InvalidChunkSizeError,
  UploadCancelledError,
  UploadNetworkError,
} from "./errors.js";

// GCS requires chunk sizes to be multiples of 256KB (except the last chunk)
const MIN_CHUNK_SIZE = 262144; // 256KB

export {
  DontBotherError,
  FileAlreadyUploadedError,
  UrlNotFoundError,
  UploadFailedError,
  UploadIncompleteError,
  InvalidChunkSizeError,
  UploadCancelledError,
  UploadNetworkError,
};

export default class Upload {
  /**
   * @param {Object} opts
   * @param {string} opts.id - Unique upload identifier (used for localStorage key)
   * @param {string} opts.url - GCS resumable session URI
   * @param {File} opts.file - The File object to upload
   * @param {number} [opts.chunkSize=524288] - Chunk size in bytes (must be multiple of 256KB)
   * @param {Function} [opts.onChunkUpload] - Progress callback
   * @param {Function} [opts.onProgress] - Intra-chunk progress callback: ({ uploadedBytes, totalBytes }) => {}
   * @param {Object} [opts.headers] - Extra headers to send on each chunk PUT request
   */
  constructor(opts) {
    this.id = opts.id;
    this.url = opts.url;
    this.file = opts.file;
    this.chunkSize = opts.chunkSize ?? 524288;
    this.onChunkUpload = opts.onChunkUpload || (() => { });
    this.onProgress = opts.onProgress || (() => { });
    this.headers = opts.headers || {};

    // Validate chunk size
    if (this.chunkSize <= 0 || this.chunkSize % MIN_CHUNK_SIZE !== 0) {
      throw new InvalidChunkSizeError(this.chunkSize);
    }

    this.processor = new FileProcessor();
    this.meta = new FileMeta(this.id, this.file.size, this.chunkSize);
    this.totalChunks = Math.ceil(this.file.size / this.chunkSize);

    // Pause/cancel state
    this._paused = false;
    this._cancelled = false;
    this._unpauseResolve = null;
    this._activeXHR = null;
  }

  /**
   * Start or resume the upload.
   * For single-chunk uploads (file <= chunkSize), skips resume probe,
   * checksums, and Content-Range header for optimal performance.
   * @returns {Promise<Object>} Response from the final chunk upload
   */
  async start() {
    const isSingleChunk = this.file.size <= this.chunkSize;

    let resumeOffset = 0;
    if (!isSingleChunk) {
      const hadResumeMeta = this.meta.isResumable();
      resumeOffset = await this._getResumeOffset();
      // If we have local resume metadata but GCS reports offset 0, we are almost
      // certainly on a fresh/expired resumable session URI. Clear stale checksums
      // so we do not skip initial chunks that this session has never received.
      if (hadResumeMeta && resumeOffset === 0) {
        this.meta.deleteMeta();
      }
    }

    const startIndex = Math.floor(resumeOffset / this.chunkSize);

    for (
      let chunkIndex = startIndex;
      chunkIndex < this.totalChunks;
      chunkIndex++
    ) {
      // Check cancel/pause before each chunk
      if (this._cancelled) {
        this.meta.deleteMeta();
        throw new UploadCancelledError();
      }
      if (this._paused) {
        await new Promise((resolve) => {
          this._unpauseResolve = resolve;
        });
        this._unpauseResolve = null;
        // Re-check cancel after unpause (cancel() resolves the pause promise)
        if (this._cancelled) {
          this.meta.deleteMeta();
          throw new UploadCancelledError();
        }
      }

      const start = chunkIndex * this.chunkSize;
      const end = Math.min(start + this.chunkSize, this.file.size);
      const chunkLength = end - start;
      const isLastChunk = chunkIndex === this.totalChunks - 1;

      // Read the chunk
      const buffer = await this.processor.readChunk(
        this.file,
        start,
        chunkLength,
      );

      // Check if we can skip this chunk (resume case)
      let newChecksum = null;
      if (!isSingleChunk) {
        newChecksum = await this.processor.checksum(buffer);
        const existingChecksum = this.meta.getChecksum(chunkIndex);
        if (existingChecksum && existingChecksum === newChecksum && !isLastChunk) {
          // Chunk already uploaded with matching checksum, skip it
          continue;
        }
      }

      // Upload the chunk
      const contentRange = isSingleChunk
        ? null
        : `bytes ${start}-${end - 1}/${this.file.size}`;
      const response = await this._uploadChunk(
        buffer,
        contentRange,
        isLastChunk,
        start,
      );

      // Store checksum for resume
      if (!isSingleChunk) {
        this.meta.addChecksum(chunkIndex, newChecksum);
      }

      // Progress callback
      this.onChunkUpload({
        uploadedBytes: end,
        totalBytes: this.file.size,
        chunkIndex,
        chunkLength,
      });

      // If last chunk, clean up and return
      if (isLastChunk) {
        this.meta.deleteMeta();
        return response;
      }
    }

    // Defensive: handles zero-byte files where the loop body never executes
    this.meta.deleteMeta();
    return { status: 200, data: null };
  }

  /**
   * Query GCS for the current upload offset (for resuming).
   * @returns {Promise<number>} The byte offset to resume from
   */
  async _getResumeOffset() {
    // If no previous meta, start from 0
    if (!this.meta.isResumable()) {
      return 0;
    }

    try {
      const response = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        this._activeXHR = xhr;
        xhr.open("PUT", this.url);
        xhr.setRequestHeader("Content-Range", `bytes */${this.file.size}`);
        xhr.onload = () => {
          this._activeXHR = null;
          resolve(xhr);
        };
        xhr.onerror = () => {
          this._activeXHR = null;
          reject(new UploadNetworkError());
        };
        xhr.send(null);
      });

      // 308 Resume Incomplete -- GCS tells us where to resume
      if (response.status === 308) {
        const rangeHeader = response.getResponseHeader("range");
        if (rangeHeader) {
          // Range header format: "bytes=0-1234"
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) {
            return parseInt(match[1], 10) + 1;
          }
        }
        return 0;
      }

      // 200 or 201 -- upload already complete
      if (response.status === 200 || response.status === 201) {
        throw new FileAlreadyUploadedError();
      }

      // 404 or 410 -- session expired, start over
      if (response.status === 404 || response.status === 410) {
        this.meta.deleteMeta();
        return 0;
      }

      // Unexpected status
      return 0;
    } catch (e) {
      if (e instanceof FileAlreadyUploadedError) {
        throw e;
      }
      // Network error or other issue, start from beginning
      this.meta.deleteMeta();
      return 0;
    }
  }

  /**
   * Upload a single chunk to GCS with retry on transient errors.
   * @param {ArrayBuffer} buffer - Chunk data
   * @param {string|null} contentRange - Content-Range header value
   * @param {boolean} isLastChunk - Whether this is the final chunk
   * @param {number} chunkStart - Starting byte offset for this chunk
   * @param {number} [maxRetries=3] - Maximum retry attempts for 5xx/network errors
   * @returns {Promise<Object>} Parsed response for last chunk, or status info for intermediate
   */
  async _uploadChunk(buffer, contentRange, isLastChunk, chunkStart, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this._cancelled) {
        this.meta.deleteMeta();
        throw new UploadCancelledError();
      }

      let response;

      try {
        const xhr = new XMLHttpRequest();
        this._activeXHR = xhr;
        let bytesSent = 0;
        response = await new Promise((resolve, reject) => {
          xhr.open("PUT", this.url);
          if (contentRange) {
            xhr.setRequestHeader("Content-Range", contentRange);
          }
          for (const [name, value] of Object.entries(this.headers)) {
            xhr.setRequestHeader(name, value);
          }
          if (xhr.upload) {
            xhr.upload.onprogress = (evt) => {
              if (evt.lengthComputable) {
                bytesSent = evt.loaded;
                if (!this._cancelled) {
                  this.onProgress({
                    uploadedBytes: chunkStart + evt.loaded,
                    totalBytes: this.file.size,
                  });
                }
              }
            };
          }
          xhr.onload = () => {
            this._activeXHR = null;
            resolve({ status: xhr.status, responseText: xhr.responseText });
          };
          xhr.onerror = () => {
            this._activeXHR = null;
            // All bytes sent + onerror on last chunk = CORS-masked success
            if (isLastChunk && bytesSent >= buffer.byteLength) {
              resolve({ status: 200, data: null, _corsSuccess: true });
            } else {
              reject(new UploadNetworkError());
            }
          };
          xhr.send(buffer);
        });

        if (response._corsSuccess === true) {
          return { status: 200, data: null };
        }
      } catch (error) {
        if (attempt < maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw error;
      }

      // For intermediate chunks, GCS returns 308 Resume Incomplete
      if (response.status === 308) {
        return { status: 308 };
      }

      // For the last chunk, GCS returns 200 OK
      if (response.status === 200 || response.status === 201) {
        const body = response.responseText.trim() === ""
          ? null
          : JSON.parse(response.responseText);
        return { status: response.status, data: body };
      }

      // 404/410 -- session expired
      if (response.status === 404 || response.status === 410) {
        this.meta.deleteMeta();
        throw new UrlNotFoundError();
      }

      // 5xx -- transient server error, retry with backoff
      if (response.status >= 500) {
        if (attempt < maxRetries) {
          await this._backoff(attempt);
          continue;
        }
        throw new UploadFailedError(
          response.status,
          `Server error: ${response.status}`,
        );
      }

      // Other errors (4xx) -- not retryable
      throw new UploadFailedError(
        response.status,
        `Upload failed with status ${response.status}`,
      );
    }
  }

  /**
   * Pause the upload. The current chunk will finish, then the loop halts.
   */
  pause() {
    this._paused = true;
  }

  /**
   * Resume a paused upload.
   */
  unpause() {
    this._paused = false;
    if (this._unpauseResolve) {
      this._unpauseResolve();
    }
  }

  /**
   * Cancel the upload. Clears resume metadata.
   */
  cancel() {
    this._cancelled = true;
    this._paused = false;
    if (this._activeXHR) {
      this._activeXHR.abort();
      this._activeXHR = null;
    }
    if (this._unpauseResolve) {
      this._unpauseResolve();
    }
  }

  /**
   * Exponential backoff: 1s, 2s, 4s + jitter.
   * @param {number} attempt - Zero-based attempt number
   * @returns {Promise<void>}
   */
  _backoff(attempt) {
    const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}
