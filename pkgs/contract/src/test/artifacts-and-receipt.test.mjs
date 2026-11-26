import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MANAGED_DIR = path.resolve(REPO_ROOT, "pkgs/contract/src/managed/veil_tender");
const CONTRACT_SRC = path.resolve(REPO_ROOT, "pkgs/contract/src/veil_tender.compact");
const MANIFEST_PATH = path.resolve(REPO_ROOT, "docs/compact-artifacts.json");
const AUDIT_CLI = path.resolve(REPO_ROOT, "pkgs/cli/audit-receipt.mjs");
const VERIFY_CLI = path.resolve(REPO_ROOT, "pkgs/cli/verify-receipt.mjs");

const sha256File = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const recomputeReceiptHash = (receipt) => {
  const { receiptSha256: _ignored, ...body } = receipt;
  return {
    ...body,
    receiptSha256:
      "0x" + crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
};

describe("Compact 0.36.1 Artifact Manifest & Offline Receipt Integrity", () => {
  it("matches compiled Compact 0.36.1 compiler provenance and veil_tender.compact source SHA-256", () => {
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const contractInfo = JSON.parse(
      fs.readFileSync(path.join(MANAGED_DIR, "compiler/contract-info.json"), "utf8"),
    );

    expect(manifest.schema).toBe("veiltender.compact_artifacts.v1");
    expect(manifest.compiler.version).toBe("0.36.1");
    expect(manifest.compiler.runtimeVersion).toBe("0.21.0");
    expect(manifest.compiler.commit).toBe(contractInfo["compiler-commit"]);
    expect(manifest.compiler.verifiedAgainstCompilerManifest).toBe(true);
    expect(manifest.source.sha256).toBe(sha256File(CONTRACT_SRC));
  });

  it("verifies all 8 circuits' .zkir, .bzkir, .prover, and .verifier hashes and byte sizes against disk", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const compilerManifest = JSON.parse(
      fs.readFileSync(path.join(MANAGED_DIR, "compiler/contract-manifest.json"), "utf8"),
    );

    expect(manifest.circuits).toHaveLength(8);
    expect(manifest.pureHelpers).toHaveLength(3);

    for (const circuit of manifest.circuits) {
      const checks = [
        ["zkir", `${circuit.name}.zkir`, circuit.artifacts.zkir],
        ["zkir", `${circuit.name}.bzkir`, circuit.artifacts.bzkir],
        ["keys", `${circuit.name}.prover`, circuit.artifacts.prover],
        ["keys", `${circuit.name}.verifier`, circuit.artifacts.verifier],
      ];
      for (const [subDir, fileName, entry] of checks) {
        const fullPath = path.join(MANAGED_DIR, subDir, fileName);
        expect(fs.existsSync(fullPath)).toBe(true);
        expect(entry.bytes).toBe(fs.statSync(fullPath).size);
        expect(entry.sha256).toBe(sha256File(fullPath));
        expect(entry.sha256).toBe(compilerManifest[subDir][fileName].hash);
      }
    }
  });

  it("reports authentic BLS12-381 ZKIR instruction counts and communications commitments for all 8 circuits", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    expect(manifest.totals.totalZkirInstructions).toBeGreaterThan(500);
    expect(manifest.totals.totalPersistentHashes).toBeGreaterThanOrEqual(8);
    expect(manifest.totals.totalAssertions).toBeGreaterThanOrEqual(20);

    for (const c of manifest.circuits) {
      expect(c.zkirMetrics.doCommunicationsCommitment).toBe(true);
      expect(c.zkirMetrics.instructionCount).toBeGreaterThan(20);
      expect(c.zkirMetrics.privateInputs).toBeGreaterThanOrEqual(2);
      expect(c.zkirMetrics.persistentHashes).toBeGreaterThanOrEqual(1);
      expect(c.zkirMetrics.assertions).toBeGreaterThanOrEqual(2);
      expect(c.sourceRange).toMatch(/^L\d+-L\d+$/);
    }
  });

  it("enforces strict dual-ledger schema separation: 6 private witnesses, 25 public ledger cells with zero bid/band secrets", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    expect(manifest.witnesses).toHaveLength(6);
    expect(manifest.ledgerFields).toHaveLength(25);

    const witnessNames = manifest.witnesses.map((w) => w.name);
    expect(witnessNames).toEqual(
      expect.arrayContaining([
        "local_secret_key",
        "get_bid_amount",
        "get_bid_salt",
        "get_audit_band",
        "get_policy_salt",
        "store_bid_receipt",
      ]),
    );

    const ledgerNames = manifest.ledgerFields.map((f) => f.name);
    for (const forbidden of [
      "secret_key",
      "bid_salt",
      "policy_salt",
      "min_band",
      "max_band",
      "slot0_amount",
      "slot1_amount",
      "slot2_amount",
    ]) {
      expect(ledgerNames).not.toContain(forbidden);
    }
  });

  it("generates and independently verifies a deterministic v2 Auditor ZK Compliance Receipt (15/15 checks)", () => {
    const rawReceipt = execFileSync(process.execPath, [AUDIT_CLI], {
      encoding: "utf8",
    });
    const receipt = JSON.parse(rawReceipt);
    expect(receipt.schema).toBe("veiltender.auditor_receipt.v2");
    expect(receipt.policyLocked).toBe(true);
    expect(receipt.complianceOk).toBe(true);
    expect(receipt.compiledCircuits).toHaveLength(8);

    const verify = spawnSync(process.execPath, [VERIFY_CLI, "-"], {
      input: rawReceipt,
      encoding: "utf8",
    });
    expect(verify.status).toBe(0);
    const summary = JSON.parse(verify.stdout);
    expect(summary.verified).toBe(true);
    expect(summary.passed).toBe(15);
    expect(summary.total).toBe(15);
  });

  it("rejects tampered winningBid in offline receipt verifier", () => {
    const receipt = JSON.parse(
      execFileSync(process.execPath, [AUDIT_CLI], { encoding: "utf8" }),
    );
    receipt.winningBid = "1";

    const verify = spawnSync(process.execPath, [VERIFY_CLI, "-"], {
      input: JSON.stringify(receipt),
      encoding: "utf8",
    });
    expect(verify.status).toBe(1);
    const summary = JSON.parse(verify.stdout);
    expect(summary.verified).toBe(false);
    const digestCheck = summary.checks.find(
      (c) => c.name === "receipt_sha256_integrity",
    );
    expect(digestCheck.ok).toBe(false);
  });

  it("rejects forged circuit ZKIR SHA-256 even when receiptSha256 is recomputed", () => {
    const receipt = JSON.parse(
      execFileSync(process.execPath, [AUDIT_CLI], { encoding: "utf8" }),
    );
    const target = receipt.compiledCircuits.find(
      (c) => c.circuit === "submit_sealed_bid",
    );
    target.zkirSha256 = "0".repeat(64);
    const resigned = recomputeReceiptHash(receipt);

    const verify = spawnSync(process.execPath, [VERIFY_CLI, "-"], {
      input: JSON.stringify(resigned),
      encoding: "utf8",
    });
    expect(verify.status).toBe(1);
    const summary = JSON.parse(verify.stdout);
    expect(summary.verified).toBe(false);
    const circuitCheck = summary.checks.find(
      (c) => c.name === "circuit_submit_sealed_bid",
    );
    expect(circuitCheck.ok).toBe(false);
  });

  it("rejects breached privacy invariants even when receiptSha256 is recomputed", () => {
    const receipt = JSON.parse(
      execFileSync(process.execPath, [AUDIT_CLI], { encoding: "utf8" }),
    );
    receipt.privacyInvariants.privatePolicyBoundsDisclosedOnChain = true;
    const resigned = recomputeReceiptHash(receipt);

    const verify = spawnSync(process.execPath, [VERIFY_CLI, "-"], {
      input: JSON.stringify(resigned),
      encoding: "utf8",
    });
    expect(verify.status).toBe(1);
    const summary = JSON.parse(verify.stdout);
    expect(summary.verified).toBe(false);
    const invCheck = summary.checks.find(
      (c) => c.name === "privacy_invariants",
    );
    expect(invCheck.ok).toBe(false);
  });

  it("rejects unlocked policy commitment even when receiptSha256 is recomputed", () => {
    const receipt = JSON.parse(
      execFileSync(process.execPath, [AUDIT_CLI], { encoding: "utf8" }),
    );
    receipt.policyLocked = false;
    const resigned = recomputeReceiptHash(receipt);

    const verify = spawnSync(process.execPath, [VERIFY_CLI, "-"], {
      input: JSON.stringify(resigned),
      encoding: "utf8",
    });
    expect(verify.status).toBe(1);
    const summary = JSON.parse(verify.stdout);
    expect(summary.verified).toBe(false);
    const polCheck = summary.checks.find(
      (c) => c.name === "policy_commitment_locked",
    );
    expect(polCheck.ok).toBe(false);
  });

  it("rejects receipt missing one of the 8 compiled Compact circuits", () => {
    const receipt = JSON.parse(
      execFileSync(process.execPath, [AUDIT_CLI], { encoding: "utf8" }),
    );
    receipt.compiledCircuits = receipt.compiledCircuits.filter(
      (c) => c.circuit !== "lock_compliance_policy",
    );
    const resigned = recomputeReceiptHash(receipt);

    const verify = spawnSync(process.execPath, [VERIFY_CLI, "-"], {
      input: JSON.stringify(resigned),
      encoding: "utf8",
    });
    expect(verify.status).toBe(1);
    const summary = JSON.parse(verify.stdout);
    expect(summary.verified).toBe(false);
    const countCheck = summary.checks.find(
      (c) => c.name === "all_8_circuits_present",
    );
    expect(countCheck.ok).toBe(false);
  });
});
