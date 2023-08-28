import { utils } from 'ethers';
import { readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import YAML from 'yaml';
import {
	EOA,
	EOASchema,
	load,
	PopulatedSafe,
	PopulatedSafeSchema,
	Proposal,
	ProposalSchema,
	SafeCDKit,
	Transaction,
	TransactionSchema
} from '../types';

const explorerByNetwork: { [key: string]: string } = {
	mainnet: 'https://etherscan.io/tx/',
	goerli: 'https://goerli.etherscan.io/tx/'
};

export async function generateRootReadme(scdk: SafeCDKit): Promise<void> {
	let content = `# ${scdk.config.title}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "linear" } } }%%
${generateSafesDiagram(scdk)}
\`\`\`	

${generateSafesDetailsDiagram(scdk)}
`;

	scdk.fs.write('./README.md', content);
}

function generateSafesDetailsDiagram(scdk: SafeCDKit): string {
	let content = '';
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		const safeTransactions: Transaction[] = getAllSafeTransactions(scdk, safe);
		content += `
---

## ${safe.name}

${safe.description ? safe.description : ''}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "linear" } } }%%
flowchart LR
subgraph ${safe.name}
direction LR
${generateSafeDiagram(scdk, safe, {})}
end
\`\`\`


${
	safeTransactions.filter(tx => !tx.isExecuted).length === 0
		? ''
		: formatPendingTransactionsTable(
				scdk,
				safe,
				safeTransactions.filter(tx => !tx.isExecuted)
		  )
}

### History

<details>
<summary>Click to expand</summary>

<table>

<tr>
<td>Nonce</td>
<td>Title</td>
<td>Description</td>
<td>Payload</td>
<td>Confirmations</td>
<td>Signers</td>
<td>Tx</td>
<td>Proposal</td>
<tr>

${formatSafeTransactions(
	scdk,
	safe,
	safeTransactions.filter(tx => tx.isExecuted)
)}

</table>

</details>

`;
	}
	return content;
}

function formatPendingTransactionsTable(scdk: SafeCDKit, safe: PopulatedSafe, txs: Transaction[]): string {
	return `
### Pending Transactions

<table>

<tr>
<td>Nonce</td>
<td>Title</td>
<td>Description</td>
<td>Payload</td>
<td>Confirmations</td>
<td>Signers</td>
<td>Proposal</td>
<tr>

${formatSafeTransactions(scdk, safe, txs)}

</table>

`;
}

function getTxTitle(tx: Transaction): string {
	if (utils.getAddress(tx.safe) === utils.getAddress(tx.to) && tx.data === null) {
		if (tx.value === '0') {
			return 'Transaction rejection';
		}
		return `Ether transfer of ${utils.formatEther(tx.value)} ETH`;
	}
	if (tx.dataDecoded?.method) {
		return `\`\`\`solidity

${tx.dataDecoded.method}(
  ${tx.dataDecoded.parameters?.map((p: any) => `${p.name}: ${p.type}`).join(',\n  ') || ''}
)

\`\`\``;
	}
	return '';
}

function getProposalOfSafeHash(
	scdk: SafeCDKit,
	safe: PopulatedSafe,
	tx: Transaction
): [string | null, Proposal | null] {
	return getProposalOfSafeHashFromDir(scdk, safe, tx, './script');
}

function getProposalOfSafeHashFromDir(
	scdk: SafeCDKit,
	safe: PopulatedSafe,
	tx: Transaction,
	path: string
): [string | null, Proposal | null] {
	const elements = readdirSync(path);
	for (const element of elements) {
		const elementPath = resolve(path, element);
		const stat = statSync(elementPath);
		if (stat.isDirectory()) {
			const proposal = getProposalOfSafeHashFromDir(scdk, safe, tx, elementPath);
			if (proposal !== null) {
				return proposal;
			}
		} else if (stat.isFile() && element.endsWith('.proposal.yaml')) {
			const proposal: Proposal = load<Proposal>(scdk.fs, ProposalSchema, elementPath);
			if (proposal.safeTxHash && proposal.safeTxHash?.toLowerCase() === tx.safeTxHash.toLowerCase()) {
				return [elementPath, proposal];
			}
		}
	}
	return [null, null];
}

function formatSafeTransactions(scdk: SafeCDKit, safe: PopulatedSafe, txs: Transaction[]): string {
	let content = '';
	for (const tx of txs) {
		const [proposalPath, proposal] = getProposalOfSafeHash(scdk, safe, tx);
		content += `
<tr>
<td>${tx.nonce}</td>
<td>

${proposal ? proposal.title : getTxTitle(tx)}

</td>
<td>
${
	proposal
		? `
<details>
<summary></summary>


${proposal.description}


</details>
`
		: ''
}
</td>
<td>
<details>
<summary></summary>


\`\`\`yaml
${YAML.stringify(tx)}
\`\`\`


</details>
</td>
<td>${tx.confirmations.length}/${safe.threshold}</td>
<td>${resolveConfirmations(scdk, tx)}</td>
${
	tx.isExecuted
		? `<td><a target="_blank" href="${explorerByNetwork[scdk.network]}${tx.transactionHash}">🔗</a></td>`
		: ''
}
<td>${proposal ? `<a target="_blank" href="${proposalPath}">🔗</a>` : ''}</td>
</tr>
`;
	}
	return content;
}

