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

// Hardhat compiles npm dependency sources only when they are reachable from the
// project's own sources. The policy extractors are deployed as part of the ACE
// core (scripts/lib/ace-core.ts) but are never imported by a project contract,
// so they are pulled into the compilation graph here. Test tooling and deploy
// scripts instantiate them from the build-info output.
import {ERC20TransferExtractor} from "@chainlink/ace/packages/policy-management/src/extractors/ERC20TransferExtractor.sol";
import {ERC3643MintBurnExtractor} from "@chainlink/ace/packages/policy-management/src/extractors/ERC3643MintBurnExtractor.sol";
