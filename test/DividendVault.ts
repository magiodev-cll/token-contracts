import { expect } from "chai";
import hre from "hardhat";
import {
	ethers,
	deployAceCore,
	onboard,
	baseEligibilityConfig,
	ccidFor,
	KYC,
} from "./helpers/ace";

const YEAR = 365 * 24 * 60 * 60;

describe("DividendVault behavior", function () {
	let admin: any;
	let alice: any;
	let bob: any;
	let protocol: any;
	let core: any;
	let token: any;
	let usdc: any;
	let vault: any;

	const SUPPLY = ethers.parseUnits("1000", 18);
	const DEPOSIT = ethers.parseUnits("10000", 18);

	beforeEach(async function () {
		[admin, alice, bob, protocol] = await ethers.getSigners();
		core = await deployAceCore(admin);

		for (const s of [admin, alice, bob]) {
			await onboard(core, admin, s);
		}

		const { sources, requirements } = baseEligibilityConfig(core);
		const productId = await core.factory.nextProductId();
		await core.factory
			.connect(admin)
			.createProduct(
				"Prop",
				"PROP",
				18,
				sources,
				requirements,
				true,
				admin.address,
				admin.address
			);
		const record = await core.factory.getProduct(productId);
		const PropertyToken = await ethers.getContractFactory("PropertyToken");
		token = PropertyToken.attach(record.token);

		await token.connect(admin).mint(admin.address, SUPPLY);

		const MockERC20 = await ethers.getContractFactory("MockERC20");
		usdc = await MockERC20.deploy();
		await usdc.waitForDeployment();
		await usdc.mint(admin.address, DEPOSIT * 10n);

		const Vault = await ethers.getContractFactory("DividendVault");
		vault = await Vault.deploy(
			await usdc.getAddress(),
			protocol.address,
			admin.address
		);
		await vault.waitForDeployment();

		// The vault snapshots the token on every deposit.
		await token.setSnapshotter(await vault.getAddress(), true);
		// Only vetted properties can host distributions, and claims are gated
		// by the product's ACE eligibility policy.
		await vault.setPropertyValid(record.token, true);
		await vault.setPropertyEligibilityPolicy(record.token, record.eligibilityPolicy);
		await usdc.approve(await vault.getAddress(), DEPOSIT * 10n);

		// 75/25 split between alice and bob.
		await token.transfer(alice.address, (SUPPLY * 75n) / 100n);
		await token.transfer(bob.address, (SUPPLY * 25n) / 100n);
	});

	it("rejects depositDividend unless the vault is an authorized snapshotter", async function () {
		await token.setSnapshotter(await vault.getAddress(), false);
		await expect(
			vault.depositDividend(await token.getAddress(), DEPOSIT)
		).to.be.revertedWith("Not authorized to snapshot");
	});

	it("rejects depositDividend for a non-validated property", async function () {
		await vault.setPropertyValid(await token.getAddress(), false);
		await expect(
			vault.depositDividend(await token.getAddress(), DEPOSIT)
		).to.be.revertedWith("Property not validated");
	});

	it("rejects depositDividend from a caller who owns neither vault nor token", async function () {
		await usdc.mint(alice.address, DEPOSIT);
		await usdc.connect(alice).approve(await vault.getAddress(), DEPOSIT);
		await expect(
			vault.connect(alice).depositDividend(await token.getAddress(), DEPOSIT)
		).to.be.revertedWith("Not authorized to deposit");
	});

	it("takes the protocol fee and pays holders pro-rata by snapshot", async function () {
		await vault.depositDividend(await token.getAddress(), DEPOSIT);

		const fee = (DEPOSIT * 100n) / 10000n; // 1% default
		expect(await usdc.balanceOf(protocol.address)).to.equal(fee);

		const distributable = DEPOSIT - fee;
		await expect(
			vault.connect(alice).claim(await token.getAddress(), 0)
		).to.emit(vault, "DividendClaimed");
		expect(await usdc.balanceOf(alice.address)).to.equal(
			(distributable * 75n) / 100n
		);
		await vault.connect(bob).claim(await token.getAddress(), 0);
		expect(await usdc.balanceOf(bob.address)).to.equal(
			(distributable * 25n) / 100n
		);
	});

	it("blocks double claims", async function () {
		await vault.depositDividend(await token.getAddress(), DEPOSIT);
		await vault.connect(alice).claim(await token.getAddress(), 0);
		await expect(
			vault.connect(alice).claim(await token.getAddress(), 0)
		).to.be.revertedWith("Already claimed");
	});

	it("pays by snapshot balance even after tokens move post-deposit", async function () {
		await vault.depositDividend(await token.getAddress(), DEPOSIT);
		// alice dumps everything on bob AFTER the snapshot
		await token
			.connect(alice)
			.transfer(bob.address, await token.balanceOf(alice.address));

		const distributable = DEPOSIT - (DEPOSIT * 100n) / 10000n;
		await vault.connect(alice).claim(await token.getAddress(), 0);
		expect(await usdc.balanceOf(alice.address)).to.equal(
			(distributable * 75n) / 100n
		);
		// bob still only gets his snapshot share
		await vault.connect(bob).claim(await token.getAddress(), 0);
		expect(await usdc.balanceOf(bob.address)).to.equal(
			(distributable * 25n) / 100n
		);
	});

	it("blocks claims from ineligible holders until re-verified", async function () {
		await vault.depositDividend(await token.getAddress(), DEPOSIT);
		await core.credentialRegistry
			.connect(admin)
			.removeCredential(ccidFor(bob.address), KYC(), "0x");
		await expect(
			vault.connect(bob).claim(await token.getAddress(), 0)
		).to.be.revertedWith("Claimant not verified");

		await core.credentialRegistry
			.connect(admin)
			.registerCredential(ccidFor(bob.address), KYC(), 0n, "0x", "0x");
		await expect(
			vault.connect(bob).claim(await token.getAddress(), 0)
		).to.emit(vault, "DividendClaimed");
	});

	// H2 regression: recoverUnclaimed must permanently close the distribution,
	// or un-claimed holders can still pull from the shared pool afterward and
	// drain other distributions' funds.
	it("blocks claims after recoverUnclaimed (H2 regression)", async function () {
		await vault.depositDividend(await token.getAddress(), DEPOSIT);
		await vault.connect(alice).claim(await token.getAddress(), 0);

		await ethers.provider.send("evm_increaseTime", [YEAR + 1]);
		await ethers.provider.send("evm_mine", []);

		const ownerBefore = await usdc.balanceOf(admin.address);
		await expect(
			vault.recoverUnclaimed(await token.getAddress(), 0)
		).to.emit(vault, "UnclaimedRecovered");

		const distributable = DEPOSIT - (DEPOSIT * 100n) / 10000n;
		const bobShare = (distributable * 25n) / 100n;
		expect(await usdc.balanceOf(admin.address)).to.equal(
			ownerBefore + bobShare
		);

		// bob never claimed; the shared pool no longer owes him anything.
		await expect(
			vault.connect(bob).claim(await token.getAddress(), 0)
		).to.be.revertedWith("Distribution recovered");
		expect(
			await vault.getClaimableAmount(await token.getAddress(), 0, bob.address)
		).to.equal(0n);
		await expect(
			vault.recoverUnclaimed(await token.getAddress(), 0)
		).to.be.revertedWith("Already recovered");
	});

	it("batchClaim skips recovered and already-claimed distributions", async function () {
		await vault.depositDividend(await token.getAddress(), DEPOSIT);
		await vault.depositDividend(await token.getAddress(), DEPOSIT);

		await vault.connect(bob).claim(await token.getAddress(), 0);
		const afterFirst = await usdc.balanceOf(bob.address);

		// batchClaim over [0, 1]: 0 already claimed (skipped), 1 pays.
		await vault
			.connect(bob)
			.batchClaim(await token.getAddress(), [0, 1]);
		const distributable = DEPOSIT - (DEPOSIT * 100n) / 10000n;
		expect(await usdc.balanceOf(bob.address)).to.equal(
			afterFirst + (distributable * 25n) / 100n
		);
	});
});
