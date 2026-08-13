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

import {Policy} from "@chainlink/policy-management/core/Policy.sol";
import {IPolicyEngine} from "@chainlink/policy-management/interfaces/IPolicyEngine.sol";
import {SanctionsList} from "./SanctionsList.sol";

// Ported from smartcontractkit/chainlink-ace @ 60f0450
// (getting_started/advanced/SanctionsPolicy.sol), licensed under BUSL-1.1.
// Two changes from upstream:
// 1. The upstream copy pins solc 0.8.26; relaxed here to ^0.8.24.
// 2. The upstream tutorial copy is missing the _disableInitializers()
//    constructor required by the v1.2.0 Policy base when deployed behind a
//    proxy; it is added here.
contract SanctionsPolicy is Policy {
	string public constant override typeAndVersion = "SanctionsPolicy 1.2.0";

	address public sanctionsList;

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Configures the policy with the sanctions list address.
	 * @dev This is called automatically during initialization.
	 * @param parameters ABI-encoded address of the SanctionsList contract.
	 */
	function configure(bytes calldata parameters) internal override onlyInitializing {
		require(parameters.length > 0, "SanctionsPolicy: configData required");
		address _sanctionsList = abi.decode(parameters, (address));
		_setSanctionsList(_sanctionsList);
	}

	/// @notice Allows updating the sanctions list address after deployment.
	function setSanctionsList(address _listAddress) public onlyOwner {
		_setSanctionsList(_listAddress);
	}

	/// @notice Internal function to validate and set the sanctions list address.
	function _setSanctionsList(address _listAddress) private {
		require(_listAddress != address(0), "SanctionsPolicy: Invalid address");
		sanctionsList = _listAddress;
	}

	function run(
		address, /* caller */
		address, /* subject */
		bytes4, /* selector */
		bytes[] calldata parameters,
		bytes calldata /* context */
	) public view override returns (IPolicyEngine.PolicyResult) {
		if (parameters.length != 1) {
			revert InvalidParameters("SanctionsPolicy: Expected 1 parameter");
		}
		// This policy expects the "to" address as the first parameter
		address recipient = abi.decode(parameters[0], (address));

		SanctionsList _sl = SanctionsList(sanctionsList);

		// If the recipient is on the list, reject the transaction.
		if (_sl.isSanctioned(recipient)) {
			revert IPolicyEngine.PolicyRejected("account sanctions validation failed");
		}

		return IPolicyEngine.PolicyResult.Continue;
	}
}
