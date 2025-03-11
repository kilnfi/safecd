import SafeApiKit, { ProposeTransactionProps } from '@safe-global/api-kit';
import { ethers, getAddress, isAddress } from 'ethers';
import { readFileSync } from 'fs';
import YAML from 'yaml';
import { z } from 'zod';
import { State } from './state';

const ethAddressSchema = z
	.string()
	.refine(value => isAddress(value), {
		message: 'Provided address is invalid. Please insure you have typed correctly.'
	})
	.transform(value => getAddress(value));

export const GlobalConfigSchema = z.object({
	network: z.string(),
	title: z.string(),
	addressBook: z.array(z.object({ name: z.string(), address: ethAddressSchema })).optional()
});

const AddressSchema = z.object({
	type: z.string(),
	name: z.string(),
	address: ethAddressSchema
});

export const NotificationSchema = z.object({
	slack: z
		.object({
			channels: z.array(z.string())
		})
		.optional()
});

export const EOASchema = AddressSchema.extend({
	type: z.literal('eoa'),
	description: z.string().optional()
});

export const DelegateSchema = z.object({
	delegate: ethAddressSchema,
	delegator: ethAddressSchema,
	label: z.string()
});

export const SafeSchema = AddressSchema.extend({
	type: z.literal('safe'),
	description: z.string().optional(),
	notifications: NotificationSchema.optional(),
	owners: z.array(ethAddressSchema).optional(),
	delegates: z.array(DelegateSchema).optional(),
	threshold: z.number().optional(),
	nonce: z.coerce.number().optional(),
	version: z.string().optional()
});

export const PopulatedSafeSchema = SafeSchema.extend({
	owners: z.array(ethAddressSchema),
	delegates: z.array(DelegateSchema),
	threshold: z.number(),
	nonce: z.number(),
	version: z.string()
});

export const LabelSchema = z.object({
	name: z.string(),
	address: ethAddressSchema
});

export const NotificationTrackingSchema = z.object({
	slack: z
		.array(
			z.object({
				channel: z.string(),
				message: z.string().optional(),
				hash: z.string().optional()
			})
		)
		.optional()
});

export const ProposalSchema = z.object({
	title: z.string(),
	description: z.string().optional(),
	safe: ethAddressSchema,
	delegate: ethAddressSchema,
	proposal: z.string().optional(),
	function: z.string().optional(),
	childOf: z
		.object({
			safe: z.string(),
			hash: z.string()
		})
		.optional(),
	nonce: z.string().optional(),
	arguments: z.any().optional(),
	safeTxHash: z.string().optional(),
	messageHash: z.string().optional(),
	labels: z.array(LabelSchema).optional(),
	createChildProposals: z.boolean().optional(),
	notifications: NotificationTrackingSchema.optional()
});

export const TransactionSchema = z.object({
	safe: z.string(),
	to: z.string(),
	value: z.string(),
	data: z.string().optional().nullable(),
	operation: z.number(),
	gasToken: z.string(),
	safeTxGas: z.coerce.number().optional(),
	baseGas: z.coerce.number().optional(),
	gasPrice: z.string(),
	refundReceiver: z.string().optional().nullable(),
	nonce: z.coerce.number().optional(),
	executionDate: z.string().optional().nullable(),
	submissionDate: z.string(),
	modified: z.string(),
	blockNumber: z.number().optional().nullable(),
	transactionHash: z.string().optional().nullable(),
	safeTxHash: z.string(),
	executor: z.string().optional().nullable(),
	proposer: z.string().nullable().nullable(),
	isExecuted: z.boolean(),
	isSuccessful: z.boolean().optional().nullable(),
	ethGasPrice: z.string().optional().nullable(),
	gasUsed: z.number().optional().nullable(),
	fee: z.string().optional().nullable(),
	origin: z.string().optional().nullable(),
	dataDecoded: z.any(),
	confirmationsRequired: z.number(),
	confirmations: z
		.array(
			z.object({
				owner: z.string(),
				submissionDate: z.string(),
				transactionHash: z.string().optional().nullable(),
				signature: z.string(),
				signatureType: z.string().optional().nullable()
			})
		)
		.optional()
		.nullable(),
	trusted: z.boolean(),
	signatures: z.string().optional().nullable()
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type Safe = z.infer<typeof SafeSchema>;
export type EOA = z.infer<typeof EOASchema>;
export type PopulatedSafe = z.infer<typeof PopulatedSafeSchema>;
export type Delegate = z.infer<typeof DelegateSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type Label = z.infer<typeof LabelSchema>;
export type NotificationTracking = z.infer<typeof NotificationTrackingSchema>;
export type Notification = z.infer<typeof NotificationSchema>;

export function loadEntity<T>(zo: z.ZodType<T>, path: string): T {
	const rawSafe = YAML.parse(readFileSync(path, 'utf8'));
	const res = zo.safeParse(rawSafe);
	if (!res.success) {
		console.error(`error${res.error.errors.length > 1 ? 's' : ''} parsing ${path}:`);
		console.error();
		console.error(YAML.stringify(res.error.errors, { lineWidth: 0 }));
		console.error();
		throw new Error(`invalid object file at ${path}`);
	}
	return res.data;
}

export interface WriteOperation {
	file: string;
	content: string;
}

export interface SafeCDKit {
	sak: SafeApiKit;
	provider: ethers.Provider;
	signers: { [key: string]: ethers.Signer };
	shouldUpload: boolean;
	shouldWrite: boolean;
	rpcUrl: string;
	safeUrl: string;
	network: string;
	network_id: number;
	state: State;
}

export interface Manifest {
	safe: PopulatedSafe;
	raw_proposal: Proposal;
	raw_script: string;
	raw_command: string;
	simulation_output: string;
	simulation_error_output?: string;
	simulation_success: boolean;
	simulation_transactions: ForgeTransaction[];
	safe_estimation?: any;
	safe_transaction?: ProposeTransactionProps['safeTransactionData'];
	error?: string;
}

export interface ForgeTransaction {
	hash: string;
	transactionType: string;
	contractName: string;
	contractAddress: string;
	function: string;
	arguments: string;
	transaction: {
		type: string;
		from: string;
		to: string;
		gas: string;
		value: string;
		input: string;
		nonce: string;
		accessList: string[];
	};
	additionalContracts: string[];
	isFixedGasLimit: boolean;
}
