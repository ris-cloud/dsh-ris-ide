/**
 * Fixture builders shared by the ProxyBridge bundle tests.
 *
 * Fixtures are built in-process: a tiny ustar writer + gzip gives a real `.tgz`,
 * so the parser is exercised end-to-end without network or binaries.
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

/** The bytes every fixture entry carries unless the caller overrides them. */
export const fileContent = (rel) => `fixture bytes for ${rel}\n`

/** Octal field: width-1 digits + NUL, as ustar spells numbers. */
export const octalField = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

/** One 512-byte ustar header. */
export function tarHeader(name, size, { mode = 0o644, type = '0', linkname = '' } = {}) {
  const header = Buffer.alloc(512, 0)
  const encoded = Buffer.from(name, 'utf8')
  assert.ok(encoded.length <= 100, `fixture name too long: ${name}`)
  encoded.copy(header, 0)
  header.write(octalField(mode, 8), 100, 'ascii')
  header.write(octalField(0, 8), 108, 'ascii') // uid
  header.write(octalField(0, 8), 116, 'ascii') // gid
  header.write(octalField(size, 12), 124, 'ascii')
  header.write(octalField(0, 12), 136, 'ascii') // mtime
  header.write('        ', 148, 'ascii') // checksum placeholder
  header.write(type, 156, 'ascii')
  header.write(linkname < 101 ? linkname : linkname.slice(0, 100), 157, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

/** Build a real `.tgz` from `{name, content?, mode?, type?, linkname?}` entries. */
export function makeTgz(entries, { prefix = '' } = {}) {
  const chunks = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? fileContent(entry.name))
    chunks.push(tarHeader(`${prefix}${entry.name}`, content.length, entry))
    chunks.push(content)
    const pad = (512 - (content.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024)) // end-of-archive: two zero blocks
  return gzipSync(Buffer.concat(chunks))
}

/**
 * `fetch` stand-in serving one body. `calls.count` counts invocations and
 * `calls.urls` records every requested URL; `options.url` mimics `Response.url`
 * after redirects and `options.headers` mimics the header bag.
 */
export function fetchServing(body, options = {}) {
  const calls = { count: 0, urls: [] }
  const impl = async (requested) => {
    calls.count += 1
    calls.urls.push(String(requested))
    return {
      ok: true,
      status: 200,
      url: options.url ?? requested,
      headers: options.headers ?? { get: () => null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    }
  }
  return { impl, calls }
}
