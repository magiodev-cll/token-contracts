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

import {IExtractor} from "@chainlink/policy-management/interfaces/IExtractor.sol";
import {IPolicyEngine} from "@chainlink/policy-management/interfaces/IPolicyEngine.sol";

/**
 * @title AccountExtractor
 * @notice Extracts the relevant account from `ListingEscrow` deposit calls so
 * the ACE eligibility and reject policies can govern them through the engine.
 * @dev ACE ships extractors for mainstream ERC-20/ERC-3643 selectors only;
 * custom contracts that policy-protect their own functions supply their own
 * extractor — this is the documented extension point (IExtractor).
 *
 * - `deposit(uint256)`: the investor is the caller, exposed as `from`
 *   (same convention ERC20TransferExtractor uses for `transfer`).
 * - `depositFor(address,uint256)`: the investor is the decoded account.
 */
contract AccountExtractor is IExtractor {
	string public constant override typeAndVersion = "AccountExtractor 1.0.0";

	bytes32 public constant PARAM_FROM = keccak256("from");
	bytes32 public constant PARAM_ACCOUNT = keccak256("account");

	function extract(IPolicyEngine.Payload calldata payload)
		external
		pure
		override
		returns (IPolicyEngine.Parameter[] memory)
	{
		if (payload.selector == bytes4(keccak256("deposit(uint256)"))) {
			IPolicyEngine.Parameter[] memory from = new IPolicyEngine.Parameter[](1);
			from[0] = IPolicyEngine.Parameter(PARAM_FROM, abi.encode(payload.sender));
			return from;
		}

		if (payload.selector == bytes4(keccak256("depositFor(address,uint256)"))) {
			(address account,) = abi.decode(payload.data, (address, uint256));
			IPolicyEngine.Parameter[] memory accountParam = new IPolicyEngine.Parameter[](1);
			accountParam[0] = IPolicyEngine.Parameter(PARAM_ACCOUNT, abi.encode(account));
			return accountParam;
		}

		revert IPolicyEngine.UnsupportedSelector(payload.selector);
	}
}
