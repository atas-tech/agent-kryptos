import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";

const suite = new CipherSuite({
    kem: KemId.DhkemX25519HkdfSha256,
    kdf: KdfId.HkdfSha256,
    aead: AeadId.Chacha20Poly1305
});

function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export async function sealBase64(publicKeyB64, plaintextUtf8) {
    const publicKeyBytes = base64ToBytes(publicKeyB64);
    const publicKey = await suite.kem.deserializePublicKey(publicKeyBytes.buffer);

    const sealed = await suite.seal(
        { recipientPublicKey: publicKey },
        new TextEncoder().encode(plaintextUtf8).buffer
    );

    return {
        enc: bytesToBase64(new Uint8Array(sealed.enc)),
        ciphertext: bytesToBase64(new Uint8Array(sealed.ct))
    };
}
