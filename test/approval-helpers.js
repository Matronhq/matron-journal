// Test-only helpers for approval keys: key generation and statement signing.
import crypto from 'node:crypto'
import { canonicalize } from '../src/federation-jcs.js'

// A fresh P-256 key as { privateKeyPem, publicKey (base64url of the 65-byte
// uncompressed point), keyId (lowercase hex SHA-256 of those 65 bytes) }.
export function generateApprovalKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: point.toString('base64url'),
    keyId: crypto.createHash('sha256').update(point).digest('hex'),
  }
}

// Canonicalise a statement object and sign it (ES256, DER signature).
export function signForTest(privateKeyPem, statementObject) {
  const statement = canonicalize(statementObject)
  const signature = crypto.sign('sha256', Buffer.from(statement, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64url')
  return { statement, signature }
}
