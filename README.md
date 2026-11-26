# VeilTender v1.4.0 — Zero-Knowledge Sealed-Bid Procurement & Policy-Locked Compliance Escrow on Midnight

> **Privacy-first enterprise RFQs, DAO grants, and OTC block tenders powered by Midnight Compact 0.36.1 zero-knowledge circuits — featuring Pre-Award Policy-Locked Selective Compliance (`lock_compliance_policy`), a Real Compiled Compact 0.36.1 Circuit & Artifact Inspector, a 1-Click 60-Second Guided Judge Tour, and Independent Offline Auditor Receipt Verification.**

- **Live Interactive dApp (Local Dual-Ledger Simulator + Real Compact 0.36.1 Artifact Inspector):** `https://andreyjackkali.github.io/veil-tender/`
- **1-Page Printable Judge Brief (AKINDO Midnight Wave 3):** `https://andreyjackkali.github.io/veil-tender/judge-brief.html`
- **1-Click 60-Second Guided Judge Tour:** `https://andreyjackkali.github.io/veil-tender/#tour`
- **Interactive Judge Pitch Deck (10 Slides):** `https://andreyjackkali.github.io/veil-tender/deck.html`
- **Narrated Walkthrough Video:** `https://andreyjackkali.github.io/veil-tender/demo.mp4`
- **License:** Apache License 2.0 (`LICENSE`)
- **Compiler & Runtime Verified:** Official Midnight `compact 0.36.1` (`@midnight-ntwrk/compact-runtime 0.21.0`) — **8 ZK circuits compiled cleanly** (`625` BLS12-381 ZKIR instructions, `41` assertions, `129.05 MiB` proving keys) + **47/47 automated Vitest tests passing** (37 real Compact-runtime simulation & adversarial tests + 10 Compact artifact integrity & receipt tamper tests) + automated GitHub Actions CI.

> **Real vs. simulated (read before judging the web demo).**
> - **Real:** `pkgs/contract/src/veil_tender.compact` compiled with official `compact 0.36.1` into 8 `.zkir`/`.bzkir` circuits and `.prover`/`.verifier` keys (`pkgs/contract/src/managed/veil_tender/`); build-time extracted `docs/compact-artifacts.json` cross-checked against the compiler's own `contract-manifest.json`; **47 Vitest tests** executing the real generated contract through `@midnight-ntwrk/compact-runtime 0.21.0` plus end-to-end receipt verification; and the standalone CLI receipt generator/verifier (`pkgs/cli/audit-receipt.mjs`, `pkgs/cli/verify-receipt.mjs`).
> - **Simulated:** The static GitHub Pages dApp does **not** submit live Midnight Testnet transactions yet. Its buttons drive a local browser model mirroring the contract ledger & private witnesses so judges can inspect dual-ledger privacy, adversarial rejections, and receipt verification with zero wallet/faucet friction, and "Connect Lace" checks the DApp connector extension only.

---

## What's New in v1.4.0

1. **Real Compiled Compact 0.36.1 Circuit & Artifact Inspector (`docs/compact-artifacts.json` + in-app Explorer):**
   - Build-time generator (`pkgs/cli/generate-artifact-manifest.mjs`) parses real compiled `.zkir`, `.bzkir`, `.prover`, `.verifier`, `contract-info.json`, `contract-manifest.json`, and `veil_tender.compact`.
   - Judges can click any of the **8 compiled ZK circuits** right in the browser to verify exact file sizes, full SHA-256 digests, real BLS12-381 ZKIR instruction breakdowns (`private_input`, `public_input`, `persistent_hash`, `assert`, `constrain_bits`, `impact`), private witnesses consumed vs explicit `disclose()` outputs, and the full **6 Private Witnesses vs 25 Public Ledger Fields** schema boundary.
2. **1-Click 60-Second Guided Judge Tour (`index.html#tour`):**
   - Walks a judge step-by-step through (a) creating a `$100k` sealed-bid procurement tender + locking a private auditor policy corridor, (b) committing 3 sealed bids with SHA-256 commitments + live Midnight vs Public EVM leakage diff, (c) executing all 4 core adversarial exploit rejections (`Double-Bid`, `Bid Tamper`, `Premature Reveal`, `Compliance Bypass`), and (d) exporting & cryptographically verifying an Offline Auditor Receipt JSON (`8/8` ZKIR fingerprints).
3. **Upgraded 10-Slide Judge Pitch Deck (`docs/deck.html`):**
   - Covers problem, Midnight dual-ledger architecture, all 8 compiled circuits, security invariants, an honest Real-vs-Simulated matrix, verified benchmarks, business viability, and post-Wave roadmap.
4. **Expanded 47-Test Automated Suite (`pkgs/contract/src/test/`):**
   - `37` real `@midnight-ntwrk/compact-runtime` lifecycle, policy-lock, multi-slot, and adversarial security tests (`veil-tender.test.ts`).
   - `10` Compact 0.36.1 artifact manifest integrity & offline receipt tamper-resistance tests (`artifacts-and-receipt.test.ts`).

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

VeilTender compiles **8 zero-knowledge Compact circuits** (`compact 0.36.1`) plus **3 pure cryptographic helper circuits**:

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
│   │       ├── managed/veil_tender/             # Compiled Compact JS bindings + .d.ts + 8 .zkir/.bzkir/.prover/.verifier
│   │       └── test/
│   │           ├── veil-tender-simulator.ts     # Multi-party Midnight dual-ledger runtime simulator
│   │           ├── veil-tender.test.ts          # 37 real Compact-runtime lifecycle, policy-lock & adversarial tests
│   │           └── artifacts-and-receipt.test.ts # 10 Compact artifact integrity & offline receipt tamper tests
│   └── cli/
│       ├── generate-artifact-manifest.mjs       # Build-time Compact 0.36.1 metadata & ZKIR extractor -> docs/compact-artifacts.json
│       ├── demo.mjs                             # End-to-end 6-phase Policy-Locked CLI simulation
│       ├── audit-receipt.mjs                    # Deterministic Auditor ZK Compliance Receipt v2 CLI
│       └── verify-receipt.mjs                   # Independent cryptographic receipt & 8-circuit ZKIR verifier CLI
└── docs/
    ├── index.html                               # Interactive Web dApp (60s Judge Tour + Compact Inspector + 9-Attack Lab + Verifier)
    ├── judge-brief.html                         # 1-Page Printable Judge Brief (AKINDO Midnight Wave 3 rubric + demo video)
    ├── compact-artifacts.json                   # Build-time verified Compact 0.36.1 circuit/witness/ledger manifest
    ├── deck.html                                # 10-Slide Interactive Judge Pitch Deck
    └── demo.mp4                                 # 57s Narrated HD Walkthrough Video
```

---

## Quick Verification (Reproducible on Linux / macOS)

### 1. Recompile All 8 Compact Circuits & Refresh Artifact Manifest
```bash
compact --version   # verified with compact 0.5.3 / compiler 0.36.1
cd pkgs/contract
npm run compact
npm run manifest
```

### 2. Typecheck, Build & Run All 47 Automated Tests
```bash
cd pkgs/contract
npm ci
npm run typecheck
npm test            # 47/47 passing (37 Compact runtime + 10 artifact/receipt integrity)
npm run build
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
