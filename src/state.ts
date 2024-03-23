import { utils } from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { promisify } from 'util';
import {
	EOA,
	EOASchema,
	GlobalConfig,
	GlobalConfigSchema,
	loadEntity,
	PopulatedSafe,
	Proposal,
	ProposalSchema,
	Safe,
	SafeSchema,
	Transaction,
	TransactionSchema
} from './types';
import { yamlToString } from './utils/yamlToString';
const gitDiff = require('git-diff');
const exec = promisify(require('child_process').exec);

interface SafeEntity {
	path: string;
	del: boolean;
	entity: Safe | PopulatedSafe;
}

interface EOAEntity {
	path: string;
	del: boolean;
	entity: EOA;
}

interface Entity {
	path: string;
	del: boolean;
	entity: any;
}

interface TransactionEntity {
	path: string;
	del: boolean;
	entity: Transaction;
}

interface ProposalEntity {
	path: string;
	del: boolean;
	entity: Proposal;
}

const relativify = (path: string): string => {
	return relative(resolve('.'), resolve(path));
};

export interface SaveResult {
	commit: {
		edits: number;
		creations: number;
		deletions: number;
		message: string;
	};
}

export class State {
	config: GlobalConfig = {
		network: '',
		title: ''
	};

	safes: SafeEntity[] = [];
	safeByAddress: { [address: string]: number } = {};
	safeByName: { [name: string]: number } = {};

	eoas: EOAEntity[] = [];
	eoaByAddress: { [address: string]: number } = {};
	eoaByName: { [name: string]: number } = {};

	transactions: TransactionEntity[] = [];
	transactionBySafe: { [safe: string]: number[] } = {};
	transactionByHash: { [hash: string]: number } = {};

	proposals: ProposalEntity[] = [];
	proposalByHash: { [hash: string]: number } = {};
	proposalsBySafe: { [safe: string]: number[] } = {};

	async writeSafe(index: number, safe: Safe | PopulatedSafe | null): Promise<void> {
		if (index < 0 || index >= this.safes.length) {
			throw new Error(`Safe index ${index} out of bounds`);
		}
		const currentSafe = this.safes[index].entity;
		if (safe === null) {
			this.safes[index].del = true;
		} else {
			const safeName = currentSafe.name;
			const safeAddress = utils.getAddress(currentSafe.address);
			delete this.safeByAddress[safeAddress];
			delete this.safeByName[safeName];
			safe.address = utils.getAddress(safe.address);
			this.safes[index].entity = safe;
			this.safes[index].del = false;
			this.safeByAddress[safe.address] = index;
			this.safeByName[safe.name] = index;
		}
	}

	async writeProposal(index: number, proposal: Proposal | null): Promise<void> {
		if (index < 0 || index >= this.proposals.length) {
			throw new Error(`Proposal index ${index} out of bounds`);
		}
		const currentProposal = this.proposals[index].entity;
		if (proposal === null) {
			this.proposals[index].del = true;
		} else {
			const proposalSafe = utils.getAddress(currentProposal.safe);
			const proposalHash = currentProposal.safeTxHash?.toLowerCase();
			if (proposalHash) {
				delete this.proposalByHash[proposalHash];
			}
			this.proposals[index].entity = proposal;
			this.proposals[index].del = false;
			if (proposal.safeTxHash) {
				proposal.safeTxHash = proposal.safeTxHash.toLowerCase();
				this.proposalByHash[proposal.safeTxHash] = index;
			}
			if (this.proposalsBySafe[proposalSafe] === undefined) {
				this.proposalsBySafe[proposalSafe] = [];
			}
			this.proposalsBySafe[proposalSafe].push(index);
		}
	}

