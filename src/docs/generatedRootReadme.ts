import { utils } from 'ethers';
import { readdirSync, readFileSync, statSync } from 'fs';
import { relative, resolve } from 'path';
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
	mainnet: 'https://etherscan.io',
	goerli: 'https://goerli.etherscan.io'
};

const uiByNetwork: { [key: string]: string } = {
	mainnet: 'https://app.safe.global/home?safe=eth:',
	goerli: 'https://app.safe.global/home?safe=gor'
};

export async function generateRootReadme(scdk: SafeCDKit): Promise<string | null> {
	let content = `# ${scdk.config.title}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "linear" } } }%%
${generateSafesDiagram(scdk)}
\`\`\`	

${generateSafesDetailsDiagram(scdk)}
`;

	if (readFileSync('./README.md', 'utf8') !== content) {
		return content;
	}
	return null;
}

function generateSafesDetailsDiagram(scdk: SafeCDKit): string {
	let content = '';
	const safes = readdirSync('./safes');
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		const safeTransactions: Transaction[] = getAllSafeTransactions(scdk, safe);
		const [diagram] = generateSafeDiagram(scdk, safe, 0, {});
		content += `
---

## [${safe.name} (\`${safe.address}\`)](${uiByNetwork[scdk.network]}${safe.address})

${safe.description ? safe.description : ''}

\`\`\`mermaid
%%{init: {'theme': 'dark', "flowchart" : { "curve" : "linear" } } }%%
flowchart LR
subgraph "Safe ${safe.name}"
direction LR
${diagram}
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

### Transaction History

<details>
<summary>Click to expand</summary>

<table>

<tr>
<td>Nonce</td>
<td>Title</td>
<td>Description</td>
<td>Payload</td>
<td>Signers</td>
<td>Executor</td>
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
				return [relative(resolve('.'), elementPath), proposal];
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
${YAML.stringify(tx, { lineWidth: 0 })}
\`\`\`


</details>
</td>
${tx.isExecuted ? '' : `<td>${getConfirmationIcons(tx.confirmations.length, safe.threshold)}</td>`}
<td>${resolveConfirmations(scdk, tx)}</td>
${tx.isExecuted ? `<td>${resolveExecutor(scdk, tx)}</td>` : ''}
${tx.isExecuted ? `<td><a target="_blank" href="${getTxExplorerLink(scdk, tx)}">🔗</a></td>` : ''}
<td>${proposal ? `<a target="_blank" href="${proposalPath}">🔗</a>` : ''}</td>
</tr>
`;
	}
	return content;
}

function getConfirmationIcons(confirmationCount: number, threshold: number): string {
	return '🟩'.repeat(confirmationCount) + '⬜️'.repeat(threshold - confirmationCount);
}

function resolveExecutor(scdk: SafeCDKit, tx: Transaction): string {
	return getNameAndType(scdk, tx.executor as string);
}

function resolveConfirmations(scdk: SafeCDKit, tx: Transaction): string {
	let content = [];
	for (const confirmation of tx.confirmations) {
		content.push(getNameAndType(scdk, confirmation.owner));
	}
	return content.join('<br/>');
}

function getAddressExplorerLink(scdk: SafeCDKit, address: string): string {
	return `${explorerByNetwork[scdk.network]}/address/${address}`;
}

function getTxExplorerLink(scdk: SafeCDKit, tx: Transaction): string {
	return `${explorerByNetwork[scdk.network]}/tx/${tx.transactionHash}`;
}

let namingMap: { [key: string]: string };

function getNameAndType(scdk: SafeCDKit, address: string): string {
	if (namingMap === undefined) {
		namingMap = {};
		const eoas = readdirSync('./eoas');
		for (const eoa of eoas) {
			const loadedEOA: EOA = load<EOA>(scdk.fs, EOASchema, `./eoas/${eoa}`);
			namingMap[utils.getAddress(loadedEOA.address)] = `<code><a href="${getAddressExplorerLink(
				scdk,
				loadedEOA.address
			)}" target="_blank">eoa@${loadedEOA.name}</a></code>`;
		}

		const safes = readdirSync('./safes');
		for (const safeConfig of safes) {
			const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
			namingMap[utils.getAddress(safe.address)] = `<code><a href="${getAddressExplorerLink(
				scdk,
				safe.address
			)}" target="_blank">safe@${safe.name}</a></code>`;
		}
	}

	if (namingMap[utils.getAddress(address)]) {
		return namingMap[utils.getAddress(address)];
	}

	return `<code><a href="${getAddressExplorerLink(scdk, address)}" target="_blank">${address}</a></code>`;
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
	let index = 0;
	for (const safeConfig of safes) {
		const safe: PopulatedSafe = load<PopulatedSafe>(scdk.fs, PopulatedSafeSchema, `./safes/${safeConfig}`);
		const [res, newIndex] = generateSafeDiagram(scdk, safe, index, done);
		content += res;
		index = newIndex;
	}
	content += 'end\n';
	return content;
}

