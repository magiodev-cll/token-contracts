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
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title IdentitySyncSender
 * @dev Home-chain endpoint that broadcasts identity and credential changes to
 * every configured destination chain via CCIP, so each chain's ACE
 * IdentityRegistry/CredentialRegistry (through its IdentitySyncReceiver,
 * authorized as a writer by the destination's registry writer policy) mirrors
 * global KYC state. This is what makes source-side bridge gating sound: a
 * receiver eligible anywhere is eligible everywhere.
 *
 * Fees are paid in `feeToken` (address(0) = native). For native, the caller
 * sends msg.value covering the sum of per-destination fees (exact amounts are
 * forwarded; any surplus is refunded). For an ERC20 fee token, the caller must
 * approve this contract for the total first.
 *
 * Every broadcast carries a per-user monotonic sequence number, and messages
 * are sent with allowOutOfOrderExecution: CCIP does not guarantee cross-message
 * ordering, so the receiver applies only the highest-seq state per user. This
 * makes a stalled `remove` that is manually executed after a later `register`
 * a no-op instead of a de-authorization bypass.
 */
contract IdentitySyncSender is Ownable, ReentrancyGuard {
	using SafeERC20 for IERC20;
	using EnumerableSet for EnumerableSet.UintSet;

	IRouterClient public immutable router;
	address public immutable feeToken; // address(0) => native

	// destinationChainSelector => IdentitySyncReceiver address
	mapping(uint64 => address) public destReceiver;
	EnumerableSet.UintSet private _destChains;

	// Per-user monotonic sequence number, embedded in every sync payload.
	mapping(address => uint64) public userSeq;

	uint256 public gasLimit = 200_000;

	/// @notice Upper bound on the fee accepted per destination message; caps
	/// how much a single misconfigured/malicious lane router can pull (0 = no
	/// cap). Symmetric across native and ERC20 fee paths.
	uint256 public maxFeePerMessage;

	event DestinationSet(uint64 indexed chainSelector, address receiver);
	event GasLimitSet(uint256 gasLimit);
	event MaxFeePerMessageSet(uint256 maxFee);
	event IdentityBroadcast(
		address indexed user,
		bool removal,
		uint64 indexed chainSelector,
		bytes32 messageId
	);

	error NoDestinations();
	error InsufficientNativeFee(uint256 required, uint256 provided);
	error FeeExceedsMax(uint64 chainSelector, uint256 fee, uint256 maxFee);

	constructor(
		address _router,
		address _feeToken,
		address _owner
	) Ownable(_owner) {
		router = IRouterClient(_router);
		feeToken = _feeToken;
	}

	function setDestination(
		uint64 chainSelector,
		address receiver
	) external onlyOwner {
		if (receiver != address(0)) {
			_destChains.add(chainSelector);
		} else {
			_destChains.remove(chainSelector);
		}
		destReceiver[chainSelector] = receiver;
		emit DestinationSet(chainSelector, receiver);
	}

	function setGasLimit(uint256 _gasLimit) external onlyOwner {
		gasLimit = _gasLimit;
		emit GasLimitSet(_gasLimit);
	}

	function setMaxFeePerMessage(uint256 _maxFee) external onlyOwner {
		maxFeePerMessage = _maxFee;
		emit MaxFeePerMessageSet(_maxFee);
	}

	function destinationCount() external view returns (uint256) {
		return _destChains.length();
	}

	function destChainAt(uint256 index) external view returns (uint64) {
		return uint64(_destChains.at(index));
	}

	/// @notice Broadcasts a wallet -> CCID registration to all destinations.
	function broadcastRegister(
		address user,
		bytes32 ccid
	) external payable onlyOwner nonReentrant {
		uint64 seq = ++userSeq[user];
		_broadcast(abi.encode(false, user, ccid, bytes32(0), false, uint40(0), seq), user, false);
	}

	/// @notice Broadcasts an identity removal to all destinations.
	function broadcastRemove(address user) external payable onlyOwner nonReentrant {
		uint64 seq = ++userSeq[user];
		_broadcast(abi.encode(true, user, bytes32(0), bytes32(0), false, uint40(0), seq), user, true);
	}

	/// @notice Broadcasts a credential enable/renew/remove (with expiry) to all
	/// destinations. The CCID is resolved by the receiver from the local
	/// IdentityRegistry, so the identity must already be synced.
	function broadcastCredential(
		address user,
		bytes32 credentialType,
		bool enabled,
		uint40 expiresAt
	) external payable onlyOwner nonReentrant {
		uint64 seq = ++userSeq[user];
		_broadcast(abi.encode(false, user, bytes32(0), credentialType, enabled, expiresAt, seq), user, false);
	}

	function _broadcast(
		bytes memory data,
		address user,
		bool removal
	) internal {
		uint256 len = _destChains.length();
		if (len == 0) revert NoDestinations();

		uint256 nativeSpent = 0;
		for (uint256 i = 0; i < len; i++) {
			uint64 sel = uint64(_destChains.at(i));
			address receiver = destReceiver[sel];

			Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
				receiver: abi.encode(receiver),
				data: data,
				tokenAmounts: new Client.EVMTokenAmount[](0),
				feeToken: feeToken,
				// Out-of-order execution: ordering is enforced by the per-user
				// seq in the payload, so a stuck message must not head-of-line
				// block later (possibly more urgent) removes.
				extraArgs: Client._argsToBytes(
					Client.GenericExtraArgsV2({
						gasLimit: gasLimit,
						allowOutOfOrderExecution: true
					})
				)
			});

			uint256 fee = router.getFee(sel, message);
			if (maxFeePerMessage != 0 && fee > maxFeePerMessage) {
				revert FeeExceedsMax(sel, fee, maxFeePerMessage);
			}
			bytes32 messageId;
			if (feeToken == address(0)) {
				nativeSpent += fee;
				if (msg.value < nativeSpent) {
					revert InsufficientNativeFee(nativeSpent, msg.value);
				}
				messageId = router.ccipSend{value: fee}(sel, message);
			} else {
				IERC20(feeToken).safeTransferFrom(msg.sender, address(this), fee);
				IERC20(feeToken).forceApprove(address(router), fee);
				messageId = router.ccipSend(sel, message);
			}
			emit IdentityBroadcast(user, removal, sel, messageId);
		}

		// Refund any native surplus.
		if (feeToken == address(0) && msg.value > nativeSpent) {
			Address.sendValue(payable(msg.sender), msg.value - nativeSpent);
		}
	}
}
