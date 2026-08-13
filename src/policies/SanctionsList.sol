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

import "@openzeppelin/contracts/access/Ownable.sol";

// Mock contract representing a public sanctions list.
// In a real-world scenario, this would be a highly secure contract managed by
// a trusted data provider (e.g. a Chainlink-managed or institutional list).
//
// Ported from smartcontractkit/chainlink-ace @ 60f0450
// (getting_started/advanced/SanctionsList.sol), licensed under BUSL-1.1.
// The upstream copy pins solc 0.8.26; relaxed here to ^0.8.24 for the repo's
// 0.8.25 toolchain.
contract SanctionsList is Ownable {
	mapping(address => bool) public isSanctioned;

	event AddedToSanctionsList(address indexed account);
	event RemovedFromSanctionsList(address indexed account);

	constructor() Ownable(msg.sender) {}

	function add(address _account) public onlyOwner {
		isSanctioned[_account] = true;
		emit AddedToSanctionsList(_account);
	}

	function remove(address _account) public onlyOwner {
		isSanctioned[_account] = false;
		emit RemovedFromSanctionsList(_account);
	}
}