	async writeTransaction(index: number, tx: Transaction | null): Promise<void> {
		if (index < 0 || index >= this.transactions.length) {
			throw new Error(`Transaction index ${index} out of bounds`);
		}
		const currentTx = this.transactions[index].entity;
		if (tx === null) {
			this.transactions[index].del = true;
		} else {
			const transactionSafe = utils.getAddress(currentTx.safe);
			const transactionHash = currentTx.safeTxHash.toLowerCase();
			this.transactionBySafe[transactionSafe] = this.transactionBySafe[transactionSafe].filter(
				(i: number) => i !== index
			);
			delete this.transactionByHash[transactionHash];
			tx.safeTxHash = tx.safeTxHash.toLowerCase();
			this.transactions[index].entity = tx;
			this.transactions[index].del = false;
			if (this.transactionBySafe[transactionSafe] === undefined) {
				this.transactionBySafe[transactionSafe] = [];
			}
			this.transactionBySafe[transactionSafe].push(index);
			this.transactionByHash[transactionHash] = index;
		}
	}

	async createSafe(path: string, safe: Safe | PopulatedSafe): Promise<void> {
		const safeAddress = utils.getAddress(safe.address);
		if (this.safeByAddress[safeAddress] !== undefined) {
			throw new Error(`Safe with address ${safe.address} already exists`);
		}
		if (this.safeByName[safe.name] !== undefined) {
			throw new Error(`Safe with name ${safe.name} already exists`);
		}
		const safeIndex =
			this.safes.push({
				path: relativify(path),
				entity: safe,
				del: false
			}) - 1;
		this.safeByAddress[safeAddress] = safeIndex;
		this.safeByName[safe.name] = safeIndex;
	}

	async createEOA(path: string, eoa: EOA): Promise<void> {
		const eoaAddress = utils.getAddress(eoa.address);
		if (this.eoaByAddress[eoaAddress] !== undefined) {
			throw new Error(`EOA with address ${eoa.address} already exists`);
		}
		if (this.eoaByName[eoa.name] !== undefined) {
			throw new Error(`EOA with name ${eoa.name} already exists`);
		}
		const eoaIndex =
			this.eoas.push({
				path: relativify(path),
				entity: eoa,
				del: false
			}) - 1;
		this.eoaByAddress[eoaAddress] = eoaIndex;
		this.eoaByName[eoa.name] = eoaIndex;
	}

	async createTransaction(path: string, tx: Transaction): Promise<void> {
		const txSafe = utils.getAddress(tx.safe);
		const txHash = tx.safeTxHash.toLowerCase();
		if (this.transactionByHash[txHash] !== undefined) {
			throw new Error(`Transaction with hash ${tx.safeTxHash} already exists`);
		}
		const txIndex =
			this.transactions.push({
				path: relativify(path),
				entity: tx,
				del: false
			}) - 1;
		if (this.transactionBySafe[txSafe] === undefined) {
			this.transactionBySafe[txSafe] = [];
		}
		this.transactionBySafe[txSafe].push(txIndex);
		this.transactionByHash[txHash] = txIndex;
	}

	async createProposal(path: string, proposal: Proposal): Promise<void> {
		const proposalSafe = utils.getAddress(proposal.safe);
		if (proposal.safeTxHash) {
			const proposalHash = proposal.safeTxHash.toLowerCase();
			if (this.proposalByHash[proposalHash] !== undefined) {
				throw new Error(`Proposal with hash ${proposal.safeTxHash} already exists`);
			}
			proposal.safeTxHash = proposalHash;
			this.proposalByHash[proposal.safeTxHash] = this.proposals.length;
		}
		const proposalIndex =
			this.proposals.push({
				path: relativify(path),
				entity: proposal,
				del: false
			}) - 1;
		if (this.proposalsBySafe[proposalSafe] === undefined) {
			this.proposalsBySafe[proposalSafe] = [];
		}
		this.proposalsBySafe[proposalSafe].push(proposalIndex);
	}

	async proposalExists(path: string): Promise<number> {
		for (let proposalIdx = 0; proposalIdx < this.proposals.length; proposalIdx++) {
			const proposal = this.proposals[proposalIdx];
			if (relativify(proposal.path) === relativify(path)) {
				return proposalIdx;
			}
		}
		return -1;
	}

