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
const POLICY_SALT = new Uint8Array(32).fill(0xd4);
const WRONG_POLICY_SALT = new Uint8Array(32).fill(0xe5);
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

  it("binds bid commitments across tender_id domain (cross-tender replay impossible)", async () => {
    const otherTenderId = new Uint8Array(32).fill(0x99);
    const alicePk = pureCircuits.derive_pk(ALICE_SK);
    const c1 = pureCircuits.make_bid_commitment(TENDER_ID, alicePk, 75_000n, SALT_A);
    const c2 = pureCircuits.make_bid_commitment(otherTenderId, alicePk, 75_000n, SALT_A);
    expect(c1).not.toEqual(c2);
  });

  it("blocks sealed bid submission after bidding window closes or tender cancels", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(alice, 82_000n, SALT_A);
    await sim.closeBidding(sim.issuer);

    await expect(sim.submitSealedBid(bob, 70_000n, SALT_B)).rejects.toThrow(
      /Tender is not accepting sealed bids/,
    );

    const sim2 = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const carol = sim2.registerBidder("carol", CAROL_SK);
    await sim2.cancelTender(sim2.issuer);
    await expect(sim2.submitSealedBid(carol, 50_000n, SALT_C)).rejects.toThrow(
      /Tender is not accepting sealed bids/,
    );
  });

  it("rejects reveal during open phase and after award finalization", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(alice, 71_000n, SALT_A);
    await sim.submitSealedBid(bob, 68_000n, SALT_B);

    await expect(sim.revealBid(alice)).rejects.toThrow(/Tender is not in reveal phase/);

    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    await expect(sim.revealBid(bob)).rejects.toThrow(/Tender is not in reveal phase/);
  });

  it("enforces issuer-only authorization on finalize_award and settle_tender", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 65_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);

    await expect(sim.finalizeAward(alice)).rejects.toThrow(/Only issuer can finalize award/);
    await sim.finalizeAward(sim.issuer);
    await sim.proveComplianceBand(alice, 60_000n, 70_000n);
    await expect(sim.settleTender(alice)).rejects.toThrow(/Only issuer can settle tender/);
    await sim.settleTender(sim.issuer);
    expect(sim.getLedger().phase).toBe(TenderPhase.settled);
  });

  it("supports exact boundary compliance attestation (min_band == winning_bid == max_band) and blocks re-settlement", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 50_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    const attested = await sim.proveComplianceBand(alice, 50_000n, 50_000n);
    expect(attested.compliance_ok).toBe(true);
    await sim.settleTender(sim.issuer);
    await expect(sim.settleTender(sim.issuer)).rejects.toThrow(
      /Tender must be awarded before settlement/,
    );
  });

  it("allows issuer cancellation during reveal phase before award and blocks subsequent reveals", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(alice, 80_000n, SALT_A);
    await sim.submitSealedBid(bob, 74_000n, SALT_B);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.cancelTender(sim.issuer);

    expect(sim.getLedger().phase).toBe(TenderPhase.cancelled);
    await expect(sim.revealBid(bob)).rejects.toThrow(/Tender is not in reveal phase/);
    await expect(sim.finalizeAward(sim.issuer)).rejects.toThrow(/Tender is not in reveal phase/);
  });

  it("verifies deterministic commitment separation across salts and bidder keys", () => {
    const alicePk = pureCircuits.derive_pk(ALICE_SK);
    const bobPk = pureCircuits.derive_pk(BOB_SK);
    expect(alicePk).not.toEqual(bobPk);
    const cAliceSaltA = pureCircuits.make_bid_commitment(TENDER_ID, alicePk, 72_000n, SALT_A);
    const cAliceSaltB = pureCircuits.make_bid_commitment(TENDER_ID, alicePk, 72_000n, SALT_B);
    const cBobSaltA = pureCircuits.make_bid_commitment(TENDER_ID, bobPk, 72_000n, SALT_A);
    expect(cAliceSaltA).not.toEqual(cAliceSaltB);
    expect(cAliceSaltA).not.toEqual(cBobSaltA);
  });

  it("produces distinct compliance_hash digests for distinct private auditor policy bands", async () => {
    const sim1 = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const a1 = sim1.registerBidder("alice", ALICE_SK);
    await sim1.submitSealedBid(a1, 70_000n, SALT_A);
    await sim1.closeBidding(sim1.issuer);
    await sim1.revealBid(a1);
    await sim1.finalizeAward(sim1.issuer);
    const l1 = await sim1.proveComplianceBand(a1, 60_000n, 80_000n);

    const sim2 = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const a2 = sim2.registerBidder("alice", ALICE_SK);
    await sim2.submitSealedBid(a2, 70_000n, SALT_A);
    await sim2.closeBidding(sim2.issuer);
    await sim2.revealBid(a2);
    await sim2.finalizeAward(sim2.issuer);
    const l2 = await sim2.proveComplianceBand(a2, 65_000n, 75_000n);

    expect(l1.compliance_ok).toBe(true);
    expect(l2.compliance_ok).toBe(true);
    expect(l1.compliance_hash).not.toEqual(l2.compliance_hash);
  });

  it("blocks compliance attestation or cancellation once tender is settled", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 68_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);
    await sim.proveComplianceBand(alice, 60_000n, 75_000n);
    await sim.settleTender(sim.issuer);

    await expect(sim.proveComplianceBand(alice, 60_000n, 75_000n)).rejects.toThrow(
      /Tender must be awarded/,
    );
    await expect(sim.cancelTender(sim.issuer)).rejects.toThrow(/Cannot cancel after award/);
  });

  // === v1.3.0 Policy-Locked Selective Compliance ZK Circuit Tests (Circuit #8) ===

  it("runs full 6-step policy-locked lifecycle without disclosing private policy bounds", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    expect(sim.getLedger().policy_locked).toBe(false);

    const locked = await sim.lockCompliancePolicy(60_000n, 80_000n, POLICY_SALT);
    expect(locked.policy_locked).toBe(true);
    expect(locked.policy_commitment).toEqual(
      pureCircuits.make_policy_commitment(TENDER_ID, 60_000n, 80_000n, POLICY_SALT),
    );

    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(alice, 86_000n, SALT_A);
    await sim.submitSealedBid(bob, 69_500n, SALT_B);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.revealBid(bob);
    await sim.finalizeAward(sim.issuer);

    const attested = await sim.proveComplianceBand(bob, 60_000n, 80_000n, POLICY_SALT);
    expect(attested.compliance_ok).toBe(true);
    const settled = await sim.settleTender(sim.issuer);
    expect(settled.phase).toBe(TenderPhase.settled);
  });

  it("blocks forged self-attested compliance band when policy_commitment is locked", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await sim.lockCompliancePolicy(60_000n, 80_000n, POLICY_SALT);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(bob, 69_500n, SALT_B);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(bob);
    await sim.finalizeAward(sim.issuer);

    // Winner tries forging a wider self-approved band [1, 100_000] to bypass auditor policy
    await expect(
      sim.proveComplianceBand(bob, 1n, RESERVE_CAP, POLICY_SALT),
    ).rejects.toThrow(/Compliance band does not match locked policy commitment/);
    expect(sim.getLedger().compliance_ok).toBe(false);
  });

  it("blocks compliance proof with correct bounds but wrong policy_salt", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await sim.lockCompliancePolicy(60_000n, 80_000n, POLICY_SALT);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(bob, 71_000n, SALT_B);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(bob);
    await sim.finalizeAward(sim.issuer);

    await expect(
      sim.proveComplianceBand(bob, 60_000n, 80_000n, WRONG_POLICY_SALT),
    ).rejects.toThrow(/Compliance band does not match locked policy commitment/);
  });

  it("enforces issuer-only authorization on lock_compliance_policy", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await expect(
      sim.lockCompliancePolicy(50_000n, 90_000n, POLICY_SALT, alice),
    ).rejects.toThrow(/Only issuer can lock compliance policy/);
    expect(sim.getLedger().policy_locked).toBe(false);
  });

  it("prevents locking compliance policy twice (immutability of auditor commitment)", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await sim.lockCompliancePolicy(60_000n, 80_000n, POLICY_SALT);
    await expect(
      sim.lockCompliancePolicy(50_000n, 95_000n, WRONG_POLICY_SALT),
    ).rejects.toThrow(/Compliance policy already locked/);
  });

  it("rejects locking compliance policy after award or cancellation", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 72_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    await expect(
      sim.lockCompliancePolicy(60_000n, 80_000n, POLICY_SALT),
    ).rejects.toThrow(/Policy must be locked prior to award/);

    const sim2 = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await sim2.cancelTender(sim2.issuer);
    await expect(
      sim2.lockCompliancePolicy(60_000n, 80_000n, POLICY_SALT),
    ).rejects.toThrow(/Policy must be locked prior to award/);
  });

  it("enforces ZK policy bounds: rejects zero floor, inverted band, and ceiling > reserve_cap", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await expect(
      sim.lockCompliancePolicy(0n, 80_000n, POLICY_SALT),
    ).rejects.toThrow(/Policy floor must be positive/);
    await expect(
      sim.lockCompliancePolicy(85_000n, 70_000n, POLICY_SALT),
    ).rejects.toThrow(/Invalid audit band/);
    await expect(
      sim.lockCompliancePolicy(60_000n, RESERVE_CAP + 1n, POLICY_SALT),
    ).rejects.toThrow(/Policy ceiling exceeds reserve cap/);
    expect(sim.getLedger().policy_locked).toBe(false);
  });

  it("allows locking compliance policy during revealing phase prior to award", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 75_000n, SALT_A);
    await sim.closeBidding(sim.issuer);

    const locked = await sim.lockCompliancePolicy(70_000n, 85_000n, POLICY_SALT);
    expect(locked.policy_locked).toBe(true);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    await expect(
      sim.proveComplianceBand(alice, 65_000n, 90_000n, POLICY_SALT),
    ).rejects.toThrow(/Compliance band does not match locked policy commitment/);

    const attested = await sim.proveComplianceBand(alice, 70_000n, 85_000n, POLICY_SALT);
    expect(attested.compliance_ok).toBe(true);
  });

  it("domain-separates policy commitments across tender_id and policy_salt", () => {
    const otherTenderId = new Uint8Array(32).fill(0x77);
    const p1 = pureCircuits.make_policy_commitment(TENDER_ID, 60_000n, 80_000n, POLICY_SALT);
    const p2 = pureCircuits.make_policy_commitment(otherTenderId, 60_000n, 80_000n, POLICY_SALT);
    const p3 = pureCircuits.make_policy_commitment(TENDER_ID, 60_000n, 80_000n, WRONG_POLICY_SALT);
    expect(p1).not.toEqual(p2);
    expect(p1).not.toEqual(p3);
  });

  it("blocks settlement when winning bid falls outside locked policy band even with authentic policy_salt", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    // Auditor privately requires bids within [70_000, 90_000]; Bob bids abnormally low 55_000
    await sim.lockCompliancePolicy(70_000n, 90_000n, POLICY_SALT);
    const bob = sim.registerBidder("bob", BOB_SK);
    await sim.submitSealedBid(bob, 55_000n, SALT_B);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(bob);
    await sim.finalizeAward(sim.issuer);

    await expect(
      sim.proveComplianceBand(bob, 70_000n, 90_000n, POLICY_SALT),
    ).rejects.toThrow(/Winning bid below compliance floor/);
    await expect(
      sim.proveComplianceBand(bob, 50_000n, 60_000n, POLICY_SALT),
    ).rejects.toThrow(/Compliance band does not match locked policy commitment/);
    await expect(sim.settleTender(sim.issuer)).rejects.toThrow(
      /Compliance attestation required before settlement/,
    );
  });

  // === v1.4.0 Adversarial Edge-Case, Multi-Slot & Policy-Boundary Tests ===

  it("blocks duplicate bidder submission across slot 1 and slot 2 (Double-Bid invariant)", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    const carol = sim.registerBidder("carol", CAROL_SK);

    await sim.submitSealedBid(alice, 89_000n, SALT_A);
    await sim.submitSealedBid(bob, 76_000n, SALT_B);
    await expect(sim.submitSealedBid(bob, 65_000n, SALT_C)).rejects.toThrow(
      /Bidder already submitted/,
    );
    await sim.submitSealedBid(carol, 71_000n, SALT_C);
    await expect(sim.submitSealedBid(carol, 60_000n, SALT_A)).rejects.toThrow(
      /Bidder already submitted/,
    );
    expect(sim.getLedger().bid_count).toBe(3n);
  });

  it("blocks tampered reveal and double-reveal replay on slots 1 and 2", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    const carol = sim.registerBidder("carol", CAROL_SK);

    await sim.submitSealedBid(alice, 91_000n, SALT_A);
    await sim.submitSealedBid(bob, 73_000n, SALT_B);
    await sim.submitSealedBid(carol, 68_000n, SALT_C);
    await sim.closeBidding(sim.issuer);

    await expect(sim.revealBid(bob, 67_000n, SALT_B)).rejects.toThrow(
      /Commitment mismatch for slot 1/,
    );
    await expect(sim.revealBid(carol, 68_000n, SALT_A)).rejects.toThrow(
      /Commitment mismatch for slot 2/,
    );

    await sim.revealBid(bob, 73_000n, SALT_B);
    await expect(sim.revealBid(bob, 73_000n, SALT_B)).rejects.toThrow(
      /Slot 1 already revealed/,
    );
    await sim.revealBid(carol, 68_000n, SALT_C);
    await expect(sim.revealBid(carol, 68_000n, SALT_C)).rejects.toThrow(
      /Slot 2 already revealed/,
    );
    expect(sim.getLedger().winning_bid).toBe(68_000n);
    expect(sim.getLedger().winner_pk).toEqual(pureCircuits.derive_pk(CAROL_SK));
  });

  it("awards cleanly on partial reveal while unrevealed commitments stay sealed", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    const bob = sim.registerBidder("bob", BOB_SK);
    const carol = sim.registerBidder("carol", CAROL_SK);

    await sim.submitSealedBid(alice, 84_000n, SALT_A);
    await sim.submitSealedBid(bob, 62_000n, SALT_B);
    await sim.submitSealedBid(carol, 77_000n, SALT_C);
    await sim.closeBidding(sim.issuer);

    // Only Carol reveals; Alice and Bob never open their commitments
    await sim.revealBid(carol);
    const postReveal = sim.getLedger();
    expect(postReveal.bid_count).toBe(3n);
    expect(postReveal.reveal_count).toBe(1n);
    expect(postReveal.slot0_revealed).toBe(false);
    expect(postReveal.slot1_revealed).toBe(false);
    expect(postReveal.slot2_revealed).toBe(true);
    expect(postReveal.winning_bid).toBe(77_000n);
    expect(postReveal.winner_pk).toEqual(pureCircuits.derive_pk(CAROL_SK));

    await sim.finalizeAward(sim.issuer);
    await sim.proveComplianceBand(carol, 70_000n, 80_000n);
    const settled = await sim.settleTender(sim.issuer);
    expect(settled.phase).toBe(TenderPhase.settled);
  });

  it("enforces issuer-only authorization for cancel during reveal and policy lock during reveal", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 75_000n, SALT_A);
    await sim.closeBidding(sim.issuer);

    await expect(
      sim.lockCompliancePolicy(60_000n, 85_000n, POLICY_SALT, alice),
    ).rejects.toThrow(/Only issuer can lock compliance policy/);
    await expect(sim.cancelTender(alice)).rejects.toThrow(
      /Only issuer can cancel tender/,
    );
    expect(sim.getLedger().phase).toBe(TenderPhase.revealing);
    expect(sim.getLedger().policy_locked).toBe(false);
  });

  it("supports minimum positive bid (1) with locked exact singleton compliance band [1, 1]", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await sim.lockCompliancePolicy(1n, 1n, POLICY_SALT);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 1n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    const attested = await sim.proveComplianceBand(alice, 1n, 1n, POLICY_SALT);
    expect(attested.compliance_ok).toBe(true);
    const settled = await sim.settleTender(sim.issuer);
    expect(settled.phase).toBe(TenderPhase.settled);
    expect(settled.winning_bid).toBe(1n);
  });

  it("blocks settlement when winning bid exceeds locked policy ceiling even with authentic policy_salt", async () => {
    const sim = await VeilTenderSimulator.create(TENDER_ID, RESERVE_CAP, ISSUER_SK);
    await sim.lockCompliancePolicy(50_000n, 70_000n, POLICY_SALT);
    const alice = sim.registerBidder("alice", ALICE_SK);
    await sim.submitSealedBid(alice, 82_000n, SALT_A);
    await sim.closeBidding(sim.issuer);
    await sim.revealBid(alice);
    await sim.finalizeAward(sim.issuer);

    await expect(
      sim.proveComplianceBand(alice, 50_000n, 70_000n, POLICY_SALT),
    ).rejects.toThrow(/Winning bid above compliance ceiling/);
    await expect(
      sim.proveComplianceBand(alice, 50_000n, 90_000n, POLICY_SALT),
    ).rejects.toThrow(/Compliance band does not match locked policy commitment/);
    await expect(sim.settleTender(sim.issuer)).rejects.toThrow(
      /Compliance attestation required before settlement/,
    );
  });
});
