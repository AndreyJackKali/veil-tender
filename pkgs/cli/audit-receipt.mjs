import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "../contract/node_modules/@midnight-ntwrk/compact-runtime/dist/index.js";
import {
  Contract,
  TenderPhase,
  ledger,
  pureCircuits,
} from "../contract/src/managed/veil_tender/contract/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANAGED_DIR = path.resolve(__dirname, "../contract/src/managed/veil_tender");

const CIRCUITS = [
  "submit_sealed_bid",
  "close_bidding",
  "reveal_bid",
  "finalize_award",
  "prove_compliance_band",
  "settle_tender",
  "cancel_tender",
];

const toHex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const fileSha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function collectCircuitFingerprints() {
  return CIRCUITS.map((name) => {
    const zkirPath = path.join(MANAGED_DIR, "zkir", `${name}.zkir`);
    const bzkirPath = path.join(MANAGED_DIR, "zkir", `${name}.bzkir`);
    return {
      circuit: name,
      zkirBytes: fs.statSync(zkirPath).size,
      zkirSha256: fileSha256(zkirPath),
      bzkirBytes: fs.statSync(bzkirPath).size,
      bzkirSha256: fileSha256(bzkirPath),
    };
  });
}

const witnesses = {
  local_secret_key: (ctx) => [ctx.privateState, ctx.privateState.secretKey],
  get_bid_amount: (ctx) => [ctx.privateState, ctx.privateState.bidAmount],
  get_bid_salt: (ctx) => [ctx.privateState, ctx.privateState.bidSalt],
  get_audit_band: (ctx) => [ctx.privateState, [ctx.privateState.auditMin, ctx.privateState.auditMax]],
  store_bid_receipt: (ctx, amt, salt) => [
    { ...ctx.privateState, bidAmount: amt, bidSalt: new Uint8Array(salt) },
    [],
  ],
};

async function main() {
  const contract = new Contract(witnesses);
  const addr = sampleContractAddress();
  const tenderId = new Uint8Array(32).fill(0x42);
  const reserveCap = 100_000n;

  const issuer = { sk: new Uint8Array(32).fill(0x01), pkHex: "0".repeat(64) };
  let issuerPS = { secretKey: issuer.sk, bidAmount: null, bidSalt: null, auditMin: null, auditMax: null };

  const init = await contract.initialState(
    createConstructorContext(issuerPS, issuer.pkHex),
    tenderId,
    reserveCap,
  );
  issuerPS = init.currentPrivateState;
  let shared = init.currentContractState.data;

  const call = async (circuitId, ps, coinPk) => {
    const ctx = createCircuitContext({
      circuitId,
      contractAddress: addr,
      coinPublicKeyOrZswapState: coinPk,
      contractState: shared,
      privateState: ps,
    });
    const res = await contract.impureCircuits[circuitId](ctx);
    shared = res.context.callContext.currentQueryContext.state;
    return res.context.callContext.currentPrivateState ?? ps;
  };

  let alicePS = { secretKey: new Uint8Array(32).fill(0x11), bidAmount: 88_000n, bidSalt: new Uint8Array(32).fill(0xa1), auditMin: null, auditMax: null };
  let bobPS   = { secretKey: new Uint8Array(32).fill(0x22), bidAmount: 69_500n, bidSalt: new Uint8Array(32).fill(0xb2), auditMin: 60_000n, auditMax: 80_000n };
  let carolPS = { secretKey: new Uint8Array(32).fill(0x33), bidAmount: 74_000n, bidSalt: new Uint8Array(32).fill(0xc3), auditMin: null, auditMax: null };

  alicePS = await call("submit_sealed_bid", alicePS, "1".padStart(64, "0"));
  bobPS   = await call("submit_sealed_bid", bobPS,   "2".padStart(64, "0"));
  carolPS = await call("submit_sealed_bid", carolPS, "3".padStart(64, "0"));

  const sealedLedger = ledger(shared);
  const zeroLeakageDuringSealed =
    sealedLedger.winning_bid === 0n &&
    sealedLedger.has_winner === false &&
    sealedLedger.bid_count === 3n;

  issuerPS = await call("close_bidding", issuerPS, issuer.pkHex);
  alicePS  = await call("reveal_bid", alicePS, "1".padStart(64, "0"));
  carolPS  = await call("reveal_bid", carolPS, "3".padStart(64, "0"));
  bobPS    = await call("reveal_bid", bobPS,   "2".padStart(64, "0"));
  issuerPS = await call("finalize_award", issuerPS, issuer.pkHex);
  bobPS    = await call("prove_compliance_band", bobPS, "2".padStart(64, "0"));
  issuerPS = await call("settle_tender", issuerPS, issuer.pkHex);

  const finalLedger = ledger(shared);
  const circuits = collectCircuitFingerprints();

  const receiptBody = {
    schema: "veiltender.auditor_receipt.v1",
    compactCompiler: "0.36.1",
    compactRuntime: "0.21.0",
    tenderId: toHex(tenderId),
    reserveCap: reserveCap.toString(),
    phase: TenderPhase[finalLedger.phase],
    bidCount: Number(finalLedger.bid_count),
    revealCount: Number(finalLedger.reveal_count),
    winnerPk: toHex(finalLedger.winner_pk),
    winnerMatchesBob: Buffer.from(finalLedger.winner_pk).equals(
      Buffer.from(pureCircuits.derive_pk(bobPS.secretKey)),
    ),
    winningBid: finalLedger.winning_bid.toString(),
    complianceOk: finalLedger.compliance_ok,
    complianceHash: toHex(finalLedger.compliance_hash),
    privacyInvariants: {
      zeroLeakageDuringSealedPhase: zeroLeakageDuringSealed,
      privatePolicyBoundsDisclosedOnChain: false,
      bidderSaltsDisclosedOnChain: false,
    },
    commitments: [
      toHex(finalLedger.slot0_commit),
      toHex(finalLedger.slot1_commit),
      toHex(finalLedger.slot2_commit),
    ],
    compiledCircuits: circuits,
  };

  const receiptDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(receiptBody))
    .digest("hex");

  const output = { ...receiptBody, receiptSha256: "0x" + receiptDigest };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
