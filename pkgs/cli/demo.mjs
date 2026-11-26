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

const hex = (u8) => "0x" + Buffer.from(u8).toString("hex").slice(0, 16) + "...";

const witnesses = {
  local_secret_key: (ctx) => [ctx.privateState, ctx.privateState.secretKey],
  get_bid_amount: (ctx) => [ctx.privateState, ctx.privateState.bidAmount],
  get_bid_salt: (ctx) => [ctx.privateState, ctx.privateState.bidSalt],
  get_audit_band: (ctx) => [ctx.privateState, [ctx.privateState.auditMin, ctx.privateState.auditMax]],
  get_policy_salt: (ctx) => [ctx.privateState, ctx.privateState.policySalt],
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
  const policySalt = new Uint8Array(32).fill(0xd4);

  const issuer = { sk: new Uint8Array(32).fill(0x01), pkHex: "0".repeat(64) };
  let issuerPS = {
    secretKey: issuer.sk,
    bidAmount: null,
    bidSalt: null,
    auditMin: 60_000n,
    auditMax: 80_000n,
    policySalt,
  };

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

  console.log("=== VeilTender v1.4.0 Midnight Compact 0.36.1 End-to-End Policy-Locked Proof Walkthrough ===");
  console.log("Initial ledger:", { phase: TenderPhase[ledger(shared).phase], reserveCap: ledger(shared).reserve_cap.toString(), issuerPk: hex(ledger(shared).issuer_pk) });

  issuerPS = await call("lock_compliance_policy", issuerPS, issuer.pkHex);
  console.log("After lock_compliance_policy():", {
    policyLocked: ledger(shared).policy_locked,
    policyCommitment: hex(ledger(shared).policy_commitment),
  });

  let alicePS = { secretKey: new Uint8Array(32).fill(0x11), bidAmount: 88_000n, bidSalt: new Uint8Array(32).fill(0xa1), auditMin: null, auditMax: null, policySalt: null };
  let bobPS   = { secretKey: new Uint8Array(32).fill(0x22), bidAmount: 69_500n, bidSalt: new Uint8Array(32).fill(0xb2), auditMin: 60_000n, auditMax: 80_000n, policySalt };
  let carolPS = { secretKey: new Uint8Array(32).fill(0x33), bidAmount: 74_000n, bidSalt: new Uint8Array(32).fill(0xc3), auditMin: null, auditMax: null, policySalt: null };

  alicePS = await call("submit_sealed_bid", alicePS, "1".padStart(64, "0"));
  bobPS   = await call("submit_sealed_bid", bobPS,   "2".padStart(64, "0"));
  carolPS = await call("submit_sealed_bid", carolPS, "3".padStart(64, "0"));
  let L = ledger(shared);
  console.log("After 3 sealed bids:", { bidCount: L.bid_count.toString(), winningBidOnChain: L.winning_bid.toString(), slot0Commit: hex(L.slot0_commit), slot1Commit: hex(L.slot1_commit) });

  issuerPS = await call("close_bidding", issuerPS, issuer.pkHex);
  alicePS  = await call("reveal_bid", alicePS, "1".padStart(64, "0"));
  carolPS  = await call("reveal_bid", carolPS, "3".padStart(64, "0"));
  bobPS    = await call("reveal_bid", bobPS,   "2".padStart(64, "0"));
  issuerPS = await call("finalize_award", issuerPS, issuer.pkHex);
  bobPS    = await call("prove_compliance_band", bobPS, "2".padStart(64, "0"));
  issuerPS = await call("settle_tender", issuerPS, issuer.pkHex);

  L = ledger(shared);
  console.log("Final settled ledger:", {
    phase: TenderPhase[L.phase],
    winningBid: L.winning_bid.toString(),
    winnerMatchesBob: Buffer.from(L.winner_pk).equals(Buffer.from(pureCircuits.derive_pk(bobPS.secretKey))),
    policyLocked: L.policy_locked,
    policyCommitment: hex(L.policy_commitment),
    complianceOk: L.compliance_ok,
    complianceHash: hex(L.compliance_hash),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
