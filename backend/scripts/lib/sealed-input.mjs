// sealed-input.mjs — a script input that must not be read in the public log.
//
// run-script.yml prints the variables a run is given (the step's env), and the
// Actions log of this repository is PUBLIC. An amount typed for a script — "this
// order, so much" — would be published by passing it. A SEALED input is
// encrypted on the operator's machine to a key only a run of the workflow can
// open:
//   · the key pair is X25519; its private half is derived (HMAC-SHA-256) from a
//     secret the run already holds — the database URL — so nothing new is
//     stored anywhere, and the public half may be printed: it opens nothing;
//   · sealing is an ephemeral X25519 exchange, HKDF-SHA-256, AES-256-GCM, so a
//     sealed text changed on the way, or sealed to another key, does not open.
// A script prints its sealing key when asked (and does nothing else), the
// operator seals the text to it with seal(), and passes the hex as the input.
//
// NO SHEBANG — a test-imported module must not carry one (CLAUDE.md).
import crypto from 'node:crypto';

/* DER wrappers of a raw 32-byte X25519 key (RFC 8410). */
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const INFO = 'houzs sealed input v1';
const HEX = /^(?:[0-9a-f]{2})+$/i;

const privateOf = (secret, label) => {
  if (!secret) throw new Error('no secret to derive the sealing key from');
  const seed = crypto.createHmac('sha256', String(secret)).update(`sealed-input:${label}`).digest();
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
};
const rawOf = (publicKey) => publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
const publicOf = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const keyOf = (shared, ephRaw, pubRaw) => Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephRaw, pubRaw]), INFO, 32));

/** The key a text for `label` is sealed to, as 64 hex characters. Safe to print. */
export const sealingKeyOf = (secret, label) => rawOf(crypto.createPublicKey(privateOf(secret, label))).toString('hex');

/** Seal `text` to a sealing key: hex of the ephemeral key (32 bytes), the iv (12), the tag (16), then the text. */
export function seal(sealingKeyHex, text) {
  const k = String(sealingKeyHex ?? '').trim();
  if (!HEX.test(k) || k.length !== 64) throw new Error('the sealing key is 64 hex characters');
  const pubRaw = Buffer.from(k, 'hex');
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRaw = rawOf(eph.publicKey);
  const key = keyOf(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicOf(pubRaw) }), ephRaw, pubRaw);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([ephRaw, iv, cipher.getAuthTag(), body]).toString('hex');
}

/** Open what seal() made for this secret and label. Throws when it is not one, was sealed to another key, or changed on the way. */
export function unseal(secret, label, sealedHex) {
  const s = String(sealedHex ?? '').trim();
  if (!HEX.test(s) || s.length < 122) throw new Error('not a sealed input');
  const buf = Buffer.from(s, 'hex');
  const priv = privateOf(secret, label);
  const ephRaw = buf.subarray(0, 32);
  const key = keyOf(crypto.diffieHellman({ privateKey: priv, publicKey: publicOf(ephRaw) }), ephRaw, rawOf(crypto.createPublicKey(priv)));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(32, 44));
  decipher.setAuthTag(buf.subarray(44, 60));
  try {
    return Buffer.concat([decipher.update(buf.subarray(60)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('the sealed input does not open: it was sealed to another key, or changed on the way');
  }
}
