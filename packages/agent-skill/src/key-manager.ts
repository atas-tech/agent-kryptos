import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";

const suite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Chacha20Poly1305
});

export interface KeyPair {
  publicKey: string;
  privateKey: Buffer;
}

function arrayBufferToBuffer(value: ArrayBuffer): Buffer {
  return Buffer.from(new Uint8Array(value));
}

function bufferToArrayBuffer(value: Buffer): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const buf = Buffer.from(value, "base64");
  return Uint8Array.from(buf).buffer;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await suite.kem.generateKeyPair();
  const publicKey = await suite.kem.serializePublicKey(keyPair.publicKey);
  const privateKey = await suite.kem.serializePrivateKey(keyPair.privateKey);

  return {
    publicKey: arrayBufferToBuffer(publicKey).toString("base64"),
    privateKey: arrayBufferToBuffer(privateKey)
  };
}

export async function decrypt(privateKey: Buffer, encB64: string, ciphertextB64: string): Promise<Buffer> {
  const recipientKey = await suite.kem.deserializePrivateKey(bufferToArrayBuffer(privateKey));

  const plaintext = await suite.open(
    {
      recipientKey,
      enc: base64ToArrayBuffer(encB64)
    },
    base64ToArrayBuffer(ciphertextB64)
  );

  return arrayBufferToBuffer(plaintext);
}

export async function encrypt(publicKeyB64: string, plaintext: Buffer): Promise<{ enc: string; ciphertext: string }> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(base64ToArrayBuffer(publicKeyB64));
  const { enc, ct } = await suite.seal(
    {
      recipientPublicKey
    },
    bufferToArrayBuffer(plaintext)
  );

  return {
    enc: arrayBufferToBuffer(enc).toString("base64"),
    ciphertext: arrayBufferToBuffer(ct).toString("base64")
  };
}

export function destroyKeyPair(keyPair: KeyPair): void {
  keyPair.privateKey.fill(0);
}
