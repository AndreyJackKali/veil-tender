import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CONTRACT_SRC = path.resolve(REPO_ROOT, "pkgs/contract/src/veil_tender.compact");
const MANAGED_DIR = path.resolve(REPO_ROOT, "pkgs/contract/src/managed/veil_tender");
const OUT_PATH = path.resolve(REPO_ROOT, "docs/compact-artifacts.json");

const CIRCUIT_META = {
  lock_compliance_policy: {
    phase: "Phase 0 (Pre-Award Governance)",
    actor: "Issuer / Compliance Auditor",
    summary:
      "Locks a private auditor compliance corridor [min_band, max_band] + policy_salt on-chain via domain-separated persistentHash without disclosing the bounds.",
    witnessesUsed: ["local_secret_key", "get_audit_band", "get_policy_salt"],
    ledgerWritten: ["policy_commitment", "policy_locked"],
    disclosedValues: ["policy_commitment (32-byte hash)"],
    hiddenValues: ["sk", "min_band", "max_band", "policy_salt"],
  },
  submit_sealed_bid: {
    phase: "Phase 1 (Sealed Bidding)",
    actor: "Bidder",
    summary:
      "Proves 0 < amount <= reserve_cap in ZK, enforces pk != issuer_pk and single-bid-per-identity, stores local receipt, and discloses only bidder pk + salted bid commitment.",
    witnessesUsed: [
      "local_secret_key",
      "get_bid_amount",
      "get_bid_salt",
      "store_bid_receipt",
    ],
    ledgerWritten: [
      "slotN_bidder",
      "slotN_commit",
      "slotN_used",
      "bid_count",
    ],
    disclosedValues: ["pk = derive_pk(sk)", "commitment = persistentHash(...)"],
    hiddenValues: ["sk", "amount (never disclosed during open phase)", "salt"],
  },
  close_bidding: {
    phase: "Phase 1 -> 2 Transition",
    actor: "Issuer",
    summary:
      "Authenticates issuer via private sk, requires at least one sealed bid, and transitions ledger phase from open to revealing.",
    witnessesUsed: ["local_secret_key"],
    ledgerWritten: ["phase"],
    disclosedValues: ["phase = TenderPhase.revealing"],
    hiddenValues: ["sk"],
  },
  reveal_bid: {
    phase: "Phase 2 (Reveal Window)",
    actor: "Committed Bidder",
    summary:
      "Verifies persistentHash(tid, pk, amount, salt) matches the bidder's committed slot, blocks replay, and deterministically tracks the lowest valid winning_bid.",
    witnessesUsed: ["local_secret_key", "get_bid_amount", "get_bid_salt"],
    ledgerWritten: [
      "slotN_revealed",
      "reveal_count",
      "has_winner",
      "winner_pk",
      "winning_bid",
    ],
    disclosedValues: ["pk", "amount (only after bidding closes)"],
    hiddenValues: ["sk", "salt (never disclosed on-chain)"],
  },
  finalize_award: {
    phase: "Phase 2 -> 3 Transition",
    actor: "Issuer",
    summary:
      "Authenticates issuer and requires at least one revealed bid (has_winner == true) before locking phase = awarded.",
    witnessesUsed: ["local_secret_key"],
    ledgerWritten: ["phase"],
    disclosedValues: ["phase = TenderPhase.awarded"],
    hiddenValues: ["sk"],
  },
  prove_compliance_band: {
    phase: "Phase 4 (Selective Compliance ZK)",
    actor: "Awarded Winner",
    summary:
      "Proves winning_bid lies within private [min_band, max_band] and (when policy_locked) matches on-chain policy_commitment using private policy_salt — disclosing only compliance_hash.",
    witnessesUsed: ["local_secret_key", "get_audit_band", "get_policy_salt"],
    ledgerWritten: ["compliance_hash", "compliance_ok"],
    disclosedValues: ["compliance_hash (32-byte hash)", "compliance_ok = true"],
    hiddenValues: ["sk", "min_band", "max_band", "policy_salt"],
  },
  settle_tender: {
    phase: "Phase 5 (Escrow Settlement)",
    actor: "Issuer",
    summary:
      "Authenticates issuer and enforces compliance_ok == true before marking phase = settled.",
    witnessesUsed: ["local_secret_key"],
    ledgerWritten: ["phase"],
    disclosedValues: ["phase = TenderPhase.settled"],
    hiddenValues: ["sk"],
  },
  cancel_tender: {
    phase: "Emergency Governance",
    actor: "Issuer",
    summary:
      "Allows issuer emergency cancellation strictly while phase is open or revealing (blocked post-award and post-settlement).",
    witnessesUsed: ["local_secret_key"],
    ledgerWritten: ["phase"],
    disclosedValues: ["phase = TenderPhase.cancelled"],
    hiddenValues: ["sk"],
  },
};

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function formatType(t) {
  if (!t) return "Unit";
  if (t["type-name"] === "Bytes") return `Bytes<${t.length}>`;
  if (t["type-name"] === "Uint") {
    return t.maxval === 18446744073709551615 ? "Uint<64>" : `Uint<..${t.maxval}>`;
  }
  if (t["type-name"] === "Boolean") return "Boolean";
  if (t["type-name"] === "Enum") return `Enum ${t.name} (${(t.elements || []).join(" | ")})`;
  if (t["type-name"] === "Vector") return `Vector<${t.length}, ${formatType(t.type)}>`;
  if (t["type-name"] === "Tuple") {
    return t.types && t.types.length ? `[${t.types.map(formatType).join(", ")}]` : "[]";
  }
  return t["type-name"] || "Unknown";
}

