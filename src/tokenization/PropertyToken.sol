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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {
	ComplianceTokenERC3643
} from "@chainlink/ace/packages/tokens/erc-3643/src/ComplianceTokenERC3643.sol";

/**
 * @title PropertyToken
 * @notice ACE-native property token: stock Chainlink ACE `ComplianceTokenERC3643`
 * with the Commertize snapshot and vault behaviors layered on top.
 * @dev Compliance no longer lives in this contract: eligibility, sanctions and
 * admin rules are enforced by policies attached to the token's selectors in the
 * ACE PolicyEngine (see PropertyFactory). What remains here is product logic:
 * distribution snapshots (used by DividendVault) and the funds vault
 * (`withdrawFunds`).
 *
 * The CCIP pool (`CompliantPropertyTokenPool`) calls `IBurnMintERC20`, so the
 * `burn(uint256)` / `burnFrom(address,uint256)` surface of that interface is
 * implemented on top of the policy-protected `burn(address,uint256)`.
 */
contract PropertyToken is ComplianceTokenERC3643 {
	using SafeERC20 for IERC20;
	using Checkpoints for Checkpoints.Trace208;

	// Snapshot ID counter
	uint256 private _currentSnapshotId;

	// Post-change values checkpointed per snapshot period (OZ Trace208
	// collapses same-key pushes, keeping one checkpoint per period).
	Checkpoints.Trace208 private _totalSupplySnaps;
	mapping(address => Checkpoints.Trace208) private _balanceSnaps;

	// Contracts allowed to take snapshots besides the owner (e.g. DividendVault).
	mapping(address => bool) public isSnapshotter;

	event Snapshot(uint256 id);
	event SnapshotterSet(address indexed account, bool allowed);

	function snapshot() external returns (uint256) {
		require(msg.sender == owner() || isSnapshotter[msg.sender], "Not authorized to snapshot");
		_currentSnapshotId += 1;
		uint256 currentId = _currentSnapshotId;
		emit Snapshot(currentId);
		return currentId;
	}

	function setSnapshotter(address account, bool allowed) external onlyOwner {
		isSnapshotter[account] = allowed;
		emit SnapshotterSet(account, allowed);
	}

	function getCurrentSnapshotId() external view returns (uint256) {
		return _currentSnapshotId;
	}

	/// @notice IBurnMintERC20 surface: burns the caller's balance directly.
	/// @dev Unrestricted self-burn (anyone can burn what they hold), matching
	/// the old ComplianceEnabled model where burns were always allowed. The
	/// policy-protected `burn(address,uint256)` remains for admin-managed
	/// burns via the engine.
	function burn(uint256 amount) external {
		_burn(msg.sender, amount);
	}

	/// @notice IBurnMintERC20 surface: burns `account`'s balance up to its
	/// allowance with the caller.
	function burnFrom(address account, uint256 amount) public {
		uint256 currentAllowance = this.allowance(account, msg.sender);
		if (currentAllowance != type(uint256).max) {
			require(currentAllowance >= amount, "ERC20: burn amount exceeds allowance");
			_approve(account, msg.sender, currentAllowance - amount);
		}
		_burn(account, amount);
	}

	// Overrides

	/// @dev Checkpoint the post-change values keyed by the current snapshot
	/// period. balanceOfAt(id) then reads upperLookup(id - 1): the last value
	/// written before snapshot id was taken — i.e. the balance frozen at
	/// snapshot time, immune to later same-period transfers.
	function _checkpoint(address from, address to) internal {
		uint48 key = SafeCast.toUint48(_currentSnapshotId);
		if (from != address(0)) {
			_balanceSnaps[from].push(key, SafeCast.toUint208(balanceOf(from)));
		}
		if (to != address(0)) {
			_balanceSnaps[to].push(key, SafeCast.toUint208(balanceOf(to)));
		}
		if (from == address(0) || to == address(0)) {
			_totalSupplySnaps.push(key, SafeCast.toUint208(this.totalSupply()));
		}
	}

	function _transfer(address from, address to, uint256 amount) internal virtual override {
		super._transfer(from, to, amount);
		_checkpoint(from, to);
	}

	function _mint(address account, uint256 amount) internal virtual override {
		super._mint(account, amount);
		_checkpoint(address(0), account);
	}

	function _burn(address account, uint256 amount) internal virtual override {
		super._burn(account, amount);
		_checkpoint(account, address(0));
	}

	function _valueAt(
		Checkpoints.Trace208 storage snaps,
		uint256 snapshotId,
		uint256 currentValue
	) private view returns (uint256) {
		require(snapshotId > 0, "Invalid snapshot id");
		// Beyond the latest snapshot there is nothing frozen yet — the live
		// value is the answer (and skips an out-of-range uint48 cast).
		if (snapshotId > _currentSnapshotId) {
			return currentValue;
		}
		return snaps.upperLookup(SafeCast.toUint48(snapshotId - 1));
	}

	function balanceOfAt(address account, uint256 snapshotId) public view returns (uint256) {
		return _valueAt(_balanceSnaps[account], snapshotId, balanceOf(account));
	}

	function totalSupplyAt(uint256 snapshotId) public view returns (uint256) {
		return _valueAt(_totalSupplySnaps, snapshotId, this.totalSupply());
	}

	// ==========================================
	// Vault Functionality
	// ==========================================

	/**
	 * @notice Allow contract to receive native funds (e.g. from Escrow)
	 */
	receive() external payable {}

	/**
	 * @notice Withdraw funds (Native or ERC20) from the contract.
	 * @dev Only owner (Sponsor/Admin) can withdraw.
	 * @param token Address of token to withdraw. address(0) for Native.
	 * @param to Recipient address.
	 * @param amount Amount to withdraw.
	 */
	function withdrawFunds(address token, address to, uint256 amount) external onlyOwner {
		require(to != address(0), "Invalid recipient");

		if (token == address(0)) {
			Address.sendValue(payable(to), amount);
		} else {
			// ERC20
			IERC20(token).safeTransfer(to, amount);
		}
	}
}