	getHighestProposalNonce(safe: PopulatedSafe): number | null {
		const transactionIndexes = this.transactionBySafe[utils.getAddress(safe.address)];
		if (transactionIndexes.length == 0) {
			return null;
		}
		let maxNonce = 0;
		for (const transactionIndex of transactionIndexes) {
			const transaction = this.transactions[transactionIndex].entity;
			if (transaction.nonce !== undefined && transaction.nonce > maxNonce) {
				maxNonce = transaction.nonce;
			}
		}
		return maxNonce;
	}

	getHighestExecutedProposalNonce(safe: PopulatedSafe): number | null {
		const transactionIndexes = this.transactionBySafe[utils.getAddress(safe.address)];
		if (transactionIndexes.length == 0) {
			return null;
		}
		let maxNonce = 0;
		for (const transactionIndex of transactionIndexes) {
			const transaction = this.transactions[transactionIndex].entity;
			if (!transaction.executionDate) {
				continue;
			}
			if (transaction.nonce !== undefined && transaction.nonce > maxNonce) {
				maxNonce = transaction.nonce;
			}
		}
		return maxNonce;
	}

	getSafeByName(name: string): PopulatedSafe | null {
		const safeIndex = this.safeByName[name];
		if (safeIndex === undefined) {
			return null;
		}
		return this.safes[safeIndex].entity as PopulatedSafe;
	}

	getSafeByAddress(address: string): PopulatedSafe | null {
		address = utils.getAddress(address);
		const safeIndex = this.safeByAddress[address];
		if (safeIndex === undefined) {
			return null;
		}
		return this.safes[safeIndex].entity as PopulatedSafe;
	}

	getEOAByAddress(address: string): EOA | null {
		address = utils.getAddress(address);
		const eoaIndex = this.eoaByAddress[address];
		if (eoaIndex === undefined) {
			return null;
		}
		return this.eoas[eoaIndex].entity;
	}

	getProposalByHash(hash: string): Proposal | null {
		hash = hash.toLowerCase();
		const proposalIndex = this.proposalByHash[hash];
		if (proposalIndex === undefined) {
			return null;
		}
		return this.proposals[proposalIndex].entity;
	}

	getProposalPathByHash(hash: string): string | null {
		hash = hash.toLowerCase();
		const proposalIndex = this.proposalByHash[hash];
		if (proposalIndex === undefined) {
			return null;
		}
		return this.proposals[proposalIndex].path;
	}

	getTransactionByHash(hash: string): Transaction | null {
		hash = hash.toLowerCase();
		const transactionIndex = this.transactionByHash[hash];
		if (transactionIndex === undefined) {
			return null;
		}
		return this.transactions[transactionIndex].entity;
	}

	getPendingProposalsByOwner(owner: string): Proposal[] {
		const res: Proposal[] = [];
		for (const proposalEntity of this.proposals) {
			const proposal = proposalEntity.entity;
			if (proposal.safeTxHash) {
				const transaction = this.getTransactionByHash(proposal.safeTxHash);
				const safe = this.getSafeByAddress(proposal.safe);
				if (transaction && safe) {
					if (safe.owners.find(o => getAddress(o) === owner)) {
						if (
							transaction.confirmations.length < safe.threshold &&
              !transaction.isExecuted &&
							transaction.confirmations.find(c => getAddress(c.owner) === getAddress(owner)) === undefined
						) {
							res.push(proposal);
						}
					}
				}
			}
		}

		return res.sort((a, b) => {
			const txA = this.getTransactionByHash(a.safeTxHash!);
			const txB = this.getTransactionByHash(b.safeTxHash!);
			return new Date(txA!.submissionDate).getTime() - new Date(txB!.submissionDate).getTime();
		});
	}

	async load(): Promise<void> {
		await this.loadConfig();
		await this.loadSafes();
		await this.loadEOAS();
		await this.loadTransactions();
		await this.loadProposals();
	}

	async loadConfig(): Promise<void> {
		const config = loadEntity<GlobalConfig>(GlobalConfigSchema, './safecd.yaml');
		this.config = config;
	}