var colors = require('nice-color-palettes');

function getLightest(palette: string[]): string {
	let lightest = palette[0];
	let lighestsScore = 0;
	for (const color of palette) {
		const score =
			parseInt(color.slice(1, 3), 16) + parseInt(color.slice(3, 5), 16) + parseInt(color.slice(5, 7), 16);
		if (score > lighestsScore) {
			lighestsScore = score;
			lightest = color;
		}
	}
	return lightest;
}

function getDarkest(palette: string[]): string {
	let darkest = palette[0];
	let darkestScore = Infinity;
	for (const color of palette) {
		const score =
			parseInt(color.slice(1, 3), 16) + parseInt(color.slice(3, 5), 16) + parseInt(color.slice(5, 7), 16);
		if (score < darkestScore) {
			darkestScore = score;
			darkest = color;
		}
	}
	return darkest;
}

function getScore(color: string): number {
	return parseInt(color.slice(1, 3), 16) + parseInt(color.slice(3, 5), 16) + parseInt(color.slice(5, 7), 16);
}

function increaseScore(color: string, add: number): string {
	let r = parseInt(color.slice(1, 3), 16);
	let g = parseInt(color.slice(3, 5), 16);
	let b = parseInt(color.slice(5, 7), 16);
	const score = r + g + b;
	if (score + add > 765) {
		return '#ffffff';
	}
	const ratio = add / score;
	r = Math.round(r * (1 + ratio));
	g = Math.round(g * (1 + ratio));
	b = Math.round(b * (1 + ratio));
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function lightAndDark(address: string): [string, string] {
	const index = parseInt(utils.getAddress(address).slice(2, 8), 16);
	const palette = colors[index % colors.length];
	let lightest = getLightest(palette);
	let darkest = getDarkest(palette);
	while (getScore(lightest) - getScore(darkest) < 300) {
		lightest = increaseScore(lightest, 10);
		darkest = increaseScore(darkest, -10);
	}
	if (parseInt(utils.getAddress(address).slice(8, 10), 16) % 2 == 0) {
		return [lightest, darkest];
	}
	return [darkest, lightest];
}

function generateSafeDiagram(
	scdk: SafeCDKit,
	safe: PopulatedSafe,
	linkIndex: number,
	done: { [key: string]: boolean }
): [string, number] {
	let content = '';
	if (done[safe.address]) {
		return [content, linkIndex];
	}
	done[safe.address] = true;

	let internalIdx = 0;
	const [safeLight, safeDark] = lightAndDark(safe.address);
	for (const owner of safe.owners) {
		const [light, dark] = lightAndDark(owner);
		const ownerSafe = getSafe(owner, scdk);
		if (ownerSafe !== null) {
			content += `${owner}{{${getNames(scdk, owner).join(', ')}<br/>type=safe,threshold=${
				ownerSafe.threshold
			}<br/>${owner}}} ---|owner| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${
				safe.address
			}}}\n`;
		} else {
			content += `${owner}(${getNames(scdk, owner).join(', ')}<br/>type=eoa<br/>${owner}) ---|owner| ${
				safe.address
			}{{${safe.name}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		}
		content += `style ${owner} fill:${light},color:${dark},stroke:${dark},stroke-width:4px\n`;
		content += `linkStyle ${linkIndex + internalIdx} stroke:${safeDark},stroke-width:4px\n`;
		++internalIdx;
	}

	for (const delegate of safe.delegates) {
		const delegateAddress = delegate.delegate;
		const delegateSafe = getSafe(delegateAddress, scdk);
		const [light, dark] = lightAndDark(delegateAddress);
		if (delegateSafe !== null) {
			content += `${delegateAddress}{{${getNames(scdk, delegateAddress).join(', ')}<br/>type=safe,threshold=${
				delegateSafe.threshold
			},label=${delegate.label}<br/>${delegateAddress}}} ---|delegate| ${safe.address}{{${
				safe.name
			}<br/>type=safe,threshold=${safe.threshold}<br/>${safe.address}}}\n`;
		} else {
			content += `${delegateAddress}(${getNames(scdk, delegateAddress).join(', ')}<br/>type=eoa,label=${
				delegate.label
			}<br/>${delegateAddress}) ---|delegate| ${safe.address}{{${safe.name}<br/>type=safe,threshold=${
				safe.threshold
			}<br/>${safe.address}}}\n`;
		}
		content += `style ${delegateAddress} fill:${light},color:${dark},stroke:${dark},stroke-width:4px\n`;
		content += `linkStyle ${linkIndex + internalIdx} stroke:${safeDark},stroke-width:4px\n`;
		++internalIdx;
	}
	content += `style ${safe.address} fill:${safeLight},color:${safeDark},stroke:${safeDark},stroke-width:4px\n`;

	return [content, linkIndex + internalIdx];
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
