import { expect } from "chai";
import hre from "hardhat";
import {
	ethers,
	deployAceCore,
	ccidFor,
	KYC,
	AML,
} from "./helpers/ace";

describe("Cross-chain Identity Sync", function () {
	let admin: any;
	let user: any;
	let outsider: any;
	let routerSigner: any; // stands in for the CCIP router calling ccipReceive
	let core: any;

	before(async function () {
		[admin, user, outsider, routerSigner] = await ethers.getSigners();
		core = await deployAceCore(admin);
	});

	describe("ACE registry writer policy", function () {
		it("an authorized writer can register and remove identities", async function () {
			await core.identityRegistry
				.connect(admin)
				.registerIdentity(ccidFor(user.address), user.address, "0x");
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ccidFor(user.address)
			);
			await core.identityRegistry
				.connect(admin)
				.removeIdentity(ccidFor(user.address), user.address, "0x");
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ethers.ZeroHash
			);
		});

		it("an unauthorized caller cannot write to the registries", async function () {
			await expect(
				core.identityRegistry
					.connect(outsider)
					.registerIdentity(ccidFor(user.address), user.address, "0x")
			).to.be.revertedWithCustomError(core.engine, "PolicyRunRejected");
		});

		it("a newly authorized issuer can write (OnlyAuthorizedSenderPolicy)", async function () {
			await core.writerPolicy.authorizeSender(outsider.address);
			await core.identityRegistry
				.connect(outsider)
				.registerIdentity(ccidFor(user.address), user.address, "0x");
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ccidFor(user.address)
			);
			await core.identityRegistry
				.connect(admin)
				.removeIdentity(ccidFor(user.address), user.address, "0x");
			await core.writerPolicy.unauthorizeSender(outsider.address);
		});
	});

	describe("IdentitySyncReceiver", function () {
		let receiver: any;
		const SOURCE_SELECTOR = 3478487238524512106n;
		const trustedSenderAddr = "0x00000000000000000000000000000000000000A1";

		before(async function () {
			const Receiver = await ethers.getContractFactory("IdentitySyncReceiver");
			// router = routerSigner so we can invoke ccipReceive as the router
			receiver = await Receiver.deploy(
				routerSigner.address,
				core.identityRegistry.target,
				core.credentialRegistry.target,
				admin.address
			);
			await receiver.waitForDeployment();
			// the receiver writes to the destination registries through the
			// registry writer policy (replaces the old SYNC_ROLE grant)
			await core.writerPolicy.authorizeSender(await receiver.getAddress());
			await receiver.setTrustedSender(SOURCE_SELECTOR, trustedSenderAddr);
		});

		function message(senderAddr: string, data: string) {
			return {
				messageId: ethers.ZeroHash,
				sourceChainSelector: SOURCE_SELECTOR,
				sender: ethers.AbiCoder.defaultAbiCoder().encode(
					["address"],
					[senderAddr]
				),
				data,
				destTokenAmounts: [],
			};
		}

		function payload(
			isRemoval: boolean,
			userAddr: string,
			ccid: string,
			credentialType: string,
			enabled: boolean,
			expiresAt: bigint,
			seq: bigint
		) {
			return ethers.AbiCoder.defaultAbiCoder().encode(
				["bool", "address", "bytes32", "bytes32", "bool", "uint40", "uint64"],
				[isRemoval, userAddr, ccid, credentialType, enabled, expiresAt, seq]
			);
		}

		function registerPayload(seq: bigint) {
			return payload(false, user.address, ccidFor(user.address), ethers.ZeroHash, false, 0n, seq);
		}
		function removePayload(seq: bigint) {
			return payload(true, user.address, ethers.ZeroHash, ethers.ZeroHash, false, 0n, seq);
		}
		function credentialPayload(type: string, enabled: boolean, seq: bigint) {
			return payload(false, user.address, ethers.ZeroHash, type, enabled, 0n, seq);
		}

		it("rejects a call from a non-router caller", async function () {
			await expect(
				receiver
					.connect(outsider)
					.ccipReceive(
						message(trustedSenderAddr, registerPayload(1n))
					)
			).to.be.revertedWithCustomError(receiver, "InvalidRouter");
		});

		it("rejects a message from an untrusted sender", async function () {
			await expect(
				receiver
					.connect(routerSigner)
					.ccipReceive(
						message(outsider.address, registerPayload(1n))
					)
			).to.be.revertedWithCustomError(receiver, "UntrustedSource");
		});

		it("mirrors a registration from the trusted sender", async function () {
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, registerPayload(1n))
				);
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ccidFor(user.address)
			);
			expect(await receiver.lastSeq(user.address)).to.equal(1n);
		});

		it("mirrors a removal from the trusted sender", async function () {
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, removePayload(2n))
				);
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ethers.ZeroHash
			);
		});

		it("mirrors credential changes (with expiry) from the trusted sender", async function () {
			// identity must exist before credentials can be applied
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, registerPayload(3n))
				);
			const ccid = ccidFor(user.address);

			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, credentialPayload(KYC(), true, 4n))
				);
			expect(await core.credentialRegistry.validate(ccid, KYC(), "0x")).to.equal(true);
			expect(await core.credentialRegistry.validate(ccid, AML(), "0x")).to.equal(false);

			// removal mirrors the same way
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, credentialPayload(KYC(), false, 5n))
				);
			expect(await core.credentialRegistry.validate(ccid, KYC(), "0x")).to.equal(false);

			// cleanup
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, removePayload(6n))
				);
		});

		it("discards a stale register replayed after a newer remove (reorder attack)", async function () {
			// user was removed at seq 6; a stuck seq-1 register executed late
			// must NOT re-verify them.
			await expect(
				receiver
					.connect(routerSigner)
					.ccipReceive(
						message(trustedSenderAddr, registerPayload(1n))
					)
			).to.emit(receiver, "StaleSyncDiscarded");
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ethers.ZeroHash
			);
			expect(await receiver.lastSeq(user.address)).to.equal(6n);
		});

		it("discards an equal-seq replay of the last applied message", async function () {
			await expect(
				receiver
					.connect(routerSigner)
					.ccipReceive(
						message(trustedSenderAddr, removePayload(6n))
					)
			).to.emit(receiver, "StaleSyncDiscarded");
		});

		it("applies the next in-sequence message normally", async function () {
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, registerPayload(7n))
				);
			expect(await core.identityRegistry.getIdentity(user.address)).to.equal(
				ccidFor(user.address)
			);
			// cleanup for subsequent suites
			await receiver
				.connect(routerSigner)
				.ccipReceive(
					message(trustedSenderAddr, removePayload(8n))
				);
		});

		it("enforces a single active source (lastSeq is one sequence space)", async function () {
			const OTHER_SELECTOR = 4949039107694359620n;
			await expect(
				receiver.setTrustedSender(OTHER_SELECTOR, trustedSenderAddr)
			).to.be.revertedWithCustomError(receiver, "SourceAlreadyActive");

			// clearing the active source frees the slot; then restore state.
			await receiver.setTrustedSender(SOURCE_SELECTOR, ethers.ZeroAddress);
			await receiver.setTrustedSender(OTHER_SELECTOR, trustedSenderAddr);
			expect(await receiver.activeSourceSelector()).to.equal(OTHER_SELECTOR);
			await receiver.setTrustedSender(OTHER_SELECTOR, ethers.ZeroAddress);
			await receiver.setTrustedSender(SOURCE_SELECTOR, trustedSenderAddr);
		});
	});

	describe("IdentitySyncSender", function () {
		let sender: any;
		let mockRouter: any;
		const SEL_A = 111n;
		const SEL_B = 222n;
		const recvA = "0x00000000000000000000000000000000000000B1";
		const recvB = "0x00000000000000000000000000000000000000B2";
		const FEE = ethers.parseEther("0.01");

		before(async function () {
			const MockRouter = await ethers.getContractFactory("MockCCIPRouter");
			mockRouter = await MockRouter.deploy(FEE);
			await mockRouter.waitForDeployment();

			const Sender = await ethers.getContractFactory("IdentitySyncSender");
			// native fee (feeToken = address(0))
			sender = await Sender.deploy(
				mockRouter.target,
				ethers.ZeroAddress,
				admin.address
			);
			await sender.waitForDeployment();
		});

		it("only owner can set destinations", async function () {
			await expect(
				sender.connect(outsider).setDestination(SEL_A, recvA)
			).to.be.revertedWithCustomError(sender, "OwnableUnauthorizedAccount");
		});

		it("reverts broadcast with no destinations", async function () {
			await expect(
				sender.broadcastRegister(user.address, ccidFor(user.address))
			).to.be.revertedWithCustomError(sender, "NoDestinations");
		});

		it("broadcasts to all destinations and refunds native surplus", async function () {
			await sender.setDestination(SEL_A, recvA);
			await sender.setDestination(SEL_B, recvB);
			expect(await sender.destinationCount()).to.equal(2n);

			const before = await mockRouter.sendCount();
			// send more than 2*FEE; expect exact 2*FEE consumed, remainder refunded
			await sender.broadcastRegister(user.address, ccidFor(user.address), {
				value: FEE * 3n,
			});
			expect(await mockRouter.sendCount()).to.equal(before + 2n);
			// router keeps only the two exact fees
			expect(await ethers.provider.getBalance(mockRouter.target)).to.equal(
				FEE * 2n
			);
			// sender holds nothing (surplus refunded, fees forwarded)
			expect(await ethers.provider.getBalance(sender.target)).to.equal(0n);
		});

		it("reverts when native value cannot cover the fees", async function () {
			await expect(
				sender.broadcastRegister(user.address, ccidFor(user.address), { value: FEE })
			).to.be.revertedWithCustomError(sender, "InsufficientNativeFee");
		});

		it("enforces maxFeePerMessage across the loop", async function () {
			await sender.setMaxFeePerMessage(FEE); // exactly the current fee is ok
			await sender.broadcastRegister(user.address, ccidFor(user.address), {
				value: FEE * 2n,
			});
			// raise the router fee above the cap -> revert
			await mockRouter.setFee(FEE + 1n);
			await expect(
				sender.broadcastRegister(user.address, ccidFor(user.address), { value: FEE * 4n })
			).to.be.revertedWithCustomError(sender, "FeeExceedsMax");
			// reset
			await mockRouter.setFee(FEE);
			await sender.setMaxFeePerMessage(0n);
		});

		it("encodes a removal payload with a monotonic per-user seq", async function () {
			const seqBefore = await sender.userSeq(user.address);
			await sender.broadcastRemove(user.address, { value: FEE * 2n });
			const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
				["bool", "address", "bytes32", "bytes32", "bool", "uint40", "uint64"],
				await mockRouter.lastData()
			);
			expect(decoded[0]).to.equal(true); // isRemoval
			expect(decoded[1]).to.equal(user.address);
			expect(decoded[6]).to.equal(seqBefore + 1n); // seq incremented
			expect(await sender.userSeq(user.address)).to.equal(seqBefore + 1n);
		});

		it("encodes a credential broadcast with type and enable flag", async function () {
			const seqBefore = await sender.userSeq(user.address);
			await sender.broadcastCredential(user.address, KYC(), true, 0n, {
				value: FEE * 2n,
			});
			const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
				["bool", "address", "bytes32", "bytes32", "bool", "uint40", "uint64"],
				await mockRouter.lastData()
			);
			expect(decoded[0]).to.equal(false); // not a removal
			expect(decoded[1]).to.equal(user.address);
			expect(decoded[3]).to.equal(KYC());
			expect(decoded[4]).to.equal(true);
			expect(decoded[6]).to.equal(seqBefore + 1n);
		});

		it("removes a cleared destination so re-adding cannot duplicate it", async function () {
			// clear A, re-add A: destChains must still hold exactly {A, B}.
			await sender.setDestination(SEL_A, ethers.ZeroAddress);
			expect(await sender.destinationCount()).to.equal(1n);
			await sender.setDestination(SEL_A, recvA);
			expect(await sender.destinationCount()).to.equal(2n);

			const before = await mockRouter.sendCount();
			await sender.broadcastRegister(user.address, ccidFor(user.address), {
				value: FEE * 3n,
			});
			// exactly 2 sends — a duplicated selector would produce 3.
			expect(await mockRouter.sendCount()).to.equal(before + 2n);
		});
	});
});