	async save(): Promise<SaveResult> {
		let saveResult: SaveResult = {
			commit: {
				edits: 0,
				creations: 0,
				deletions: 0,
				message: ''
			}
		};
		saveResult = await this.saveEntity(
			{ path: relativify('./safecd.yaml'), del: false, entity: this.config },
			saveResult
		);
		for (const safe of this.safes) {
			saveResult = await this.saveEntity(safe, saveResult);
		}
		for (const eoa of this.eoas) {
			saveResult = await this.saveEntity(eoa, saveResult);
		}
		for (const tx of this.transactions) {
			saveResult = await this.saveEntity(tx, saveResult);
		}
		for (const proposal of this.proposals) {
			saveResult = await this.saveEntity(proposal, saveResult);
		}
		return saveResult;
	}

	async diff(): Promise<void> {
		for (const safe of this.safes) {
			await this.diffEntity(safe);
		}
		for (const eoa of this.eoas) {
			await this.diffEntity(eoa);
		}
		for (const tx of this.transactions) {
			await this.diffEntity(tx);
		}
		for (const proposal of this.proposals) {
			await this.diffEntity(proposal);
		}
	}

	private async saveEntity(entity: Entity, saveResult: SaveResult): Promise<SaveResult> {
		const contentToWrite = yamlToString(entity.entity);
		if (entity.del) {
			if (existsSync(entity.path)) {
				console.log('- removing', entity.path);
				unlinkSync(entity.path);
				saveResult.commit.deletions += 1;
				saveResult.commit.message += `- delete ${entity.path}\n`;
			}
		} else if (existsSync(entity.path)) {
			const content = readFileSync(entity.path, 'utf8');
			if (content === contentToWrite) {
				return saveResult;
			}
			console.log('- editing', entity.path);
			writeFileSync(entity.path, contentToWrite, { encoding: 'utf8' });
			saveResult.commit.edits += 1;
			saveResult.commit.message += `- edit   ${entity.path}\n`;
		} else {
			console.log('- creating', entity.path);
			mkdirSync(dirname(entity.path), { recursive: true });
			writeFileSync(entity.path, contentToWrite, { encoding: 'utf8' });
			saveResult.commit.creations += 1;
			saveResult.commit.message += `- create ${entity.path}\n`;
		}
		return saveResult;
	}

	private async diffEntity(entity: Entity): Promise<void> {
		const contentToWrite = yamlToString(entity.entity);
		if (entity.del) {
			if (existsSync(entity.path)) {
				const content = readFileSync(entity.path, 'utf8');
				const diff = gitDiff(content, '', {
					color: true,
					forceFake: true
				});
				console.log(entity.path);
				console.log();
				console.log(diff);
				console.log();
			}
		} else if (existsSync(entity.path)) {
			const content = readFileSync(entity.path, 'utf8');
			if (content === contentToWrite) {
				return;
			}
			const diff = gitDiff(content, contentToWrite, {
				color: true,
				forceFake: true
			});
			console.log(entity.path);
			console.log();
			console.log(diff);
			console.log();
		} else {
			const diff = gitDiff('', contentToWrite, {
				color: true,
				forceFake: true
			});
			console.log(entity.path);
			console.log();
			console.log(diff);
			console.log();
		}
	}

	private async loadSafes(): Promise<void> {
		const safes = readdirSync('./safes');
		for (const safeConfig of safes) {
			const safe: Safe = loadEntity<Safe>(SafeSchema, `./safes/${safeConfig}`);
			safe.address = utils.getAddress(safe.address);
			const safeIndex =
				this.safes.push({
					path: relativify(`./safes/${safeConfig}`),
					entity: safe,
					del: false
				}) - 1;
			if (this.safeByAddress[safe.address] !== undefined) {
				throw new Error(`Safe with address ${safe.address} is defined twice`);
			}
			this.safeByAddress[safe.address] = safeIndex;
			if (this.safeByName[safe.name] !== undefined) {
				throw new Error(`Safe with name ${safe.name} is defined twice`);
			}
			this.safeByName[safe.name] = safeIndex;
		}
	}

