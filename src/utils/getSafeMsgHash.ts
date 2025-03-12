import { ethers } from 'ethers';

interface SafeTx {
	to: string;
	value: number | string;
	data: string;
	operation: number;
	safeTxGas: number;
	baseGas: number;
	gasPrice: number;
	gasToken: string;
	refundReceiver: string;
	nonce: number | string;
}

// Constants
const SAFETX_TYPEHASH = ethers.keccak256(
	ethers.toUtf8Bytes(
		'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)'
	)
);

/**
 * Computes the safe transaction hash according to EIP-712
 * @param safeTx The safe transaction object
 * @returns The EIP-712 hash of the safe transaction
 */
export function getSafeMsgHash(tx: SafeTx): string {
	// Compute the hash of the data field
	const dataHash = ethers.keccak256(tx.data);

	// Encode the struct according to EIP-712
	const encodedStruct = ethers.AbiCoder.defaultAbiCoder().encode(
		[
			'bytes32',
			'address',
			'uint256',
			'bytes32',
			'uint8',
			'uint256',
			'uint256',
			'uint256',
			'address',
			'address',
			'uint256'
		],
		[
			SAFETX_TYPEHASH,
			tx.to,
			tx.value,
			dataHash,
			tx.operation,
			tx.safeTxGas,
			tx.baseGas,
			tx.gasPrice,
			tx.gasToken,
			tx.refundReceiver,
			tx.nonce
		]
	);

	// Compute the final hash
	return ethers.keccak256(encodedStruct);
}
