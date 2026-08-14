// ┌───────────────────────────────────────────────────────────────────────────┐
// │  UNREVIEWED PROOF OF CONCEPT -- DO NOT USE IN PRODUCTION.                 │
// │                                                                           │
// │  THIS CODE HAS NOT BEEN AUDITED AND HAS NOT BEEN REVIEWED FOR SECURITY.   │
// │  IT IS DEPLOYED ON A TEST NETWORK FOR INTEGRATION TESTING AND DEVELOPMENT │
// │  PURPOSES ONLY. IT IS NOT SUITABLE FOR PRODUCTION USE, AND IT MUST NOT BE │
// │  USED TO HOLD OR MOVE ANY ASSET OF VALUE.                                 │
// │                                                                           │
// │  PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. USE AT YOUR OWN RISK.    │
// └───────────────────────────────────────────────────────────────────────────┘
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IBurnMintERC20} from "@chainlink/contracts/src/v0.8/shared/token/ERC20/IBurnMintERC20.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {IIdentityValidator} from "@chainlink/cross-chain-identity/interfaces/IIdentityValidator.sol";

/**
 * @title CompliantPropertyTokenPool
 * @dev CCIP burn/mint pool with SOURCE-SIDE compliance gating.
 *
 * The destination chain cannot reject a mint without stranding already-burned
 * tokens (CCIP's OffRamp requires releaseOrMint to credit the receiver exactly,
 * so a rejected receiver either strands funds or forces the mint-and-freeze
 * fallback). To guarantee that tokens can NEVER be bridged to an ineligible
 * receiver, this pool checks the destination receiver against the product's ACE
 * eligibility policy BEFORE burning, in lockOrBurn. Because identity and
 * credentials are mirrored to every chain (see IdentitySyncSender/Receiver), a
 * receiver eligible on the destination is eligible here too, so the local check
 * is a sound proxy.
 *
 * The destination token remains policy-protected: the destination pool must be
 * authorized as a minter on the destination product's mint policy.
 *
 * Receiver is read from lockOrBurnIn.receiver, which is abi.encode(address) for
 * EVM destinations. Non-EVM (non-32-byte) receivers are rejected.
 */
contract CompliantPropertyTokenPool is BurnMintTokenPool {
	IIdentityValidator public eligibilityPolicy;

	error ReceiverNotEligible(address receiver);
	error NonEvmReceiver();
	error InvalidAddress();

	event OutboundGated(
		uint64 indexed remoteChainSelector,
		address indexed receiver,
		uint256 amount
	);
	event EligibilityPolicySet(address indexed policy);

	constructor(
		IBurnMintERC20 token,
		uint8 localTokenDecimals,
		address[] memory allowlist,
		address rmnProxy,
		address router
	) BurnMintTokenPool(token, localTokenDecimals, allowlist, rmnProxy, router) {}

	/// @notice Sets the product's ACE eligibility policy (IIdentityValidator).
	function setEligibilityPolicy(address policy) external onlyOwner {
		if (policy == address(0)) revert InvalidAddress();
		eligibilityPolicy = IIdentityValidator(policy);
		emit EligibilityPolicySet(policy);
	}

	/// @dev Gates the destination receiver before delegating to the base
	/// lock/burn. Runs alongside the base's own validation (allowlist, RMN,
	/// rate limits), which execute inside super.lockOrBurn.
	function lockOrBurn(
		Pool.LockOrBurnInV1 calldata lockOrBurnIn
	) public override returns (Pool.LockOrBurnOutV1 memory) {
		if (lockOrBurnIn.receiver.length != 32) revert NonEvmReceiver();
		address receiver = abi.decode(lockOrBurnIn.receiver, (address));

		if (!eligibilityPolicy.validate(receiver, "")) {
			revert ReceiverNotEligible(receiver);
		}

		emit OutboundGated(
			lockOrBurnIn.remoteChainSelector,
			receiver,
			lockOrBurnIn.amount
		);
		return super.lockOrBurn(lockOrBurnIn);
	}
}
