import { generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Build an unencrypted OpenSSH-format ("openssh-key-v1") ed25519 private key
 * in-process, byte-for-byte in the layout `ssh-keygen` writes, so tests do not
 * depend on ssh-keygen being installed. The key is generated per call and
 * never stored. Its base64 body contains the long "AAAA" runs (zero-valued
 * length fields) that real OpenSSH keys always have.
 */
export function opensshEd25519PrivateKey(comment = 'synthetic@example.invalid'): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  const seed = Buffer.from(jwk.d, 'base64url');
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const str = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
    return Buffer.concat([u32(buf.length), buf]);
  };
  const pubBlob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'binary'), str('none'), str('none'), str(''), u32(1), str(pubBlob), str(priv)]).toString('base64');
  const lines = body.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
