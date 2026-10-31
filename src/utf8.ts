/**
 * Internal: UTF-8 encoding into one reusable buffer. A digest of a large input encodes about a
 * million short texts (a pointer for each salt, a content for each leaf); a fresh array from
 * `TextEncoder` for each costs more than hashing them.
 *
 * It encodes exactly as `TextEncoder` does (WHATWG Encoding): a surrogate pair as one 4-byte
 * code point, a lone surrogate as U+FFFD. The texts this package hashes never hold a lone
 * surrogate: the validators refuse them before.
 */
export class Utf8Writer {
  private bytes = new Uint8Array(256);

  /**
   * The UTF-8 bytes of `text`, a view of the writer's buffer, valid until the next call of
   * `encode`.
   */
  encode(text: string): Uint8Array {
    if (text.length * 3 > this.bytes.length) this.bytes = new Uint8Array(text.length * 3);
    const out = this.bytes;
    let j = 0;
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code < 0x80) {
        out[j++] = code;
        continue;
      }
      if (code < 0x800) {
        out[j++] = 0xc0 | (code >> 6);
        out[j++] = 0x80 | (code & 0x3f);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(i + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          const point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          out[j++] = 0xf0 | (point >> 18);
          out[j++] = 0x80 | ((point >> 12) & 0x3f);
          out[j++] = 0x80 | ((point >> 6) & 0x3f);
          out[j++] = 0x80 | (point & 0x3f);
          i += 1;
          continue;
        }
        // A lone surrogate: U+FFFD, as TextEncoder writes it.
        code = 0xfffd;
      }
      out[j++] = 0xe0 | (code >> 12);
      out[j++] = 0x80 | ((code >> 6) & 0x3f);
      out[j++] = 0x80 | (code & 0x3f);
    }
    return out.subarray(0, j);
  }
}
