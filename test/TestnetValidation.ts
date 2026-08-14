/**
 * Testnet Deployment Validation
 *
 * Validates that deployed contracts on the target network are correctly configured.
 * Run with: hardhat test test/TestnetValidation.ts --network arc-testnet
 *
 * Requirements:
 *   - EVM_PRIVATE_KEY env var set (the deployer key)
 *   - A deployment.{network}.json file for the target network
 */
import { expect } from "chai";
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { getNetworkMeta } from "../hardhat.config";
import { describe, before, it, beforeEach, after } from "node:test";
import { ethers, contractAt } from "./helpers/ace";

const { networkName } = await hre.network.getOrCreate();

// ─── Load deployment config ──────────────────────────────────

const deploymentFile = `deployment.${networkName.replace(/-/g, "_")}.json`;
const deploymentPath = path.join(import.meta.dirname, `../${deploymentFile}`);

if (!fs.existsSync(deploymentPath)) {
	console.log(
		`\n  ⚠ No ${deploymentFile} found — skipping all testnet validation.\n`
	);
	process.exit(0);
}

const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
const meta = getNetworkMeta(networkName);
const contracts = deployment.contracts as Record<string, string>;

describe(
	`Testnet Validation — ${networkName} (chainId ${deployment.network?.chainId})`,
	{ timeout: 120_000 },
	function () {
		let deployer: any;

		before(async function () {
			[deployer] = await ethers.getSigners();
			const balance = await deployer.provider.getBalance(deployer.address);
			console.log(`    Deployer: ${deployer.address}`);
			console.log(
				`    Balance:  ${ethers.formatEther(balance)} ${meta.currency}`
			);
		});

		// ─── Contract Code Checks ──────────────────────────────────

		describe("Contract Existence", function () {
			for (const [name, addr] of Object.entries(contracts)) {
				if (name === "USDC") continue; // USDC might be a precompile/native address
				it(`${name} has deployed code at ${addr}`, async function () {
					const code = await deployer.provider.getCode(addr);
					expect(code).to.not.equal("0x", `${name} has no code at ${addr}`);
				});
			}
		});

		// ─── Core Contract Configuration (Chainlink ACE) ───────────

		describe(
			"ACE IdentityRegistry",
			{ skip: !contracts.IdentityRegistry },
			function () {
				let ir: any;

				beforeEach(async function () {
					ir = contractAt("IdentityRegistry", contracts.IdentityRegistry, deployer);
				});

				it("Deployer is registered (CCID != 0)", async function () {
					expect(await ir.getIdentity(deployer.address)).to.not.equal(
						ethers.ZeroHash
					);
				});

				it("Points at the PolicyEngine", async function () {
					if (!contracts.PolicyEngine) {
						this.skip();
						return;
					}
					expect(await ir.getPolicyEngine()).to.equal(contracts.PolicyEngine);
				});
			}
		);

		describe(
			"ACE CredentialRegistry",
			{ skip: !contracts.CredentialRegistry },
			function () {
				let cr: any;

				beforeEach(async function () {
					cr = contractAt("CredentialRegistry", contracts.CredentialRegistry, deployer);
				});

				it("Deployer's CCID has the KYC credential", async function () {
					const ccid = ethers.zeroPadValue(deployer.address, 32);
					expect(
						await cr.validate(
							ccid,
							ethers.keccak256(ethers.toUtf8Bytes("common.kyc")),
							"0x"
						)
					).to.be.true;
				});
			}
		);

		describe(
			"PolicyEngine",
			{ skip: !contracts.PolicyEngine },
			function () {
				let engine: any;

				beforeEach(async function () {
					engine = contractAt("PolicyEngine", contracts.PolicyEngine, deployer);
				});

				it("Deployer holds DEFAULT_ADMIN_ROLE", async function () {
					expect(
						await engine.hasRole(await engine.DEFAULT_ADMIN_ROLE(), deployer.address)
					).to.be.true;
				});

				it("Registry writer policy authorizes the deployer", async function () {
					if (!contracts.RegistryWriterPolicy) {
						this.skip();
						return;
					}
					const writer = contractAt(
						"OnlyAuthorizedSenderPolicy",
						contracts.RegistryWriterPolicy,
						deployer
					);
					expect(await writer.senderAuthorized(deployer.address)).to.be.true;
				});
			}
		);

		describe(
			"PropertyFactory",
			{ skip: !contracts.PropertyFactory },
			function () {
				let factory: any;

				beforeEach(async function () {
					factory = await ethers.getContractAt(
						"PropertyFactory",
						contracts.PropertyFactory
					);
				});

				it("Owner is deployer", async function () {
					expect(await factory.owner()).to.equal(deployer.address);
				});

				it("Can query product records", async function () {
					const next = await factory.nextProductId();
					console.log(`      Product count: ${next - 1n}`);
					expect(next).to.be.greaterThan(0);
					if (next > 1n) {
						await factory.getProduct(1n);
					}
				});

				it("Can query deployed escrows", async function () {
					const escrows = await factory.getDeployedEscrows();
					console.log(`      Deployed escrows: ${escrows.length}`);
					expect(escrows).to.be.an("array");
				});
			}
		);

		// ─── Property Tokens (ACE products) ───────────────────────

		describe(
			"Property Tokens (from Factory)",
			{ skip: !contracts.PropertyFactory },
			function () {
				let factory: any;
				let propertyAddresses: string[];
				let hasProperties = false;

				before(async function () {
					factory = await ethers.getContractAt(
						"PropertyFactory",
						contracts.PropertyFactory
					);
					const next = await factory.nextProductId();
					propertyAddresses = [];
					for (let id = 1n; id < next; id++) {
						const record = await factory.getProduct(id);
						propertyAddresses.push(record.token);
					}
					hasProperties = propertyAddresses.length > 0;
				});

				it("All factory-deployed tokens have code", async function () {
					if (!hasProperties) {
						this.skip();
						return;
					}
					for (const addr of propertyAddresses) {
						const code = await deployer.provider.getCode(addr);
						expect(code).to.not.equal(
							"0x",
							`PropertyToken at ${addr} has no code`
						);
					}
				});

				it("First property token has valid metadata", async function () {
					if (!hasProperties) {
						this.skip();
						return;
					}
					const pt = await ethers.getContractAt(
						"PropertyToken",
						propertyAddresses[0]
					);
					const name = await pt.name();
					const symbol = await pt.symbol();
					const owner = await pt.owner();

					console.log(`      Token: ${name} (${symbol})`);
					console.log(`      Supply: ${ethers.formatEther(await pt.totalSupply())}`);
					console.log(`      Owner: ${owner}`);

					expect(name.length).to.be.greaterThan(0);
					expect(symbol.length).to.be.greaterThan(0);
				});

				it("First property token points at the PolicyEngine", async function () {
					if (!hasProperties || !contracts.PolicyEngine) {
						this.skip();
						return;
					}
					const pt = await ethers.getContractAt(
						"PropertyToken",
						propertyAddresses[0]
					);
					expect(await pt.getPolicyEngine()).to.equal(contracts.PolicyEngine);
				});
			}
		);

		// MARK: Summary

		after(function () {
			console.log("\n    --- Deployment Summary ---");
			console.log(
				`    Network:    ${networkName} (chainId ${deployment.network?.chainId})`
			);
			console.log(`    Contracts:  ${Object.keys(contracts).length}`);
			console.log("");
		});
	}
);
