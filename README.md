# VeilTender — Zero-Knowledge Sealed-Bid Procurement & Compliance Escrow on Midnight

> **Privacy-first enterprise RFQs, DAO grants, and OTC block tenders powered by Midnight Compact zero-knowledge circuits.**

- **Live Interactive dApp (Lace Wallet + Dual-Ledger ZK Simulator):** `https://andreyjackkali.github.io/veil-tender/`
- **Interactive Pitch Deck:** `https://andreyjackkali.github.io/veil-tender/deck.html`
- **Narrated Walkthrough Video:** `https://andreyjackkali.github.io/veil-tender/demo.mp4`
- **License:** Apache License 2.0 (`LICENSE`)
- **Compiler Verified:** Official Midnight `compact 0.36.1` (`@midnight-ntwrk/compact-runtime 0.21.0`) — **7 ZK circuits compiled cleanly** + **12/12 real Compact-runtime Vitest simulation tests passing**.

---

## Why VeilTender?

Public blockchains break competitive bidding: every bid sits in plaintext in the mempool and on-chain state, letting rivals front-run, undercut by `$1`, and reverse-engineer vendor margins. Meanwhile, off-chain sealed-bid portals force bidders to trust an opaque operator not to leak bids or rig awards.

**VeilTender** solves both problems using **Midnight's dual-ledger architecture**:

| Data Element | Where It Lives | Visible On-Chain During Bidding? | Cryptographic Guarantee |
|---|---|---|---|
| **Bidder Secret Key (`sk`)** | Local Private Witness | **Never** | Only domain-separated `derive_pk(sk)` is disclosed |
| **Sealed Bid Amount (`amount`)** | Local Private Witness | **Never** (only `persistentHash` commitment) | **ZK Range Proof** asserts `0 < amount <= reserve_cap` before commitment |
| **Bid Salt (`salt`)** | Local Private Witness | **Never** | Prevents brute-force dictionary attacks on bid commitments |
| **Reserve Cap (`reserve_cap`)** | Public Ledger | Yes | Enforced inside `submit_sealed_bid` ZK circuit |
| **Auditor Policy Band (`[min_band, max_band]`)** | Local Private Witness | **Never** (only `compliance_hash` + `compliance_ok`) | **Selective Compliance Disclosure** proves `min_band <= winning_bid <= max_band` in ZK |

---

## Smart Contract Architecture (`pkgs/contract/src/veil_tender.compact`)

VeilTender compiles **7 zero-knowledge Compact circuits** (`compact 0.36.1`) plus **2 pure cryptographic helper circuits**:

```
[Phase 0: open]
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
   │                              Public disclosure: compliance_hash + compliance_ok = true (bounds stay private!)
   ▼
[Phase 3: settled]              ← Triggered exclusively by issuer via settle_tender() (requires compliance_ok)
   └─ cancel_tender()           ← Emergency issuer cancellation allowed strictly prior to award
```

### Information-Flow Privacy Verification
Midnight's Compact compiler statically enforces witness non-disclosure across all 7 circuits:
- In `submit_sealed_bid`, `get_bid_amount()` and `get_bid_salt()` are **never wrapped in `disclose()`** — the compiler guarantees zero leakage of bid values to public ledger state.
- In `prove_compliance_band`, `get_audit_band()` (`[min_band, max_band]`) is **never disclosed** — only its domain-separated `persistentHash` (`"veiltender:audit:v1"`) and boolean attestation `compliance_ok` reach the public ledger.

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
│   │       ├── veil_tender.compact              # Main Compact ZK smart contract (7 circuits)
│   │       ├── witnesses.ts                     # Private-state types & local witness handlers
│   │       ├── index.ts                         # Package entrypoint
│   │       ├── managed/veil_tender/             # Compiled Compact JS bindings + .d.ts + 7 .zkir/.bzkir circuits
│   │       └── test/
│   │           ├── veil-tender-simulator.ts     # Multi-party Midnight dual-ledger runtime simulator
│   │           └── veil-tender.test.ts          # 12 comprehensive unit & security-invariant tests
│   └── cli/
│       └── demo.mjs                             # End-to-end CLI execution against compiled Compact circuits
└── docs/
    ├── index.html                               # Live Interactive Web dApp (Lace Wallet connector + Dual-Ledger Simulator)
    └── deck.html                                # 8-Slide Interactive Pitch Deck
```

---

## Quick Verification (Reproducible on Linux / macOS)

### 1. Recompile the Compact Contract
```bash
compact --version   # verified with compact 0.5.3 / compiler 0.36.1
cd pkgs/contract
npm run compact
```

### 2. Typecheck & Run Real `@midnight-ntwrk/compact-runtime` Tests
```bash
cd pkgs/contract
npm install
npm run typecheck
npm test
```

### 3. Run the End-to-End CLI Walkthrough
```bash
node pkgs/cli/demo.mjs
```

---

## Built for Midnight Buildathon (Wave 3)
- **Built by:** VeridianLabs (`AndreyJackKali`)
- **Ecosystem Attribution:** Powered by [Midnight Network](https://midnight.network/), Compact language (`midnightntwrk/compact`), and `@midnight-ntwrk/compact-runtime`.