function resolveConfirmations(scdk: SafeCDKit, tx: Transaction): string {
	let content = [];
	for (const confirmation of tx.confirmations) {
		content.push(getNameAndType(scdk, confirmation.owner));
	}
	return content.join('<br/>');
}

function getNameAndType(scdk: SafeCDKit, address: string): string {
	const eoas = readdirSync('./eoas');
	for (const eoa of eoas) {
		const loadedEOA: EOA = load<EOA>(scdk.fs, EOASchema, `./eoas/${eoa}`);
		if (utils.getAddress(loadedEOA.address) === utils.getAddress(address)) {
			return `<code>eoa@${loadedEOA.name}</code>`;
		}
	}

	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		if (utils.getAddress(safe.address) === utils.getAddress(address)) {
			return `<code>safe@${safe.name}</code>`;
		}
	}

	return address;
}

function getAllSafeTransactions(scdk: SafeCDKit, safe: PopulatedSafe): Transaction[] {
	const path = `./transactions`;
	return getAllSafeTransactionsInDir(scdk, safe, path).sort((a: Transaction, b: Transaction) =>
		b.submissionDate.localeCompare(a.submissionDate)
	);
}

function getAllSafeTransactionsInDir(scdk: SafeCDKit, safe: PopulatedSafe, path: string): Transaction[] {
	const elements = readdirSync(path);
	let transactions: Transaction[] = [];
	for (const element of elements) {
		const elementPath = resolve(path, element);
		const stat = statSync(elementPath);
		if (stat.isDirectory()) {
			transactions = transactions.concat(getAllSafeTransactionsInDir(scdk, safe, elementPath));
		} else if (stat.isFile() && element.endsWith('.yaml')) {
			const tx: Transaction = load<Transaction>(scdk.fs, TransactionSchema, elementPath);
			if (utils.getAddress(tx.safe) === utils.getAddress(safe.address)) {
				transactions.push(tx);
			}
		}
	}
	return transactions;
}

function generateSafesDiagram(scdk: SafeCDKit): string {
	let content = 'flowchart LR\nsubgraph Overview\ndirection LR\n';
	const done = {};
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		content += generateSafeDiagram(scdk, safe, done);
	}
	content += 'end\n';
	return content;
}

function generateSafeDiagram(scdk: SafeCDKit, safe: PopulatedSafe, done: { [key: string]: boolean }): string {
	let content = '';
	if (done[safe.address]) {
		return content;
	}
	done[safe.address] = true;

	for (const owner of safe.owners) {
		const ownerSafe = getSafe(owner, scdk);
		if (ownerSafe !== null) {
			content += `${owner}{{${getNames(scdk, owner).join(', ')}<br/>type=safe,threshold=${
				ownerSafe.threshold
			}<br/>${owner}}} -->|owner| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${
				safe.address
			}}}\n`;
		} else {
			content += `${owner}(${getNames(scdk, owner).join(', ')}<br/>type=eoa<br/>${owner}) -->|owner| ${
				safe.address
			}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		}
	}

	for (const delegate of safe.delegates) {
		const delegateAddress = delegate.delegate;
		const delegateSafe = getSafe(delegateAddress, scdk);
		if (delegateSafe !== null) {
			content += `${delegateAddress}{{${getNames(scdk, delegateAddress).join(', ')}<br/>type=safe,threshold=${
				delegateSafe.threshold
			},label=${delegate.label}<br/>${delegateAddress}}} -->|delegate| ${safe.address}{{${
				safe.name
			}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		} else {
			content += `${delegateAddress}(${getNames(scdk, delegateAddress).join(', ')}<br/>type=eoa,label=${
				delegate.label
			}<br/>${delegateAddress}) -->|delegate| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${
				safe.threshold
			}<br/>${safe.address}}}\n`;
		}
	}

	return content;
}

function getNames(scdk: SafeCDKit, address: string): string[] {
	let names = [];
	const eoas = readdirSync('./eoas');
	for (const eoa of eoas) {
		const loadedEOA: EOA = load<EOA>(scdk.fs, EOASchema, `./eoas/${eoa}`);
		if (utils.getAddress(loadedEOA.address) === utils.getAddress(address)) {
			names.push(loadedEOA.name);
		}
	}

	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		if (utils.getAddress(safe.address) === utils.getAddress(address)) {
			names.push(safe.name);
		}
	}

	return names;
}

function getSafe(address: string, scdk: SafeCDKit): PopulatedSafe | null {
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		if (utils.getAddress(safe.address) === utils.getAddress(address)) {
			return safe;
		}
	}
	return null;
}