function extractSourceLines(sourceLines, circuitName) {
  const startIdx = sourceLines.findIndex((line) =>
    new RegExp(`export\\s+(?:pure\\s+)?circuit\\s+${circuitName}\\s*\\(`).test(line),
  );
  if (startIdx === -1) return null;
  let depth = 0;
  let started = false;
  let endIdx = startIdx;
  for (let i = startIdx; i < sourceLines.length; i++) {
    for (const ch of sourceLines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    endIdx = i;
    if (started && depth === 0) break;
  }
  return {
    startLine: startIdx + 1,
    endLine: endIdx + 1,
    snippet: sourceLines.slice(startIdx, endIdx + 1).join("\n"),
  };
}

function parseZkirMetrics(zkirPath) {
  const parsed = JSON.parse(fs.readFileSync(zkirPath, "utf8"));
  const instructions = Array.isArray(parsed.instructions) ? parsed.instructions : [];
  const opCounts = {};
  for (const ins of instructions) {
    opCounts[ins.op] = (opCounts[ins.op] || 0) + 1;
  }
  return {
    zkirVersion: parsed.version ? `${parsed.version.major}.${parsed.version.minor}` : "unknown",
    doCommunicationsCommitment: Boolean(parsed.do_communications_commitment),
    instructionCount: instructions.length,
    privateInputs: opCounts.private_input || 0,
    publicInputs: opCounts.public_input || 0,
    persistentHashes: opCounts.persistent_hash || 0,
    assertions: opCounts.assert || 0,
    constrainBits: opCounts.constrain_bits || 0,
    lessThans: opCounts.less_than || 0,
    impacts: opCounts.impact || 0,
    opCounts,
    sampleInstructions: instructions.slice(0, 12),
  };
}

function main() {
  const contractInfoPath = path.join(MANAGED_DIR, "compiler/contract-info.json");
  const contractManifestPath = path.join(MANAGED_DIR, "compiler/contract-manifest.json");
  const contractInfo = JSON.parse(fs.readFileSync(contractInfoPath, "utf8"));
  const contractManifest = JSON.parse(fs.readFileSync(contractManifestPath, "utf8"));
  const sourceText = fs.readFileSync(CONTRACT_SRC, "utf8");
  const sourceLines = sourceText.split(/\r?\n/);

  const proofCircuits = [];
  const pureHelpers = [];

  for (const c of contractInfo.circuits || []) {
    const loc = extractSourceLines(sourceLines, c.name);
    if (c.pure) {
      pureHelpers.push({
        name: c.name,
        pure: true,
        proof: false,
        arguments: (c.arguments || []).map((a) => ({
          name: a.name,
          type: formatType(a.type),
        })),
        resultType: formatType(c["result-type"]),
        sourceRange: loc ? `L${loc.startLine}-L${loc.endLine}` : null,
      });
      continue;
    }

    const zkirPath = path.join(MANAGED_DIR, "zkir", `${c.name}.zkir`);
    const bzkirPath = path.join(MANAGED_DIR, "zkir", `${c.name}.bzkir`);
    const proverPath = path.join(MANAGED_DIR, "keys", `${c.name}.prover`);
    const verifierPath = path.join(MANAGED_DIR, "keys", `${c.name}.verifier`);

    const artifacts = {
      zkir: {
        file: `zkir/${c.name}.zkir`,
        bytes: fs.statSync(zkirPath).size,
        sha256: sha256File(zkirPath),
      },
      bzkir: {
        file: `zkir/${c.name}.bzkir`,
        bytes: fs.statSync(bzkirPath).size,
        sha256: sha256File(bzkirPath),
      },
      prover: {
        file: `keys/${c.name}.prover`,
        bytes: fs.statSync(proverPath).size,
        sha256: sha256File(proverPath),
      },
      verifier: {
        file: `keys/${c.name}.verifier`,
        bytes: fs.statSync(verifierPath).size,
        sha256: sha256File(verifierPath),
      },
    };

    // Cross-check disk SHA-256 against compiler's own contract-manifest.json
    const checks = [
      ["zkir", `${c.name}.zkir`, artifacts.zkir],
      ["zkir", `${c.name}.bzkir`, artifacts.bzkir],
      ["keys", `${c.name}.prover`, artifacts.prover],
      ["keys", `${c.name}.verifier`, artifacts.verifier],
    ];
    for (const [dirKey, fileName, actual] of checks) {
      const expected = contractManifest?.[dirKey]?.[fileName];
      if (!expected || expected.hash !== actual.sha256 || expected.size !== actual.bytes) {
        throw new Error(
          `Artifact integrity mismatch for ${dirKey}/${fileName}: disk does not match contract-manifest.json`,
        );
      }
    }

    const zkirMetrics = parseZkirMetrics(zkirPath);
    const meta = CIRCUIT_META[c.name] || {
      phase: "Contract Circuit",
      actor: "Authorized Caller",
      summary: "",
      witnessesUsed: [],
      ledgerWritten: [],
      disclosedValues: [],
      hiddenValues: [],
    };

    proofCircuits.push({
      name: c.name,
      pure: false,
      proof: Boolean(c.proof),
      sourceRange: loc ? `L${loc.startLine}-L${loc.endLine}` : null,
      sourceSnippet: loc ? loc.snippet : null,
      ...meta,
      artifacts,
      zkirMetrics,
    });
  }

  const witnessDescriptions = {
    local_secret_key: "32-byte actor secret key (never disclosed; only derive_pk(sk) leaves witness)",
    get_bid_amount: "Private Uint<64> sealed bid quote (range-proved in ZK, hidden during open phase)",
    get_bid_salt: "32-byte bidder blinding salt (never disclosed on-chain in any phase)",
    get_audit_band: "Private [min_band, max_band] compliance corridor (never disclosed on-chain)",
    get_policy_salt: "32-byte auditor policy blinding salt (never disclosed on-chain)",
    store_bid_receipt: "Persists committed (amount, salt) strictly into local device private state",
  };

  const witnesses = (contractInfo.witnesses || []).map((w) => ({
    name: w.name,
    arguments: (w.arguments || []).map((a) => ({
      name: a.name,
      type: formatType(a.type),
    })),
    resultType: formatType(w["result type"]),
    privacy: "LOCAL WITNESS ONLY",
    description: witnessDescriptions[w.name] || "",
  }));

  const ledgerFields = (contractInfo.ledger || []).map((f) => ({
    name: f.name,
    index: f.index,
    storage: f.storage,
    type: f.storage === "Counter" ? "Counter (Uint<64>)" : formatType(f.type),
    exported: Boolean(f.exported),
  }));

  const totals = {
    proofCircuitCount: proofCircuits.length,
    pureHelperCount: pureHelpers.length,
    witnessCount: witnesses.length,
    ledgerFieldCount: ledgerFields.length,
    totalZkirBytes: proofCircuits.reduce((s, c) => s + c.artifacts.zkir.bytes, 0),
    totalBzkirBytes: proofCircuits.reduce((s, c) => s + c.artifacts.bzkir.bytes, 0),
    totalProverBytes: proofCircuits.reduce((s, c) => s + c.artifacts.prover.bytes, 0),
    totalVerifierBytes: proofCircuits.reduce((s, c) => s + c.artifacts.verifier.bytes, 0),
    totalZkirInstructions: proofCircuits.reduce((s, c) => s + c.zkirMetrics.instructionCount, 0),
    totalPersistentHashes: proofCircuits.reduce((s, c) => s + c.zkirMetrics.persistentHashes, 0),
    totalAssertions: proofCircuits.reduce((s, c) => s + c.zkirMetrics.assertions, 0),
  };

  const manifest = {
    schema: "veiltender.compact_artifacts.v1",
    version: "1.4.0",
    source: {
      path: "pkgs/contract/src/veil_tender.compact",
      lines: sourceLines.length,
      bytes: fs.statSync(CONTRACT_SRC).size,
      sha256: sha256File(CONTRACT_SRC),
    },
    compiler: {
      version: contractInfo["compiler-version"],
      commit: contractInfo["compiler-commit"],
      languageVersion: contractInfo["language-version"],
      runtimeVersion: contractInfo["runtime-version"],
      contractInfoSha256: sha256File(contractInfoPath),
      contractManifestSha256: sha256File(contractManifestPath),
      verifiedAgainstCompilerManifest: true,
    },
    totals,
    circuits: proofCircuits,
    pureHelpers,
    witnesses,
    ledgerFields,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(
    `Generated ${path.relative(REPO_ROOT, OUT_PATH)}: ${totals.proofCircuitCount} ZK circuits, ${totals.pureHelperCount} pure helpers, ${totals.witnessCount} witnesses, ${totals.ledgerFieldCount} ledger fields, ${totals.totalZkirInstructions} total ZKIR instructions (${(totals.totalProverBytes / (1024 * 1024)).toFixed(2)} MB prover keys).`,
  );
}

main();
