/**
 * Compression utilities for sync blobs
 * Uses native CompressionStream (browser) or zlib (Node.js)
 */

/**
 * Compress a JSON object to gzipped bytes
 * @param {object} data - JSON-serializable object
 * @returns {Promise<Uint8Array>} Compressed bytes
 */
export async function compress(data) {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);

  // Check if we're in Node.js (for tests)
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { gzipSync } = await import('zlib');
    return new Uint8Array(gzipSync(Buffer.from(bytes)));
  }

  // Browser: use CompressionStream
  const stream = new Blob([bytes]).stream();
  const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
  const compressedBlob = await new Response(compressedStream).blob();
  return new Uint8Array(await compressedBlob.arrayBuffer());
}

/**
 * Decompress gzipped bytes to JSON object
 * @param {Uint8Array} compressed - Gzipped bytes
 * @returns {Promise<object>} Parsed JSON object
 */
export async function decompress(compressed) {
  // Check if we're in Node.js (for tests)
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { gunzipSync } = await import('zlib');
    const decompressed = gunzipSync(Buffer.from(compressed));
    const json = new TextDecoder().decode(decompressed);
    return JSON.parse(json);
  }

  // Browser: use DecompressionStream
  const stream = new Blob([compressed]).stream();
  const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
  const decompressedBlob = await new Response(decompressedStream).blob();
  const json = await decompressedBlob.text();
  return JSON.parse(json);
}
