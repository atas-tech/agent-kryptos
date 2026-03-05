import { describe, expect, it } from "vitest";
import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { decrypt, destroyKeyPair, generateKeyPair } from "../src/key-manager.js";

const suite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Chacha20Poly1305
});

describe("key-manager", () => {
  it("generates and decrypts HPKE payloads", async () => {
    const keyPair = await generateKeyPair();
    const publicKeyBuffer = Buffer.from(keyPair.publicKey, "base64");
    const recipientPublicKey = await suite.kem.deserializePublicKey(Uint8Array.from(publicKeyBuffer).buffer);

    const sealed = await suite.seal(
      { recipientPublicKey },
      new TextEncoder().encode("secret-value").buffer
    );

    const plaintext = await decrypt(
      keyPair.privateKey,
      Buffer.from(new Uint8Array(sealed.enc)).toString("base64"),
      Buffer.from(new Uint8Array(sealed.ct)).toString("base64")
    );

    expect(plaintext.toString("utf8")).toBe("secret-value");

    destroyKeyPair(keyPair);
    expect(keyPair.privateKey.every((value) => value === 0)).toBe(true);
  });
});
