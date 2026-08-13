import { expect } from "chai";
import hre from "hardhat";
import {
	ethers,
	deployAceCore,
	onboard,
	baseEligibilityConfig,
} from "./helpers/ace";

// Regression tests for the snapshot read bug (audit C1): balanceOfAt /
// totalSupplyAt on the LATEST snapshot must return the value frozen when the
// snapshot was taken, not the live balance — otherwise DividendVault can be
// drained by cycling tokens through wallets and re-claiming.
describe("PropertyToken snapshot correctness (C1 regression)", function () {
	let admin: any;
	let owner: any;
	let alice: any;
	let bob: any;
	let carol: any;
	let core: any;
	let token: any;

	const SUPPLY = ethers.parseUnits("1000", 18);

	beforeEach(async function () {
		[admin, owner, alice, bob, carol] = await ethers.getSigners();
		core = await deployAceCore(admin);

		for (const s of [owner, alice, bob, carol]) {
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
				owner.address,
				owner.address
			);
		const record = await core.factory.getProduct(productId);
		const PropertyToken = await ethers.getContractFactory("PropertyToken");
		token = PropertyToken.attach(record.token);

		// product owner mints the supply and seeds alice
		await token.connect(owner).mint(owner.address, SUPPLY);
		await token.connect(owner).transfer(alice.address, ethers.parseUnits("100", 18));
	});

	it("freezes balances at the latest snapshot despite later transfers", async function () {
		const amt = ethers.parseUnits("100", 18);
		await token.connect(owner).snapshot(); // id = 1
		const id = await token.getCurrentSnapshotId();
		expect(id).to.equal(1);

		// Balances at snapshot time.
		expect(await token.balanceOfAt(alice.address, id)).to.equal(amt);
		expect(await token.balanceOfAt(bob.address, id)).to.equal(0);

		// Alice moves everything to Bob AFTER the snapshot.
		await token.connect(alice).transfer(bob.address, amt);

		// The snapshot must be unchanged — this is the drain guard.
		expect(await token.balanceOfAt(alice.address, id)).to.equal(amt);
		expect(await token.balanceOfAt(bob.address, id)).to.equal(0);

		// And Bob relaying to Carol must not create a third claimant either.
		await token.connect(bob).transfer(carol.address, amt);
		expect(await token.balanceOfAt(bob.address, id)).to.equal(0);
		expect(await token.balanceOfAt(carol.address, id)).to.equal(0);
	});

	it("keeps totalSupplyAt stable across a later snapshot's changes", async function () {
		await token.connect(owner).snapshot(); // id = 1
		const id = await token.getCurrentSnapshotId();
		const supplyAt = await token.totalSupplyAt(id);
		expect(supplyAt).to.equal(SUPPLY);

		// A transfer in the same period must not change totalSupplyAt(id).
		await token
			.connect(alice)
			.transfer(bob.address, ethers.parseUnits("10", 18));
		expect(await token.totalSupplyAt(id)).to.equal(SUPPLY);
	});

	it("returns correct historical values across multiple snapshots", async function () {
		const amt = ethers.parseUnits("100", 18);
		await token.connect(owner).snapshot(); // id 1: alice has 100
		await token.connect(alice).transfer(bob.address, ethers.parseUnits("40", 18));
		await token.connect(owner).snapshot(); // id 2: alice 60, bob 40
		await token.connect(bob).transfer(carol.address, ethers.parseUnits("40", 18));
		await token.connect(owner).snapshot(); // id 3: alice 60, bob 0, carol 40

		expect(await token.balanceOfAt(alice.address, 1)).to.equal(amt);
		expect(await token.balanceOfAt(bob.address, 1)).to.equal(0);

		expect(await token.balanceOfAt(alice.address, 2)).to.equal(
			ethers.parseUnits("60", 18)
		);
		expect(await token.balanceOfAt(bob.address, 2)).to.equal(
			ethers.parseUnits("40", 18)
		);

		expect(await token.balanceOfAt(bob.address, 3)).to.equal(0);
		expect(await token.balanceOfAt(carol.address, 3)).to.equal(
			ethers.parseUnits("40", 18)
		);
	});
});
