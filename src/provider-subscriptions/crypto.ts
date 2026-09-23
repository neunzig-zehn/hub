import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** Separate the credential-encryption key from Better Auth's use of the instance secret. */
export function providerCredentialKey(instanceSecret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(instanceSecret),
      Buffer.from("paseo-hub-provider-credentials"),
      Buffer.from("aes-256-gcm-v1"),
      32,
    ),
  );
}

export function encryptCredential(
  key: Buffer,
  identity: { organizationId: string; id: string; family: string },
  credential: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad(identity)));
  const encrypted = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return ["v1", nonce, cipher.getAuthTag(), encrypted]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptCredential(
  key: Buffer,
  identity: { organizationId: string; id: string; family: string },
  stored: string,
): string {
  const [version, nonce, tag, encrypted, extra] = stored.split(".");
  if (version !== "v1" || !nonce || !tag || !encrypted || extra !== undefined) {
    throw new Error("Invalid provider credential envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(aad(identity)));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function aad(identity: { organizationId: string; id: string; family: string }): string {
  return `${identity.organizationId}\0${identity.id}\0${identity.family}`;
}
