import { expect } from "chai";
import hre from "hardhat";
import { deployAceCore, baseEligibilityConfig, onboard, ccidFor } from "./helpers/ace";

const { ethers } = await hre.network.getOrCreate();

describe("Commertize ACE Contracts Suite", function () {
	let admin: any;
	let agent: any;
	let user: any;
	let sponsor: any;
	let core: any;
	let propertyToken: any;

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
		const productId = await core.factory.nextProductId();
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
		const escrowAddress = core.factory.interface.parseLog(event!)!.args.escrow;

		expect(escrowAddress).to.not.equal(ethers.ZeroAddress);
		expect(await core.factory.isEscrow(escrowAddress)).to.equal(true);
	});
});
