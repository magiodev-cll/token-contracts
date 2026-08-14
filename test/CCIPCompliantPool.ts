import { expect } from "chai";
import hre from "hardhat";
import {
	ethers,
	contractAt,
	deployAceCore,
	deployProxy,
	aceFactory,
	onboard,
	baseEligibilityConfig,
} from "./helpers/ace";

describe("CCIP Bridged Token Suite", function () {
	let admin: any;
	let verifiedUser: any;
	let unverifiedUser: any;
	let dstReceiver: any;
	let rmnProxy: any;
	let router: any;
	let core: any;
	let token: any;
	let eligibilityPolicy: any;
	let pool: any;

	before(async function () {
		[admin, verifiedUser, unverifiedUser, dstReceiver, rmnProxy, router] =
			await ethers.getSigners();

		core = await deployAceCore(admin);
		await onboard(core, admin, verifiedUser);

		// bridged product: mint is authorization-only (mint-and-freeze), so a
		// CCIP inbound mint always delivers; transfers stay eligibility-gated
		const { sources, requirements } = baseEligibilityConfig(core);
		const productId = await core.factory.nextProductId();
		await core.factory
			.connect(admin)
			.createProduct(
				"Bridged Prop",
				"bPROP",
				18,
				sources,
				requirements,
				false, // mintRequiresEligibility = false
				admin.address,
				admin.address
			);
		const record = await core.factory.getProduct(productId);
		const PropertyToken = await ethers.getContractFactory("PropertyToken");
		token = PropertyToken.attach(record.token);
		eligibilityPolicy = contractAt(
			"CredentialRegistryIdentityValidatorPolicy",
			record.eligibilityPolicy,
			admin
		);
	});

	describe("PropertyToken CCT readiness", function () {
		it("exposes getCCIPAdmin() returning the owner", async function () {
			expect(await token.getCCIPAdmin()).to.equal(admin.address);
		});

		it("blocks transfers from unverified parties", async function () {
			await expect(
				token.connect(unverifiedUser).transfer(admin.address, 0n)
			).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");
		});
	});

	describe("ACE bridged token (mint-and-freeze)", function () {
		it("deploys with zero supply", async function () {
			expect(await token.totalSupply()).to.equal(0n);
		});

		it("mints to a VERIFIED receiver", async function () {
			await token.connect(admin).mint(verifiedUser.address, 500n);
			expect(await token.balanceOf(verifiedUser.address)).to.equal(500n);
		});

		it("mints to an UNVERIFIED receiver (CCIP delivery must not revert)", async function () {
			// mintRequiresEligibility=false: the bridge delivers exactly
			// `amount` or CCIP's OffRamp reverts (ReleaseOrMintBalanceMismatch)
			await token.connect(admin).mint(unverifiedUser.address, 300n);
			expect(await token.balanceOf(unverifiedUser.address)).to.equal(300n);
		});

		it("freezes the unverified receiver: they cannot transfer until eligible", async function () {
			await expect(
				token.connect(unverifiedUser).transfer(verifiedUser.address, 1n)
			).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");

			// After verification the same transfer succeeds.
			await onboard(core, admin, unverifiedUser);
			await token
				.connect(unverifiedUser)
				.transfer(verifiedUser.address, 100n);
			expect(await token.balanceOf(verifiedUser.address)).to.equal(600n);
		});

		it("rejects mint from an address without minter authorization", async function () {
			await expect(
				token.connect(dstReceiver).mint(verifiedUser.address, 100n)
			).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");
		});

		it("burn(uint256) is unrestricted self-burn (old burns-always-allowed model)", async function () {
			// anyone can burn what they hold (no admin gate)
			await token.connect(verifiedUser)["burn(uint256)"](1n);
			expect(await token.balanceOf(verifiedUser.address)).to.equal(599n);
			await token.connect(admin).mint(admin.address, 100n); // mint-and-freeze: any delivery
			await token["burn(uint256)"](40n);
			expect(await token.balanceOf(admin.address)).to.equal(60n);
		});

		it("burnFrom spends allowance (no confiscation)", async function () {
			await expect(
				token.burnFrom(verifiedUser.address, 100n)
			).to.be.revertedWith("ERC20: burn amount exceeds allowance");
			await token.connect(verifiedUser).approve(admin.address, 100n);
			await token.burnFrom(verifiedUser.address, 100n);
			expect(await token.balanceOf(verifiedUser.address)).to.equal(499n);
			expect(
				await token.allowance(verifiedUser.address, admin.address)
			).to.equal(0n);
		});

	});

	describe("CompliantPropertyTokenPool (source-side gating)", function () {
		before(async function () {
			// The pool is a contract with no credentials, so holders funding it
			// need the pool on a bypass list: stock BypassPolicy attached FIRST
			// on transfer (Allowed short-circuits eligibility). Semantics: any
			// holder — verified or not — can send to the bypassed pool.
			const Pool = await ethers.getContractFactory("CompliantPropertyTokenPool");
			pool = await Pool.deploy(
				token.target,
				18,
				[],
				rmnProxy.address,
				router.address
			);
			await pool.waitForDeployment();
			await pool.setEligibilityPolicy(eligibilityPolicy.target);

			const BypassPolicy = await aceFactory("BypassPolicy");
			const bypass = await deployProxy(
				await BypassPolicy.deploy(),
				BypassPolicy.interface.encodeFunctionData("initialize", [core.engine.target, admin.address, "0x"]),
				"BypassPolicy"
			);
			await bypass.allowAddress(pool.target);
			await core.engine.addPolicyAt(
				token.target,
				ethers.id("transfer(address,uint256)").slice(0, 10),
				bypass.target,
				[ethers.keccak256(ethers.toUtf8Bytes("to"))],
				0n
			);
		});

		it("outbound: holders can fund the pool (stock BypassPolicy)", async function () {
			// verified holder can send to the pool
			await token.connect(verifiedUser).transfer(pool.target, 50n);
			expect(await token.balanceOf(pool.target)).to.equal(50n);
			// an unverified holder can too (bypass semantics — the old
			// isExempt-from-check also exempted pool receives; the from-side
			// check is not replicated here)
			await token.connect(unverifiedUser).transfer(pool.target, 10n);
			expect(await token.balanceOf(pool.target)).to.equal(60n);
		});

		function lockOrBurnIn(receiverAddr: string) {
			return {
				receiver: ethers.AbiCoder.defaultAbiCoder().encode(
					["address"],
					[receiverAddr]
				),
				remoteChainSelector: 1n,
				originalSender: verifiedUser.address,
				amount: 100n,
				localToken: token.target,
			};
		}

		it("constructs against the token (decimals + wiring)", async function () {
			expect(await pool.getToken()).to.equal(token.target);
		});

		it("rejects bridging to an INELIGIBLE destination receiver (before burn)", async function () {
			await expect(
				pool.lockOrBurn.staticCall(lockOrBurnIn(dstReceiver.address))
			)
				.to.be.revertedWithCustomError(pool, "ReceiverNotEligible")
				.withArgs(dstReceiver.address);
		});

		it("rejects a non-EVM (non-32-byte) receiver", async function () {
			const badIn = {
				...lockOrBurnIn(verifiedUser.address),
				receiver: "0x1234", // 2 bytes
			};
			await expect(
				pool.lockOrBurn.staticCall(badIn)
			).to.be.revertedWithCustomError(pool, "NonEvmReceiver");
		});

		it("lets an ELIGIBLE receiver past the gate (then hits CCIP onRamp auth, not our gate)", async function () {
			// Our compliance gate passes for an eligible receiver; the call then
			// reverts inside the base's _validateLockOrBurn because this test
			// signer is not a registered CCIP onRamp — proving the gate let it
			// through rather than rejecting on compliance.
			await expect(
				pool.lockOrBurn.staticCall(lockOrBurnIn(verifiedUser.address))
			).to.not.be.revertedWithCustomError(pool, "ReceiverNotEligible");
		});

		it("gate reflects credential revocation (same live policy)", async function () {
			await expect(
				pool.lockOrBurn.staticCall(lockOrBurnIn(verifiedUser.address))
			).to.not.be.revertedWithCustomError(pool, "ReceiverNotEligible");

			// revoke verifiedUser's KYC -> the gate now rejects them
			await core.credentialRegistry
				.connect(admin)
				.removeCredential(
					ethers.zeroPadValue(verifiedUser.address, 32),
					ethers.keccak256(ethers.toUtf8Bytes("common.kyc")),
					"0x"
				);
			await expect(
				pool.lockOrBurn.staticCall(lockOrBurnIn(verifiedUser.address))
			)
				.to.be.revertedWithCustomError(pool, "ReceiverNotEligible")
				.withArgs(verifiedUser.address);

			// restore the KYC credential (identity already exists)
			await core.credentialRegistry
				.connect(admin)
				.registerCredential(
					ethers.zeroPadValue(verifiedUser.address, 32),
					ethers.keccak256(ethers.toUtf8Bytes("common.kyc")),
					0n,
					"0x",
					"0x"
				);
		});
	});
});