	private async loadEOAS(): Promise<void> {
		if (existsSync('./eoas')) {
			const eoas = readdirSync('./eoas');
			for (const eoaConfig of eoas) {
				const eoa: EOA = loadEntity<EOA>(EOASchema, `./eoas/${eoaConfig}`);
				eoa.address = utils.getAddress(eoa.address);
				const eoaIndex =
					this.eoas.push({
						path: relativify(`./eoas/${eoaConfig}`),
						entity: eoa,
						del: false
					}) - 1;
				if (this.eoaByAddress[eoa.address] !== undefined) {
					throw new Error(`EOA with address ${eoa.address} is defined twice`);
				}
				this.eoaByAddress[eoa.address] = eoaIndex;
				if (this.eoaByName[eoa.name] !== undefined) {
					throw new Error(`EOA with name ${eoa.name} is defined twice`);
				}
				this.eoaByName[eoa.name] = eoaIndex;
			}
		}
	}

	private async loadTransactionsInDir(path: string): Promise<void> {
		const elements = readdirSync(path);
		for (const element of elements) {
			const stat = statSync(resolve(path, element));
			if (stat.isDirectory()) {
				await this.loadTransactionsInDir(resolve(path, element));
			} else if (stat.isFile() && element.endsWith('.yaml')) {
				const transaction = loadEntity<Transaction>(TransactionSchema, resolve(path, element));
				transaction.safe = utils.getAddress(transaction.safe);
				const transactionIndex =
					this.transactions.push({
						path: relativify(join(path, element)),
						entity: transaction,
						del: true
					}) - 1;
				if (this.transactionBySafe[transaction.safe] === undefined) {
					this.transactionBySafe[transaction.safe] = [];
				}
				this.transactionBySafe[transaction.safe].push(transactionIndex);
				if (this.transactionByHash[transaction.safeTxHash.toLowerCase()] !== undefined) {
					throw new Error(`Transaction with hash ${transaction.safeTxHash} is defined twice`);
				}
				this.transactionByHash[transaction.safeTxHash.toLowerCase()] = transactionIndex;
			}
		}
	}

	async unbindTransaction(index: number): Promise<void> {
		if (index < 0 || index >= this.transactions.length) {
			throw new Error(`Transaction index ${index} out of bounds`);
		}
		const currentTx = this.transactions[index].entity;
		const transactionSafe = utils.getAddress(currentTx.safe);
		const transactionHash = currentTx.safeTxHash.toLowerCase();
		this.transactionBySafe[transactionSafe] = this.transactionBySafe[transactionSafe].filter(
			(i: number) => i !== index
		);
		delete this.transactionByHash[transactionHash];
	}

	private async loadTransactions(): Promise<void> {
		if (existsSync('./transactions')) {
			await this.loadTransactionsInDir('./transactions');
		}
	}

	private async loadProposalsInDir(path: string): Promise<void> {
		const elements = readdirSync(path);
		for (const element of elements) {
			const stat = statSync(resolve(path, element));
			if (stat.isDirectory()) {
				await this.loadProposalsInDir(resolve(path, element));
			} else if (stat.isFile() && element.endsWith('.proposal.yaml')) {
				const proposal = loadEntity<Proposal>(ProposalSchema, resolve(path, element));
				proposal.safeTxHash = proposal.safeTxHash?.toLowerCase();
				const proposalIndex =
					this.proposals.push({
						path: relativify(join(path, element)),
						entity: proposal,
						del: false
					}) - 1;
				if (proposal.safeTxHash) {
					if (this.proposalByHash[proposal.safeTxHash.toLowerCase()] !== undefined) {
						throw new Error(`Proposal with hash ${proposal.safeTxHash} is defined twice`);
					}
					this.proposalByHash[proposal.safeTxHash.toLowerCase()] = proposalIndex;
				}
				if (this.proposalsBySafe[utils.getAddress(proposal.safe)] === undefined) {
					this.proposalsBySafe[utils.getAddress(proposal.safe)] = [];
				}
				this.proposalsBySafe[utils.getAddress(proposal.safe)].push(proposalIndex);
			}
		}
	}

	private async loadProposals(): Promise<void> {
		await this.loadProposalsInDir('./script');
	}
}
