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

const DAY = 24 * 60 * 60;

// H3 regression: finalize() distributes in a loop through the token's
// policy-gated mint; one investor whose KYC lapsed must not revert the whole
// distribution. Their share parks in pendingTokens for a claimTokens() pull.
describe("ListingEscrow distribution fault tolerance (H3 regression)", function () {
	let admin: any;
	let sponsor: any;
	let alice: any;
	let bob: any;
	let core: any;
	let token: any;
	let pay: any;
	let escrow: any;

	const TARGET = ethers.parseUnits("1000", 18);
	const SUPPLY = ethers.parseUnits("1000", 18);

	beforeEach(async function () {
		[admin, sponsor, alice, bob] = await ethers.getSigners();
		core = await deployAceCore(admin);

		await onboard(core, admin, alice);
		await onboard(core, admin, bob);

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

		const MockERC20 = await ethers.getContractFactory("MockERC20");
		pay = await MockERC20.deploy();
		await pay.waitForDeployment();

		const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
		const tx = await core.factory
			.connect(admin)
			.deployEscrow(
				productId,
				await pay.getAddress(),
				sponsor.address,
				TARGET,
				SUPPLY,
				now + BigInt(DAY),
				admin.address
			);
		const receipt = await tx.wait();
		const event = receipt!.logs.find((log: any) => {
			try {
				return core.factory.interface.parseLog(log)!.name === "EscrowDeployed";
			} catch {
				return false;
			}
		});
		const escrowAddr = core.factory.interface.parseLog(event!)!.args.escrow;
		const Escrow = await ethers.getContractFactory("ListingEscrow");
		escrow = Escrow.attach(escrowAddr);

		const record = await core.factory.getProduct(productId);
		const PropertyToken = await ethers.getContractFactory("PropertyToken");
		token = PropertyToken.attach(record.token);

		const half = TARGET / 2n;
		for (const s of [alice, bob]) {
			await pay.mint(s.address, half);
			await pay.connect(s).approve(await escrow.getAddress(), half);
			await escrow.connect(s).deposit(half);
		}

		await ethers.provider.send("evm_increaseTime", [DAY + 1]);
		await ethers.provider.send("evm_mine", []);
	});

	it("finalize survives a non-compliant investor and parks their share", async function () {
		// bob's KYC lapses between deposit and finalize
		await core.credentialRegistry
			.connect(admin)
			.removeCredential(ccidFor(bob.address), KYC(), "0x");

		await expect(escrow.finalize()).to.emit(escrow, "Finalized");

		// alice was paid directly; bob's share is pending, not lost
		expect(await token.balanceOf(alice.address)).to.equal(SUPPLY / 2n);
		expect(await token.balanceOf(bob.address)).to.equal(0n);
		expect(await escrow.pendingTokens(bob.address)).to.equal(SUPPLY / 2n);
		expect(await escrow.totalPendingTokens()).to.equal(SUPPLY / 2n);

		// still ineligible -> pull fails at the token's mint eligibility check;
		// the failed pull must not zero the pending balance
		await expect(escrow.connect(bob).claimTokens()).to.be.revertedWithCustomError(
			core.engine,
			"PolicyRunRejected"
		);
		expect(await escrow.pendingTokens(bob.address)).to.equal(SUPPLY / 2n);

		// re-KYC -> pull succeeds exactly once
		await core.credentialRegistry
			.connect(admin)
			.registerCredential(ccidFor(bob.address), KYC(), 0n, "0x", "0x");
		await expect(escrow.connect(bob).claimTokens()).to.emit(escrow, "TokensClaimed");
		expect(await token.balanceOf(bob.address)).to.equal(SUPPLY / 2n);
		expect(await escrow.totalPendingTokens()).to.equal(0n);
		await expect(escrow.connect(bob).claimTokens()).to.be.revertedWith(
			"Nothing to claim"
		);
	});

	it("distributes directly to everyone when all investors are compliant", async function () {
		await escrow.finalize();
		expect(await token.balanceOf(alice.address)).to.equal(SUPPLY / 2n);
		expect(await token.balanceOf(bob.address)).to.equal(SUPPLY / 2n);
		expect(await escrow.pendingTokens(alice.address)).to.equal(0n);
		expect(await escrow.pendingTokens(bob.address)).to.equal(0n);
	});

	it("blocks claimTokens before finalize", async function () {
		await expect(escrow.connect(alice).claimTokens()).to.be.revertedWith(
			"Not finalized"
		);
	});
});
