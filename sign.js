const { Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;

// 1. We create a fixed "dummy" wallet for testing
// (In production, the frontend handles this)
const seed = (new Uint8Array(32)).fill(1); // predictable seed so address stays the same
const keypair = Keypair.fromSeed(seed);

// The message you copied from your Postman Challenge Response
const messageToSign = `gpteerelay.local wants you to sign in with your Solana wallet:\n4uH6KGymnzdqjEgb8dm9hmdS6moWn29rPkcHfKULGh1J\n\nURI: https://gpteerelay.local\nVersion: 1\nChain: solana\nNonce: df11fe674b0a93d3d87dc06244cee999\nIssued At: 2026-03-25T11:18:40.673Z\n\nBy signing this message, you prove wallet ownership to log in to Flashback. No funds will be moved.`;

// 2. Sign the message
const messageBytes = Buffer.from(messageToSign, 'utf8');
const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
const signature = bs58.encode(signatureBytes);

console.log("=== PASTE THIS INTO POSTMAN ===");
console.log(`"address": "${keypair.publicKey.toBase58()}"`);
console.log(`"signature": "${signature}"`);
