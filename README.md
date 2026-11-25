# VeilTender v1.3.0 — Zero-Knowledge Sealed-Bid Procurement & Policy-Locked Compliance Escrow on Midnight

> **Privacy-first enterprise RFQs, DAO grants, and OTC block tenders powered by Midnight Compact zero-knowledge circuits — now with Pre-Award Policy-Locked Selective Compliance (`lock_compliance_policy`) and Independent Offline Receipt Verification.**

- **Live Interactive dApp (Lace Wallet + Dual-Ledger ZK Simulator + Offline Receipt Verifier):** `https://andreyjackkali.github.io/veil-tender/`
- **Interactive Pitch Deck:** `https://andreyjackkali.github.io/veil-tender/deck.html`
- **Narrated Walkthrough Video:** `https://andreyjackkali.github.io/veil-tender/demo.mp4`
- **License:** Apache License 2.0 (`LICENSE`)
- **Compiler Verified:** Official Midnight `compact 0.36.1` (`@midnight-ntwrk/compact-runtime 0.21.0`) — **8 ZK circuits compiled cleanly** + **31/31 real Compact-runtime Vitest simulation & adversarial tests passing** + deterministic CLI auditor receipt generator (`pkgs/cli/audit-receipt.mjs`) + independent cryptographic receipt verifier (`pkgs/cli/verify-receipt.mjs`) + automated GitHub Actions CI.

---

## Why VeilTender?

Public blockchains break competitive bidding: every bid sits in plaintext in the mempool and on-chain state, letting rivals front-run, undercut by `$1`, and reverse-engineer vendor margins. Meanwhile, off-chain sealed-bid portals force bidders to trust an opaque operator not to leak bids or rig awards.

**VeilTender** solves both problems — and closes the self-attestation loophole — using **Midnight's dual-ledger architecture**:

| Data Element | Where It Lives | Visible On-Chain During Bidding? | Cryptographic Guarantee |
|---|---|---|---|
| **Bidder Secret Key (`sk`)** | Local Private Witness | **Never** | Only domain-separated `derive_pk(sk)` is disclosed |
| **Sealed Bid Amount (`amount`)** | Local Private Witness | **Never** (only `persistentHash` commitment) | **ZK Range Proof** asserts `0 < amount <= reserve_cap` before commitment |
| **Bid Salt (`salt`)** | Local Private Witness | **Never** | Prevents brute-force dictionary attacks on bid commitments |
| **Reserve Cap (`reserve_cap`)** | Public Ledger | Yes | Enforced inside `submit_sealed_bid` and `lock_compliance_policy` ZK circuits |
| **Auditor Policy Band (`[min_band, max_band]`) & `policy_salt`** | Local Private Witness | **Never** (only `policy_commitment` + `compliance_hash`) | **Policy-Locked Selective Compliance:** Issuer locks `policy_commitment` pre-award; winner proves `winning_bid ∈ [min_band, max_band]` **and** opening of `policy_commitment` in ZK |

---

## Smart Contract Architecture (`pkgs/contract/src/veil_tender.compact`)

VeilTender v1.3.0 compiles **8 zero-knowledge Compact circuits** (`compact 0.36.1`) plus **3 pure cryptographic helper circuits**:

```text
[Phase 0: open]
   ├─ lock_compliance_policy()  ← Optional pre-award issuer governance (private witness: min_band, max_band, policy_salt)
   │                              ZK asserts: 0 < min_band <= max_band <= reserve_cap
   │                              Public disclosure: policy_commitment + policy_locked = true (ZERO bound/salt leak!)
   │  submit_sealed_bid()       ← Private witness: (sk, amount, salt)
   │                              ZK asserts: 0 < amount <= reserve_cap, pk != issuer_pk, no duplicate bidder
   │                              Public disclosure: slotN_bidder, slotN_commit (ZERO amount leak!)
   ▼
[Phase 1: revealing]            ← Triggered exclusively by issuer via close_bidding()
   │  reveal_bid()              ← Bidder opens (amount, salt); circuit verifies persistentHash == slotN_commit
   │                              Deterministically updates lowest valid winning_bid & winner_pk
   ▼
[Phase 2: awarded]              ← Triggered exclusively by issuer via finalize_award()
   │  prove_compliance_band()   ← Winner proves winning_bid ∈ [min_band, max_band] from private witness
   │                              If policy_locked: ZK asserts make_policy_commitment(...) == policy_commitment!
   │                              Public disclosure: compliance_hash + compliance_ok = true (bounds & salt stay private!)
   ▼
[Phase 3: settled]              ← Triggered exclusively by issuer via settle_tender() (requires compliance_ok)
   └─ cancel_tender()           ← Emergency issuer cancellation allowed strictly prior to award
```

