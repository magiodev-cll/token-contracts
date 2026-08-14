import { expect } from "chai";
import hre from "hardhat";
import {
	deployAceCore,
	baseEligibilityConfig,
	onboard,
	ccidFor,
	tokenSurface,
	escrowSurface,
	identityRegistrySurface,
	credentialRegistrySurface,
	assertPolicyCoverage,
} from "./helpers/ace";

const { ethers } = await hre.network.getOrCreate();

describe("Commertize ACE Contracts Suite", function () {
	let admin: any;
	let agent: any;
	let user: any;
	let sponsor: any;
	let core: any;
	let propertyToken: any;
	let escrow: any;
	let productId: bigint;

	before(async function () {
		[admin, agent, user, sponsor] = await ethers.getSigners();
		core = await deployAceCore(admin);
	});

	it("Should deploy the ACE registries behind the policy engine", async function () {
		expect(await core.identityRegistry.getPolicyEngine()).to.equal(
			core.engine.target
		);
		expect(await core.credentialRegistry.getPolicyEngine()).to.equal(
			core.engine.target
		);
	});

	it("Should deploy the Property Factory", async function () {
		expect(await core.factory.owner()).to.equal(admin.address);
	});

	it("Only authorized senders can write to the registries", async function () {
		// admin is authorized on the writer policy
		await core.identityRegistry
			.connect(admin)
			.registerIdentity(ccidFor(agent.address), agent.address, "0x");
		await core.identityRegistry
			.connect(admin)
			.removeIdentity(ccidFor(agent.address), agent.address, "0x");

		// anyone else is rejected by the policy chain
		await expect(
			core.identityRegistry
				.connect(agent)
				.registerIdentity(ccidFor(agent.address), agent.address, "0x")
		).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");
	});

	it("Should deploy PropertyToken and Escrow via Factory", async function () {
		// Onboard admin so they can be minted to and act as product owner.
		await onboard(core, admin, admin);
		await onboard(core, admin, user);

		const { sources, requirements } = baseEligibilityConfig(core);
		productId = await core.factory.nextProductId();
		await core.factory
			.connect(admin)
			.createProduct(
				"Commertize Property",
				"CPROP",
				18,
				sources,
				requirements,
				true,
				admin.address,
				admin.address
			);
		const record = await core.factory.getProduct(productId);
		const PropertyToken = await ethers.getContractFactory("PropertyToken");
		propertyToken = PropertyToken.attach(record.token);

		expect(await propertyToken.name()).to.equal("Commertize Property");
		expect(await propertyToken.getCCIPAdmin()).to.equal(admin.address);

		// mint is policy-gated: authorized minter + eligible recipient
		await propertyToken.connect(admin).mint(user.address, ethers.parseEther("1000"));

		// Deploy Escrow
		const deadline = Math.floor(Date.now() / 1000) + 3600;
		const tx = await core.factory
			.connect(admin)
			.deployEscrow(
				productId,
				ethers.ZeroAddress,
				sponsor.address,
				ethers.parseEther("1.0"),
				ethers.parseEther("1000"),
				deadline,
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
		escrow = core.factory.interface.parseLog(event!)!.args.escrow;

		expect(escrow).to.not.equal(ethers.ZeroAddress);
		expect(await core.factory.isEscrow(escrow)).to.equal(true);
	});

	it("Fail-closed: every protected selector has policies attached", async function () {
		await assertPolicyCoverage(core.engine, [
			...identityRegistrySurface.map((sig) => [core.identityRegistry.target, sig] as [string, string]),
			...credentialRegistrySurface.map((sig) => [core.credentialRegistry.target, sig] as [string, string]),
			...tokenSurface.map((sig) => [propertyToken.target, sig] as [string, string]),
			...escrowSurface.map((sig) => [escrow, sig] as [string, string]),
		]);
	});

	it("RejectPolicy blocks transfers to a sanctioned address", async function () {
		// the reject policy screens the recipient ("to" param), same as the
		// previous SanctionsPolicy behavior
		await core.rejectPolicy.connect(admin).rejectAddress(admin.address);
		await expect(
			propertyToken.connect(user).transfer(admin.address, 1n)
		).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");

		await core.rejectPolicy.connect(admin).unrejectAddress(admin.address);
		await propertyToken.connect(user).transfer(admin.address, 1n);
		expect(await propertyToken.balanceOf(admin.address)).to.equal(1n);
	});

	it("Escrow deposits are gated by the engine (eligibility + reject)", async function () {
		const Escrow = await ethers.getContractFactory("ListingEscrow");
		const escrowC = Escrow.attach(escrow);

		// an un-onboarded investor cannot deposit
		await expect(
			escrowC.connect(agent).deposit(0n, { value: 2000n })
		).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");

		// a rejected investor cannot deposit either
		await core.rejectPolicy.connect(admin).rejectAddress(user.address);
		await expect(
			escrowC.connect(user).deposit(0n, { value: 2000n })
		).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");
		await core.rejectPolicy.connect(admin).unrejectAddress(user.address);

		// an eligible investor can
		await escrowC.connect(user).deposit(0n, { value: 2000n });
		expect(await escrowC.totalRaised()).to.equal(2000n);
	});

	it("depositFor is gated through the account extractor", async function () {
		const Escrow = await ethers.getContractFactory("ListingEscrow");
		const escrowC = Escrow.attach(escrow);

		// depositFor pulls payment tokens from the investor, so this path uses
		// a payment token escrow; the "account" param drives the policy check
		const MockERC20 = await ethers.getContractFactory("MockERC20");
		const pay = await MockERC20.deploy();
		await pay.waitForDeployment();
		const now = Math.floor(Date.now() / 1000) + 3600;
		const tx = await core.factory
			.connect(admin)
			.deployEscrow(
				productId,
				await pay.getAddress(),
				sponsor.address,
				ethers.parseEther("1"),
				ethers.parseEther("1000"),
				now,
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
		const escrowC2 = Escrow.attach(escrowAddr);

		await pay.mint(user.address, 1000000n);
		await pay.connect(user).approve(escrowAddr, 1000000n);

		// un-onboarded investor blocked via the account param
		await pay.mint(agent.address, 1000000n);
		await pay.connect(agent).approve(escrowAddr, 1000000n);
		await expect(
			escrowC2.connect(admin).depositFor(agent.address, 2000n)
		).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");

		// eligible investor succeeds
		await escrowC2.connect(admin).depositFor(user.address, 2000n);
		expect(await escrowC2.totalRaised()).to.equal(2000n);
	});

	it("expired credentials fail eligibility", async function () {
		// bob with KYC/AML expiring momentarily cannot be minted to or deposit
		const bob = (await ethers.getSigners())[4];
		const { sources, requirements } = baseEligibilityConfig(core);
		const productId2 = await core.factory.nextProductId();
		await core.factory
			.connect(admin)
			.createProduct(
				"Expiry Prop",
				"EXP",
				18,
				sources,
				requirements,
				true,
				admin.address,
				admin.address
			);
		const record2 = await core.factory.getProduct(productId2);
		const PropertyToken = await ethers.getContractFactory("PropertyToken");
		const token2 = PropertyToken.attach(record2.token);

		await onboard(core, admin, bob, {
			expiresAt: BigInt(Math.floor(Date.now() / 1000) + 60),
		});
		await token2.connect(admin).mint(bob.address, 10n);
		await ethers.provider.send("evm_increaseTime", [120]);
		await ethers.provider.send("evm_mine", []);

		// mint to the now-expired investor reverts via the eligibility policy
		await expect(
			token2.connect(admin).mint(bob.address, 10n)
		).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");
	});
});
