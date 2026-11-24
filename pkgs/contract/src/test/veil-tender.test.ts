import { describe, expect, it } from "vitest";
import {
  TenderPhase,
  VeilTenderSimulator,
  pureCircuits,
} from "./veil-tender-simulator.js";

const TENDER_ID = new Uint8Array(32).fill(0x42);
const ISSUER_SK = new Uint8Array(32).fill(0x01);
const ALICE_SK = new Uint8Array(32).fill(0x11);
const BOB_SK = new Uint8Array(32).fill(0x22);
const CAROL_SK = new Uint8Array(32).fill(0x33);
const DAVE_SK = new Uint8Array(32).fill(0x44);

const SALT_A = new Uint8Array(32).fill(0xa1);
const SALT_B = new Uint8Array(32).fill(0xb2);
const SALT_C = new Uint8Array(32).fill(0xc3);
const RESERVE_CAP = 100_000n;

describe("VeilTender Midnight Compact ZK Contract", () => {
  it("initializes in open phase with issuer public key derived from private witness", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const state = sim.getLedger();
    expect(state.phase).toBe(TenderPhase.open);
    expect(state.reserve_cap).toBe(RESERVE_CAP);
    expect(state.bid_count).toBe(0n);
    expect(state.reveal_count).toBe(0n);
    expect(state.has_winner).toBe(false);
    expect(state.compliance_ok).toBe(false);
    expect(state.issuer_pk).toEqual(pureCircuits.derive_pk(ISSUER_SK));
  });

  it("rejects zero reserve cap in constructor", async () => {
    await expect(
      VeilTenderSimulator.create(TENDER_ID, 0n, ISSUER_SK),
    ).rejects.toThrow(/Reserve cap must be positive/);
  });

  it("seals bids with ZK range proof without leaking bid amounts to public ledger", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);

    await sim.submitSealedBid(alice, 84_500n, SALT_A);
    await sim.submitSealedBid(bob, 72_250n, SALT_B);

    const state = sim.getLedger();
    expect(state.bid_count).toBe(2n);
    expect(state.slot0_used).toBe(true);
    expect(state.slot1_used).toBe(true);
    expect(state.slot2_used).toBe(false);
    // Winning bid remains hidden (0) during sealed phase
    expect(state.winning_bid).toBe(0n);
    expect(state.has_winner).toBe(false);
    // Stored commitments match deterministic persistentHash
    const alicePk = pureCircuits.derive_pk(ALICE_SK);
    expect(state.slot0_commit).toEqual(
      pureCircuits.make_bid_commitment(TENDER_ID, alicePk, 84_500n, SALT_A),
    );
    // Local private state retained receipt cleanly
    expect(alice.privateState.storedReceipt?.amount).toBe(84_500n);
  });

  it("enforces ZK range proof: rejects zero bid and bid exceeding reserve cap", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);

    await expect(sim.submitSealedBid(alice, 0n, SALT_A)).rejects.toThrow(
      /Bid amount must be positive/,
    );
    await expect(
      sim.submitSealedBid(alice, RESERVE_CAP + 1n, SALT_A),
    ).rejects.toThrow(/Bid exceeds tender reserve cap/);
    expect(sim.getLedger().bid_count).toBe(0n);
  });

  it("prevents issuer self-bidding, duplicate bidder submission, and 4th slot overflow", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    const carol = sim.registerBidder("carol", CAROL_SK);
    const dave = sim.registerBidder("dave", DAVE_SK);

    await expect(sim.submitSealedBid(sim.issuer, 50_000n, SALT_A)).rejects.toThrow(
      /Issuer cannot bid on own tender/,
    );

    await sim.submitSealedBid(alice, 90_000n, SALT_A);
    await expect(sim.submitSealedBid(alice, 80_000n, SALT_B)).rejects.toThrow(
      /Bidder already submitted/,
    );

    await sim.submitSealedBid(bob, 75_000n, SALT_B);
    await sim.submitSealedBid(carol, 82_000n, SALT_C);
    await expect(sim.submitSealedBid(dave, 60_000n, SALT_A)).rejects.toThrow(
      /All sealed bid slots are full/,
    );
  });

  it("runs complete 5-phase privacy lifecycle: seal -> close -> reveal -> award -> compliance -> settle", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    const carol = sim.registerBidder("carol", CAROL_SK);

    await sim.submitSealedBid(alice, 88_000n, SALT_A);
    await sim.submitSealedBid(bob, 69_500n, SALT_B);
    await sim.submitSealedBid(carol, 74_000n, SALT_C);

    // Non-issuer cannot close bidding
    await expect(sim.closeBidding(alice)).rejects.toThrow(
      /Only issuer can close bidding/,
    );
    await sim.closeBidding(sim.issuer);
    expect(sim.getLedger().phase).toBe(TenderPhase.revealing);

    // Reveal all 3 bids in arbitrary order; lowest valid bid (Bob: 69,500) must win
    await sim.revealBid(alice);
    await sim.revealBid(carol);
    await sim.revealBid(bob);

    const postReveal = sim.getLedger();
    expect(postReveal.reveal_count).toBe(3n);
    expect(postReveal.has_winner).toBe(true);
    expect(postReveal.winning_bid).toBe(69_500n);
    expect(postReveal.winner_pk).toEqual(pureCircuits.derive_pk(BOB_SK));

    // Finalize award
    await sim.finalizeAward(sim.issuer);
    expect(sim.getLedger().phase).toBe(TenderPhase.awarded);

    // Settlement blocked until selective compliance attestation is proved
    await expect(sim.settleTender(sim.issuer)).rejects.toThrow(
      /Compliance attestation required before settlement/,
    );

    // Non-winner cannot attest compliance
    await expect(sim.proveComplianceBand(alice, 60_000n, 80_000n)).rejects.toThrow(
      /Only awarded winner can attest compliance/,
    );

    // Winner cannot attest with an out-of-band compliance range
    await expect(sim.proveComplianceBand(bob, 70_000n, 90_000n)).rejects.toThrow(
      /Winning bid below compliance floor/,
    );

    // Winner proves compliance inside private auditor band [60,000, 80,000] without disclosing bounds
    const attested = await sim.proveComplianceBand(bob, 60_000n, 80_000n);
    expect(attested.compliance_ok).toBe(true);
    expect(attested.compliance_hash.some((b) => b !== 0)).toBe(true);

    // Issuer settles tender
    const settled = await sim.settleTender(sim.issuer);
    expect(settled.phase).toBe(TenderPhase.settled);
  });

  it("blocks tampered reveal amounts/salts and prevents double-reveal replay", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 80_000n, SALT_A);
    await sim.closeBidding(sim.issuer);

    // Attempt to undercut own committed bid during reveal
    await expect(sim.revealBid(alice, 79_999n, SALT_A)).rejects.toThrow(
      /Commitment mismatch for slot 0/,
    );
    // Attempt wrong salt
    await expect(sim.revealBid(alice, 80_000n, SALT_B)).rejects.toThrow(
      /Commitment mismatch for slot 0/,
    );

    // Valid reveal succeeds once, then replay is rejected
    await sim.revealBid(alice, 80_000n, SALT_A);
    await expect(sim.revealBid(alice, 80_000n, SALT_A)).rejects.toThrow(
      /Slot 0 already revealed/,
    );
  });

  it("supports issuer cancellation before award and blocks cancellation post-award", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 55_000n, SALT_A);
    await expect(sim.cancelTender(alice)).rejects.toThrow(
      /Only issuer can cancel tender/,
    );
    await sim.cancelTender(sim.issuer);
    expect(sim.getLedger().phase).toBe(TenderPhase.cancelled);
  });

  it("blocks closing bidding with zero sealed bids and blocks finalizing award with zero reveals", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await expect(sim.closeBidding(sim.issuer)).rejects.toThrow(
      /At least one sealed bid is required/,
    );
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 64_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await expect(sim.finalizeAward(sim.issuer)).rejects.toThrow(
      /No revealed bids to award/,
    );
  });

  it("rejects reveal from unregistered bidder and rejects post-award cancellation", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const dave = sim.registerBidder("dave", DAVE_SK);
    await sim.submitSealedBid(alice, 61_000n, SALT_A);
    await sim.closeBidding(sim.issuer);

    await expect(sim.revealBid(dave, 61_000n, SALT_A)).rejects.toThrow(
      /Caller has no sealed bid/,
    );
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);
    await expect(sim.cancelTender(sim.issuer)).rejects.toThrow(
      /Cannot cancel after award/,
    );
  });

  it("rejects invalid compliance bands (min > max and winning_bid > max_band)", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 77_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    await expect(sim.proveComplianceBand(alice, 90_000n, 70_000n)).rejects.toThrow(
      /Invalid audit band/,
    );
    await expect(sim.proveComplianceBand(alice, 50_000n, 75_000n)).rejects.toThrow(
      /Winning bid above compliance ceiling/,
    );
  });

  it("handles exact reserve-cap boundary bid and tie-breaking deterministically (first revealer holds tie)", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(alice, RESERVE_CAP, SALT_A);
    await sim.submitSealedBid(bob, RESERVE_CAP, SALT_B);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.revealBid(bob);
    const state = sim.getLedger();
    expect(state.winning_bid).toBe(RESERVE_CAP);
    expect(state.winner_pk).toEqual(pureCircuits.derive_pk(ALICE_SK));
  });
});