### Compiler-Enforced Information-Flow Privacy
Midnight's Compact compiler statically enforces witness non-disclosure across all 8 circuits:
- In `lock_compliance_policy`, `get_audit_band()` and `get_policy_salt()` are **never wrapped in `disclose()`** — only the domain-separated `policy_commitment` (`"veiltender:policy:v1"`) reaches the public ledger.
- In `submit_sealed_bid`, `get_bid_amount()` and `get_bid_salt()` are **never wrapped in `disclose()`** — the compiler guarantees zero leakage of bid values to public ledger state.
- In `prove_compliance_band`, `[min_band, max_band]` and `policy_salt` stay strictly private while cryptographically proving membership in the exact auditor-locked policy corridor.

---

## Repository Structure

```text
veil-tender/
├── LICENSE                                      # Apache License 2.0
├── README.md                                    # Architecture, build & verification guide
├── pkgs/
│   ├── contract/
│   │   ├── package.json                         # @midnight-ntwrk/compact-runtime ^0.21.0 + Vitest
│   │   └── src/
│   │       ├── veil_tender.compact              # Main Compact ZK smart contract (8 circuits + 3 pure helpers)
│   │       ├── witnesses.ts                     # Private-state types & local witness handlers
│   │       ├── index.ts                         # Package entrypoint
│   │       ├── managed/veil_tender/             # Compiled Compact JS bindings + .d.ts + 8 .zkir/.bzkir circuits
│   │       └── test/
│   │           ├── veil-tender-simulator.ts     # Multi-party Midnight dual-ledger runtime simulator
│   │           └── veil-tender.test.ts          # 31 comprehensive unit, policy-lock & adversarial security tests
│   └── cli/
│       ├── demo.mjs                             # End-to-end 6-phase Policy-Locked CLI simulation
│       ├── audit-receipt.mjs                    # Deterministic Auditor ZK Compliance Receipt v2 CLI
│       └── verify-receipt.mjs                   # Independent cryptographic receipt & 8-circuit ZKIR verifier CLI
└── docs/
    ├── index.html                               # Live Interactive Web dApp (Lace Wallet + Privacy Diff + 8-Attack Lab + Offline Verifier)
    ├── deck.html                                # 8-Slide Interactive Pitch Deck
    └── demo.mp4                                 # 57s Narrated HD Walkthrough Video
```

---

## Quick Verification (Reproducible on Linux / macOS)

### 1. Recompile All 8 Compact Circuits
```bash
compact --version   # verified with compact 0.5.3 / compiler 0.36.1
cd pkgs/contract
npm run compact
```

### 2. Typecheck & Run Real `@midnight-ntwrk/compact-runtime` Tests (31/31)
```bash
cd pkgs/contract
npm ci
npm run typecheck
npm test
```

### 3. Run End-to-End Policy-Locked CLI & Independent Receipt Verification
```bash
node pkgs/cli/demo.mjs
node pkgs/cli/audit-receipt.mjs > /tmp/veiltender-receipt.json
node pkgs/cli/verify-receipt.mjs /tmp/veiltender-receipt.json
```

---

## Built for Midnight Buildathon (Wave 3)
- **Built by:** VeridianLabs (`AndreyJackKali`)
- **Ecosystem Attribution:** Powered by [Midnight Network](https://midnight.network/), Compact language (`midnightntwrk/compact`), and `@midnight-ntwrk/compact-runtime`.
