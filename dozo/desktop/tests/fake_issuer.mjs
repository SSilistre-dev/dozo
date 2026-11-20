// A stand-in for the hosted server in tests/stack_e2e.sh: the two things a local server asks of
// it during sign-in with the hosted account (packages/auth/src/dozo-hosted-login.ts). It
// publishes its Ed25519 key and, at the page that would ask the person to agree, signs a login
// token for one fixed account and sends the browser straight back to the callback it was given.
// Usage: node fake_issuer.mjs [port]  (127.0.0.1; default 8788). Plain Node, nothing to install.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8788);
const origin = `http://127.0.0.1:${port}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const b64 = (value) => Buffer.from(value).toString("base64url");
const { x } = publicKey.export({ format: "jwk" });
const kid = b64(createHash("sha256").update(Buffer.from(x, "base64url")).digest());
const jwk = { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" };
export const ACCOUNT = { sub: "hosted-user-1", email: "owner@example.test", name: "Owner" };

function token(audience) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "dozo-local-login+jwt", kid };
  const claims = { v: 1, iss: origin, ...ACCOUNT, aud: audience, email_verified: true };
  const payload = { ...claims, iat, exp: iat + 60, jti: randomUUID() };
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(sign(null, Buffer.from(input), privateKey))}`;
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname === "/api/auth/dozo/hosted-login/keys") {
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify({ keys: [jwk] }));
  }
  const back = url.searchParams.get("return") ?? "";
  const audience = url.searchParams.get("audience") ?? "";
  if (url.pathname === "/dozo/hosted-login" && back.startsWith("http://127.0.0.1:")) {
    const callback = new URL(back);
    callback.searchParams.set("token", token(audience));
    process.stdout.write(`[issuer] signed a token for ${audience.slice(0, 6)}…\n`);
    response.writeHead(302, { location: callback.href });
    return response.end();
  }
  response.writeHead(404);
  response.end();
}).listen(port, "127.0.0.1", () => process.stdout.write(`[issuer] at ${origin}\n`));
